/** 单一版本来源：项目根 VERSION 文件。
 *  运行时读取（不是编译期常量），因此 bump 后重启服务即可在 /health 与 MCP serverInfo 看到新版本。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './db.js'

const FALLBACK = '1.0.0'

export function version(): string {
  try {
    const v = readFileSync(join(ROOT, 'VERSION'), 'utf8').trim()
    return /^\d+\.\d+\.\d+$/.test(v) ? v : FALLBACK
  } catch {
    return FALLBACK
  }
}
