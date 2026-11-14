/**
 * 数据层 —— Node 22 内置 node:sqlite（免原生编译）
 *
 * 设计要点：
 *  1. vouchers 表 = 唯一数据源，字段与旧 流水.csv 一一对应（迁移零丢失）
 *  2. attachments 表独立于 vouchers，支持一笔多张凭证图
 *  3. 所有写操作走事务，避免半截数据
 *  4. `period`（凭证号所属期）与 `belong`（归属期）分开，跨月支付不串月
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 定位项目根目录（南丰村财务/）。
 *
 * ⚠️ 源码在 `server/db.ts`，编译产物在 `server/dist/db.js` —— 后者深一层。
 * 若直接用 `join(__dirname, '..')`，跑 dist 时会得到 `server/`，从而连到
 * `server/data/ledger.db`（一个空库），表现为「0 笔凭证」。
 * 所以先判断本文件是否在 dist 里，是则再多提一级。
 */
const here = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = basename(here) === 'dist' ? join(here, '..') : here
export const ROOT = join(SRC_DIR, '..')
const DB_PATH = join(ROOT, 'data', 'ledger.db')
const CSV_PATH = join(ROOT, '流水.csv')

mkdirSync(join(ROOT, 'data'), { recursive: true })

export const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

/**
 * node:sqlite 的 all()/get() 返回的是 `Record<string, SQLOutputValue>[]`，
 * 字段类型全是联合类型，直接 `as VoucherRow[]` 会因「类型不充分重叠」被 TS 拒绝。
 * 这两个助手统一走 `unknown` 中转，并收窄参数类型（不接受 undefined）。
 */
function all<T>(sql: string, ...params: (string | number | null)[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[]
}

function get<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined
}

db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  code        TEXT PRIMARY KEY,          -- wx / ab / icbc
  name        TEXT NOT NULL,             -- 微信零钱
  full_name   TEXT NOT NULL,             -- 微信零钱(阿四个人账户代管)
  role        TEXT,                      -- 主账户 / 备用账户 / 中转账户
  holder      TEXT,                      -- 户名
  opening     REAL NOT NULL DEFAULT 0,   -- 期初余额
  sort_no     INTEGER NOT NULL DEFAULT 99
);

