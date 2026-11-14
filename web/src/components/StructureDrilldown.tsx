/** 收支结构：时间区间控件 + 两级钻取（标签明细 → 单笔明细） */

import { useEffect, useState } from 'react'
import type { StructureRange, Voucher } from '../lib/types'
import { api, money } from '../lib/api'
import { Modal, cls } from './ui'

/** 区间选择：月粒度，默认今年 01—12；口径可切归属期 / 实付日 */
export function StructureRangeBar({ range, onChange }: {
  range: StructureRange
  onChange: (r: StructureRange) => void
}) {
  const year = new Date().getFullYear()
  const set = (patch: Partial<StructureRange>) => {
    const next = { ...range, ...patch }
    // 起止倒置时自动把另一端拉齐
    if (next.from && next.to && next.from > next.to) {
      if ('from' in patch) next.to = next.from
      else next.from = next.to
    }
    onChange(next)
  }
  const isThisYear = range.from === `${year}-01` && range.to === `${year}-12`

  return (
    <div className="panel mb-3 flex flex-wrap items-center gap-2.5 text-[13px]">
      <span className="text-fg-dim text-xs font-medium">统计区间</span>
      <input type="month" className="inp !w-[145px]" value={range.from}
             aria-label="起始月份" onChange={e => set({ from: e.target.value })} />
      <span className="text-fg-dim">至</span>
      <input type="month" className="inp !w-[145px]" value={range.to}
             aria-label="结束月份" onChange={e => set({ to: e.target.value })} />
      <button className={cls('btn', isThisYear && '!bg-acc !border-acc !text-[#06121f] !font-semibold')}
              onClick={() => onChange({ ...range, from: `${year}-01`, to: `${year}-12` })}>今年</button>
      <button className="btn" onClick={() => onChange({ ...range, from: '', to: '' })}>全部</button>

      <span className="mx-1 w-px h-4 bg-ink-600" />
      <span className="text-fg-dim text-xs">时间口径</span>
      <select className="inp !w-[168px]" value={range.basis}
              onChange={e => set({ basis: e.target.value as StructureRange['basis'] })}>
        <option value="belong">归属期（费用所属月）</option>
        <option value="date">实付日（钱进出那天）</option>
      </select>

      <span className="text-fg-dim2 text-2xs ml-auto">
        点击标签看合并明细 · 再点单笔看详情
      </span>
    </div>
  )
}

/** 一级：某标签下合并的流水表格 */
export function TagVouchersModal({ tag, range, onClose, onPick, onViewFile }: {
  tag: string | null
  range: StructureRange
  onClose: () => void
  onPick: (v: Voucher) => void
  onViewFile: (vno: string, i: number) => void
}) {
  const [rows, setRows] = useState<Voucher[]>([])
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!tag) { setRows([]); return }
    let alive = true
    setLoading(true); setErr('')
    api.structureVouchers(tag, range)
      .then(r => { if (alive) setRows(r) })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : '加载失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [tag, range.from, range.to, range.basis])

  if (!tag) return null
  const total = rows.reduce((s, r) => s + Math.abs(r.amount), 0)

  return (
    <Modal open wide onClose={onClose}
      title={
        <span className="flex items-baseline gap-2 min-w-0">
          <b className="shrink-0">{tag}</b>
          <span className="text-fg-dim font-normal text-[13px] truncate">
            {rows.length} 笔合并 · 合计 ¥{money(total)} · {range.from || '起'} ~ {range.to || '今'}
          </span>
        </span>
      }>
      {err && <div className="text-neg text-xs mb-3">加载失败：{err}</div>}
      {loading && <div className="text-fg-dim text-xs py-6 text-center">正在加载明细…</div>}
      {!loading && !err && (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px] min-w-[900px]">
            <thead>
              <tr className="th">
                <th>归属期</th><th>日期</th><th>凭证号</th><th>摘要 / 科目</th>
                <th>账户</th><th>对方 / 来源</th><th className="num">金额</th><th>凭证</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.vno} className="cursor-pointer hover:bg-[#1b222c]"
                    onClick={() => onPick(r)} title="点击查看单笔明细">
                  <td className="td mono text-fg-dim">{r.belong}</td>
                  <td className="td mono text-fg-dim">{r.date}</td>
                  <td className="td mono text-fg-dim">
                    {r.vno}{r.nopay && <span className="amt amt-warn ml-1">缺支付凭证</span>}
                  </td>
                  <td className="td">
                    {r.summary}<span className="nt">{r.subject}</span>
                  </td>
                  <td className="td"><span className="pill">{r.accName}</span></td>
                  <td className="td text-fg-dim text-xs">{r.party || '—'}</td>
                  <td className="td num text-neg">{money(Math.abs(r.amount))}</td>
                  <td className="td">
                    {r.files.length
                      ? r.files.map((f, i) => (
                          <button key={f} className="block text-acc text-2xs hover:underline text-left"
                                  onClick={e => { e.stopPropagation(); onViewFile(r.vno, i) }}>
                            {r.kinds[i] && r.kinds[i] !== '凭证' ? r.kinds[i] : `凭证图 ${i + 1}`}
                          </button>
                        ))
                      : '—'}
                  </td>
                </tr>
              ))}
              {!rows.length && <tr><td className="td text-fg-dim" colSpan={8}>该区间内没有此标签的流水</td></tr>}
              {rows.length > 0 && (
                <tr className="border-t border-ink-600">
                  <td className="td text-fg-dim text-xs font-medium" colSpan={6}>合计 {rows.length} 笔</td>
                  <td className="td num text-neg font-medium">{money(total)}</td>
                  <td className="td" />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <div className="note-text mt-2.5">
        科目保留入账时的原始写法，统计时按<b>标签</b>合并；时间口径为
        <b>{range.basis === 'date' ? '实付日' : '归属期（费用所属月）'}</b>。
      </div>
    </Modal>
  )
}

