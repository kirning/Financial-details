/** 版本号递增：每次修改 server/ 或 web/ 源码后、提交前跑一次。
 *
 *   npm run bump            # patch +1（默认）1.0.0 -> 1.0.1
 *   npm run bump -- --minor # minor +1，patch 归零  1.0.1 -> 1.1.0
 *   npm run bump -- --major # major +1，其余归零    1.1.0 -> 2.0.0
 *   npm run bump -- --set 2.3.4
 *
 *  单一事实来源：项目根 VERSION。同时同步 server/package.json 与 web/package.json，
 *  避免三处版本号各说各话。前端版本号在 Vite 构建时从 VERSION 注入 __APP_VERSION__。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION_FILE = join(ROOT, 'VERSION')
const PACKAGES = ['server/package.json', 'web/package.json']

const args = process.argv.slice(2)
const cur = readFileSync(VERSION_FILE, 'utf8').trim()
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur)
if (!m) throw new Error(`VERSION 格式非法：${cur}（应为 x.y.z）`)

let [, a, b, c] = m.map(Number)
const setAt = args.indexOf('--set')
if (setAt >= 0) {
  const v = args[setAt + 1]
  if (!/^\d+\.\d+\.\d+$/.test(v || '')) throw new Error('--set 需要 x.y.z')
  ;[a, b, c] = v.split('.').map(Number)
} else if (args.includes('--major')) {
  a++; b = 0; c = 0
} else if (args.includes('--minor')) {
  b++; c = 0
} else {
  c++
}
const next = `${a}.${b}.${c}`

writeFileSync(VERSION_FILE, next + '\n')
for (const p of PACKAGES) {
  const file = join(ROOT, p)
  const j = JSON.parse(readFileSync(file, 'utf8'))
  j.version = next
  writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
}
console.log(`VERSION ${cur} -> ${next}（已同步 ${PACKAGES.join(' / ')}）`)
console.log('提示：改过 web/src 后需要重新 npm run build，前端角标才会更新。')