CREATE TABLE IF NOT EXISTS vouchers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vno         TEXT NOT NULL UNIQUE,      -- NF-YYYY-MM-NNN
  date        TEXT NOT NULL,             -- 发生/实付日 YYYY-MM-DD
  period      TEXT NOT NULL,             -- 凭证号所属期 YYYY-MM
  type        TEXT NOT NULL CHECK(type IN ('收入','支出')),
  amount      REAL NOT NULL,             -- 收入正数 / 支出负数
  subject     TEXT NOT NULL,             -- 科目
  acc_code    TEXT NOT NULL REFERENCES accounts(code),
  party       TEXT,                      -- 对方/来源
  handler     TEXT,                      -- 经手人
  summary     TEXT NOT NULL,             -- 摘要 = 事由
  note        TEXT,                      -- 备注
  nopay       INTEGER NOT NULL DEFAULT 0,-- 1=缺支付凭证
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vno         TEXT NOT NULL REFERENCES vouchers(vno) ON DELETE CASCADE,
  file        TEXT NOT NULL,             -- 相对 ROOT 的路径
  kind        TEXT,                      -- 支出证明单 / 微信转账单 / 收款收据 …
  sha256      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS analyses (          -- 手写业务解读
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  vno         TEXT REFERENCES vouchers(vno) ON DELETE CASCADE,
  topic       TEXT,                      -- 无 vno 时作为「总体分析」标题
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`)

/** 由科目推断「统计标签」：去掉月份前后缀，电费/保洁工资归并为统一标签。
 *  标签只用于结构统计合并，**原始 subject 保持不变**（统计是对流水的加工，不是改写流水）。 */
export function normalizeTag(subject: string, type?: VType): string {
  let s = (subject || '').trim()
  s = s.replace(/^\d{1,2}\s*月份?/, '')                       // 「3月份小区电费」→「小区电费」
  s = s.replace(/[（(]\s*\d{1,2}\s*月份?\s*[)）]/g, '')        // 「(10月份)」
  s = s.replace(/[（(]\s*20\d\d\s*[-年]\s*\d{1,2}\s*月?\s*[)）]/g, '') // 「(2026-07)」
  s = s.trim()
  if (type !== '收入' && /电费/.test(s) && !/充电|收入/.test(s)) return '小区电费(生活缴费)'
  if (/保洁员工资|保洁员人工/.test(s)) return '支付保洁员工资'
  return s || (subject || '').trim()
}

/* 老库补列（加字段后自动 ALTER，幂等）—— 必须在建表后、索引前执行 */
function ensureColumn(table: string, col: string, decl: string): void {
  const cols = all<{ name: string }>(`PRAGMA table_info(${table})`).map(c => c.name)
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
}
// 归属期（跨月支付时 = 费用所属期）
ensureColumn('vouchers', 'belong', 'TEXT')
// 统计标签：收支结构按此聚合，原始 subject 不变
ensureColumn('vouchers', 'tag', 'TEXT')
// 历史凭证回填标签：只补空值，幂等；已手工设定过的标签不会被覆盖
for (const r of all<{ vno: string; subject: string; type: VType }>(
  `SELECT vno, subject, type FROM vouchers WHERE tag IS NULL OR TRIM(tag) = ''`)) {
  db.prepare('UPDATE vouchers SET tag=? WHERE vno=?').run(normalizeTag(r.subject, r.type), r.vno)
}

db.exec(`
CREATE INDEX IF NOT EXISTS ix_v_period ON vouchers(period);
CREATE INDEX IF NOT EXISTS ix_v_belong ON vouchers(belong);
CREATE INDEX IF NOT EXISTS ix_v_date   ON vouchers(date);
CREATE INDEX IF NOT EXISTS ix_v_acc    ON vouchers(acc_code);
CREATE INDEX IF NOT EXISTS ix_v_tag    ON vouchers(tag);
CREATE INDEX IF NOT EXISTS ix_a_vno    ON attachments(vno);
`)

/* ═══════════════ 类型定义 ═══════════════ */

export type VType = '收入' | '支出'

/** 原始行（vouchers + accounts 联表 + GROUP_CONCAT 出的附件） */
export interface VoucherRow {
  id: number
  vno: string
  date: string
  period: string
  belong?: string | null
  type: VType
  amount: number
  subject: string
  tag?: string | null
  acc_code: string
  acc_name?: string | null
  party: string | null
  handler: string | null
  summary: string
  note: string | null
  nopay: number
  created_at: string
  /** GROUP_CONCAT(file,'|')，无附件为 null */
  files?: string | null
  /** GROUP_CONCAT(kind,'|')，无附件为 null */
  kinds?: string | null
}

/** 对外输出的流水（前端 / API 用的形状） */
export interface Voucher {
  vno: string
  date: string
  period: string
  belong: string
  type: VType
  amount: number
  subject: string
  tag: string
  acc: string
  accName: string
  accFull: string | null
  party: string | null
  handler: string | null
  summary: string
  note: string | null
  nopay: boolean
  files: string[]
  kinds: string[]
}

/** 新增/修改一笔时前端传入的字段 */
export interface VoucherInput {
  vno?: string
  date: string
  period: string
  belong?: string
  type: VType
  amount: number
  subject: string
  /** 统计标签：留空则按科目自动推断 */
  tag?: string
  acc?: string
  party?: string | null
  handler?: string | null
  summary: string
  note?: string | null
  nopay?: boolean | number
}

export interface Account {
  code: string
  name: string
  full_name: string
  role: string | null
  holder: string | null
  opening: number
  sort_no: number
}

export interface Attachment {
  file: string
  kind: string | null
  sha256?: string | null
}

export interface BalanceRow extends Account {
  inc: number
  exp: number
  n: number
}

export interface MonthlyRow {
  period: string
  inc: number
  exp: number
  n: number
  net: number
}

export interface SeriesRow {
  period: string
  total: number
  n: number
}

export interface SubjectRow {
  subject: string
  n: number
  inc: number
  exp: number
  kind: '收入' | '支出' | '通用'
  variants: string[]
}

export interface TodoItem {
  vno: string
  date: string
  summary: string
  subject: string
  amount: number
  note?: string
}

export interface Todos {
  first: string | null
  missingPay: { seen: string[]; gaps: string[] }
  missingPark: { seen: string[]; gaps: string[] }
  nopay: TodoItem[]
  review: TodoItem[]
  negAcc: string[]
}

export interface ListFilter {
  period?: string
  type?: string
  acc?: string
  from?: string
  to?: string
  q?: string
}

/* ═══════════════ 账户字典 ═══════════════ */

// 与旧账本一致；新增账户在此登记即可
const ACCOUNTS: [string, string, string, string, string, number][] = [
  ['wx', '微信零钱', '微信零钱(阿四个人账户代管)', '主账户', '成（阿四）', 1],
  ['ab', '农行6316', '农业银行尾号6316(阿四个人账户)', '外部停车场分成汇集账户', '成（阿四）', 2],
  ['icbc', '工行3779', '工商银行尾号3779(阿四个人账户)', '中转账户', '成（阿四）', 3],
]
{
  const ins = db.prepare(
    `INSERT INTO accounts (code,name,full_name,role,holder,sort_no)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       name=excluded.name, full_name=excluded.full_name,
       role=excluded.role, holder=excluded.holder, sort_no=excluded.sort_no`)
  for (const a of ACCOUNTS) ins.run(...a)
}

/* ═══════════════ 工具 ═══════════════ */

/** 从凭证号取出期间：NF-2026-06-004 → 2026-06 */
export const periodOf = (vno: string): string => {
  const s = String(vno).split('-')
  return `${s[1]}-${s[2]}`
}

/** 归属期：跨月支付时取备注里的「费用所属期/收入所属期」，否则同凭证号期间 */
export function belongOf(row: { note?: string | null; belong?: string | null; vno: string }): string {
  const m = String(row.note || '').match(/(?:费用|收入)所属期\s*(20\d\d-\d\d)/)
  return (m && m[1]) || row.belong || periodOf(row.vno)
}

export function nextVno(period: string): string {
  const row = get<{ n: number }>(`SELECT COUNT(*) n FROM vouchers WHERE vno LIKE ?`, `NF-${period}-%`)!
  return `NF-${period}-${String(row.n + 1).padStart(3, '0')}`
}

/* ═══════════════ CSV 迁移 ═══════════════ */

/** 解析一行 CSV（RFC4180：引号字段、"" 转义、字段内逗号/换行） */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = '', inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++ }   // 转义的双引号
        else inQ = false
      } else cur += c
    } else {
      if (c === '"') inQ = true
      else if (c === ',') { out.push(cur); cur = '' }
      else cur += c
    }
  }
  out.push(cur)
  return out
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim())
  if (!lines.length) return []
  const head = parseCsvLine(lines[0] ?? '').map(h => h.trim())
  const rows: Record<string, string>[] = []
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    const o: Record<string, string> = {}
    head.forEach((h, i) => { o[h] = (cells[i] ?? '').trim() })
    rows.push(o)
  }
  return rows
}

/** 首次启动：从旧 流水.csv 迁移（幂等，凭证号已存在则跳过） */
export function migrateFromCsv(): { migrated: number; skipped?: boolean } {
  if (!existsSync(CSV_PATH)) return { migrated: 0, skipped: true }
  const rows = parseCsv(readFileSync(CSV_PATH, 'utf8'))
  const has = db.prepare('SELECT vno FROM vouchers WHERE vno = ?')
  const ins = db.prepare(`INSERT INTO vouchers
    (vno,date,period,belong,type,amount,subject,acc_code,party,handler,summary,note,nopay)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const insAtt = db.prepare(
    'INSERT INTO attachments (vno,file,kind) VALUES (?,?,?)')

  let n = 0
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const vno = r['凭证号']
      if (!vno || has.get(vno)) continue
      const note = r['备注'] || ''
      const pm = note.match(/(?:费用|收入)所属期\s*(20\d\d-\d\d)/)
      // CSV 字段可能缺列，读出来是 undefined —— 统一转成 null 再喂给 SQL
      ins.run(
        vno, r['日期'] ?? '', periodOf(vno), (pm && pm[1]) || periodOf(vno),
        r['类型'] ?? '支出', parseFloat(r['金额'] ?? '0'),
        r['科目'] ?? '', accOf(r['账户']), r['对方/来源'] || null,
        r['经手人'] || null, r['摘要(事由)'] ?? '', note,
        note.includes('无支付凭证') ? 1 : 0)
      for (const f of (r['凭证文件'] || '').split('|').filter(Boolean)) {
        insAtt.run(vno, f.replace(/^凭证[\\/]/, '凭证/'),
          (f.split('/').pop() || '').replace(/^凭证-|\.jpg$|\.png$/g, ''))
      }
      n++
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return { migrated: n }
}

