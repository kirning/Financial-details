/** 南丰村财务 · 基于 HTTP 的 MCP 服务（Streamable HTTP）
 *
 *  工具范围：流水明细 CRUD + 凭证附件管理 + 待办/缺口 + 凭证完整性校验
 *  + SQLite 整库备份 / 还原（备份落 MinIO）。
 *  web 中的所有统计都由明细实时算出，所以不提供统计工具（用户 2026-11-14 明确）。
 *
 *  与 Web 服务在**同一进程**内启动，共用同一个 SQLite 连接：
 *  还原时关闭连接 → 替换文件 → 重开连接，不会出现两个进程指向不同 DB 的问题。
 *
 *  默认只监听 127.0.0.1:7302；如需远程暴露，务必配置 MCP_TOKEN。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as Q from './db.js'
import {
  getObject, putObject, deleteObject, headObject, listObjects,
  sha256, isEnabled, status, contentTypeOf,
} from './storage.js'
import { version } from './version.js'

const DB_PATH = join(Q.ROOT, 'data', 'ledger.db')
const BACKUP_PREFIX = 'backups/'
const VOUCHER_PREFIX = '凭证/'
const MAX_ATTACHMENT = 8 * 1024 * 1024   // base64 传输上限 8 MB
const stamp = (): string => new Date().toISOString().replace(/[:.]/g, '-')

type ToolResult = {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (data: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
})
const fail = (e: unknown): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
})
const errText = (e: unknown): string => e instanceof Error ? e.message : String(e)

/* ═══════════════ 备份 / 还原 ═══════════════ */

interface BackupMeta {
  key: string
  sha256: string
  size: number
  createdAt: string
  vouchers: number
  attachments: number
  label: string
}

