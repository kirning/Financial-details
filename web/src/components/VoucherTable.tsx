import { useMemo } from 'react'
import type { Voucher, Account, AccCode } from '../lib/types'
import { money, signed } from '../lib/api'
import { Amount, SectionTitle, cls } from './ui'

export type SortKey = 'belong' | 'date' | 'vno' | 'summary' | 'acc' | 'party' | 'amount' | null
export type SortDir = 'asc' | 'desc'

export interface TableState {
  filterType: 'all' | '收入' | '支出'
  filterAcc: 'all' | AccCode
  query: string
  sortKey: SortKey
  sortDir: SortDir
}

const COLS: { key: SortKey; label: string; width: number; sortable: boolean; clsx?: string }[] = [
  { key: 'belong', label: '归属期', width: 78, sortable: true },
  { key: 'date', label: '日期', width: 88, sortable: true },
  { key: 'vno', label: '凭证号', width: 132, sortable: true },
  { key: 'summary', label: '摘要', width: 200, sortable: true },
  { key: 'acc', label: '账户', width: 104, sortable: true },
  { key: 'party', label: '对方/来源', width: 150, sortable: true },
  { key: 'amount', label: '金额', width: 96, sortable: true, clsx: 'num' },
  { key: null, label: '备注', width: 260, sortable: false },
  { key: null, label: '凭证', width: 88, sortable: false },
  { key: null, label: '', width: 66, sortable: false },
]

const DEFAULT_SORT: Record<NonNullable<SortKey>, SortDir> = {
  belong: 'desc', date: 'desc', vno: 'desc', summary: 'asc',
  acc: 'asc', party: 'asc', amount: 'desc',
}

function compare(a: Voucher, b: Voucher, key: NonNullable<SortKey>): number {
  switch (key) {
    case 'belong': return a.belong.localeCompare(b.belong) || a.vno.localeCompare(b.vno)
    case 'date': return a.date.localeCompare(b.date)
    case 'vno': return a.vno.localeCompare(b.vno)
    case 'summary': return a.summary.localeCompare(b.summary, 'zh')
    case 'acc': return a.acc.localeCompare(b.acc)
    case 'party': return (a.party ?? '').localeCompare(b.party ?? '', 'zh')
    case 'amount': return Math.abs(a.amount) - Math.abs(b.amount)
    default: return 0
  }
}