/** CSV 里的账户全名 → accounts.code */
function accOf(fullName: string | undefined): string {
  const hit = get<{ code: string }>('SELECT code FROM accounts WHERE full_name = ?', fullName ?? '')
  if (hit) return hit.code
  const loose = get<{ code: string }>(`SELECT code FROM accounts WHERE ? LIKE '%' || name || '%'`, fullName ?? '')
  return loose ? loose.code : 'wx'
}

/* ═══════════════ 查询 ═══════════════ */

export function listVouchers(filter: ListFilter = {}): Voucher[] {
  const w: string[] = []
  const p: (string | number)[] = []
  if (filter.period) { w.push("COALESCE(v.belong, v.period) = ?"); p.push(filter.period) }
  if (filter.type) { w.push('v.type = ?'); p.push(filter.type) }
  if (filter.acc) { w.push('v.acc_code = ?'); p.push(filter.acc) }
  if (filter.from) { w.push('v.date >= ?'); p.push(filter.from) }
  if (filter.to) { w.push('v.date <= ?'); p.push(filter.to) }
  if (filter.q) {
    w.push('(v.subject LIKE ? OR v.summary LIKE ? OR v.vno LIKE ? OR v.party LIKE ?)')
    p.push(`%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`, `%${filter.q}%`)
  }
  const sql = `SELECT v.*, a.name AS acc_name,
      (SELECT GROUP_CONCAT(file, '|') FROM attachments WHERE vno = v.vno) AS files,
      (SELECT GROUP_CONCAT(kind, '|') FROM attachments WHERE vno = v.vno) AS kinds
    FROM vouchers v LEFT JOIN accounts a ON a.code = v.acc_code
    ${w.length ? 'WHERE ' + w.join(' AND ') : ''}
    ORDER BY v.vno`
  return all<VoucherRow>(sql, ...p).map(shape)
}

