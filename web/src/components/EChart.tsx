/** 通用 ECharts 容器 —— 后续所有统计图表统一从这里进
 *
 *  - 按需注册图表/组件，避免把整个 echarts 打进包
 *  - 统一注册暗色主题 nanfeng-dark，配色对齐 tailwind.config.js
 *  - 自动 resize + dispose，支持点击事件（可用于图表钻取）
 *  新增图表类型时，在下方 echarts.use([...]) 里追加即可。
 */

import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts'
import {
  GridComponent, TooltipComponent, LegendComponent, TitleComponent,
  DataZoomComponent, MarkLineComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart,
  GridComponent, TooltipComponent, LegendComponent, TitleComponent,
  DataZoomComponent, MarkLineComponent,
  CanvasRenderer,
])

const THEME = 'nanfeng-dark'

echarts.registerTheme(THEME, {
  backgroundColor: 'transparent',
  color: ['#58a6ff', '#3fb950', '#f85149', '#d29922', '#8b98a5', '#a371f7'],
  textStyle: {
    color: '#e6edf3',
    fontFamily: '-apple-system, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif',
  },
  title: { textStyle: { color: '#e6edf3' } },
  legend: { textStyle: { color: '#8b98a5' } },
  tooltip: {
    backgroundColor: '#1e2530',
    borderColor: '#2a3441',
    borderWidth: 1,
    textStyle: { color: '#e6edf3', fontSize: 12 },
    axisPointer: { lineStyle: { color: '#58a6ff' }, crossStyle: { color: '#58a6ff' } },
  },
  grid: { borderColor: '#2a3441' },
  categoryAxis: {
    axisLine: { show: true, lineStyle: { color: '#2a3441' } },
    axisTick: { show: false },
    axisLabel: { color: '#8b98a5', fontSize: 11 },
    splitLine: { show: false },
  },
  valueAxis: {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: { color: '#8b98a5', fontSize: 11 },
    splitLine: { show: true, lineStyle: { color: '#202833', type: 'dashed' } },
  },
})

type ChartInstance = ReturnType<typeof echarts.init>

export function EChart({ option, height = 260, className = '', onClick }: {
  option: EChartsCoreOption
  height?: number
  className?: string
  /** 点击图元时回调，可用于「图表 → 明细」钻取 */
  onClick?: (params: unknown) => void
}) {
  const el = useRef<HTMLDivElement>(null)
  const inst = useRef<ChartInstance | null>(null)

  useEffect(() => {
    if (!el.current) return
    const c = echarts.init(el.current, THEME, { renderer: 'canvas' })
    inst.current = c
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(el.current)
    return () => {
      ro.disconnect()
      c.dispose()
      inst.current = null
    }
  }, [])

  useEffect(() => {
    inst.current?.setOption(option, true)
  }, [option])

  useEffect(() => {
    const c = inst.current
    if (!c || !onClick) return
    c.on('click', onClick)
    return () => { c.off('click', onClick) }
  }, [onClick])

  return <div ref={el} className={className} style={{ width: '100%', height }} />
}
