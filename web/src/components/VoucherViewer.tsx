import { useEffect, useState } from 'react'
import type { Voucher } from '../lib/types'
import { fileUrl, money } from '../lib/api'
import { Modal } from './ui'

/** 凭证查看器：左侧缩略图 + 右侧大图，支持旋转（每次 90°）与键盘 ← → 切换 */
export function VoucherViewer({ voucher, index, onIndex, onClose }: {
  voucher: Voucher | null
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const [rot, setRot] = useState(0)
  /** 原图宽高比（用于旋转后预留正确的显示空间） */
  const [ratio, setRatio] = useState<number | null>(null)

  const n = voucher?.files.length ?? 0

  // 切换凭证或图片时复位角度
  useEffect(() => { setRot(0); setRatio(null) }, [voucher?.vno, index])

  if (!voucher || n === 0) return null

  const i = Math.max(0, Math.min(index, n - 1))
  const label = (k: string | undefined) =>
    k && k !== '凭证' ? k : `凭证图${n > 1 ? ' ' + (i + 1) : ''}`

  const go = (k: number) => onIndex(Math.max(0, Math.min(k, n - 1)))
  const spin = (delta: number) => setRot(r => ((r + delta) % 360 + 360) % 360)

  // 旋转 90°/270° 时，宽高互换
  const swapped = rot % 180 !== 0

  return (
    <Modal open wide onClose={onClose}
      title={
        <span className="flex items-baseline gap-2 min-w-0">
          <b className="shrink-0">{voucher.vno}</b>
          <span className="text-fg-dim font-normal text-[13px] truncate">
            {voucher.summary} · {money(Math.abs(voucher.amount))} 元 · {voucher.date}
          </span>
        </span>
      }
      footer={
        <div className="flex justify-between items-center w-full text-xs text-fg-dim gap-3">
          <span className="truncate">
            {voucher.kinds[i] && `${voucher.kinds[i]}　`}
            <span className="text-fg-dim2 mono">{voucher.files[i].split('/').pop()}</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <button className="btn" onClick={() => spin(-90)} title="逆时针旋转 90°">↺ 逆时针</button>
            <span className="mono text-warn min-w-[36px] text-center">{rot ? `${rot}°` : ''}</span>
            <button className="btn" onClick={() => spin(90)} title="顺时针旋转 90°">↻ 顺时针</button>
            {n > 1 && (
              <>
                <span className="w-px h-3.5 bg-ink-600 mx-0.5" />
                <button className="btn" onClick={() => go(i - 1)} disabled={i === 0} title="上一张">‹</button>
                <span className="mono">{i + 1} / {n}</span>
                <button className="btn" onClick={() => go(i + 1)} disabled={i === n - 1} title="下一张">›</button>
              </>
            )}
            <a href={fileUrl(voucher.files[i])} target="_blank" rel="noreferrer"
               className="text-acc text-xs hover:underline ml-1">新窗口打开</a>
          </span>
        </div>
      }
    >
      <div
        className="flex gap-4 min-h-[340px] max-lg:flex-col"
        onKeyDown={e => {
          if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1) }
          if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1) }
        }}
        tabIndex={-1}
        ref={el => { if (el && n > 1) el.focus() }}
      >
        {n > 1 && (
          <div className="shrink-0 basis-[210px] max-lg:basis-auto">
            <div className="flex flex-col gap-2 max-lg:flex-row">
              {voucher.files.map((f, k) => (
                <button key={f} className={`vw-thumb ${k === i ? 'on' : ''}`} onClick={() => go(k)}>
                  <img src={fileUrl(f)} alt="" loading="lazy" />
                  <b>{label(voucher.kinds[k])}</b>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex-1 flex items-center justify-center min-w-0">
          {/* 图片本体承担尺寸；旋转 90°/270° 时按原图比例预留交换后的空间 */}
          <div
            className="flex items-center justify-center bg-[#0b0f14] rounded-lg border border-ink-600 overflow-hidden"
            style={
              ratio
                ? {
                    aspectRatio: String(swapped ? 1 / ratio : ratio),
                    maxWidth: '100%',
                    maxHeight: '62vh',
                    width: swapped ? 'auto' : '100%',
                    height: swapped ? '62vh' : 'auto',
                  }
                : { maxWidth: '100%', maxHeight: '62vh' }
            }
          >
            <img
              src={fileUrl(voucher.files[i])}
              alt="凭证图片"
              className="max-h-[62vh] max-w-full object-contain transition-transform duration-150"
              style={{ transform: `rotate(${rot}deg)` }}
              onLoad={e => {
                const el = e.currentTarget
                if (el.naturalWidth && el.naturalHeight) {
                  setRatio(el.naturalWidth / el.naturalHeight)
                }
              }}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}