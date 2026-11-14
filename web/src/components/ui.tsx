/** 通用 UI 原子组件 */

import type { ReactNode, ButtonHTMLAttributes } from 'react'

export const cls = (...xs: (string | false | null | undefined)[]): string =>
  xs.filter(Boolean).join(' ')

/* ── 卡片 ── */
export function StatCard({ label, value, tone = '', hint }: {
  label: string; value: string; tone?: 'text-pos' | 'text-neg' | 'text-acc' | ''; hint?: string
}) {
  return (
    <div className="card">
      <div className="text-fg-dim text-xs mb-1.5">{label}</div>
      <div className={cls('text-[22px] font-semibold tabular-nums tracking-tight', tone)}>{value}</div>
      {hint && <div className="text-fg-dim2 text-2xs mt-1">{hint}</div>}
    </div>
  )
}

/* ── 章节标题 ── */
export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="section-title">{children}</h2>
}

/* ── 金额 ── */
export function Amount({ value, signed: showSign = true }: { value: number; signed?: boolean }) {
  const s = (n: number) => (n > 0 ? '+' : '') + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (
    <span className={cls('amt', value > 0 ? 'amt-in' : 'amt-out')}>
      {showSign ? s(value) : Math.abs(value).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </span>
  )
}

/* ── 提示条 ── */
export function Toast({ msg, kind }: { msg: string; kind: 'info' | 'error' | null }) {
  if (!msg) return null
  return (
    <div className={cls(
      'fixed right-5 bottom-5 px-4 py-2.5 rounded-lg text-sm shadow-lg z-[99]',
      kind === 'error' ? 'bg-ink-800 border border-neg text-neg'
                      : 'bg-ink-700 border border-ink-600 text-fg',
    )}>{msg}</div>
  )
}

/* ── 空态 ── */
export function Empty({ text = '无数据' }: { text?: string }) {
  return <td className="td text-fg-dim" colSpan={99}>{text}</td>
}

/* ── 弹窗容器 ── */
export function Modal({ open, onClose, title, children, footer, wide = false }: {
  open: boolean; onClose: () => void; title: ReactNode
  children: ReactNode; footer?: ReactNode; wide?: boolean
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 bg-black/60"
         onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={cls(
        'bg-ink-800 text-fg border border-ink-600 rounded-xl shadow-2xl my-8',
        wide ? 'max-w-[min(1180px,94vw)] w-[94vw]' : 'max-w-[520px] w-[92vw]',
      )}>
        <div className="px-5 py-4 border-b border-ink-600 font-semibold flex justify-between items-center gap-3">
          <span className="truncate">{title}</span>
          <button className="btn shrink-0" onClick={onClose}>关闭 ✕</button>
        </div>
        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <div className="px-5 py-3.5 border-t border-ink-600 flex gap-2.5 justify-end">{footer}</div>}
      </div>
    </div>
  )
}

/* ── 确认按钮 ── */
export function ConfirmBtn({ onConfirm, children, title = '确认' }: ButtonHTMLAttributes<HTMLButtonElement> & { onConfirm: () => void; children: ReactNode }) {
  return (
    <button className="btn-ghost" title={title}
      onClick={e => { e.stopPropagation(); if (window.confirm('确认删除？凭证图片仍保留在磁盘。')) onConfirm() }}>
      {children}
    </button>
  )
}