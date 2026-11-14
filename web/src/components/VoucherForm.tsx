import { useEffect, useRef, useState } from 'react'
import type { Account, PendingFile, Subject, Voucher, VoucherForm, VoucherType } from '../lib/types'
import { monthOf, previewVno, suggestSubjects, todayStr } from '../lib/api'
import { Modal, cls } from './ui'

export interface FormErrors {
  date?: string; period?: string; subject?: string; summary?: string; amount?: string
}

export function VoucherFormModal({ open, editing, accounts, subjects, rows, onClose, onSubmit }: {
  open: boolean
  /** 传入 voucher 表示编辑模式 */
  editing: Voucher | null
  accounts: Account[]
  subjects: Subject[]
  rows: Voucher[]
  onClose: () => void
  onSubmit: (form: VoucherForm, pending: PendingFile[], kind: string) => Promise<void>
}) {
  const [form, setForm] = useState<VoucherForm>({
    date: todayStr(), period: monthOf(todayStr()), type: '支出', amount: 0,
    subject: '', tag: '', acc: accounts[0]?.code ?? 'wx', party: '', handler: '成(阿四)', summary: '', note: '',
  })
  const [pending, setPending] = useState<PendingFile[]>([])
  const [kind, setKind] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 打开时初始化（编辑模式回填）
  useEffect(() => {
    if (!open) return
    setErrors({}); setPending([]); setKind(''); setBusy(false)
    if (editing) {
      setForm({
        date: editing.date, period: editing.period, type: editing.type,
        amount: Math.abs(editing.amount), subject: editing.subject, acc: editing.acc,
        party: editing.party ?? '', handler: editing.handler ?? '', summary: editing.summary,
        note: editing.note ?? '', tag: editing.tag, vno: editing.vno,
      })
    } else {
      const d = todayStr()
      setForm({
        date: d, period: monthOf(d), type: '支出', amount: 0, subject: '',
        acc: accounts[0]?.code ?? 'wx', party: '', handler: '成(阿四)', summary: '', note: '', tag: '',
      })
    }
  }, [open, editing, accounts])

  const set = <K extends keyof VoucherForm>(k: K, v: VoucherForm[K]) => {
    setForm(f => ({ ...f, [k]: v }))
    setErrors(e => ({ ...e, [k]: undefined }))
  }

  /* 凭证图片：选择 / 拖拽 / 粘贴 */
  const addFiles = (list: FileList | File[]) => {
    const files = Array.from(list).filter(f => /^image\//.test(f.type))
    const nonImg = Array.from(list).length - files.length
    files.forEach(f => {
      const rd = new FileReader()
      rd.onload = () => setPending(p => [...p, { data: String(rd.result), name: f.name }])
      rd.readAsDataURL(f)
    })
    return nonImg
  }

  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const items = Array.from(e.clipboardData?.items ?? []).filter(i => i.type.startsWith('image/'))
      if (!items.length) return
      e.preventDefault()
      addFiles(items.map(i => i.getAsFile()).filter((f): f is File => !!f))
    }
    document.addEventListener('paste', onPaste)
    return () => document.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const suggestions = suggestSubjects(subjects, form.type)
  const vnoPreview = editing ? editing.vno : previewVno(rows, form.period)

  const validate = (): boolean => {
    const e: FormErrors = {}
    if (!form.date) e.date = '必填'
    if (!/^\d{4}-\d{2}$/.test(form.period)) e.period = '格式应为 YYYY-MM'
    if (!form.subject.trim()) e.subject = '必填'
    if (!form.summary.trim()) e.summary = '必填'
    if (!form.amount || form.amount <= 0) e.amount = '须为正数'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const submit = async () => {
    if (!validate() || busy) return
    setBusy(true)
    try {
      await onSubmit(form, pending, kind.trim())
      setPending([])
      onClose()
    } catch (err) {
      setErrors({ summary: err instanceof Error ? err.message : '保存失败' })
    } finally {
      setBusy(false)
    }
  }

  const errCls = (k: keyof FormErrors) =>
    cls('inp', errors[k] && '!border-neg focus:!border-neg')

  return (
    <Modal open={open} onClose={onClose}
      title={editing ? `编辑 ${editing.vno}` : '记一笔'}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>取消</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3.5">
        {/* 凭证号：只读，由系统分配 */}
        <label className="fld">
          <span>凭证号</span>
          <input className="inp" value={vnoPreview} readOnly disabled
                 title={editing ? '凭证号不可修改' : '保存时由服务端按所属期自动分配'} />
        </label>

        <label className="fld">
          <span>发生 / 实付日期 *</span>
          <input type="date" className={errCls('date')} value={form.date}
                 onChange={e => {
                   const d = e.target.value
                   setForm(f => ({ ...f, date: d, period: editing ? f.period : monthOf(d) }))
                   setErrors(x => ({ ...x, date: undefined }))
                 }} />
        </label>

        <label className="fld">
          <span>凭证号所属期 *（决定凭证号）</span>
          <input className={errCls('period')} value={form.period} placeholder="2026-07"
                 onChange={e => set('period', e.target.value.trim())} />
          {errors.period && <span className="text-neg text-2xs">{errors.period}</span>}
        </label>

        {/* 类型：Radio */}
        <div className="fld">
          <span>类型 *</span>
          <div className="flex gap-1.5">
            {(['支出', '收入'] as const).map(t => (
              <label key={t} className="flex-1 cursor-pointer">
                <input type="radio" name="f-type" value={t} className="sr-only peer"
                       checked={form.type === t}
                       onChange={() => set('type', t as VoucherType)} />
                <span className={cls(
                  'block text-center py-1.5 rounded-md text-xs border transition-colors',
                  'bg-ink-700 border-ink-600 text-fg-dim',
                  'peer-checked:font-semibold peer-checked:text-white',
                  t === '支出' ? 'peer-checked:bg-neg peer-checked:border-neg'
                               : 'peer-checked:bg-pos peer-checked:border-pos',
                  form.type === t && (t === '支出'
                    ? 'bg-neg border-neg text-white font-semibold'
                    : 'bg-pos border-pos text-white font-semibold'),
                )}>{t}</span>
              </label>
            ))}
          </div>
        </div>

        <label className="fld">
          <span>金额 *（支出填正数）</span>
          <input type="number" step="0.01" className={errCls('amount')} value={form.amount || ''}
                 onChange={e => set('amount', Number(e.target.value))} />
          {errors.amount && <span className="text-neg text-2xs">{errors.amount}</span>}
        </label>

        <label className="fld">
          <span>账户 *</span>
          <select className="inp" value={form.acc} onChange={e => set('acc', e.target.value)}>
            {accounts.map(a => <option key={a.code} value={a.code}>{a.name}（{a.role ?? ''}）</option>)}
          </select>
        </label>
      </div>

      {/* 科目：可下拉可输入 */}
      <label className="fld">
        <span>科目 * —— 可下拉选择，也可直接输入新科目</span>
        <input list="subject-options" className={errCls('subject')} value={form.subject}
               placeholder="如：支付保洁员工资" autoComplete="off"
               onChange={e => set('subject', e.target.value)} />
        <datalist id="subject-options">
          {suggestions.map(s => <option key={s} value={s} />)}
        </datalist>
        <span className="text-2xs block mt-1 text-fg-dim2">
          {suggestions.length
            ? `已有 ${suggestions.length} 个${form.type}科目，下拉可选或直接输入新科目`
            : '暂无历史科目，可直接输入'}
        </span>
        {errors.subject && <span className="text-neg text-2xs">{errors.subject}</span>}
      </label>

      {/* 统计标签：留空则由服务端按科目自动推断；手工填了就不会被自动规则改掉 */}
      <label className="fld">
        <span>统计标签 —— 收支结构按此合并；留空自动按科目推断</span>
        <input list="tag-options" className="inp" value={form.tag ?? ''}
               placeholder="如：小区电费(生活缴费)" autoComplete="off"
               onChange={e => set('tag', e.target.value)} />
        <datalist id="tag-options">
          {Array.from(new Set(rows.map(r => r.tag).filter(Boolean))).map(t => <option key={t} value={t} />)}
        </datalist>
        <span className="text-2xs block mt-1 text-fg-dim2">
          原始科目保持不变，标签只影响结构统计的合并方式
        </span>
      </label>

      <label className="fld">
        <span>摘要 = 事由 *</span>
        <input className={errCls('summary')} value={form.summary}
               onChange={e => set('summary', e.target.value)} />
        {errors.summary && <span className="text-neg text-2xs">{errors.summary}</span>}
      </label>

      <div className="grid grid-cols-2 gap-x-3.5">
        <label className="fld">
          <span>对方 / 来源</span>
          <input className="inp" value={form.party} onChange={e => set('party', e.target.value)} />
        </label>
        <label className="fld">
          <span>经手人</span>
          <input className="inp" value={form.handler} onChange={e => set('handler', e.target.value)} />
        </label>
      </div>

      <label className="fld">
        <span>备注 —— 含「费用所属期 YYYY-MM」可修正归属月；含「无支付凭证」自动进待办</span>
        <input className="inp" value={form.note} onChange={e => set('note', e.target.value)} />
      </label>

      {/* 凭证图片 */}
      <label className="fld">
        <span>凭证图片（可多选，或直接拖拽 / 粘贴）</span>
        <div className={cls('dropzone', over && 'over')}
             onClick={() => fileRef.current?.click()}
             onDragOver={e => { e.preventDefault(); setOver(true) }}
             onDragLeave={() => setOver(false)}
             onDrop={e => {
               e.preventDefault(); setOver(false)
               addFiles(e.dataTransfer.files)
             }}>
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
                 onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = '' }} />
          <div className="py-2">点击选择 · 拖拽图片到此处 · Ctrl+V 粘贴截图</div>
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-2 justify-start">
              {pending.map((p, i) => (
                <div key={i} className="relative w-[76px] h-[76px] rounded-md overflow-hidden border border-ink-600 group">
                  <img src={p.data} alt="" className="w-full h-full object-cover" />
                  <b className="absolute right-0.5 top-0.5 bg-black/70 text-white rounded text-[10px] px-1.5 max-w-[70px] overflow-hidden text-ellipsis">
                    {kind || '凭证'}
                  </b>
                  <i className="absolute inset-0 bg-black/55 text-white flex items-center justify-center
                                 text-xs cursor-pointer not-italic opacity-0 group-hover:opacity-100"
                     onClick={e => { e.stopPropagation(); setPending(pp => pp.filter((_, k) => k !== i)) }}>
                    移除
                  </i>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="text-fg-dim text-xs mt-1.5">
          凭证类型{' '}
          <input className="inp !w-[190px] !inline-block ml-1.5" value={kind}
                 placeholder="如：支出证明单" onChange={e => setKind(e.target.value)} />
        </div>
      </label>
    </Modal>
  )
}