export function VoucherTable({ rows, accounts, state, onState, highlightVno, onEdit, onDelete, onView }: {
  rows: Voucher[]
  accounts: Account[]
  state: TableState
  onState: (s: TableState) => void
  highlightVno: string | null
  onEdit: (vno: string) => void
  onDelete: (vno: string) => void
  onView: (vno: string, i: number) => void
}) {
  const { filterType, filterAcc, query, sortKey, sortDir } = state

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(r =>
      (filterType === 'all' || r.type === filterType) &&
      (filterAcc === 'all' || r.acc === filterAcc) &&
      (!q || (r.subject + r.tag + r.summary + r.vno + (r.party ?? '') + (r.note ?? '')).toLowerCase().includes(q)))
  }, [rows, filterType, filterAcc, query])

  const sorted = useMemo(() => {
    const out = [...filtered]
    const cmp = (a: Voucher, b: Voucher) =>
      sortKey ? compare(a, b, sortKey) : b.belong.localeCompare(a.belong) || a.vno.localeCompare(b.vno)
    out.sort((a, b) => (sortDir === 'desc' ? -cmp(a, b) : cmp(a, b)))
    return out
  }, [filtered, sortKey, sortDir])

  const accName = (c: AccCode) => accounts.find(a => a.code === c)?.name ?? c
  const inc = filtered.reduce((s, r) => (r.amount > 0 ? s + r.amount : s), 0)
  const exp = filtered.reduce((s, r) => (r.amount < 0 ? s - r.amount : s), 0)
  const label = COLS.find(c => c.key === sortKey)?.label

  const setSort = (key: SortKey) => {
    if (!key) return
    const k = key as NonNullable<SortKey>
    onState({
      ...state,
      sortKey: k,
      sortDir: sortKey === k
        ? (sortDir === 'asc' ? 'desc' : 'asc')
        : DEFAULT_SORT[k],
    })
  }

  return (
    <>
      <SectionTitle>流水明细</SectionTitle>
      <div className="panel">
        {/* 筛选 */}
        <div className="flex gap-2 flex-wrap items-center mb-3.5">
          {([['all', '全部'], ['收入', '收入'], ['支出', '支出']] as const).map(([k, l]) => (
            <button key={k} className={cls('btn', filterType === k && '!bg-acc !border-acc !text-[#06121f] !font-semibold')}
              onClick={() => onState({ ...state, filterType: k, filterAcc: 'all' })}>{l}</button>
          ))}
          {accounts.filter(a => a.code !== 'icbc').map(a => (
            <button key={a.code} className={cls('btn', filterAcc === a.code && '!bg-acc !border-acc !text-[#06121f] !font-semibold')}
              onClick={() => onState({ ...state, filterAcc: filterAcc === a.code ? 'all' : a.code, filterType: 'all' })}>
              {a.name}
            </button>
          ))}
          <input className="inp !w-[190px]" value={query} placeholder="搜索科目 / 标签 / 对方 / 凭证号…"
                 onChange={e => onState({ ...state, query: e.target.value })} />
        </div>

        {/* 表格 */}
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] table-fixed min-w-[1180px]">
            <colgroup>
              {COLS.map((c, i) => <col key={i} style={{ width: c.width }} />)}
            </colgroup>
            <thead>
              <tr>
                {COLS.map(c => (
                  <th key={c.label} className={cls('th', c.clsx, c.sortable && 'th-sort',
                    sortKey === c.key && sortDir)} onClick={() => c.sortable && setSort(c.key)}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map(r => (
                <tr key={r.vno}
                    ref={el => { if (highlightVno === r.vno && el) { el.classList.add('!bg-acc/15'); setTimeout(() => el.classList.remove('!bg-acc/15'), 2200) } }}
                    className="hover:bg-[#1b222c]">
                  <td className="td mono text-fg-dim">{r.belong}</td>
                  <td className="td mono text-fg-dim">{r.date}</td>
                  <td className="td mono text-fg-dim">
                    {r.vno}{r.nopay && <span className="amt amt-warn ml-1">缺支付凭证</span>}
                  </td>
                  <td className="td">
                    {r.summary}
                    <span className="nt">{r.subject}</span>
                    {r.tag && r.tag !== r.subject &&
                      <span className="nt ml-1 text-acc">#{r.tag}</span>}
                  </td>
                  <td className="td"><span className="pill">{accName(r.acc)}</span></td>
                  <td className="td text-fg-dim text-xs">{r.party || '—'}</td>
                  <td className="td num"><Amount value={r.amount} /></td>
                  <td className="td"><span className="nt">{r.note || '—'}</span></td>
                  <td className="td">
                    {r.files.length
                      ? r.files.map((f, i) => (
                          <button key={f} className="block text-acc text-2xs hover:underline text-left"
                                  onClick={() => onView(r.vno, i)}>
                            {r.kinds[i] && r.kinds[i] !== '凭证' ? r.kinds[i] : `凭证图${r.files.length > 1 ? ' ' + (i + 1) : ''}`}
                          </button>
                        ))
                      : '—'}
                  </td>
                  <td className="td whitespace-nowrap">
                    <button className="btn-ghost" onClick={() => onEdit(r.vno)}>改</button>
                    <button className="btn-ghost" onClick={() => {
                      if (window.confirm(`确认删除 ${r.vno}？\n（凭证图片仍保留在磁盘，仅删除数据库记录）`)) onDelete(r.vno)
                    }}>删</button>
                  </td>
                </tr>
              ))}
              {!sorted.length && (
                <tr><td className="td text-fg-dim" colSpan={COLS.length}>没有符合条件的记录</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="note-text mt-2.5">
          显示 <b>{sorted.length}</b> / {rows.length} 笔　·　收入{' '}
          <b className="text-pos">{money(inc)}</b>　支出 <b className="text-neg">{money(exp)}</b>　净额{' '}
          <b className="text-acc">{signed(inc - exp)}</b>
          {label && <>　·　按<b>{label}</b>{sortDir === 'desc' ? '降序' : '升序'}排列</>}
        </div>
      </div>
    </>
  )
}