/** VACUUM INTO 生成一致性快照 → 上传 MinIO → 回读校验 SHA256 → 写元数据 */
async function backupDb(label = ''): Promise<BackupMeta> {
  if (!isEnabled()) throw new Error('MinIO 未配置，无法备份（检查 server/.env）')
  const tmp = join(Q.ROOT, 'data', `.backup-${stamp()}.db`)
  rmSync(tmp, { force: true })
  try {
    const sqlPath = tmp.replace(/\\/g, '/').replace(/'/g, "''")
    Q.db.exec(`VACUUM INTO '${sqlPath}'`)       // WAL 模式下也能拿到一致快照
    const buf = readFileSync(tmp)
    const key = `${BACKUP_PREFIX}ledger-${stamp()}${label ? '-' + label.replace(/[^\w-]/g, '_') : ''}.db`
    const put = await putObject(key, buf)

    const back = await getObject(key)
    if (!back || sha256(back) !== put.sha256) throw new Error('备份上传后回读 SHA256 不一致')

    const s = Q.stats()
    const meta: BackupMeta = {
      key, sha256: put.sha256, size: put.size,
      createdAt: new Date().toISOString(),
      vouchers: s.vouchers, attachments: s.attachments, label,
    }
    await putObject(key + '.json', Buffer.from(JSON.stringify(meta, null, 2), 'utf8'))
    return meta
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** 校验一个 SQLite 备份文件是否完整可用（先验后用，绝不直接覆盖现库） */
function inspectBackup(buf: Buffer): { vouchers: number; attachments: number } {
  if (buf.length < 100 || buf.subarray(0, 16).toString() !== 'SQLite format 3\0') {
    throw new Error('不是有效的 SQLite 文件')
  }
  const tmp = join(Q.ROOT, 'data', `.inspect-${stamp()}.db`)
  writeFileSync(tmp, buf)
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(tmp)
    const chk = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    if (chk?.integrity_check !== 'ok') throw new Error('integrity_check 未通过：' + (chk?.integrity_check ?? '?'))
    const v = db.prepare('SELECT COUNT(*) AS n FROM vouchers').get() as { n: number }
    const a = db.prepare('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }
    return { vouchers: v.n, attachments: a.n }
  } finally {
    db?.close()
    rmSync(tmp, { force: true })
  }
}

/** 还原：下载 → 校验 → 自动预备份 → 关闭连接 → 替换文件 → 重开连接 → 验证 */
async function restoreDb(key: string): Promise<Record<string, unknown>> {
  if (!key.startsWith(BACKUP_PREFIX) || !key.endsWith('.db')) {
    throw new Error('backup_key 必须是 backups/ 下的 .db 文件')
  }
  if (!isEnabled()) throw new Error('MinIO 未配置，无法还原')

  const buf = await getObject(key)
  if (!buf) throw new Error('备份不存在：' + key)
  const inspected = inspectBackup(buf)

  // 安全网 1：先把当前库自动备份到 MinIO
  const pre = await backupDb('pre-restore')
  // 安全网 2：本地再留一份还原前文件
  const before = join(Q.ROOT, 'data', `ledger.db.before-restore-${stamp()}`)
  copyFileSync(DB_PATH, before)

  const tmp = join(Q.ROOT, 'data', `.restore-${stamp()}.db`)
  writeFileSync(tmp, buf)
  let replaced = false
  try {
    Q.closeDatabase()               // 释放 WAL / 文件句柄
    try {
      for (const suffix of ['-wal', '-shm', '-journal']) rmSync(DB_PATH + suffix, { force: true })
      copyFileSync(tmp, DB_PATH)    // 用已校验的快照替换
      replaced = true
    } catch (e) {
      copyFileSync(before, DB_PATH)  // 替换失败则立刻用本地安全网回滚
      throw e
    } finally {
      Q.reopenDatabase()             // 无论成败都必须恢复连接
    }
  } finally {
    rmSync(tmp, { force: true })
  }

  const after = Q.stats()
  return {
    restoredFrom: key,
    backupContents: inspected,
    preRestoreBackup: pre.key,
    localRollbackFile: basename(before),
    replaced,
    after: { vouchers: after.vouchers, attachments: after.attachments },
    note: '凭证图片仍由 MinIO / 本地镜像独立保存，还原数据库不会动凭证文件',
  }
}

/* ═══════════════ 凭证附件 ═══════════════ */

type AttRow = { file: string; kind: string | null; sha256: string | null }

const relFile = (vno: string, name: string): string => `${VOUCHER_PREFIX}${vno}/${name}`

/** 文件名安全化：只取 basename，挡住 ../ 与盘符路径穿越 */
function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).trim()
  if (!base || base === '.' || base === '..' || /[\\/:*?"<>|]/.test(base)) {
    throw new Error('非法文件名：' + name)
  }
  return base
}

async function putChecksum(vno: string, lines: string[] | null): Promise<void> {
  if (!isEnabled() || !lines) return
  try {
    await putObject(relFile(vno, 'SHA256SUMS.txt'), Buffer.from(lines.join('\n') + '\n', 'utf8'))
  } catch (e) { console.error('[mcp] 校验和补传失败：', errText(e)) }
}

/** 写 MinIO（主存）+ 本地镜像，登记 attachments 表并重算目录校验和。同名同内容幂等跳过。 */
async function attachVoucherFile(vno: string, filename: string, base64: string, kind: string | null) {
  if (!Q.getVoucher(vno)) throw new Error('凭证不存在：' + vno)
  const buf = Buffer.from(base64.replace(/^data:[^;,]+;base64,/, ''), 'base64')
  if (!buf.length) throw new Error('base64 解码后为空')
  if (buf.length > MAX_ATTACHMENT) throw new Error(`附件 ${buf.length} B 超过 8 MB 上限`)

  const name = safeName(filename)
  const rel = relFile(vno, name)
  const dir = join(Q.ROOT, '凭证', vno)
  mkdirSync(dir, { recursive: true })
  const hash = sha256(buf)

  const existing = Q.db.prepare('SELECT sha256 FROM attachments WHERE vno=? AND file=?')
    .get(vno, rel) as { sha256: string | null } | undefined
  if (existing?.sha256 === hash && existsSync(join(dir, name))) {
    return { vno, file: rel, sha256: hash, size: buf.length, skipped: true, reason: '同名同内容已存在，幂等跳过' }
  }

  let stored: 'minio+local' | 'local' = 'local'
  if (isEnabled()) {
    try { await putObject(rel, buf); stored = 'minio+local' }
    catch (e) { console.error('[mcp] 附件写 MinIO 失败，已保留本地镜像：', errText(e)) }
  }
  writeFileSync(join(dir, name), buf)

  if (!existing) Q.attachFile(vno, rel, kind, hash)
  else Q.db.prepare('UPDATE attachments SET sha256=?, kind=COALESCE(?, kind) WHERE vno=? AND file=?')
    .run(hash, kind, vno, rel)
  const lines = Q.hashVoucherDir(vno)
  await putChecksum(vno, lines)   // .txt 可能同尺寸变更，必须强制重传

  return {
    vno, file: rel, sha256: hash, size: buf.length, kind,
    storage: stored, skipped: false, checksumLines: lines?.length ?? 0,
  }
}

async function listAttachments(vno: string) {
  if (!Q.getVoucher(vno)) throw new Error('凭证不存在：' + vno)
  const rows = Q.db.prepare('SELECT file, kind, sha256 FROM attachments WHERE vno=? ORDER BY file')
    .all(vno) as AttRow[]
  const out: (AttRow & { localSize: number | null; remoteSize: number | null })[] = []
  for (const r of rows) {
    const p = join(Q.ROOT, r.file)
    const localSize = existsSync(p) ? statSync(p).size : null
    let remoteSize: number | null = null
    if (isEnabled()) {
      try { remoteSize = (await headObject(r.file))?.size ?? null } catch { /* 查询不因远端故障失败 */ }
    }
    out.push({ ...r, localSize, remoteSize })
  }
  return { vno, total: out.length, attachments: out }
}

/** 读回附件内容（base64），让 Agent 可以直接对凭证图做 OCR，无需 MinIO 密钥。 */
async function readAttachment(file: string) {
  if (!file.startsWith(VOUCHER_PREFIX) || file.includes('..')) throw new Error('非法附件路径：' + file)
  let buf: Buffer | null = null
  let source = 'minio'
  if (isEnabled()) {
    try { buf = await getObject(file) }
    catch (e) { console.error('[mcp] 附件读 MinIO 失败，回退本地：', errText(e)) }
  }
  if (!buf) {
    const p = join(Q.ROOT, file)
    if (existsSync(p)) { buf = readFileSync(p); source = 'local' }
  }
  if (!buf) throw new Error('附件不存在：' + file)
  if (buf.length > MAX_ATTACHMENT) throw new Error(`附件 ${buf.length} B 超过 8 MB 上限`)
  return {
    file, source, size: buf.length, sha256: sha256(buf),
    contentType: contentTypeOf(file), base64: buf.toString('base64'),
  }
}

/** 删附件记录 + 本地文件 + MinIO 对象 + 重算校验和。需 confirm。 */
async function deleteAttachment(vno: string, file: string) {
  if (!Q.getVoucher(vno)) throw new Error('凭证不存在：' + vno)
  if (!file.startsWith(relFile(vno, ''))) throw new Error('附件不属于该凭证：' + file)
  const row = Q.db.prepare('SELECT file FROM attachments WHERE vno=? AND file=?').get(vno, file)
  if (!row) throw new Error('附件记录不存在：' + file)

  Q.db.prepare('DELETE FROM attachments WHERE vno=? AND file=?').run(vno, file)
  const p = join(Q.ROOT, file)
  const localRemoved = existsSync(p)
  if (localRemoved) rmSync(p)
  let remoteRemoved = false
  if (isEnabled()) {
    try { remoteRemoved = await deleteObject(file) }
    catch (e) { console.error('[mcp] 远端附件删除失败：', errText(e)) }
  }
  const lines = Q.hashVoucherDir(vno)
  await putChecksum(vno, lines)
  return { vno, file, localRemoved, remoteRemoved, checksumLines: lines?.length ?? 0 }
}

/* ═══════════════ MCP 工具 ═══════════════ */

const createShape = {
  date: z.string().describe('发生/实付日 YYYY-MM-DD'),
  period: z.string().describe('凭证号所属期 YYYY-MM（决定凭证号）'),
  type: z.enum(['收入', '支出']).describe('收支方向'),
  amount: z.number().positive().describe('正数金额；支出会自动存为负数'),
  subject: z.string().min(1).describe('科目（原始写法，别为了统计改它）'),
  summary: z.string().min(1).describe('摘要 = 事由'),
  belong: z.string().optional().describe('归属期 YYYY-MM，跨月支付时填费用所属月；默认同 period'),
  tag: z.string().optional().describe('统计标签；留空由科目自动推断'),
  acc: z.string().optional().describe('账户代码 wx / ab / icbc，默认 wx'),
  party: z.string().optional().describe('对方 / 来源'),
  handler: z.string().optional().describe('经手人，默认 成(阿四)'),
  note: z.string().optional().describe('备注；含「费用所属期 YYYY-MM」可修正归属月'),
  vno: z.string().optional().describe('不填则按 period 自动分配 NF-YYYY-MM-NNN'),
  nopay: z.boolean().optional().describe('是否缺支付凭证'),
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'nanfeng-ledger', version: version() })

  server.registerTool('ledger_list_vouchers', {
    title: '查询流水明细',
    description: '按条件查询财务明细。web 中所有统计（收支结构、月度趋势、余额）都由这些明细实时计算，无需单独统计工具。',
    inputSchema: {
      period: z.string().optional().describe('归属期 YYYY-MM'),
      type: z.enum(['收入', '支出']).optional(),
      acc: z.string().optional().describe('账户代码 wx / ab / icbc'),
      from: z.string().optional().describe('起始日期 YYYY-MM-DD（按实付日）'),
      to: z.string().optional().describe('结束日期 YYYY-MM-DD（按实付日）'),
      q: z.string().optional().describe('搜索科目/摘要/凭证号/对方'),
      tag: z.string().optional().describe('按统计标签精确过滤'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    },
  }, async (args) => {
    try {
      let rows = Q.listVouchers({
        period: args.period, type: args.type, acc: args.acc,
        from: args.from, to: args.to, q: args.q,
      })
      if (args.tag) rows = rows.filter(r => r.tag === args.tag)
      const total = rows.length
      return ok({ total, limit: args.limit, offset: args.offset, rows: rows.slice(args.offset, args.offset + args.limit) })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_get_voucher', {
    title: '查询单笔明细',
    description: '按凭证号返回一笔流水的完整字段（含标签、附件列表）。',
    inputSchema: { vno: z.string().describe('凭证号，如 NF-2026-10-006') },
  }, async (args) => {
    try {
      const v = Q.getVoucher(args.vno)
      return v ? ok(v) : fail('凭证不存在：' + args.vno)
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_create_voucher', {
    title: '新增一笔明细',
    description: '新增流水明细。凭证号自动生成；要附图请随后调用 ledger_attach_file。',
    inputSchema: createShape,
  }, async (args) => {
    try {
      const v = Q.insertVoucher(args)
      return ok({ created: v.vno, voucher: v })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_update_voucher', {
    title: '修改一笔明细',
    description: '按凭证号局部修改明细；只传要改的字段，未传字段保持原值。',
    inputSchema: {
      vno: z.string().describe('凭证号'),
      date: z.string().optional(), period: z.string().optional(),
      belong: z.string().optional(), type: z.enum(['收入', '支出']).optional(),
      amount: z.number().positive().optional(), subject: z.string().min(1).optional(),
      tag: z.string().optional(), acc: z.string().optional(),
      party: z.string().optional(), handler: z.string().optional(),
      summary: z.string().min(1).optional(), note: z.string().optional(),
      nopay: z.boolean().optional(),
    },
  }, async (args) => {
    try {
      const { vno, ...patch } = args
      const v = Q.updateVoucher(vno, patch)
      return ok({ updated: vno, voucher: v })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_delete_voucher', {
    title: '删除一笔明细',
    description: '删除指定凭证号的流水记录。凭证图片文件仍保留在本地与 MinIO，仅删数据库记录。需显式 confirm=true。',
    inputSchema: {
      vno: z.string().describe('凭证号'),
      confirm: z.literal(true).describe('必须传 true 才会执行删除'),
    },
  }, async (args) => {
    try {
      const before = Q.getVoucher(args.vno)
      if (!before) return fail('凭证不存在：' + args.vno)
      Q.deleteVoucher(args.vno)
      return ok({ deleted: args.vno, removed: { subject: before.subject, amount: before.amount } })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_attach_file', {
    title: '上传凭证附件',
    description: '给已有凭证附加图片/文件。写 MinIO 主存 + 本地镜像，登记 attachments 表并重算 SHA256SUMS.txt；同名同内容幂等跳过。base64 上限 8 MB，文件名只取 basename 防路径穿越。',
    inputSchema: {
      vno: z.string().describe('凭证号'),
      filename: z.string().describe('文件名（含扩展名），如 凭证-微信收款单.jpg'),
      base64: z.string().min(1).describe('文件内容 base64，可带 data:image/...;base64, 前缀'),
      kind: z.string().optional().describe('凭证类型标注，如 收款单 / 支出证明单'),
    },
  }, async (args) => {
    try { return ok(await attachVoucherFile(args.vno, args.filename, args.base64, args.kind ?? null)) }
    catch (e) { return fail(e) }
  })

  server.registerTool('ledger_list_attachments', {
    title: '列出凭证附件',
    description: '列出某凭证在 attachments 表中的全部附件，并回报本地镜像大小与 MinIO 对象大小（可据此判断证据链是否完整）。',
    inputSchema: { vno: z.string().describe('凭证号') },
  }, async (args) => {
    try { return ok(await listAttachments(args.vno)) } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_get_attachment', {
    title: '读取凭证附件内容',
    description: '按相对路径读回附件的 base64 内容，供 OCR / 人工复核。优先读 MinIO，失败回退本地；密钥不出后端。上限 8 MB。',
    inputSchema: {
      file: z.string().describe('附件相对路径，取自 ledger_list_attachments 的 file 字段，如 凭证/NF-2026-10-006/凭证-微信转账单.jpg'),
    },
  }, async (args) => {
    try { return ok(await readAttachment(args.file)) } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_delete_attachment', {
    title: '删除凭证附件',
    description: '删除一条附件记录及其本地文件与 MinIO 对象，并刷新 SHA256SUMS.txt。需显式 confirm=true；不会删除凭证明细本身。',
    inputSchema: {
      vno: z.string().describe('凭证号'),
      file: z.string().describe('附件相对路径'),
      confirm: z.literal(true).describe('必须传 true 才会执行删除'),
    },
  }, async (args) => {
    try { return ok(await deleteAttachment(args.vno, args.file)) } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_todos', {
    title: '待办与缺口',
    description: '返回与 Web 待办面板同源的待办/缺口：电费与外部停车场的缺失月份（missingPay/missingPark.gaps）、缺支付凭证的明细（nopay）、备注待核项（review）、净额为负的账户（negAcc）、首笔期间（first）。记账 Agent 用它判断还缺哪些凭证，不必自己推算序列。',
    inputSchema: {},
  }, async () => {
    try { return ok(Q.todos()) } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_verify', {
    title: '凭证完整性校验',
    description: '校验本地各凭证目录的 SHA256SUMS.txt 与实际文件哈希是否一致，返回有问题目录清单。注意：与 MinIO 远端对象的逐字节比对需用 CLI minio-verify。',
    inputSchema: {},
  }, async () => {
    try {
      const bad = Q.verifyAll()
      return ok({ ok: bad.length === 0, badCount: bad.length, bad, minio: status().enabled })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_backup_db', {
    title: '备份数据库到 MinIO',
    description: '用 VACUUM INTO 生成一致快照，上传 MinIO 的 backups/ 前缀，回读校验 SHA256 并写 .json 元数据。凭证图片已独立存储，不在此备份内。',
    inputSchema: { label: z.string().optional().describe('可选备注，会进备份文件名') },
  }, async (args) => {
    try { return ok(await backupDb(args.label ?? '')) } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_list_backups', {
    title: '列出数据库备份',
    description: '列出 MinIO backups/ 下的 SQLite 备份，按时间倒序。',
    inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  }, async (args) => {
    try {
      if (!isEnabled()) throw new Error('MinIO 未配置')
      const objs = (await listObjects(BACKUP_PREFIX))
        .filter(o => o.key.endsWith('.db'))
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, args.limit)
        .map(o => ({ key: o.key, size: o.size }))
      return ok({ total: objs.length, backups: objs })
    } catch (e) { return fail(e) }
  })

  server.registerTool('ledger_restore_db', {
    title: '从 MinIO 还原数据库',
    description: '高风险：用指定备份替换当前账本。会先校验备份完整性、自动把当前库另备份到 MinIO、本地留还原前副本，再关闭连接替换并重开。需显式 confirm=true。',
    inputSchema: {
      backup_key: z.string().describe('ledger_list_backups 返回的 key'),
      confirm: z.literal(true).describe('必须传 true 才会执行还原'),
    },
  }, async (args) => {
    try { return ok(await restoreDb(args.backup_key)) } catch (e) { return fail(e) }
  })

  return server
}

/* ═══════════════ HTTP 传输 ═══════════════ */

const json = (res: ServerResponse, code: number, data: unknown): void => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/health') {
    json(res, 200, {
      ok: true, service: 'nanfeng-ledger-mcp', transport: 'streamable-http',
      version: version(), tools: toolNames.length,
      minio: status().enabled, vouchers: Q.stats().vouchers, attachments: Q.stats().attachments,
    })
    return
  }
  if (url.pathname !== '/mcp') { json(res, 404, { error: 'Not Found' }); return }

  const token = process.env.MCP_TOKEN || ''
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'Unauthorized: 需要 Authorization: Bearer <MCP_TOKEN>' })
    return
  }

  // stateless 模式：每个请求独立的 server + transport，无需维护 session
  const mcp = buildMcpServer()
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close().catch(() => undefined)
    void mcp.close().catch(() => undefined)
  })
  await mcp.connect(transport)
  await transport.handleRequest(req, res)
}

export function startMcpServer(): void {
  const port = +(process.env.MCP_PORT || 7302)
  const host = process.env.MCP_HOST || '127.0.0.1'
  const server = createServer((req, res) => {
    void handle(req, res).catch(e => {
      console.error('[mcp] 请求处理失败：', errText(e))
      if (!res.headersSent) json(res, 500, { error: errText(e) })
    })
  })
  server.listen(port, host, () => {
    console.log(`  MCP   http://${host}:${port}/mcp  (Streamable HTTP${process.env.MCP_TOKEN ? ', token 已启用' : ''})`)
  })
}

/** 供离线诊断使用：不启服务，直接列出工具名 */
export const toolNames = [
  // 明细 CRUD
  'ledger_list_vouchers', 'ledger_get_voucher', 'ledger_create_voucher',
  'ledger_update_voucher', 'ledger_delete_voucher',
  // 凭证附件
  'ledger_attach_file', 'ledger_list_attachments',
  'ledger_get_attachment', 'ledger_delete_attachment',
  // 待办 / 校验
  'ledger_todos', 'ledger_verify',
  // 整库备份 / 还原
  'ledger_backup_db', 'ledger_list_backups', 'ledger_restore_db',
] as const
