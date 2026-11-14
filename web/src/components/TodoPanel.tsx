import { SectionTitle } from './ui'
import type { Todos } from '../lib/types'
import { money } from '../lib/api'

/** 待办与缺口 —— 每条尽量关联到可点击的凭证号，便于快速定位 */
export function TodoPanel({ todos, onJump }: { todos: Todos; onJump: (vno: string) => void }) {
  const items: React.ReactNode[] = []

  items.push(
    <li key="base" className="todo-item">
      <b className="text-warn">基础</b>｜补录各账户期初余额或建账前流水 —— 否则余额不能对外
    </li>,
  )

  const gapItem = (label: string, s: Todos['missingPay']) => (
    <li key={label} className="todo-item">
      <b className="text-warn">缺凭证</b>｜{label}缺 <b className="text-warn">{s.gaps.join(' / ')}</b> 月
      （已录 {s.seen.join('/')}）
    </li>
  )
  if (todos.missingPay.gaps.length) items.push(gapItem('电费', todos.missingPay))
  if (todos.missingPark.gaps.length) items.push(gapItem('外部停车场收入', todos.missingPark))

  const VLink = ({ vno, children }: { vno: string; children?: React.ReactNode }) => (
    <button className="text-acc hover:underline mono text-xs" onClick={() => onJump(vno)}>
      {children ?? vno}
    </button>
  )

  if (todos.nopay.length) {
    items.push(
      <li key="nopay" className="todo-item">
        <b className="text-warn">缺支付凭证</b>｜仅纸质单据的 {todos.nopay.length} 笔：
        <br />
        {todos.nopay.map(v => (
          <div key={v.vno}>
            　<VLink vno={v.vno} />　{money(Math.abs(v.amount))} 元 · {v.summary}
          </div>
        ))}
      </li>,
    )
  }

  if (todos.review.length) {
    items.push(
      <li key="review" className="todo-item">
        <b className="text-warn">待核</b>｜以下凭证备注里有待确认事项：
        <br />
        {todos.review.map(v => (
          <div key={v.vno} className="mb-1">
            　<VLink vno={v.vno} />　{v.summary}
            <div className="text-fg-dim2 text-2xs pl-4">
              {(v.note ?? '').slice(0, 90)}{(v.note ?? '').length > 90 ? '…' : ''}
            </div>
          </div>
        ))}
      </li>,
    )
  }

  // 固定项：若已在 review 里列出则不再重复给链接
  const hasReview = todos.review.length > 0
  items.push(
    <li key="t1" className="todo-item">
      <b className="text-warn">待核</b>｜充电柱电费收入的付款方与归属月份　
      {!hasReview && <VLink vno="NF-2026-10-001" />}
    </li>,
    <li key="t2" className="todo-item">
      <b className="text-warn">待核</b>｜电费用电主体与表号，是否与充电柱电费同一业务（需对冲）　
      {!hasReview && <VLink vno="NF-2026-10-002" />}
    </li>,
  )

  return (
    <>
      <SectionTitle>待办与缺口</SectionTitle>
      <div className="panel"><ul className="list-none">{items}</ul></div>
    </>
  )
}