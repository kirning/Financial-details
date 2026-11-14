import { useMemo, useState } from 'react'
import { Segmented } from 'antd'
import type { Monthly } from '../lib/types'
import { money, signed } from '../lib/api'
import { SectionTitle } from './ui'
import { EChart } from './EChart'

/** 月度收支趋势（ECharts：柱状对比 / 净额折线，视图用 antd Segmented 切换）
 *  后续新增统计图表一律复用 EChart 组件，不要再造纯 CSS 图。 */
type ChartMode = '收支对比' | '净额趋势'

export function MonthlyChart({ data }: { data: Monthly[] }) {
  const [mode, setMode] = useState<ChartMode>('收支对比')

  const option = useMemo(() => {
    const months = data.map(m => m.period.slice(2))
    const tooltip = {
      trigger: 'axis' as const,
      axisPointer: { type: 'shadow' as const },
      formatter: (params: unknown) => {
        const arr = params as { dataIndex: number }[]
        const m = arr?.length ? data[arr[0].dataIndex] : undefined
        if (!m) return ''
        return `${m.period}<br/>收入 ¥${money(m.inc)}<br/>支出 ¥${money(m.exp)}<br/>净额 ${signed(m.net)}`
      },
    }
    const axis = {
      xAxis: { type: 'category' as const, data: months, boundaryGap: mode === '收支对比' },
      yAxis: {
        type: 'value' as const,
        axisLabel: { formatter: (v: number) => v.toLocaleString('zh-CN') },
      },
    }

    if (mode === '净额趋势') {
      return {
        tooltip,
        grid: { left: 62, right: 18, top: 18, bottom: 30 },
        ...axis,
        series: [{
          name: '净额', type: 'line' as const, smooth: true, symbolSize: 7,
          data: data.map(m => m.net),
          lineStyle: { color: '#58a6ff', width: 2 },
          itemStyle: { color: '#58a6ff' },
          areaStyle: { color: 'rgba(88,166,255,0.12)' },
          markLine: {
            silent: true, symbol: 'none',
            data: [{ yAxis: 0 }],
            lineStyle: { color: '#6b7885', type: 'dashed' as const },
          },
        }],
      }
    }

    return {
      tooltip,
      legend: { data: ['收入', '支出'], right: 8, top: 0, itemWidth: 10, itemHeight: 10 },
      grid: { left: 62, right: 18, top: 30, bottom: 30 },
      ...axis,
      series: [
        {
          name: '收入', type: 'bar' as const, data: data.map(m => m.inc), barMaxWidth: 26,
          itemStyle: { color: '#3fb950', borderRadius: [3, 3, 0, 0] },
        },
        {
          name: '支出', type: 'bar' as const, data: data.map(m => m.exp), barMaxWidth: 26,
          itemStyle: { color: '#f85149', borderRadius: [3, 3, 0, 0] },
        },
      ],
    }
  }, [data, mode])

  return (
    <>
      <SectionTitle>月度收支趋势</SectionTitle>
      <div className="panel">
        <div className="flex justify-between items-center gap-3 flex-wrap mb-2">
          <span className="text-fg-dim2 text-2xs">按业务归属期归月（跨月支付归入费用所属月）</span>
          <Segmented size="small" value={mode} options={['收支对比', '净额趋势']}
                     onChange={v => setMode(v as ChartMode)} />
        </div>
        {data.length
          ? <EChart option={option} height={230} />
          : <div className="text-center text-fg-dim text-sm py-8">暂无数据</div>}
      </div>
    </>
  )
}

/** 账户余额表 */
export function AccountPanel({ balances }: {
  balances: {
    accounts: import('../lib/types').AccountBalance[]
    total: { inc: number; exp: number; n: number }
  }
}) {
  const [showRole, setShowRole] = useState(true)
  const { accounts, total } = balances
  return (
    <div className="panel">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="th">
            <th>
              账户
              <button className="ml-1 text-2xs text-fg-dim2 hover:text-fg" onClick={() => setShowRole(v => !v)}
                      title="显示/隐藏账户用途">{showRole ? '▾' : '▸'}</button>
            </th>
            <th className="num">收入</th><th className="num">支出</th><th className="num">净额</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map(a => (
            <tr key={a.code}>
              <td className="td">
                <b>{a.name}</b>
                {showRole && a.role && <><br /><span className="mono text-fg-dim text-2xs">{a.role}</span></>}
              </td>
              <td className="td num text-pos">{money(a.inc)}</td>
              <td className="td num text-neg">{money(a.exp)}</td>
              <td className={a.inc - a.exp >= 0 ? 'td num text-acc' : 'td num text-neg'}>{signed(a.inc - a.exp)}</td>
            </tr>
          ))}
          <tr>
            <td className="td text-fg-dim text-xs font-medium">合计</td>
            <td className="td num text-pos font-medium">{money(total.inc)}</td>
            <td className="td num text-neg font-medium">{money(total.exp)}</td>
            <td className="td num text-acc font-medium">{signed(total.inc - total.exp)}</td>
          </tr>
        </tbody>
      </table>
      <div className="note-text mt-2.5">
        均登记在<b>成（阿四）个人名下</b>，系代管小区资金，无独立对公账户。
      </div>
    </div>
  )
}

