/**
 * 修复本机 pnpm 的顶层依赖链接
 *
 * 背景：本机 pnpm install 有时只把包落到 `.pnpm/` 而不建 `node_modules/<pkg>` 软链
 * （Windows 上无 symlink 权限时表现为「pnpm 说已是最新，但 require/import 不到」）。
 * 这个脚本按 package.json 声明的直接依赖，逐个建 junction 链接。
 *
 * 用法：node scripts/fix-links.mjs
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(ROOT, 'node_modules')
const DOT = join(NM, '.pnpm')

if (!existsSync(DOT)) {
  console.error('✗ 未找到 node_modules/.pnpm，请先 pnpm install')
  process.exit(1)
}

const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(ROOT, 'package.json'), 'utf8'))
const want = { ...pkg.dependencies, ...pkg.devDependencies }

/** .pnpm 里目录名形如 `react@18.3.1` / `@types+node@22.20.5` / `koa@3.2.1_@types+node@22` */
const findInStore = name => {
  const enc = name.startsWith('@') ? name.replace('/', '+') : name
  const cands = readdirSync(DOT)
    .filter(d => d === enc || d.startsWith(enc + '@') || d.startsWith(enc + '_'))
    .sort((a, b) => a.length - b.length)      // 优先无 peer 后缀的短名
  for (const c of cands) {
    const src = join(DOT, c, 'node_modules', name)
    if (existsSync(join(src, 'package.json'))) return src
  }
  return null
}

/** 目标已可用（真实目录且非空，或已是指向有效位置的链接） */
const usable = dst => {
  try {
    const st = lstatSync(dst)
    if (st.isSymbolicLink()) return existsSync(dst) && existsSync(join(dst, 'package.json'))
    return st.isDirectory() && existsSync(join(dst, 'package.json'))
  } catch { return false }
}

let linked = 0
const failed = []

for (const name of Object.keys(want)) {
  const dst = join(NM, name)
  if (usable(dst)) continue
  const src = findInStore(name)
  if (!src) { failed.push(name + '（.pnpm 中未找到）'); continue }
  mkdirSync(dirname(dst), { recursive: true })
  try { rmSync(dst, { recursive: true, force: true }) } catch { /* 不存在则跳过 */ }
  try {
    // Windows 无 symlink 权限时 junction 仍可用，且无需管理员
    symlinkSync(resolve(src), resolve(dst), 'junction')
    linked++
  } catch (e) {
    failed.push(`${name}（${e.message.slice(0, 40)}）`)
  }
}

console.log(`✓ 已建链接 ${linked} 个`)
if (failed.length) {
  console.log('✗ 失败：')
  for (const f of failed) console.log('   ', f)
  process.exit(1)
}