const shape = (r: VoucherRow): Voucher => ({
  vno: r.vno, date: r.date, period: r.period,
  belong: belongOf(r), type: r.type,
  amount: r.amount, subject: r.subject,
  tag: (r.tag && r.tag.trim()) || normalizeTag(r.subject, r.type), acc: r.acc_code,
  accName: r.acc_name || r.acc_code, accFull: null,
  party: r.party, handler: r.handler, summary: r.summary,
  note: r.note, nopay: !!r.nopay,
  files: r.files ? r.files.split('|') : [],
  kinds: r.kinds ? r.kinds.split('|') : [],
})

export function getVoucher(vno: string): Voucher | undefined {
  const r = listVouchers().find(x => x.vno === vno)
  if (r) {
    const a = get<{ full_name: string }>('SELECT full_name FROM accounts WHERE code=?', r.acc)
    r.accFull = a?.full_name ?? null
  }
  return r
}

export function accounts(): Account[] {
  return all<Account>('SELECT * FROM accounts ORDER BY sort_no')
    .map(a => ({ ...a, opening: a.opening }))
}

/** 余额：按账户汇总。期初余额默认 0（未录），故返回的是「已记录流水净额」。 */
export function balances(): { accounts: BalanceRow[]; total: { inc: number; exp: number; n: number } } {
  const rows = all<BalanceRow>(`
    SELECT a.code, a.name, a.full_name, a.role, a.opening,
           COALESCE(SUM(CASE WHEN v.amount>0 THEN v.amount END),0) AS inc,
           COALESCE(SUM(CASE WHEN v.amount<0 THEN -v.amount END),0) AS exp,
           COUNT(v.vno) AS n
    FROM accounts a LEFT JOIN vouchers v ON v.acc_code=a.code
    GROUP BY a.code ORDER BY a.sort_no`)
  const t = { inc: 0, exp: 0, n: 0 }
  for (const r of rows) { t.inc += r.inc; t.exp += r.exp; t.n += r.n }
  return { accounts: rows, total: t }
}

