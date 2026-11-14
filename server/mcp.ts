/** 南丰村财务 · 基于 HTTP 的 MCP 服务（Streamable HTTP）
 *
 *  工具范围只覆盖「流水明细」的增删改查 —— web 中的所有统计都由明细实时算出，
 *  所以不需要单独的统计工具。另提供 SQLite 整库备份 / 还原（备份落 MinIO）。
 *
 *  与 Web 服务在**同一进程**内启动，共用同一个 SQLite 连接：
 *  还原时关闭连接 → 替换文件 → 重开连接，不会出现两个进程指向不同 DB 的问题。
 *
 *  默认只监听 127.0.0.1:7302；如需远程暴露，务必配置 MCP_TOKEN。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import * as Q from './db.js'
import {
  getObject, putObject, listObjects, sha256, isEnabled, status,
} from './storage.js'

const DB_PATH = join(Q.ROOT, 'data', 'ledger.db')
const BACKUP_PREFIX = 'backups/'
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
  const server = new McpServer({ name: 'nanfeng-ledger', version: '1.0.0' })

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
    description: '新增流水明细。凭证号自动生成；凭证图片请用现有上传接口另行附加。',
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
      tools: 8, minio: status().enabled, vouchers: Q.stats().vouchers,
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
  'ledger_list_vouchers', 'ledger_get_voucher', 'ledger_create_voucher',
  'ledger_update_voucher', 'ledger_delete_voucher',
  'ledger_backup_db', 'ledger_list_backups', 'ledger_restore_db',
] as const