/** 稳定序列面板 */
const SERIES_META: { key: 'park' | 'wage' | 'elec'; label: string; desc: string }[] = [
  { key: 'park', label: '外部停车场收入', desc: '每月上旬到账、从未断月 —— 小区最稳定的现金流' },
  { key: 'wage', label: '保洁员工资', desc: '固定月工资，每月最后一天付给「幸福一生」' },
  { key: 'elec', label: '小区电费', desc: '每月次月 5-10 日支付，金额随季节波动' },
]

export function SeriesPanel({ series }: {
  series: Record<'park' | 'wage' | 'elec', import('../lib/types').SeriesPoint[]>
}) {
  return (
    <div className="panel">
      <table className="w-full text-[13px]">
        <thead><tr className="th"><th>稳定序列</th><th className="num">金额区间</th></tr></thead>
        <tbody>
          {SERIES_META.map(({ key, label }) => {
            const s = series[key] ?? []
            const vals = s.map(x => x.total)
            const range = vals.length
              ? `${Math.min(...vals).toLocaleString()}～${Math.max(...vals).toLocaleString()}`
              : '—'
            return (
              <tr key={key}>
                <td className="td">
                  <b>{label}</b><br />
                  <span className="mono text-fg-dim text-2xs">
                    {s.length} 个月：{s.map(x => x.period.slice(5)).join('/')}
                  </span>
                </td>
                <td className="td num mono">{range}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="note-text mt-2.5">
        {SERIES_META.map(({ label, desc }) => <div key={label}><b>{label}</b>：{desc}</div>)}
      </div>
    </div>
  )
}

/** 收支结构表（按标签聚合，可点击钻取） */
export function StructurePanel({ title, rows, color, onPick, rangeLabel }: {
  title: string
  rows: import('../lib/types').StructureRow[]
  color: 'text-neg' | 'text-pos'
  onPick?: (tag: string) => void
  rangeLabel?: string
}) {
  const sorted = useMemo(() => [...rows].sort((a, b) => b.total - a.total), [rows])
  // 占比以「当前区间内」的合计为分母，而不是全账累计
  const total = sorted.reduce((s, r) => s + r.total, 0)
  return (
    <div className="panel">
      <div className="text-fg-dim text-xs mb-2 flex justify-between items-baseline gap-2">
        <span>{title} <span className="text-fg-dim2">（按标签合并）</span></span>
        {rangeLabel && <span className="text-fg-dim2 text-2xs">{rangeLabel}</span>}
      </div>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="th">
            <th>标签</th><th className="num">金额</th><th className="num">{color === 'text-neg' ? '占比' : '笔数'}</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(r => (
            <tr key={r.tag}
                className={onPick ? 'cursor-pointer hover:bg-[#1b222c]' : ''}
                onClick={() => onPick?.(r.tag)}
                title={onPick ? `查看「${r.tag}」的 ${r.n} 笔合并明细` : undefined}>
              <td className="td">
                {r.tag}{onPick && <span className="ml-1.5 text-acc text-2xs">↗</span>}
              </td>
              <td className={`td num ${color}`}>{money(r.total)}</td>
              <td className="td num">{color === 'text-neg' ? (total ? (r.total / total * 100).toFixed(1) : '0') + '%' : r.n}</td>
            </tr>
          ))}
          {!sorted.length && <tr><td className="td text-fg-dim" colSpan={3}>该区间内无数据</td></tr>}
          {color === 'text-neg' && (
            <tr>
              <td className="td text-fg-dim text-xs font-medium">合计</td>
              <td className={`td num ${color} font-medium`}>{money(total)}</td>
              <td className="td">100%</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}