/** 二级：单笔交易的完整明细 */
export function VoucherDetailModal({ voucher, onClose, onViewFile }: {
  voucher: Voucher | null
  onClose: () => void
  onViewFile: (vno: string, i: number) => void
}) {
  if (!voucher) return null
  const v = voucher
  const fields: [string, string][] = [
    ['凭证号', v.vno], ['类型', v.type], ['金额', `¥${money(Math.abs(v.amount))}`],
    ['发生 / 实付日', v.date], ['归属期（费用所属月）', v.belong], ['凭证号所属期', v.period],
    ['科目（原始）', v.subject], ['统计标签', v.tag || '—'],
    ['账户', v.accName], ['账户全称', v.accFull || '—'],
    ['对方 / 来源', v.party || '—'], ['经手人', v.handler || '—'],
    ['摘要 = 事由', v.summary], ['凭证图', `${v.files.length} 张${v.nopay ? '（缺支付凭证）' : ''}`],
  ]

  return (
    <Modal open onClose={onClose} title={`${v.vno} · 单笔交易明细`}>
      <table className="w-full text-[13px]">
        <tbody>
          {fields.map(([k, val]) => (
            <tr key={k} className="border-b border-ink-600/60 last:border-0">
              <td className="td text-fg-dim text-xs w-[150px] align-top">{k}</td>
              <td className={cls('td', k === '金额' && 'text-neg num font-medium',
                                k === '统计标签' && 'text-acc')}>{val}</td>
            </tr>
          ))}
          <tr>
            <td className="td text-fg-dim text-xs align-top">备注</td>
            <td className="td text-xs leading-relaxed whitespace-pre-wrap break-words">{v.note || '—'}</td>
          </tr>
        </tbody>
      </table>

      {v.files.length > 0 && (
        <div className="mt-3.5">
          <div className="text-fg-dim text-xs mb-1.5">凭证图片（点击查看大图）</div>
          <div className="flex flex-wrap gap-2">
            {v.files.map((f, i) => (
              <button key={f} className="btn text-2xs" onClick={() => onViewFile(v.vno, i)}>
                {v.kinds[i] && v.kinds[i] !== '凭证' ? v.kinds[i] : `凭证图 ${i + 1}`}
              </button>
            ))}
          </div>
          <div className="text-fg-dim2 text-2xs mt-1.5 mono break-all">
            {v.files.map(f => f.split('/').pop()).join(' · ')}
          </div>
        </div>
      )}
      <div className="note-text mt-3">
        本页数据来自流水明细；<b>标签</b>用于结构统计合并，不影响原始科目与金额。
      </div>
    </Modal>
  )
}