/** 月度收支，按**归属期**归集（跨月支付算到费用所属月） */
export function monthly(): MonthlyRow[] {
  return all<Omit<MonthlyRow, 'net'>>(`
    SELECT COALESCE(belong, period) AS period,
      COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc,
      COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS exp,
      COUNT(*) AS n
    FROM vouchers GROUP BY COALESCE(belong, period) ORDER BY 1`)
    .map(r => ({ ...r, net: +(r.inc - r.exp).toFixed(2) }))
}

/** 某科目的月度序列（如「外部停车场」逐月合计） */
export function series(keyword: string): SeriesRow[] {
  return all<SeriesRow>(`
    SELECT COALESCE(belong, period) AS period, SUM(amount) AS total, COUNT(*) AS n
    FROM vouchers WHERE subject LIKE ? GROUP BY 1 ORDER BY 1`, `%${keyword}%`)
}

/** 科目清单（供前端下拉框用）
 *  把「3月份小区电费(生活缴费)」这类带月份/括号的变体归并为**通用科目名**，
 *  避免下拉框出现一堆重复项。kind 判定收入/支出/通用。 */
export function subjects(): SubjectRow[] {
  const generic = (s: string) => s
    .replace(/^\d{1,2}\s*月份?/, '')                          // 「3月份小区电费」→「小区电费」
    .replace(/[（(]\s*\d{1,2}\s*月份?\s*[)）]/g, '')           // 「(5月份)」
    .replace(/[（(]\s*20\d\d[-年]\d+月?\s*[)）]/g, '')           // 「(2026-07)」
    .replace(/[（(]\s*[^)）]{0,10}(生活缴费|个人|专用|贺年|摆盆)\s*[)）]/g, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/\s*\/\s*$/, '')
    .trim()

  const rows = all<{ subject: string; n: number; inc: number; exp: number }>(`
    SELECT subject, COUNT(*) AS n,
           COALESCE(SUM(CASE WHEN amount>0 THEN amount END),0) AS inc,
           COALESCE(SUM(CASE WHEN amount<0 THEN -amount END),0) AS exp
    FROM vouchers GROUP BY subject`)

  interface Acc { subject: string; n: number; inc: number; exp: number; variants: Set<string> }
  const map = new Map<string, Acc>()
  for (const r of rows) {
    const g = generic(r.subject) || r.subject
    if (!map.has(g)) map.set(g, { subject: g, n: 0, inc: 0, exp: 0, variants: new Set() })
    const m = map.get(g)!
    m.n += r.n; m.inc += r.inc; m.exp += r.exp
    m.variants.add(r.subject)
  }
  return [...map.values()]
    .map(m => ({
      subject: m.subject, n: m.n, inc: m.inc, exp: m.exp,
      kind: (m.inc > 0 && m.exp === 0 ? '收入' : m.exp > 0 && m.inc === 0 ? '支出' : '通用') as SubjectRow['kind'],
      variants: [...m.variants],
    }))
    .sort((a, b) => b.n - a.n || a.subject.localeCompare(b.subject, 'zh'))
}

