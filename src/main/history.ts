/**
 * What happened, kept across restarts.
 *
 * One JSONL file per day in userData/history. Sessions are written when they
 * close, entries when they finish, with output capped so a `cat` of a log
 * does not become the log. On start the last two days are read back so the
 * sidebar's "Closed" list and their timelines are still there.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Entry, HistoryFilter, HistoryHit, HistoryResult, Session } from '@shared/types'

const OUTPUT_CAP = 64 * 1024
const DAYS_BACK = 2
const MAX_LOADED = 400
const SEARCH_LIMIT = 500

type Line = { kind: 'session'; session: Session } | { kind: 'entry'; entry: Entry }

function dir(): string {
  const d = join(app.getPath('userData'), 'history')
  mkdirSync(d, { recursive: true })
  return d
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function write(line: Line): void {
  try {
    appendFileSync(join(dir(), `${today()}.jsonl`), JSON.stringify(line) + '\n', 'utf8')
  } catch (e) {
    console.error('[history] could not write', e)
  }
}

export const history = {
  session(session: Session): void {
    write({ kind: 'session', session })
  },

  entry(entry: Entry): void {
    const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(0, OUTPUT_CAP) + `\n… ${s.length - OUTPUT_CAP} more characters not kept` : s)
    write({
      kind: 'entry',
      entry: { ...entry, stdout: cap(entry.stdout), stderr: cap(entry.stderr) },
    })
  },

  /** Sessions and entries from the last days, oldest first. */
  load(): { sessions: Session[]; entries: Entry[] } {
    const { sessions, entries } = read(DAYS_BACK)
    const list = [...entries.values()].sort((a, b) => a.requestedAt - b.requestedAt).slice(-MAX_LOADED)
    return { sessions: [...sessions.values()], entries: list }
  },

  /** Finished commands matching the filter, newest first, across the kept days. */
  search(f: HistoryFilter): HistoryResult {
    const { sessions, entries, days } = read(f.days > 0 ? f.days : Infinity)
    const has = (hay: string | null | undefined, needle: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase())
    const hits: HistoryHit[] = []
    for (const e of entries.values()) {
      const s = sessions.get(e.sessionId)
      const target = s?.target ?? ''
      if (f.status && e.status !== f.status) continue
      if (!has(target, f.node.trim())) continue
      if (!has(e.by, f.by.trim())) continue
      const t = f.text.trim()
      if (t && ![e.description, e.command, e.stdout, e.stderr, e.reason].some((v) => has(v, t))) continue
      hits.push({ entry: e, target, installation: s?.installationName ?? '' })
    }
    hits.sort((a, b) => b.entry.requestedAt - a.entry.requestedAt)
    return { hits: hits.slice(0, SEARCH_LIMIT), total: hits.length, days }
  },

  /** The matching commands as Markdown (to read) or JSONL (to process). */
  format(result: HistoryResult, kind: 'md' | 'jsonl'): string {
    if (kind === 'jsonl')
      return (
        result.hits
          .map((h) =>
            JSON.stringify({
              ...h.entry,
              target: h.target,
              installation: h.installation,
            }),
          )
          .join('\n') + '\n'
      )
    const fence = (s: string) => '```\n' + s.replace(/```/g, '`​``') + '\n```'
    return [
      `# tsheep history`,
      '',
      `${result.hits.length} commands, exported ${new Date().toISOString()}`,
      '',
      ...result.hits.map((h) => {
        const e = h.entry
        return [
          `## ${new Date(e.requestedAt).toISOString().replace('T', ' ').slice(0, 19)} · ${h.target} · ${e.status}${e.exitCode !== null ? ` (exit ${e.exitCode})` : ''}`,
          '',
          `${e.description}`,
          '',
          `By ${e.by}${e.byClaudeId ? ` (\`claude -r ${e.byClaudeId}\`)` : ''}${e.reason ? `. Reason: ${e.reason}` : ''}`,
          '',
          fence(e.command),
          e.stdout ? `\nstdout:\n\n${fence(e.stdout)}` : '',
          e.stderr ? `\nstderr:\n\n${fence(e.stderr)}` : '',
          '',
        ].join('\n')
      }),
    ].join('\n')
  },
}

/** Every session and the last state of every entry in the newest `days` files. */
function read(days: number): {
  sessions: Map<string, Session>
  entries: Map<string, Entry>
  days: number
} {
  const sessions = new Map<string, Session>()
  const entries = new Map<string, Entry>()
  let count = 0
  try {
    const d = dir()
    const all = readdirSync(d)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
    const files = Number.isFinite(days) ? all.slice(-days) : all
    count = files.length
    for (const f of files) {
      const path = join(d, f)
      if (!existsSync(path)) continue
      for (const raw of readFileSync(path, 'utf8').split('\n')) {
        if (!raw.trim()) continue
        try {
          const line = JSON.parse(raw) as Line
          if (line.kind === 'session') {
            const earlier = sessions.get(line.session.id)
            sessions.set(line.session.id, {
              ...line.session,
              state: 'closed',
              error: line.session.error ?? earlier?.error ?? 'from an earlier run of tsheep',
            })
          } else entries.set(line.entry.id, line.entry)
        } catch {
          /* a torn line at the end of a file */
        }
      }
    }
  } catch (e) {
    console.error('[history] could not read', e)
  }
  return { sessions, entries, days: count }
}
