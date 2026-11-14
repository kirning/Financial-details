/**
 * 南丰村财务 · Koa 后端
 *
 * 启动：node dist/index.js          （默认 http://127.0.0.1:7300）
 * 开发：node --watch dist/index.js  （先 tsc --watch 或 pnpm dev）
 * 数据：data/ledger.db（Node 22 内置 node:sqlite，免原生编译）
 *
 * API
 * ── 凭证 ──
 *   GET    /api/vouchers?period=&type=&acc=&from=&to=&q=
 *   GET    /api/vouchers/:vno
 *   POST   /api/vouchers            {date,period,type,amount,subject,acc,party,handler,summary,note,nopay,attachments[]}
 *   PATCH  /api/vouchers/:vno
 *   DELETE /api/vouchers/:vno
 *   PATCH  /api/vouchers/:vno/nopay {nopay}
 * ── 汇总 ──
 *   GET    /api/summary             余额 + 月度 + 稳定序列 + 待办 + 收支结构 + 账户
 *   GET    /api/monthly
 *   GET    /api/balances
 *   GET    /api/todos
 * ── 业务解读（手写）──
 *   GET/POST /api/analyses   DELETE /api/analyses/:id
 * ── 凭证图片 ──
 *   GET/POST /api/vouchers/:vno/attachments
 * ── 维护 ──
 *   GET    /api/health
 *   POST   /api/admin/migrate       从旧 流水.csv 幂等迁移
 *   GET    /api/admin/verify        全量校验凭证 SHA256
 *   PATCH  /api/accounts/:code/opening
 */
import Koa from 'koa'
import Router from '@koa/router'
import type { RouterContext } from '@koa/router'
import bodyParser from 'koa-bodyparser'
import { createReadStream, existsSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import * as Q from './db.js'
import type { VoucherInput, Account, Analysis, Attachment } from './db.js'
import { ApiError, ROOT } from './db.js'
import {
  getObject, putObject, ensureBucket, isEnabled, status,
  listObjects, contentTypeOf, objectKey,
} from './storage.js'

const PORT = +(process.env.PORT || 7300)
const app = new Koa()
const router = new Router()

/** 凭证图内存缓存：MinIO 经 CF 回源单张要 4~10 秒，命中后可直接返回。
 *  上传新凭证时整体清空，避免读到旧图；TTL 兜底防止远端别处被改动后长期陈旧。 */
const voucherCache = new Map<string, { buf: Buffer; at: number }>()
const CACHE_TTL = 30 * 60 * 1000

/* ── 统一错误处理 ── */
app.use(async (ctx: Koa.Context, next: Koa.Next) => {
  try {
    await next()
    if (ctx.status === 404 && ctx.body === undefined) {
      ctx.status = 404
      ctx.body = { error: '接口不存在', path: ctx.path }
    }
  } catch (e) {
    const status = e instanceof ApiError ? e.status : ((e as { status?: number }).status || 500)
    ctx.status = status
    ctx.body = { error: (e as Error).message || '服务器内部错误' }
    if (status >= 500) console.error('[error]', ctx.method, ctx.path, e)
  }
})
app.use(bodyParser({ jsonLimit: '8mb' }))

const ok = (ctx: RouterContext) => { ctx.body = ctx.request.body ?? {} }

/** ctx.query 的值类型是 `string | string[]`，这里统一取第一个并收窄成 string */
const qs = (v: unknown): string | undefined => (Array.isArray(v) ? v[0] : v) as string | undefined

/* ═══════════ 凭证 ═══════════ */
router.get('/api/vouchers', (ctx: RouterContext) => {
  ctx.body = {
    data: Q.listVouchers({
      period: qs(ctx.query.period), type: qs(ctx.query.type), acc: qs(ctx.query.acc),
      from: qs(ctx.query.from), to: qs(ctx.query.to), q: qs(ctx.query.q),
    }),
  }
})

router.get('/api/vouchers/:vno', (ctx: RouterContext) => {
  const v = Q.getVoucher(ctx.params.vno!!)
  if (!v) ctx.throw(404, '凭证不存在')
  ctx.body = { data: v }
})

router.post('/api/vouchers', (ctx: RouterContext) => {
  const v = (ctx.request.body || {}) as Partial<VoucherInput> & { attachments?: Attachment[] }
  for (const f of ['date', 'period', 'type', 'subject', 'summary'] as const)
    if (!v[f]) ctx.throw(400, `缺字段：${f}`)
  if (v.type !== '收入' && v.type !== '支出') ctx.throw(400, 'type 必须是「收入」或「支出」')
  if (isNaN(Number(v.amount))) ctx.throw(400, 'amount 必须是数字')
  ctx.status = 201
  ctx.body = { data: Q.insertVoucher(v as VoucherInput, v.attachments || []) }
})

router.patch('/api/vouchers/:vno', (ctx: RouterContext) => {
  ctx.body = { data: Q.updateVoucher(ctx.params.vno!, ctx.request.body || {}) }
})

router.delete('/api/vouchers/:vno', (ctx: RouterContext) => {
  ctx.body = Q.deleteVoucher(ctx.params.vno!)
})

router.patch('/api/vouchers/:vno/nopay', (ctx: RouterContext) => {
  const n = (ctx.request.body as { nopay?: unknown } | undefined)?.nopay
  ctx.body = { data: Q.setNopay(ctx.params.vno!, !!n) }
})

/* ═══════════ 凭证图片 ═══════════ */
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2',
}