/** 待办：自动识别缺凭证月份与缺支付凭证笔数
 *  每条尽量关联到具体凭证号，便于前端快速定位。 */
export function todos(): Todos {
  const missing = (kw: string) => {
    const seen = new Set(all<{ p: string }>(
      `SELECT COALESCE(belong, period) p FROM vouchers WHERE subject LIKE ?`, `%${kw}%`).map(r => r.p))
    if (seen.size < 2) return { seen: [] as string[], gaps: [] as string[] }
    const sorted = [...seen].sort()
    const toM = (p: string) => +p.slice(0, 4) * 12 + +p.slice(5, 7) - 1
    const fmt = (i: number) => `${String(Math.floor(i / 12)).padStart(4, '0')}-${String(i % 12 + 1).padStart(2, '0')}`
    const gaps: string[] = []
    for (let i = toM(sorted[0]!); i < toM(sorted.at(-1)!); i++)
      if (!seen.has(fmt(i + 1))) gaps.push(fmt(i + 1))
    return { seen: sorted, gaps }
  }
  const nopay = all<TodoItem>(
    `SELECT vno, date, summary, subject, amount FROM vouchers WHERE nopay=1 ORDER BY vno`)
  const first = get<{ p: string | null }>('SELECT MIN(period) p FROM vouchers')?.p ?? null
  // 待核项：备注里带「待核 / ⚠️ / 待确认」的凭证，列出凭证号便于跳转
  const review = all<TodoItem>(`
    SELECT vno, date, summary, subject, amount, note FROM vouchers
    WHERE note LIKE '%待核%' OR note LIKE '%待确认%' OR note LIKE '%⚠️%'
    ORDER BY vno`)
  const negAcc = all<{ name: string }>(`SELECT a.name FROM accounts a
    LEFT JOIN vouchers v ON v.acc_code=a.code GROUP BY a.code
    HAVING COALESCE(SUM(v.amount),0) < 0`).map(r => r.name)

  return { first, missingPay: missing('电费'), missingPark: missing('外部停车场'), nopay, review, negAcc }
}

/** 结构统计的时间区间（月粒度 YYYY-MM）；basis 决定按归属期还是实付日 */
export interface StructureOpts { from?: string; to?: string; basis?: 'belong' | 'date' }

function structureWhere(o: StructureOpts): { w: string; p: string[] } {
  const col = o.basis === 'date' ? 'substr(date,1,7)' : 'substr(COALESCE(belong,period),1,7)'
  const c: string[] = [], p: string[] = []
  if (o.from) { c.push(`${col} >= ?`); p.push(o.from) }
  if (o.to) { c.push(`${col} <= ?`); p.push(o.to) }
  return { w: c.length ? ' AND ' + c.join(' AND ') : '', p }
}

/** 支出结构：按统计标签聚合（原始 subject 不变） */
export function expenseStructure(o: StructureOpts = {}): { tag: string; total: number; n: number }[] {
  const { w, p } = structureWhere(o)
  return all<{ tag: string; total: number; n: number }>(`
    SELECT COALESCE(NULLIF(TRIM(tag),''), subject) AS tag, SUM(-amount) AS total, COUNT(*) AS n
    FROM vouchers WHERE amount<0${w} GROUP BY 1 ORDER BY total DESC`, ...p)
}

export function incomeStructure(o: StructureOpts = {}): { tag: string; total: number; n: number }[] {
  const { w, p } = structureWhere(o)
  return all<{ tag: string; total: number; n: number }>(`
    SELECT COALESCE(NULLIF(TRIM(tag),''), subject) AS tag, SUM(amount) AS total, COUNT(*) AS n
    FROM vouchers WHERE amount>0${w} GROUP BY 1 ORDER BY total DESC`, ...p)
}

