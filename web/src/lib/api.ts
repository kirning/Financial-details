import type { Summary, Voucher, VoucherForm, AccCode, VoucherType, StructureRange } from './types'

const BASE = '/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }
  return (json as { data: T })?.data ?? (json as T)
}

/** 凭证图片 URL（中文路径需逐段编码） */
export const fileUrl = (file: string): string =>
  '/' + file.split('/').map(encodeURIComponent).join('/')

const rangeQuery = (r: StructureRange): string =>
  `from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}&basis=${r.basis}`

export const api = {
  summary: (range?: StructureRange) =>
    request<Summary>('/summary' + (range ? `?${rangeQuery(range)}` : '')),
  vouchers: () => request<Voucher[]>('/vouchers'),
  subjects: () => request<Summary['subjects']>('/subjects'),

  /** 结构钻取：某标签在区间内的流水明细 */
  structureVouchers: (tag: string, range: StructureRange) =>
    request<Voucher[]>(`/structure/vouchers?tag=${encodeURIComponent(tag)}&${rangeQuery(range)}`),

  create: (f: VoucherForm) =>
    request<Voucher>('/vouchers', { method: 'POST', body: JSON.stringify(f) }),

  update: (vno: string, f: Partial<VoucherForm>) =>
    request<Voucher>(`/vouchers/${vno}`, { method: 'PATCH', body: JSON.stringify(f) }),

  remove: (vno: string) => request<{ deleted: string }>(`/vouchers/${vno}`, { method: 'DELETE' }),

  upload: (vno: string, base64: string, filename: string, kind?: string) =>
    request<Voucher>(`/vouchers/${vno}/attachments`, {
      method: 'POST',
      body: JSON.stringify({ base64, filename, kind }),
    }),
}

/* ── 展示辅助 ── */

export const money = (n: number | null | undefined): string =>
  (n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export const signed = (n: number): string => (n > 0 ? '+' : '') + money(n)

/** 按业务归属期推算下一个凭证号（仅用于表单预览，保存以服务端分配为准） */
export function previewVno(rows: Voucher[], period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return '—'
  const n = rows.filter(r => r.vno.startsWith(`NF-${period}-`)).length + 1
  return `NF-${period}-${String(n).padStart(3, '0')}`
}

/** 科目下拉建议：按当前类型过滤 */
export function suggestSubjects(subjects: Summary['subjects'], type: VoucherType): string[] {
  const want = type === '收入'
    ? subjects.filter(s => s.kind !== '支出')
    : subjects.filter(s => s.kind !== '收入')
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of want) {
    if (seen.has(s.subject)) continue
    seen.add(s.subject)
    out.push(s.subject)
  }
  return out
}

export const todayStr = (): string => new Date().toISOString().slice(0, 10)
export const monthOf = (date: string): string => date.slice(0, 7)
export const defaultAcc = (accounts: { code: AccCode }[]): AccCode => accounts[0]?.code ?? 'wx'