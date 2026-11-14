/** 凭证文件 ↔ MinIO 同步与校验（幂等，可重复执行）
 *
 *  对象 key = 文件相对项目根的路径（如 凭证/NF-2026-10-006/凭证-微信转账单.jpg），
 *  与 DB attachments.file 及前端 URL 完全一致，因此迁移不需要改任何数据结构。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { ROOT } from './db.js'
import {
  storage, ensureBucket, putObject, getObject,
  listObjects, objectKey, sha256, status,
} from './storage.js'

const PREFIX = '凭证/'

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

/** 本地 凭证/ 下全部文件（含图片、说明、聊天原文、SHA256SUMS、原始包 zip） */
export function localFiles(): Map<string, Buffer> {
  const m = new Map<string, Buffer>()
  for (const abs of walk(join(ROOT, '凭证'))) {
    const key = objectKey(relative(ROOT, abs).replace(/\\/g, '/'))
    m.set(key, readFileSync(abs))
  }
  return m
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160)

export interface SyncReport {
  bucket: string
  total: number
  uploaded: number
  skipped: number
  verified: number
  bytes: number
  failures: { file: string; error: string }[]
}

/** 同步：远端缺失或大小不同的才上传，上传后回读比对 SHA256；--force 可全量重传。
 *  .txt（SHA256SUMS / 来源说明 / 索引）内容可能变而字节数不变，一律强制重传，
 *  与 syncVoucherDir 口径一致；否则按 key+大小跳过会漏掉同尺寸改动（2026-11-14 实测踩到）。 */
export async function syncVouchers(opts: { force?: boolean } = {}): Promise<SyncReport> {
  if (!storage()) throw new Error('MinIO 未配置（检查 server/.env）')
  await ensureBucket()
  const files = localFiles()
  const remote = new Map((await listObjects(PREFIX)).map(o => [o.key, o.size]))
  const report: SyncReport = {
    bucket: status().bucket ?? '', total: files.size,
    uploaded: 0, skipped: 0, verified: 0, bytes: 0, failures: [],
  }
  for (const [key, buf] of files) {
    try {
      const localHash = sha256(buf)
      const isText = key.toLowerCase().endsWith('.txt')
      if (!opts.force && !isText && remote.get(key) === buf.length) { report.skipped++; continue }
      await putObject(key, buf)
      report.uploaded++
      const back = await getObject(key)
      if (!back || sha256(back) !== localHash) throw new Error('上传后回读 SHA256 不一致')
      report.verified++
      report.bytes += buf.length
    } catch (e) {
      report.failures.push({ file: key, error: errText(e) })
    }
  }
  return report
}

/** 同步单个凭证目录：记账 / 补图后调用，覆盖 SHA256SUMS.txt、来源说明等非图片文件。
 *  .txt 每次强制重传（内容可能变而大小不变），图片按大小跳过。 */
export async function syncVoucherDir(vno: string): Promise<{ uploaded: number; skipped: number }> {
  if (!storage()) return { uploaded: 0, skipped: 0 }
  const dir = join(ROOT, '凭证', vno)
  if (!existsSync(dir)) return { uploaded: 0, skipped: 0 }
  const remote = new Map((await listObjects(`${PREFIX}${vno}/`)).map(o => [o.key, o.size]))
  let uploaded = 0, skipped = 0
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (!statSync(abs).isFile()) continue
    const key = objectKey(relative(ROOT, abs).replace(/\\/g, '/'))
    const buf = readFileSync(abs)
    const force = extname(name).toLowerCase() === '.txt'
    if (!force && remote.get(key) === buf.length) { skipped++; continue }
    try { await putObject(key, buf); uploaded++ }
    catch (e) { console.error(`[minio] 同步失败 ${key}：${errText(e)}`) }
  }
  return { uploaded, skipped }
}

/** 轻量校验：只列远端对象比对 key 集合与大小（1 次请求，供 `verify` 每次跑） */
export async function verifyRemoteLight(): Promise<{
  total: number; missing: string[]; sizeMismatch: string[]; extra: string[]
}> {
  if (!storage()) throw new Error('MinIO 未配置（检查 server/.env）')
  const local = localFiles()
  const remote = new Map((await listObjects(PREFIX)).map(o => [o.key, o.size]))
  return {
    total: local.size,
    missing: [...local.keys()].filter(k => !remote.has(k)),
    sizeMismatch: [...local.entries()]
      .filter(([k, b]) => remote.has(k) && remote.get(k) !== b.length).map(([k]) => k),
    extra: [...remote.keys()].filter(k => !local.has(k)),
  }
}

export interface VerifyReport {
  total: number
  ok: number
  missing: string[]
  mismatch: string[]
  extra: string[]
}

/** 全量校验：逐个下载远端对象，与本地文件比对 SHA256 */
export async function verifyRemote(): Promise<VerifyReport> {
  if (!storage()) throw new Error('MinIO 未配置（检查 server/.env）')
  const local = localFiles()
  const remote = await listObjects(PREFIX)
  const remoteKeys = new Set(remote.map(o => o.key))
  const missing = [...local.keys()].filter(k => !remoteKeys.has(k))
  const extra = [...remoteKeys].filter(k => !local.has(k))
  const mismatch: string[] = []
  let ok = 0
  for (const [key, buf] of local) {
    if (!remoteKeys.has(key)) continue
    try {
      const back = await getObject(key)
      if (back && sha256(back) === sha256(buf)) ok++
      else mismatch.push(key)
    } catch (e) {
      mismatch.push(`${key}（${errText(e)}）`)
    }
  }
  return { total: local.size, ok, missing, mismatch, extra }
}

/** 对外状态（不含密钥） */
export async function storageStatus(): Promise<{
  enabled: boolean; endpoint?: string; bucket?: string
  forcePathStyle?: boolean; objects: number; bytes: number
}> {
  const s = status()
  if (!s.enabled) return { ...s, objects: 0, bytes: 0 }
  const objs = await listObjects(PREFIX)
  return { ...s, objects: objs.length, bytes: objs.reduce((n, o) => n + o.size, 0) }
}
