import { useMemo, type ReactNode } from 'react'

/**
 * Command output with the usual status words in colour, so "active (running)"
 * or "DOWN" stands out the way it would in a terminal. Commands run without a
 * terminal and send no colours themselves; this is a fixed list of words, seen
 * only in the window. What Claude gets back is the plain text.
 */
const GREEN = ['active \\((?:running|exited|listening|waiting|mounted|plugged)\\)', 'Running', 'Ready', 'Completed', 'Succeeded', 'Bound', 'Healthy', 'healthy', 'UP', 'OK', 'PASS(?:ED)?', 'SUCCESS']
const RED = [
  'inactive \\(dead\\)',
  'failed',
  'FAILED',
  'Failed',
  'ERROR',
  'Error',
  'error',
  'ALERT',
  'CRITICAL',
  'FATAL',
  'DOWN',
  'NotReady',
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'OOMKilled',
  'Evicted',
  'Unhealthy',
  'unhealthy',
  'Connection refused',
  'Permission denied',
]
const AMBER = ['WARNING', 'WARN', 'Warning', 'Pending', 'Terminating', 'ContainerCreating', 'activating', 'deactivating', 'degraded', 'Unknown']

const WORDS = new RegExp(`\\b(?:(?<green>${GREEN.join('|')})|(?<red>${RED.join('|')})|(?<amber>${AMBER.join('|')}))(?![\\w-])`, 'g')
/** Above this the text stays plain: thousands of spans would make scrolling slow. */
const MAX_CHARS = 400_000

export function Colored({ text }: { text: string }) {
  return useMemo(() => {
    if (text.length > MAX_CHARS) return <>{text}</>
    const parts: ReactNode[] = []
    let last = 0
    for (const m of text.matchAll(WORDS)) {
      const tone = m.groups?.green ? 'green' : m.groups?.red ? 'red' : 'amber'
      if (m.index > last) parts.push(text.slice(last, m.index))
      parts.push(
        <span key={m.index} className={`tone-${tone}`}>
          {m[0]}
        </span>,
      )
      last = m.index + m[0].length
    }
    parts.push(text.slice(last))
    return <>{parts}</>
  }, [text])
}