router.get('/api/vouchers/:vno/attachments', (ctx: RouterContext) => {
  const v = Q.getVoucher(ctx.params.vno!!)
  if (!v) ctx.throw(404, '凭证不存在')
  ctx.body = {
    data: v.files.map((f, i) => ({
      file: f, kind: v.kinds[i], url: '/凭证/' + f.split('凭证/')[1],
    })),
  }
})

router.post('/api/vouchers/:vno/attachments', async (ctx: RouterContext) => {
  const v = Q.getVoucher(ctx.params.vno!!)
  if (!v) ctx.throw(404, '凭证不存在')
  const { base64, filename = '凭证.jpg', kind } = (ctx.request.body || {}) as
    { base64?: string; filename?: string; kind?: string }
  if (!base64) ctx.throw(400, '缺 base64')
  const dir = join(ROOT, '凭证', ctx.params.vno!)
  mkdirSync(dir, { recursive: true })
  const name = `凭证-${kind || '补充'}${extname(filename) || '.jpg'}`
  const buf = Buffer.from(base64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  const rel = `凭证/${ctx.params.vno!}/${name}`

  // 主存储写到 MinIO；未配置或远端失败时仍保留本地副本，凭证绝不丢失
  let stored: 'minio+local' | 'local' = 'local'
  if (isEnabled()) {
    try { await putObject(rel, buf); stored = 'minio+local' }
    catch (e) { console.error('[minio] 上传失败，已写本地副本：', (e as Error).message) }
  }
  writeFileSync(join(dir, name), buf)   // 本地镜像（灾备 / 离线可读）
  voucherCache.clear()                  // 新图/覆盖图后让缓存失效

  // 落库 + 刷新校验和（顺手补上以前留空的 sha256）
  const hash = createHash('sha256').update(buf).digest('hex')
  Q.attachFile(ctx.params.vno!, rel, kind || null, hash)
  Q.hashVoucherDir(ctx.params.vno!)
  // 同目录的 SHA256SUMS.txt / 来源说明也补传到 MinIO
  if (isEnabled()) {
    try {
      const { syncVoucherDir } = await import('./minio-sync.js')
      await syncVoucherDir(ctx.params.vno!)
    } catch (e) { console.error('[minio] 目录补同步失败：', (e as Error).message) }
  }
  ctx.status = 201
  ctx.body = { data: Q.getVoucher(ctx.params.vno!), storage: stored }
})

/* ═══════════ 汇总 ═══════════ */
/** 收支结构的时间区间（月粒度 YYYY-MM）；其余概览数据始终为全量 */
const structureOpts = (ctx: RouterContext): Q.StructureOpts => ({
  from: qs(ctx.query.from), to: qs(ctx.query.to),
  basis: qs(ctx.query.basis) === 'date' ? 'date' : 'belong',
})

router.get('/api/summary', (ctx: RouterContext) => {
  const range = structureOpts(ctx)
  ctx.body = {
    data: {
      stats: Q.stats(),
      balances: Q.balances(),
      monthly: Q.monthly(),
      expense: Q.expenseStructure(range),
      income: Q.incomeStructure(range),
      subjects: Q.subjects(),
      series: {
        park: Q.series('外部停车场'),
        wage: Q.series('保洁员工资'),
        elec: Q.series('电费'),
      },
      todos: Q.todos(),
      accounts: Q.accounts(),
      range,
    },
  }
})

/** 结构钻取：某统计标签在区间内的流水明细 */
router.get('/api/structure/vouchers', (ctx: RouterContext) => {
  const tag = qs(ctx.query.tag)
  if (!tag) ctx.throw(400, '缺 tag')
  ctx.body = { data: Q.tagVouchers(tag, structureOpts(ctx)) }
})

router.get('/api/monthly', (ctx: RouterContext) => { ctx.body = { data: Q.monthly() } })
router.get('/api/balances', (ctx: RouterContext) => { ctx.body = { data: Q.balances() } })
router.get('/api/todos', (ctx: RouterContext) => { ctx.body = { data: Q.todos() } })
router.get('/api/accounts', (ctx: RouterContext) => { ctx.body = { data: Q.accounts() } })
router.get('/api/subjects', (ctx: RouterContext) => { ctx.body = { data: Q.subjects() } })

/* ═══════════ 业务解读（手写）═══════════ */
router.get('/api/analyses', (ctx: RouterContext) => { ctx.body = { data: Q.analyses() } })
router.post('/api/analyses', (ctx: RouterContext) => {
  const payload = ctx.request.body as Partial<Analysis> | undefined
  if (!payload?.body) ctx.throw(400, '缺 body')
  ctx.status = 201
  ctx.body = { data: Q.addAnalysis(payload as { vno?: string | null; topic?: string | null; body: string }) }
})
router.delete('/api/analyses/:id', (ctx: RouterContext) => {
  ctx.body = Q.deleteAnalysis(+ctx.params.id!)
})

/* ═══════════ 维护 ═══════════ */
/** 凭证存储状态（不含任何密钥） */
router.get('/api/storage/status', async (ctx: RouterContext) => {
  const s = status()
  let objects = 0
  if (s.enabled) {
    try { objects = (await listObjects('凭证/')).length } catch { /* 状态查询不因远端故障而失败 */ }
  }
  ctx.body = { data: { ...s, objects } }
})

router.get('/api/health', (ctx: RouterContext) => {
  ctx.body = { ok: true, uptime: process.uptime(), ...Q.stats() }
})
router.post('/api/admin/migrate', (ctx: RouterContext) => {
  ctx.body = { data: Q.migrateFromCsv() }
})
router.get('/api/admin/verify', (ctx: RouterContext) => {
  const bad = Q.verifyAll()
  ctx.body = { ok: bad.length === 0, bad }
})
/* 期初余额（当前只支持设置，余额计算暂仍按流水净额口径展示） */
router.patch('/api/accounts/:code/opening', (ctx: RouterContext) => {
  ctx.body = { data: Q.setOpening(ctx.params.code!!, Number((ctx.request.body as { opening?: number })?.opening || 0)) }
})

app.use(router.routes()).use(router.allowedMethods())

/* ═══════════ 静态资源（放最后）═══════════
 * 优先级：
 *   /app/*  → web/dist（React 生产包，SPA 回退到 index.html）
 *   /       → web/dist/index.html
 *   其余     → 凭证图片等根目录文件
 * 注：旧版 账本.html 兜底及其 assets/tailwind.js 已于 2026-11-10 移入 _归档/历史版本/，
 *     此处不再保留 LEGACY 分支（web/dist 不存在时直接给出构建提示）。
 */
const DIST = join(ROOT, 'web', 'dist')

app.use(async (ctx: RouterContext) => {
  if (ctx.method !== 'GET' && ctx.method !== 'HEAD') return ctx.throw(404)
  const p = decodeURIComponent(ctx.path)

  // React 生产包
  if (p === '/' || p.startsWith('/app')) {
    const rel = p === '/' ? '/index.html' : p.slice('/app'.length) || '/index.html'
    const target = join(DIST, rel)
    if (resolve(target).startsWith(resolve(DIST)) && existsSync(target) && statSync(target).isFile()) {
      const ext = extname(target)
      if (MIME[ext]) ctx.type = MIME[ext]
      else if (ext === '.html') ctx.type = 'text/html; charset=utf-8'
    else if (ext === '.css') ctx.type = 'text/css; charset=utf-8'
    ctx.set('X-Voucher-Source', 'local')
    ctx.body = createReadStream(target)
    return
    }
    if (existsSync(join(DIST, 'index.html'))) {
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = createReadStream(join(DIST, 'index.html'))
      return
    }
    if (p === '/') {
      ctx.type = 'text/html; charset=utf-8'
      ctx.body = '尚未构建前端，请先运行 web/ 下的 npm run build'
      return
    }
    return ctx.throw(404)
  }

  // 凭证文件：优先读 MinIO，远端不可用/对象缺失时回退本地镜像
  if (p.startsWith('/凭证/') && isEnabled()) {
    const key = objectKey(p.slice(1))
    try {
      const hit = voucherCache.get(key)
      let buf = hit && Date.now() - hit.at < CACHE_TTL ? hit.buf : null
      const fromCache = !!buf
      if (!buf) {
        buf = await getObject(key)
        if (buf) {
          if (voucherCache.size >= 300) voucherCache.clear()
          voucherCache.set(key, { buf, at: Date.now() })
        }
      }
      if (buf) {
        ctx.type = contentTypeOf(key)
        ctx.set('X-Voucher-Source', fromCache ? 'minio-cache' : 'minio')
        ctx.body = buf
        return
      }
    } catch (e) {
      console.error('[minio] 读取失败，回退本地：', (e as Error).message)
    }
  }

  // 根目录文件（凭证图片、assets 等）
  const target = join(ROOT, p)
  if (!resolve(target).startsWith(resolve(ROOT))) return ctx.throw(403)
  if (existsSync(target) && statSync(target).isFile()) {
    const ext = extname(target)
    if (MIME[ext]) ctx.type = MIME[ext]
    else if (ext === '.html') ctx.type = 'text/html; charset=utf-8'
    ctx.body = createReadStream(target)
    return
  }
  ctx.throw(404)
})

Q.migrateFromCsv()
if (isEnabled()) {
  // 启动兜底：任何链路（CLI / 脚本 / 手工）只写了本地的文件，都会在这里补传
  void ensureBucket()
    .then(async () => {
      const { syncVouchers } = await import('./minio-sync.js')
      const r = await syncVouchers()
      if (r.uploaded) console.log(`[minio] 启动补传 ${r.uploaded} 个文件`)
      if (r.failures.length) console.error('[minio] 启动补传失败', r.failures.length, '个')
    })
    .catch(e => console.error('[minio] 启动检查失败：', (e as Error).message))
}
app.listen(PORT, '127.0.0.1', () => {
  const s = Q.stats()
  console.log(`\n  南丰村财务账本 · 服务已启动`)
  console.log(`  ─────────────────────────────────`)
  console.log(`  地址   http://127.0.0.1:${PORT}`)
  console.log(`  数据库 ${s.dbPath}`)
  console.log(`  数据   ${s.vouchers} 笔凭证 / ${s.attachments} 张凭证图\n`)
})