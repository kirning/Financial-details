import { useCallback, useEffect, useState } from 'react'
import { Button } from 'antd'
import { api, money } from './lib/api'
import type { Summary, Voucher, VoucherForm, PendingFile, StructureRange } from './lib/types'
import { StatCard, Toast, SectionTitle } from './components/ui'
import { MonthlyChart, AccountPanel, SeriesPanel, StructurePanel } from './components/Panels'
import { VoucherTable, type TableState } from './components/VoucherTable'
import { VoucherViewer } from './components/VoucherViewer'
import { VoucherFormModal } from './components/VoucherForm'
import { TodoPanel } from './components/TodoPanel'
import { StructureRangeBar, TagVouchersModal, VoucherDetailModal } from './components/StructureDrilldown'

export default function App() {
  const [sum, setSum] = useState<Summary | null>(null)
  const [rows, setRows] = useState<Voucher[]>([])
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ msg: string; kind: 'info' | 'error' } | null>(null)

  const [table, setTable] = useState<TableState>({
    filterType: 'all', filterAcc: 'all', query: '', sortKey: null, sortDir: 'desc',
  })
  const [highlight, setHighlight] = useState<string | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Voucher | null>(null)
  const [viewer, setViewer] = useState<{ vno: string; i: number } | null>(null)

  /** 收支结构统计区间：默认今年年初到年末，粒度为月 */
  const [range, setRange] = useState<StructureRange>(() => {
    const y = new Date().getFullYear()
    return { from: `${y}-01`, to: `${y}-12`, basis: 'belong' }
  })
  /** 两级钻取：tag → 合并明细表 → 单笔详情 */
  const [drill, setDrill] = useState<{ tag: string; detail: Voucher | null } | null>(null)

  const say = useCallback((msg: string, kind: 'info' | 'error' = 'info') => {
    setToast({ msg, kind })
    setTimeout(() => setToast(null), 2600)
  }, [])

  const reload = useCallback(async (r: StructureRange) => {
    try {
      const [s, v] = await Promise.all([api.summary(r), api.vouchers()])
      setSum(s); setRows(v); setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    }
  }, [])

  useEffect(() => { void reload(range) }, [range, reload])

  /* 从待办跳转到具体凭证 */
  const jumpTo = useCallback((vno: string) => {
    const target = rows.find(r => r.vno === vno)
    setTable(t => ({ ...t, filterType: 'all', filterAcc: 'all', query: '' }))
    setHighlight(vno)
    setTimeout(() => {
      document.querySelector('tr.bg-acc\\/15')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }, 60)
    setTimeout(() => setHighlight(null), 2200)
    if (target && target.files.length) setViewer({ vno, i: 0 })
    else openEdit(vno)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const openEdit = useCallback((vno: string) => {
    setEditing(rows.find(r => r.vno === vno) ?? null)
    setFormOpen(true)
  }, [rows])

  const submit = async (form: VoucherForm, pending: PendingFile[], kind: string) => {
    let vno: string
    if (editing) {
      await api.update(editing.vno, form)
      vno = editing.vno
      say(`已更新 ${vno}`)
    } else {
      const r = await api.create(form)
      vno = r.vno
      say(`已记入 ${vno}`)
    }
    if (pending.length) {
      let ok = 0
      for (const p of pending) {
        try { await api.upload(vno, p.data, p.name, kind || undefined); ok++ }
        catch { /* 单张失败不阻断 */ }
      }
      say(`已上传 ${ok}/${pending.length} 张凭证图`)
    }
    await reload(range)
  }

  const del = async (vno: string) => {
    try { await api.remove(vno); say(`已删除 ${vno}`); await reload(range) }
    catch (e) { say(e instanceof Error ? e.message : '删除失败', 'error') }
  }

  if (error) {
    return (
      <div className="max-w-[1320px] mx-auto text-center py-16">
        <div className="text-neg mb-3">加载失败：{error}</div>
        <div className="text-fg-dim text-xs">
          请先启动后端：<code className="mono">cd 南丰村财务/server && npm start</code>
        </div>
      </div>
    )
  }

  if (!sum) {
    return <div className="max-w-[1320px] mx-auto text-center py-16 text-fg-dim">正在从服务器加载账本数据…</div>
  }

  const { balances, monthly, expense, income, subjects, series, todos, stats, accounts } = sum
  const viewerVoucher = viewer ? rows.find(r => r.vno === viewer.vno) ?? null : null
  const parkAvg = series.park.length
    ? series.park.reduce((s, x) => s + x.total, 0) / series.park.length : 0

  return (
    <>
      {/* 页头 */}
      <header className="flex justify-between items-end flex-wrap gap-3 pb-4 mb-5 border-b border-ink-600">
        <div>
          <h1 className="text-[22px] font-semibold tracking-wide">南丰村财务账本</h1>
          <div className="text-fg-dim text-[13px] mt-1.5">
            南丰村（＝南丰小区）· 小区自治账 · 记账币种 CNY
            <span className="chip">出纳：成（阿四）</span>
            <span className="chip">{stats.vouchers} 笔凭证 · {stats.attachments} 张凭证图</span>
            <span className="chip">SQLite</span>
          </div>
        </div>
        <Button type="primary" size="small" onClick={() => { setEditing(null); setFormOpen(true) }}>
          + 记一笔
        </Button>
      </header>

      {/* 概览 */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-3">
        <StatCard label="实收累计" value={'¥' + money(balances.total.inc)} tone="text-pos" hint="按账户流水累计" />
        <StatCard label="支出累计" value={'¥' + money(balances.total.exp)} tone="text-neg" hint="按账户流水累计" />
        <StatCard label="净流入" value={money(balances.total.inc - balances.total.exp)} tone="text-acc" hint="已记录流水净额" />
        <StatCard label="月均外停费收入" value={'≈' + money(parkAvg)} hint={`${series.park.length} 个月均值`} />
      </div>

      {/* 余额说明 */}
      <div className="card mt-3 text-xs text-fg-dim leading-relaxed">
        ⚠️ <b>余额说明</b>：以上为「已记录流水」净额，<b>非真实账户余额</b>。
        账本自 {todos.first ?? '—'} 起算，各账户期初余额未录入，<b>不可直接对外引用</b>。
        {todos.negAcc.length > 0 && (
          <> 注：<b className="text-warn">{todos.negAcc.join('、')}</b> 净额为负，
               因该账户在此之前的流水未录入，<b>不代表实际透支</b>。</>
        )}
        <br />各账户均在<b>成（阿四）个人名下</b>，系代管小区资金。
        外部停车场收入全部走农行 6316，微信零钱只收内部停车费与零星补缴。
      </div>

      <MonthlyChart data={monthly} />

      <SectionTitle>账户与稳定序列</SectionTitle>
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <AccountPanel balances={balances} />
        <SeriesPanel series={series} />
      </div>

      <SectionTitle>收支结构</SectionTitle>
      <StructureRangeBar range={range} onChange={setRange} />
      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        <StructurePanel title="支出结构" rows={expense} color="text-neg"
          onPick={tag => setDrill({ tag, detail: null })}
          rangeLabel={`${range.from || '不限'} ~ ${range.to || '不限'}`} />
        <StructurePanel title="收入结构" rows={income} color="text-pos"
          onPick={tag => setDrill({ tag, detail: null })}
          rangeLabel={`${range.from || '不限'} ~ ${range.to || '不限'}`} />
      </div>

      <VoucherTable
        rows={rows} accounts={accounts} state={table} onState={setTable}
        highlightVno={highlight} onEdit={openEdit} onDelete={del}
        onView={(vno, i) => setViewer({ vno, i })}
      />

      <TodoPanel todos={todos} onJump={jumpTo} />

      {/* 记账 / 编辑 */}
      <VoucherFormModal
        open={formOpen} editing={editing} accounts={accounts} subjects={subjects}
        rows={rows} onClose={() => { setFormOpen(false); setEditing(null) }}
        onSubmit={submit}
      />

      {/* 结构钻取：一级=标签合并明细，二级=单笔交易详情 */}
      <TagVouchersModal
        tag={drill?.tag ?? null} range={range}
        onClose={() => setDrill(null)}
        onPick={v => setDrill(d => d ? { ...d, detail: v } : d)}
        onViewFile={(vno, i) => setViewer({ vno, i })}
      />
      <VoucherDetailModal
        voucher={drill?.detail ?? null}
        onClose={() => setDrill(d => d ? { ...d, detail: null } : d)}
        onViewFile={(vno, i) => setViewer({ vno, i })}
      />

      {/* 凭证查看器 */}
      <VoucherViewer
        voucher={viewerVoucher} index={viewer?.i ?? 0}
        onIndex={i => setViewer(v => (v ? { ...v, i } : v))}
        onClose={() => setViewer(null)}
      />

      <Toast msg={toast?.msg ?? ''} kind={toast?.kind ?? null} />
    </>
  )
}