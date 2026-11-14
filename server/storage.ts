/** MinIO / S3 凭证对象存储
 *
 *  设计要点：
 *   - 密钥只从 .env 或进程环境变量读取，**绝不写进源码 / 日志 / 文档**。
 *   - forcePathStyle=true（CF 代理下避免 bucket.<host> 虚拟主机解析）。
 *   - 对象 key 直接沿用账本里的相对路径（如 凭证/NF-.../凭证-xxx.jpg），
 *     因此 DB attachments.file 与前端 fileUrl() 都不需要改动。
 *   - 读取失败时可回退本地磁盘，远端不稳不会让账本页面打不开图。
 */

import {
  S3Client, ListBucketsCommand, HeadBucketCommand, CreateBucketCommand,
  PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command,
  type BucketLocationConstraint,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { extname } from 'node:path'

/** 加载 .env（Node 22 内置）；外部已提供环境变量时不覆盖 */
function loadEnv(): void {
  if (process.env.MINIO_ENDPOINT) return
  try { process.loadEnvFile('.env') } catch { /* 无 .env 则只用环境变量 */ }
}
loadEnv()

interface StorageConfig {
  endpoint: string
  accessKey: string
  secretKey: string
  bucket: string
  region: string
  forcePathStyle: boolean
}

function readConfig(): StorageConfig | null {
  const endpoint = process.env.MINIO_ENDPOINT
  const accessKey = process.env.MINIO_ACCESS_KEY
  const secretKey = process.env.MINIO_SECRET_KEY
  const bucket = process.env.MINIO_BUCKET
  if (!endpoint || !accessKey || !secretKey || !bucket) return null
  return {
    endpoint, accessKey, secretKey, bucket,
    region: process.env.MINIO_REGION || 'us-east-1',
    forcePathStyle: (process.env.MINIO_FORCE_PATH_STYLE ?? 'true') !== 'false',
  }
}

let client: S3Client | null = null
let config: StorageConfig | null = null

/** 配置缺失时返回 null（本地模式），调用方据此决定回退 */
export function storage(): { client: S3Client; bucket: string } | null {
  if (!config) config = readConfig()
  if (!config) return null
  if (!client) {
    client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      forcePathStyle: config.forcePathStyle,
    })
  }
  return { client, bucket: config.bucket }
}

export const isEnabled = (): boolean => storage() !== null

/** 对外状态（不含任何密钥） */
export function status(): { enabled: boolean; endpoint?: string; bucket?: string; forcePathStyle?: boolean } {
  const c = config ?? readConfig()
  if (!c) return { enabled: false }
  return { enabled: true, endpoint: c.endpoint, bucket: c.bucket, forcePathStyle: c.forcePathStyle }
}

export async function listBuckets(): Promise<string[]> {
  const s = storage()
  if (!s) throw new Error('MinIO 未配置')
  const r = await s.client.send(new ListBucketsCommand({}))
  return (r.Buckets ?? []).map(b => b.Name ?? '')
}

/** 确保 bucket 存在；已存在返回 created=false */
export async function ensureBucket(): Promise<{ created: boolean; bucket: string }> {
  const s = storage()
  if (!s) throw new Error('MinIO 未配置')
  try {
    await s.client.send(new HeadBucketCommand({ Bucket: s.bucket }))
    return { created: false, bucket: s.bucket }
  } catch {
    // 经 CF 代理的 MinIO 必须带 CreateBucketConfiguration，
    // 否则 SDK 发空 body 会被回 400 MalformedXML。
    // AWS SDK 的枚举不含 us-east-1（S3 默认区不发送该字段），但 MinIO 不校验取值，
    // 故显式断言以保留与 .env region 一致的语义。
    await s.client.send(new CreateBucketCommand({
      Bucket: s.bucket,
      CreateBucketConfiguration: {
        LocationConstraint: 'us-east-1' as unknown as BucketLocationConstraint,
      },
    }))
    return { created: true, bucket: s.bucket }
  }
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.zip': 'application/zip', '.pdf': 'application/pdf',
}

export function contentTypeOf(name: string): string {
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** 统一把 Windows 反斜杠转成 /，并去掉开头的 / */
export function objectKey(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex')

export interface PutResult { key: string; size: number; sha256: string; etag?: string }

export async function putObject(key: string, body: Buffer): Promise<PutResult> {
  const s = storage()
  if (!s) throw new Error('MinIO 未配置')
  const k = objectKey(key)
  const r = await s.client.send(new PutObjectCommand({
    Bucket: s.bucket, Key: k, Body: body, ContentType: contentTypeOf(k),
  }))
  return { key: k, size: body.length, sha256: sha256(body), etag: r.ETag }
}

export async function getObject(key: string): Promise<Buffer | null> {
  const s = storage()
  if (!s) return null
  try {
    const r = await s.client.send(new GetObjectCommand({ Bucket: s.bucket, Key: objectKey(key) }))
    if (!r.Body) return null
    return Buffer.from(await r.Body.transformToByteArray())
  } catch (e) {
    if ((e as { name?: string }).name === 'NoSuchKey' ||
        (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
    throw e
  }
}

export async function headObject(key: string): Promise<{ size: number; etag?: string } | null> {
  const s = storage()
  if (!s) return null
  try {
    const r = await s.client.send(new HeadObjectCommand({ Bucket: s.bucket, Key: objectKey(key) }))
    return { size: r.ContentLength ?? 0, etag: r.ETag }
  } catch (e) {
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
    throw e
  }
}

export async function listObjects(prefix = ''): Promise<{ key: string; size: number }[]> {
  const s = storage()
  if (!s) return []
  const out: { key: string; size: number }[] = []
  let token: string | undefined
  do {
    const r = await s.client.send(new ListObjectsV2Command({
      Bucket: s.bucket, Prefix: objectKey(prefix), ContinuationToken: token,
    }))
    for (const o of r.Contents ?? []) out.push({ key: o.Key ?? '', size: o.Size ?? 0 })
    token = r.IsTruncated ? r.NextContinuationToken : undefined
  } while (token)
  return out
}
