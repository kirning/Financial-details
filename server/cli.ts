#!/usr/bin/env node
/**
 * 记账 CLI —— 直接写 SQLite，不经过 HTTP
 *
 * 用法
 * ----
 * node dist/cli.js add --date 2026-06-25 --period 2026-06 \
 *      --type 支出 --amount 1250.00 --subject "清理隔油池" \
 *      --account wx --party "高邮疏通" --summary "清理隔油池服务费" \
 *      --files "D:/path/收据.jpg" [--kind 收款收据] [--note "用户原话"]
 *
 *   node dist/cli.js verify            # 校验所有凭证 SHA256
 *   node dist/cli.js report            # 汇总报表
 *   node dist/cli.js migrate           # 从旧 流水.csv 幂等迁移
 *   node dist/cli.js export-csv        # 导出回 流水.csv（与旧格式一致）
 *   node dist/cli.js minio-status      # 查看 MinIO 凭证存储状态
 *   node dist/cli.js minio-sync        # 把 凭证/ 全量同步到 MinIO（幂等）
 *   node dist/cli.js minio-verify      # 逐个回读远端对象，比对 SHA256
 *
 * 账户简写：wx 微信零钱 / ab 农行6316 / icbc 工行3779
 */
import { mkdirSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import * as Q from './db.js'
import type { Attachment } from './db.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

/** 取 `--key value`；值不存在或以 `--` 开头时返回默认值 */
const arg = (k: string, d: string | null = null): string | null => {
  const i = argv.indexOf('--' + k)
  const v = i >= 0 ? argv[i + 1] : undefined
  return v && !v.startsWith('--') ? v : d
}

const money = (n: number) => (n || 0).toLocaleString('zh-CN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 把凭证图复制到 `凭证/<vno>/`，命名 `凭证-<kind>.jpg`，并写来源说明 */
function archiveFiles(vno: string, files: string[], kind = '凭证'): Attachment[] {
  const dir = join(Q.ROOT, '凭证', vno)
  mkdirSync(dir, { recursive: true })
  const out: Attachment[] = []
  files.forEach((src, i) => {
    if (!existsSync(src)) throw new Error('文件不存在：' + src)
    const ext = extname(src) || '.jpg'
    const name = `凭证-${kind}${i ? '-' + (i + 1) : ''}${ext}`
    const dst = join(dir, name)
    copyFileSync(src, dst)
    out.push({
      file: `凭证/${vno}/${name}`,
      kind,
      sha256: createHash('sha256').update(readFileSync(dst)).digest('hex'),
    })
  })
  writeFileSync(join(dir, '来源-说明.txt'),
    `凭证来源：用户于 ${new Date().toISOString().slice(0, 10)} 直接提供图片（无聊天记录原始包）。\n` +
    (arg('note') ? `用户说明：${arg('note')}\n` : ''), 'utf8')
  return out
}

switch (cmd) {
  case 'add': {
    const files = (arg('files') || '').split('|').filter(Boolean)
    if (!files.length) { console.error('✗ 需要 --files'); process.exit(1) }
    const date = arg('date') || new Date().toISOString().slice(0, 10)
    const period = arg('period') || date.slice(0, 7)
    const type = arg('type') as '收入' | '支出' | null
    const amount = Number(arg('amount'))
    const subject = arg('subject')
    const summary = arg('summary')
    if (!type || !['收入', '支出'].includes(type)) {
      console.error('✗ --type 必须是收入/支出'); process.exit(1)
    }
    if (!(amount > 0)) { console.error('✗ --amount 须为正数'); process.exit(1) }
    if (!subject || !summary) { console.error('✗ 需要 --subject 与 --summary'); process.exit(1) }

    const vno = arg('vno') || Q.nextVno(period)
    const atts = archiveFiles(vno, files, arg('kind', '凭证')!)
    const v = Q.insertVoucher({
      vno, date, period, type, amount, subject,
      acc: arg('account', 'wx')!, party: arg('party'), handler: arg('handler', '成(阿四)'),
      summary, note: arg('note'),
    }, atts)
    Q.hashVoucherDir(vno)
    if ((await import('./storage.js')).isEnabled()) {
      const { syncVoucherDir } = await import('./minio-sync.js')
      const s = await syncVoucherDir(vno)
      console.log(`  MinIO 同步：上传 ${s.uploaded} · 跳过 ${s.skipped}`)
    }
    console.log(`✓ ${v.vno}  ${v.type} ${money(Math.abs(v.amount))}  ${v.subject}`)
    console.log(`  凭证 → 凭证/${vno}/  (${atts.length + 2} 个文件, SHA256 已生成)`)
    break
  }

  case 'attach': {   // 给已有凭证补凭证图
    const vno = arg('vno')
    if (!vno || !Q.getVoucher(vno)) { console.error('✗ 凭证不存在'); process.exit(1) }
    const files = (arg('files') || '').split('|').filter(Boolean)
    if (!files.length) { console.error('✗ 需要 --files'); process.exit(1) }
    const atts = archiveFiles(vno, files, arg('kind', '凭证')!)
    for (const a of atts) Q.attachFile(vno, a.file, a.kind, a.sha256 ?? null)
    Q.hashVoucherDir(vno)
    if ((await import('./storage.js')).isEnabled()) {
      const { syncVoucherDir } = await import('./minio-sync.js')
      const s = await syncVoucherDir(vno)
      console.log(`  MinIO 同步：上传 ${s.uploaded} · 跳过 ${s.skipped}`)
    }
    console.log(`✓ ${vno} 补凭证 ${atts.length} 张，SHA256 已刷新`)
    break
  }

  case 'verify': {
    const bad = Q.verifyAll()
    for (const b of bad) console.log(`✗ ${b.vno}  ${b.error}`)
    const n = Q.stats().vouchers
    console.log(bad.length ? `\n${bad.length}/${n} 个凭证目录有问题` : `\n${n} 个凭证目录，全部通过`)

    // 配置了 MinIO 时追加远端对象检查（只列 key + 大小，1 次请求；全量 SHA256 用 minio-verify）
    const { isEnabled } = await import('./storage.js')
    let remoteBad = 0
    if (isEnabled()) {
      const { verifyRemoteLight } = await import('./minio-sync.js')
      const r = await verifyRemoteLight()
      remoteBad = r.missing.length + r.sizeMismatch.length
      console.log(`MinIO：${r.total - r.missing.length - r.sizeMismatch.length}/${r.total} 个对象齐全且大小一致` +
        (r.extra.length ? `（远端多出 ${r.extra.length}）` : ''))
      if (r.missing.length) console.log(`  ✗ 缺失 ${r.missing.length}：${r.missing.slice(0, 5).join('、')}`)
      if (r.sizeMismatch.length) console.log(`  ✗ 大小不符 ${r.sizeMismatch.length}：${r.sizeMismatch.slice(0, 5).join('、')}`)
    }
    process.exit(bad.length || remoteBad ? 1 : 0)
  }

  case 'report': {
    const b = Q.balances()
    console.log(`\n共 ${b.total.n} 笔　实收 ${money(b.total.inc)}　支出 ${money(b.total.exp)}　净流入 ${money(b.total.inc - b.total.exp)}\n`)
    for (const a of b.accounts)
      console.log(`  ${a.name.padEnd(10)} 收 ${money(a.inc).padStart(12)}  支 ${money(a.exp).padStart(10)}  净 ${money(a.inc - a.exp)}`)
    console.log('\n  月度（按归属期）')
    for (const m of Q.monthly())
      console.log(`    ${m.period}  收 ${money(m.inc).padStart(11)}  支 ${money(m.exp).padStart(9)}  净 ${money(m.net).padStart(11)}`)
    console.log()
    break
  }

  case 'migrate':
    console.log(Q.migrateFromCsv())
    break

  case 'export-csv': {
    const H = ['日期', '凭证号', '类型', '金额', '科目', '统计标签', '账户', '对方/来源', '经手人', '摘要(事由)', '凭证文件', '备注']
    const rows = Q.listVouchers()
    const csv = [H.join(',')].concat(rows.map(r => [
      r.date, r.vno, r.type, r.amount.toFixed(2), r.subject,
      `"${r.tag.replace(/"/g, '""')}"`,
      r.accFull || Q.accounts().find(a => a.code === r.acc)?.full_name || r.acc,
      r.party || '', r.handler || '', r.summary,
      `"${r.files.join('|').replace(/"/g, '""')}"`, `"${(r.note || '').replace(/"/g, '""')}"`,
    ].join(','))).join('\n')
    writeFileSync(join(Q.ROOT, '流水.csv'), '\ufeff' + csv + '\n', 'utf8')
    console.log(`✓ 已导出 ${rows.length} 笔到 流水.csv`)
    break
  }

  case 'minio-status': {
    const { storageStatus } = await import('./minio-sync.js')
    const s = await storageStatus()
    if (!s.enabled) { console.log('MinIO 未配置（检查 server/.env）'); break }
    console.log(`MinIO：${s.endpoint} / ${s.bucket}   forcePathStyle=${s.forcePathStyle}`)
    console.log(`  凭证对象 ${s.objects} 个 · ${(s.bytes / 1024 / 1024).toFixed(2)} MB`)
    break
  }

  case 'minio-sync': {
    const { syncVouchers } = await import('./minio-sync.js')
    const r = await syncVouchers({ force: argv.includes('--force') })
    console.log(`✓ 同步完成：本地 ${r.total} 个文件 → ${r.bucket}`)
    console.log(`  上传 ${r.uploaded}（回读校验 ${r.verified} 个 · ${(r.bytes / 1024 / 1024).toFixed(2)} MB）· 已存在跳过 ${r.skipped}`)
    if (r.failures.length) {
      console.log(`  ✗ 失败 ${r.failures.length} 个：`)
      for (const f of r.failures) console.log(`    ${f.file} — ${f.error}`)
      process.exitCode = 1
    }
    break
  }

  case 'minio-verify': {
    const { verifyRemote } = await import('./minio-sync.js')
    const r = await verifyRemote()
    console.log(`✓ 远端校验：${r.ok}/${r.total} 个对象 SHA256 与本地一致`)
    if (r.missing.length) console.log(`  ✗ 缺失 ${r.missing.length}：${r.missing.slice(0, 5).join('、')}`)
    if (r.mismatch.length) console.log(`  ✗ 不一致 ${r.mismatch.length}：${r.mismatch.slice(0, 5).join('、')}`)
    if (r.extra.length) console.log(`  · 远端多出 ${r.extra.length}：${r.extra.slice(0, 5).join('、')}`)
    if (r.missing.length || r.mismatch.length) process.exitCode = 1
    break
  }

  default:
    console.log(`南丰村财务 · 记账 CLI

  add       记一笔（凭证号自动分配 + 凭证自动归档 + SHA256）
  attach    给已有凭证补凭证图      --vno NF-... --files "a.jpg|b.jpg"
  verify    校验所有凭证 SHA256
  report    汇总报表
  migrate   从旧 流水.csv 幂等迁移
  export-csv  导出回 流水.csv
  minio-status  查看 MinIO 凭证存储状态
  minio-sync    把 凭证/ 全量同步到 MinIO（幂等，可重复跑）
  minio-verify  逐个回读远端对象比对 SHA256

账户简写：wx 微信零钱 / ab 农行6316 / icbc 工行3779
数据库：${Q.stats().dbPath}（${Q.stats().vouchers} 笔）`)
}