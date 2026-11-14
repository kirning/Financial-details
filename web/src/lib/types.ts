/** 后端接口返回的数据类型 —— 与 server/db.js 的 shape 保持一致 */

export type VoucherType = '收入' | '支出'
export type AccCode = string

export interface Voucher {
  vno: string
  date: string
  period: string
  /** 归属期：跨月支付时为费用所属月，否则同 period */
  belong: string
  type: VoucherType
  amount: number
  subject: string
  /** 统计标签：结构表按此合并，独立于原始科目 */
  tag: string
  acc: AccCode
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

export interface Account {
  code: AccCode
  name: string
  full_name: string
  role: string | null
  holder: string | null
  opening: number
  sort_no: number
}

export interface AccountBalance {
  code: AccCode
  name: string
  full_name: string
  role: string | null
  opening: number
  inc: number
  exp: number
  n: number
}

export interface Monthly {
  period: string
  inc: number
  exp: number
  net: number
  n: number
}

/** 收支结构行：按标签聚合 */
export interface StructureRow {
  tag: string
  total: number
  n: number
}

/** 结构统计区间（月粒度 YYYY-MM） */
export interface StructureRange {
  from: string
  to: string
  basis: 'belong' | 'date'
}

export interface SeriesPoint {
  period: string
  total: number
  n: number
}

export interface Subject {
  subject: string
  n: number
  inc: number
  exp: number
  kind: '收入' | '支出' | '通用'
  variants: string[]
}

export interface TodoVoucher {
  vno: string
  date?: string
  summary: string
  subject?: string
  amount: number
  note?: string
}

export interface SeriesGaps {
  seen: string[]
  gaps: string[]
}

export interface Todos {
  first: string | null
  missingPay: SeriesGaps
  missingPark: SeriesGaps
  nopay: TodoVoucher[]
  review: TodoVoucher[]
  negAcc: string[]
}

export interface Summary {
  stats: { vouchers: number; attachments: number; dbPath: string }
  balances: { accounts: AccountBalance[]; total: { inc: number; exp: number; n: number } }
  monthly: Monthly[]
  expense: StructureRow[]
  income: StructureRow[]
  subjects: Subject[]
  series: { park: SeriesPoint[]; wage: SeriesPoint[]; elec: SeriesPoint[] }
  todos: Todos
  accounts: Account[]
  /** 服务端回显的当前统计区间 */
  range?: StructureRange
}

/** 记账表单（新增/编辑共用） */
export interface VoucherForm {
  date: string
  period: string
  type: VoucherType
  amount: number
  subject: string
  /** 留空表示由服务端按科目自动推断标签 */
  tag?: string
  acc: AccCode
  party: string
  handler: string
  summary: string
  note: string
  /** 编辑时带vno，新增时留空由服务端分配 */
  vno?: string
}

/** 待上传的凭证图片 */
export interface PendingFile {
  data: string      // dataURL
  name: string
}