/** 某标签在区间内的流水明细（供结构钻取） */
export function tagVouchers(tag: string, o: StructureOpts = {}): Voucher[] {
  const col = o.basis === 'date' ? 'substr(date,1,7)' : 'substr(COALESCE(belong,period),1,7)'
  const c: string[] = ["COALESCE(NULLIF(TRIM(tag),''), subject) = ?"]
  const p: string[] = [tag]
  if (o.from) { c.push(`${col} >= ?`); p.push(o.from) }
  if (o.to) { c.push(`${col} <= ?`); p.push(o.to) }
  const sql = `SELECT v.*, a.name AS acc_name,
      (SELECT GROUP_CONCAT(file, '|') FROM attachments WHERE vno = v.vno) AS files,
      (SELECT GROUP_CONCAT(kind, '|') FROM attachments WHERE vno = v.vno) AS kinds
    FROM vouchers v LEFT JOIN accounts a ON a.code = v.acc_code
    WHERE ${c.join(' AND ')} ORDER BY v.date, v.vno`
  return all<VoucherRow>(sql, ...p).map(shape)
}

/* ═══════════════ 写入 ═══════════════ */

/** 业务错误：带 HTTP 状态码，由 index.ts 统一转成响应 */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

export function insertVoucher(v: VoucherInput, attachments: Attachment[] = []): Voucher {
  const vno = v.vno || nextVno(v.period)
  if (get('SELECT 1 FROM vouchers WHERE vno=?', vno))
    throw new ApiError(409, `凭证号 ${vno} 已存在`)

  let amount = Math.abs(Number(v.amount))
  if (v.type === '支出') amount = -amount

  db.exec('BEGIN')
  try {
    db.prepare(`INSERT INTO vouchers
      (vno,date,period,belong,type,amount,subject,tag,acc_code,party,handler,summary,note,nopay)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      vno, v.date, v.period, v.belong || v.period, v.type, amount, v.subject,
      (v.tag ?? '').trim() || normalizeTag(v.subject, v.type),
      v.acc || 'wx', v.party || null, v.handler || '成(阿四)', v.summary,
      v.note || null,
      (v.nopay ? 1 : 0) || (String(v.note || '').includes('无支付凭证') ? 1 : 0))
    const ins = db.prepare(
      'INSERT INTO attachments (vno,file,kind,sha256) VALUES (?,?,?,?)')
    for (const a of attachments) ins.run(vno, a.file, a.kind || null, a.sha256 || null)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return getVoucher(vno)!
}

export function deleteVoucher(vno: string): { deleted: string } {
  db.prepare('DELETE FROM vouchers WHERE vno=?').run(vno)
  db.prepare('DELETE FROM attachments WHERE vno=?').run(vno)
  return { deleted: vno }
}

export function updateVoucher(vno: string, v: Partial<VoucherInput>): Voucher {
  const cur = getVoucher(vno)
  if (!cur) throw new ApiError(404, '凭证不存在')
  let amount = Math.abs(Number(v.amount ?? cur.amount))
  if ((v.type ?? cur.type) === '支出') amount = -amount
  const note = v.note ?? cur.note ?? ''
  const nopay = v.nopay === undefined
    ? (note.includes('无支付凭证') ? 1 : 0)
    : (v.nopay ? 1 : 0)
  const subject = v.subject ?? cur.subject
  const t = v.type ?? cur.type
  const tag = v.tag !== undefined
    ? (v.tag.trim() || normalizeTag(subject, t))
    : (cur.tag || normalizeTag(subject, t))
  db.prepare(`UPDATE vouchers SET date=?,type=?,amount=?,subject=?,tag=?,acc_code=?,
    party=?,handler=?,summary=?,note=?,nopay=? WHERE vno=?`).run(
    v.date ?? cur.date, t, amount, subject, tag,
    v.acc ?? cur.acc, v.party ?? cur.party, v.handler ?? cur.handler,
    v.summary ?? cur.summary, note, nopay, vno)
  return getVoucher(vno)!
}

export function setNopay(vno: string, nopay: boolean): Voucher {
  db.prepare('UPDATE vouchers SET nopay=? WHERE vno=?').run(nopay ? 1 : 0, vno)
  return getVoucher(vno)!
}

/* ── 凭证图片：入库 + 目录校验和 ── */

export function attachFile(vno: string, file: string, kind: string | null, sha256: string | null): unknown {
  db.prepare('INSERT INTO attachments (vno,file,kind,sha256) VALUES (?,?,?,?)')
    .run(vno, file, kind, sha256)
  return db.prepare('SELECT * FROM attachments WHERE vno=? AND file=?').get(vno, file)
}

/** 重算某凭证目录的 SHA256SUMS.txt（口径：`<hash>  <name>`） */
export function hashVoucherDir(vno: string): string[] | null {
  const dir = join(ROOT, '凭证', vno)
  if (!existsSync(dir)) return null
  const lines: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (name === 'SHA256SUMS.txt') continue
    const h = createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')
    lines.push(`${h}  ${name}`)
  }
  writeFileSync(join(dir, 'SHA256SUMS.txt'), lines.join('\n') + '\n')
  // 同步回 attachments 表的 sha256
  for (const l of lines) {
    const [h, name] = [l.slice(0, 64), l.slice(66)]
    db.prepare('UPDATE attachments SET sha256=? WHERE vno=? AND file=?')
      .run(h, vno, `凭证/${vno}/${name}`)
  }
  return lines
}

/** 全量校验凭证目录，返回有问题的列表 */
export function verifyAll(): { vno: string; error: string }[] {
  const base = join(ROOT, '凭证')
  if (!existsSync(base)) return []
  const bad: { vno: string; error: string }[] = []
  for (const vno of readdirSync(base).filter(x => x.startsWith('NF-'))) {
    const dir = join(base, vno)
    const sp = join(dir, 'SHA256SUMS.txt')
    if (!existsSync(sp)) { bad.push({ vno, error: '无 SHA256SUMS.txt' }); continue }
    const errs: string[] = []
    for (const ln of readFileSync(sp, 'utf8').split('\n').filter(Boolean)) {
      const want = ln.slice(0, 64).trim()
      const name = ln.slice(64).trim().replace(/^\*/, '')
      if (want.length !== 64 || !name) { errs.push(`<格式异常> ${ln}`); continue }
      const fp = join(dir, name)
      if (!existsSync(fp)) { errs.push(name); continue }
      const h = createHash('sha256').update(readFileSync(fp)).digest('hex')
      if (h !== want) errs.push(name)
    }
    if (errs.length) bad.push({ vno, error: errs.join(', ') })
  }
  return bad
}

/* ── 期初余额 / 业务解读 ── */

export function setOpening(code: string, opening: number): Account | undefined {
  db.prepare('UPDATE accounts SET opening=? WHERE code=?').run(opening, code)
  return accounts().find(a => a.code === code)
}

export interface Analysis {
  id: number
  vno: string | null
  topic: string | null
  body: string
  created_at: string
}

export function analyses(): Analysis[] {
  return all<Analysis>('SELECT * FROM analyses ORDER BY id')
}

export function addAnalysis(a: { vno?: string | null; topic?: string | null; body: string }): Analysis | undefined {
  db.prepare('INSERT INTO analyses (vno,topic,body) VALUES (?,?,?)')
    .run(a.vno || null, a.topic || null, a.body)
  return analyses().at(-1)
}

export function deleteAnalysis(id: number): { deleted: number } {
  db.prepare('DELETE FROM analyses WHERE id=?').run(id)
  return { deleted: id }
}

/* ═══════════════ 统计 ═══════════════ */

export interface Stats {
  vouchers: number
  attachments: number
  dbPath: string
}

export function stats(): Stats {
  const t = get<{ n: number }>('SELECT COUNT(*) n FROM vouchers')!.n
  const att = get<{ n: number }>('SELECT COUNT(*) n FROM attachments')!.n
  return { vouchers: t, attachments: att, dbPath: DB_PATH }
}
