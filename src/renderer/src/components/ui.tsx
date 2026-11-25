import { Check, Copy, Lock, Minus, Square, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { NodeShell, Session } from '@shared/types'

export function Dot({ session, inline }: { session: Pick<Session, 'state' | 'error'>; inline?: boolean }) {
  const cls = session.state === 'closed' && session.error && !/closed|idle|quit/i.test(session.error) ? 'error' : session.state
  return <span className={`dot ${cls}${inline ? ' inline' : ''}`} />
}

/** Free or approve, as a two-way switch. */
export function ModeToggle({ mode, lockedBy, onChange }: { mode: 'free' | 'approve'; lockedBy?: string | null; onChange: (mode: 'free' | 'approve') => void }) {
  if (lockedBy) {
    return (
      <div className="tabs mode-toggle" title={`Fixed to approve by the node rule "${lockedBy}" (Settings → Node rules)`}>
        <span className="tab approve active locked">
          <Lock size={11} /> Approve each
        </span>
      </div>
    )
  }
  return (
    <div className="tabs mode-toggle" role="radiogroup" aria-label="Session mode">
      <button type="button" className={`tab${mode === 'free' ? ' active' : ''}`} onClick={() => onChange('free')} title="Claude runs commands without asking">
        Free
      </button>
      <button type="button" className={`tab approve${mode === 'approve' ? ' active' : ''}`} onClick={() => onChange('approve')} title="Every command waits for your OK here">
        Approve each
      </button>
    </div>
  )
}

/**
 * Who did something, with a colour that stays the same for the same name, so
 * two Claude sessions sharing one shell can be told apart at a glance.
 */
export function ByChip({ by, claudeId, repo, branch, ownLabel, ownId }: { by: string; claudeId?: string | null; repo?: string | null; branch?: string | null; ownLabel?: string | null; ownId?: string | null }) {
  const [copied, setCopied] = useState(false)
  let h = 0
  for (const ch of claudeId ?? by) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const hue = h % 360
  const resume = claudeId ? `claude -r ${claudeId}` : null
  const tooltip = resume
    ? [
        `Claude session: ${by}`,
        `id: ${claudeId}`,
        repo ? `repo: ${repo}${branch ? ` @ ${branch}` : ''}` : null,
        `resume: ${resume}`,
        ownId ? `ran via a session Claude started: ${ownLabel ?? ''} (${ownId})` : null,
        'click to copy the resume command',
      ]
        .filter(Boolean)
        .join('\n')
    : `Run by ${by}`
  return (
    <span
      className={`by-chip${resume ? ' copyable' : ''}`}
      title={tooltip}
      onClick={(e) => {
        if (!resume) return
        e.stopPropagation()
        void navigator.clipboard.writeText(resume).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      <span className="by-dot" style={{ background: `hsl(${hue} 65% 52%)` }} />
      {copied ? 'resume command copied' : by}
      {claudeId && !copied ? <span className="by-id">{claudeId.slice(0, 8)}</span> : null}
      {ownId && !copied ? <span className="by-sub" title={`${ownLabel ?? 'sub-session'} (${ownId})`}>via sub-session</span> : null}
    </span>
  )
}

/**
 * The node settings a command ran with, so nothing about how it runs is hidden
 * from the person reading or approving it. Values show in the tooltip.
 */
export function ShellBadges({ shell }: { shell?: NodeShell }) {
  if (!shell) return null
  const vars = Object.entries(shell.env)
  if (!shell.login && vars.length === 0) return null
  return (
    <>
      {shell.login ? (
        <span className="badge" title="Runs as a login shell: /etc/profile, ~/.profile, ~/.bash_profile are read first">
          login shell
        </span>
      ) : null}
      {vars.length ? (
        <span className="badge mono shell-chip" title={vars.map(([k, v]) => `${k}=${v}`).join('\n')}>
          env {vars.map(([k]) => k).join(', ')}
        </span>
      ) : null}
    </>
  )
}

export function Badge({ tone, mono, children }: { tone?: 'green' | 'amber' | 'red' | 'blue' | 'purple'; mono?: boolean; children: ReactNode }) {
  return <span className={`badge${tone ? ` ${tone}` : ''}${mono ? ' mono' : ''}`}>{children}</span>
}

export function CopyButton({ text, small }: { text: string; small?: boolean }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`btn icon ghost${small ? ' sm' : ''}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
    </button>
  )
}

export function TopBar({ title, children, platform }: { title: ReactNode; children?: ReactNode; platform: string }) {
  return (
    <header className="main-top drag">
      <h1>{title}</h1>
      <span className="spacer" />
      <div className="row no-drag">{children}</div>
      {platform !== 'darwin' ? <WindowControls /> : null}
    </header>
  )
}

function WindowControls() {
  const act = (action: 'minimize' | 'maximize' | 'close') => () => void window.tsheep.windowControl(action)
  return (
    <div className="win-controls no-drag">
      <button type="button" className="win-btn" onClick={act('minimize')} title="Minimize">
        <Minus size={14} strokeWidth={1.75} />
      </button>
      <button type="button" className="win-btn" onClick={act('maximize')} title="Maximize">
        <Square size={11} strokeWidth={1.75} />
      </button>
      <button type="button" className="win-btn close" onClick={act('close')} title="Close">
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  )
}
