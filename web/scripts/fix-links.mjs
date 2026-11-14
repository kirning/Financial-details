#!/usr/bin/env node
/**
 * pnpm 链接修复
 * ───────────────────────────────────────────────
 * 本机（WorkBuddy 环境 + 腾讯云镜像）下pnpm 装包后，
 * 顶层 node_modules 与 .pnpm 各包的内部 node_modules
 * 偶尔缺少软链，导致 vite 构建时报这些错：
 *   - Cannot find package 'esbuild' imported from .../vite/dist/node/cli.js
 *   - Cannot find module '@rollup/rollup-win32-x64-msvc'
 *   - The package "@esbuild/win32-x64" could not be found
 *
 * 本脚本按 package.json 里声明的依赖，把 .pnpm 下已下载的包
 * 逐一软链（Windows 用 junction）到需要的位置。
 *
 * 用法：node scripts/fix-links.mjs      （在 web/ 目录下执行）
 */
import { readdirSync, readFileSync, existsSync, mkdirSync, symlinkSync, rmSync, statSync, lstatSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NM = join(WEB, 'node_modules')
const DOT = join(NM, '.pnpm')
const PLATFORM_PKGS = ['@esbuild/win32-x64', '@rollup/rollup-win32-x64-msvc']

if (!existsSync(DOT)) {
  console.error('✗ 没有 node_modules/.pnpm，请先 pnpm install')
  process.exit(1)
}

const dotEntries = readdirSync(DOT)

/** 在 .pnpm 里按包名找已下载的包目录（处理 @scope+name 与 peer 后缀） */
function findInStore(name) {
  const enc = name.startsWith('@') ? name.replace('/', '+') : name
  const cands = dotEntries
    .filter(d => d === enc || d.startsWith(enc + '@') || d.startsWith(enc + '_'))
    .sort((a, b) => a.length - b.length)
  for (const c of cands) {
    const src = join(DOT, c, 'node_modules', name)
    if (existsSync(join(src, 'package.json'))) return src
  }
  return null
}

/** 判断目标是否已可用（有 package.json 且目录非空） */
function usable(p) {
  try {
    return statSync(p).isDirectory() && existsSync(join(p, 'package.json'))
  } catch { return false }
}

function link(src, dst) {
  try { if (lstatSync(dst)) { rmSync(dst, { recursive: true, force: true }) } } catch { /* 不存在 */ }
  mkdirSync(dirname(dst), { recursive: true })
  symlinkSync(resolve(src), resolve(dst), 'junction')
}

let linked = 0
const missing = []

const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8'))

/* 1) 顶层直接依赖 */
for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
  const dst = join(NM, name)
  if (usable(dst)) continue
  const src = findInStore(name)
  if (!src) { missing.push(name); continue }
  link(src, dst); linked++
}

/* 2) 平台原生包（esbuild / rollup）—— 顶层 + 各相关包内部 */
for (const name of PLATFORM_PKGS) {
  const src = findInStore(name)
  if (!src) { missing.push(name + '（未下载）'); continue }
  const top = join(NM, name)
  if (!usable(top)) { link(src, top); linked++ }
  // 链接到引用方的 node_modules 下
  for (const holder of ['vite', 'rollup', 'esbuild']) {
    const enc = name.startsWith('@') ? name.replace('/', '+') : name
    const cands = dotEntries.filter(d => d === enc || d.startsWith(enc + '@') || d.startsWith(enc + '_'))
    for (const c of cands) {
      const inner = join(DOT, c, 'node_modules')
      if (!existsSync(inner)) continue
      const dst = join(inner, name)
      if (usable(dst)) continue
      link(src, dst); linked++
    }
  }
}

/* 3) 递归补齐依赖链
 *    pnpm 的扁平结构里，一个包的依赖可能散落在多处，
 *    逐层读取各包的 package.json 依赖声明并补链，直到没有新发现。 */
const queue = dotEntries.slice()
const seen = new Set()

while (queue.length) {
  const d = queue.pop()
  if (seen.has(d)) continue
  seen.add(d)

  const inner = join(DOT, d, 'node_modules')
  if (!existsSync(inner)) continue

  // 该目录下真实存在的包（含 @scope/x）
  const pkgs = []
  for (const e of readdirSync(inner)) {
    if (e.startsWith('@')) {
      const scopeDir = join(inner, e)
      if (!existsSync(scopeDir)) continue
      for (const sub of readdirSync(scopeDir)) pkgs.push(`${e}/${sub}`)
    } else pkgs.push(e)
  }

  for (const name of pkgs) {
    const selfPkg = join(inner, name, 'package.json')
    if (!existsSync(selfPkg)) continue

    // 读它的依赖声明 → 缺哪个补哪个
    let deps = {}
    try { deps = JSON.parse(readFileSync(selfPkg, 'utf8')).dependencies ?? {} } catch { /* 忽略 */ }
    for (const dep of Object.keys(deps)) {
      const dst = join(inner, dep)
      if (usable(dst)) continue
      const src = findInStore(dep)
      if (!src) continue
      link(src, dst); linked++
    }
  }
}

console.log(`✓ 补齐链接 ${linked} 处`)
if (missing.length) {
  console.log('⚠ 未找到:', missing.join(', '))
  process.exit(1)
}