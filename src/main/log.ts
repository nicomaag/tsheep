/**
 * A plain diagnostic log, to find out afterwards why a login or a shell hung.
 *
 * Off by default; a switch in the settings turns it on. One text file per day
 * in userData/logs, kept for two weeks. It holds what
 * tsheep did and what tsh answered (logins, shells connecting and closing, MCP
 * tool calls with their duration), never a command's text or output: those are
 * in the history, already scrubbed.
 */
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { config } from './config'

const KEEP_DAYS = 14
let pruned = false

export function logDir(): string {
  const d = join(app.getPath('userData'), 'logs')
  mkdirSync(d, { recursive: true })
  return d
}

export function log(area: 'app' | 'login' | 'shell' | 'mcp', message: string, data?: Record<string, unknown>): void {
  if (!config.settings().diagnosticLog) return
  try {
    const dir = logDir()
    if (!pruned) {
      pruned = true
      const files = readdirSync(dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
      for (const f of files.slice(0, -KEEP_DAYS)) unlinkSync(join(dir, f))
    }
    const stamp = localStamp(new Date())
    const line = `${stamp} [${area}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`
    appendFileSync(join(dir, `${stamp.slice(0, 10)}.log`), line, 'utf8')
  } catch (e) {
    console.error('[log] could not write', e)
  }
}

/** The machine's own time, e.g. "2026-11-11 12:24:04.078 +01:00"; the file's day is local too. */
function localStamp(d: Date): string {
  const p = (n: number, len = 2) => String(n).padStart(len, '0')
  const off = -d.getTimezoneOffset()
  const zone = `${off < 0 ? '-' : '+'}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)} ${zone}`
}

/** The end of a tsh output, short enough for one log line or an error text. */
export function tail(text: string, max = 600): string {
  const t = text.trim()
  return t.length > max ? `…${t.slice(-max)}` : t
}
