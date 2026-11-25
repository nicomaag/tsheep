import { Check, ChevronDown, ChevronRight, Clock, Eye, EyeOff, KeyRound, Loader2, Play, ShieldAlert, Square, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Entry } from '@shared/types'
import { Badge, ByChip, CopyButton, Dot, ModeToggle, ShellBadges, TopBar } from '../components/ui'
import { Colored } from '../components/Colored'
import { ago, clock, duration, stripAnsi } from '../format'
import { useEntriesFor, useStore } from '../store'

export function SessionView({ id }: { id: string }) {
  const platform = useStore((s) => s.platform)
  const session = useStore((s) => s.sessions[id])
  const entries = useEntriesFor(id)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [])

  if (!session) {
    return (
      <>
        <TopBar title="Session" platform={platform} />
        <div className="main-scroll">
          <div className="empty">This session is gone.</div>
        </div>
      </>
    )
  }

  const closed = session.state === 'closed'
  const pending = entries.filter((e) => e.status === 'pending').sort((a, b) => a.seq - b.seq)
  const rest = entries.filter((e) => e.status !== 'pending')

  return (
    <>
      <TopBar
        title={
          <span className="row">
            <Dot session={session} inline /> {session.target}
          </span>
        }
        platform={platform}
      >
        {!closed ? <ModeToggle mode={session.mode} lockedBy={session.lockedBy} onChange={(mode) => void window.tsheep.sessions.setMode(session.id, mode)} /> : null}
        {!closed ? (
          <button type="button" className="btn sm danger" onClick={() => void window.tsheep.sessions.close(session.id)}>
            <X size={13} /> Close shell
          </button>
        ) : (
          <button type="button" className="btn sm" onClick={() => void window.tsheep.sessions.close(session.id, true)}>
            <Trash2 size={13} /> Remove
          </button>
        )}
      </TopBar>

      <div className="main-scroll">
        <div className="content">
          <div className="session-head">
            <div className="grow">
              <h2>{session.target}</h2>
              <div className="session-meta row wrap">
                <Badge>{session.installationName}</Badge>
                <Badge tone={session.mode === 'free' ? 'green' : 'purple'}>
                  {session.mode === 'free' ? 'free mode' : 'approve each command'}
                  {session.lockedBy ? ` · rule ${session.lockedBy}` : ''}
                </Badge>
                <StateBadge state={session.state} />
                <span className="muted small row" style={{ gap: 4 }}>
                  opened by <ByChip by={session.openedBy} claudeId={session.openedByClaudeId} /> · {ago(session.createdAt)} · last used {ago(session.lastUsedAt)}
                </span>
              </div>
              <div className="session-purpose selectable">{session.purpose}</div>
              {session.state === 'connecting' ? (
                <div className="notice amber" style={{ marginTop: 12 }}>
                  <Loader2 size={15} className="spin" />
                  <span>Opening the shell. Teleport asks for MFA now, approve it in the browser or on your device. The shell waits up to three minutes.</span>
                </div>
              ) : null}
              {closed && session.error ? (
                <div className="notice red" style={{ marginTop: 12 }}>
                  <X size={15} />
                  <span className="selectable" style={{ whiteSpace: 'pre-wrap' }}>
                    {session.error}
                  </span>
                </div>
              ) : null}
            </div>
          </div>

          {!closed ? <Composer sessionId={session.id} disabled={session.state === 'connecting'} /> : null}

          {pending.length ? (
            <div className="timeline" style={{ marginBottom: 14 }}>
              {pending.map((e) => (
                <PendingCard key={e.id} entry={e} />
              ))}
            </div>
          ) : null}

          {entries.length === 0 ? (
            <div className="empty card">
              <Clock size={20} />
              <h3>Nothing ran yet</h3>
              <div>Every command a Claude session runs here shows up the moment it starts, with its description, the command and the live output.</div>
            </div>
          ) : (
            <div className="timeline">
              {rest.map((e, i) => (
                <EntryCard key={e.id} entry={e} latest={i === 0} />
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * A command of the person's own, typed into this shell. It runs like any
 * other (in its own child shell, with the node's settings) but needs no
 * approval: the person approving would be the person typing.
 */
function Composer({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [command, setCommand] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [past, setPast] = useState<string[]>([])
  const [back, setBack] = useState(-1)
  const send = () => {
    const c = command.trim()
    if (!c) return
    setError(null)
    window.tsheep.sessions.run(sessionId, c).then(
      () => {
        setPast((p) => [c, ...p.filter((x) => x !== c)].slice(0, 50))
        setBack(-1)
        setCommand('')
      },
      (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')),
    )
  }
  return (
    <div className="composer">
      <span className="prompt">$</span>
      <input
        className="input mono"
        placeholder="Run a command yourself. Enter runs it, ↑ brings back the last ones"
        value={command}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            send()
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && past.length) {
            e.preventDefault()
            const next = Math.max(-1, Math.min(past.length - 1, back + (e.key === 'ArrowUp' ? 1 : -1)))
            setBack(next)
            setCommand(next === -1 ? '' : past[next])
          }
        }}
      />
      <button type="button" className="btn sm" onClick={send} disabled={disabled || !command.trim()}>
        <Play size={12} /> Run
      </button>
      {error ? <div className="composer-error">{error}</div> : null}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  if (state === 'ready') return <Badge tone="green">ready</Badge>
  if (state === 'busy') return <Badge tone="blue">running</Badge>
  if (state === 'pending') return <Badge tone="purple">waiting for you</Badge>
  if (state === 'connecting') return <Badge tone="amber">connecting</Badge>
  return <Badge>closed</Badge>
}

/**
 * One command waiting for a person. Shown above the timeline, with the
 * description first, the command verbatim, how long the question stays open,
 * and two answers. Deny takes an optional reason that goes back to Claude.
 */
/** How long the keyboard answers nothing after a pending card took the focus. */
const GUARD_MS = 1000

function PendingCard({ entry }: { entry: Entry }) {
  const [reason, setReason] = useState('')
  const [answered, setAnswered] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [remember, setRemember] = useState<'none' | 'session' | 'always'>('session')
  const needed = entry.needs?.secrets ?? []
  const firstInput = useRef<HTMLInputElement>(null)
  const runButton = useRef<HTMLButtonElement>(null)
  // The window jumps to the front while the person types somewhere else, and
  // those keys land here. So the keyboard answers nothing for a moment after
  // the card appeared or the window got focus, and typing on the Run button
  // pushes that moment out. Space never answers; a mouse click always does.
  const quietUntil = useRef(Date.now() + GUARD_MS)
  const quiet = () => Date.now() < quietUntil.current

  // Keyboard focus lands where the answer is typed: the first secret field, or
  // the Run button. Again whenever the window regains focus, because main
  // brings it to the front while the person is still typing elsewhere.
  useEffect(() => {
    const place = () => {
      if (answered) return
      const target = needed.length ? firstInput.current : runButton.current
      if (target && document.activeElement !== target) target.focus()
    }
    // The OS may hand the window focus before this card exists, so it is
    // placed now, again shortly after, and whenever the window regains focus.
    place()
    const timers = [50, 200, 500, 1000].map((ms) => setTimeout(place, ms))
    const onFocus = () => {
      quietUntil.current = Date.now() + GUARD_MS
      place()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      timers.forEach(clearTimeout)
      window.removeEventListener('focus', onFocus)
    }
  }, [answered, needed.length])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !answered && !quiet()) answer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  const complete = needed.every((n) => (values[n] ?? '').length > 0)
  const total = entry.expiresAt ? entry.expiresAt - entry.requestedAt : 1
  const left = Math.max(0, (entry.expiresAt ?? Date.now()) - Date.now())
  const fraction = Math.min(1, Math.max(0, left / total))
  const tone = left <= 15_000 ? 'red' : left <= 60_000 ? 'amber' : 'purple'

  const answer = (allow: boolean) => {
    if (answered) return
    setAnswered(true)
    void window.tsheep.approvals.answer(entry.id, allow ? { allow: true, secrets: needed.length ? values : undefined, remember: needed.length ? remember : undefined } : { allow: false, reason: reason.trim() || 'Denied in tsheep.' })
  }

  return (
    <article className="entry pending">
      <div className="entry-head">
        <span className="entry-status pending">{needed.length ? <KeyRound size={12} strokeWidth={2.5} /> : <ShieldAlert size={12} strokeWidth={2.5} />}</span>
        <div className="grow">
          <div className="entry-title">{entry.description}</div>
          <div className="entry-sub">
            <ByChip by={entry.by} claudeId={entry.byClaudeId} repo={entry.byRepo} branch={entry.byBranch} ownLabel={entry.byOwnLabel} ownId={entry.byOwnId} />
            <ShellBadges shell={entry.shell} />
            <span>{needed.length ? `needs ${needed.length === 1 ? 'a secret' : `${needed.length} secrets`}` : 'asks to run this'}</span>
            <span>·</span>
            <span>{clock(entry.requestedAt)}</span>
          </div>
        </div>
        <div className={`countdown ${tone}`} title="Refused on its own when the time runs out">
          <svg viewBox="0 0 36 36" width="28" height="28" aria-hidden="true">
            <circle cx="18" cy="18" r="14" className="countdown-track" />
            <circle cx="18" cy="18" r="14" className="countdown-arc" strokeDasharray={2 * Math.PI * 14} strokeDashoffset={2 * Math.PI * 14 * (1 - fraction)} />
          </svg>
          <span className="mono">{formatLeft(left)}</span>
        </div>
      </div>
      <div className="entry-cmd">
        <span className="prompt">$</span>
        <pre>{entry.command}</pre>
        <CopyButton text={entry.command} small />
      </div>
      {entry.shell && Object.keys(entry.shell.env).length ? (
        <div className="entry-env">
          <span className="muted small">runs with</span>
          <pre>{Object.entries(entry.shell.env).map(([k, v]) => `${k}=${v}`).join('\n')}</pre>
        </div>
      ) : null}
      {needed.length ? (
        <div className="secret-fields">
          <div className="small muted" style={{ marginBottom: 6 }}>
            The value goes straight into the shell and is removed from the output. Claude only ever sees the placeholder.
          </div>
          {needed.map((name, i) => (
            <label key={name} className="secret-field">
              <code>{`{{secret:${name}}}`}</code>
              <input
                ref={i === 0 ? firstInput : undefined}
                className="input mono"
                type="password"
                autoComplete="off"
                placeholder="value"
                value={values[name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
                onKeyDown={(e) => e.key === 'Enter' && complete && !quiet() && answer(true)}
                disabled={answered}
              />
            </label>
          ))}
          <div className="row small" style={{ marginTop: 6 }}>
            <span className="muted">Remember</span>
            <select className="select" style={{ width: 'auto', height: 24, fontSize: 12 }} value={remember} onChange={(e) => setRemember(e.target.value as typeof remember)} disabled={answered}>
              <option value="none">only for this command</option>
              <option value="session">until tsheep quits</option>
              <option value="always">on this machine (encrypted)</option>
            </select>
          </div>
        </div>
      ) : null}
      <div className="pending-actions">
        <input
          className="input"
          placeholder="Reason for denying (optional, Claude reads it). Enter denies."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          onKeyDown={(e) => {
            // Typing a reason means no: Enter here never runs the command.
            if (e.key === 'Enter') {
              e.preventDefault()
              answer(false)
            }
          }}
          disabled={answered}
        />
        <button type="button" className="btn" onClick={() => answer(false)} disabled={answered}>
          <X size={13} /> Deny
        </button>
        <button
          ref={runButton}
          type="button"
          className="btn primary"
          title="Enter or click"
          onKeyDown={(e) => {
            // Any other key here is typing that was meant for another window.
            if (!['Enter', 'Escape', 'Tab', 'Shift'].includes(e.key)) quietUntil.current = Date.now() + GUARD_MS
            if (e.key === ' ') e.preventDefault()
          }}
          onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
          onClick={(e) => {
            // detail 0 is a click made by the keyboard; the mouse always counts.
            if (e.detail === 0 && quiet()) return
            answer(true)
          }}
          disabled={answered || !complete}
        >
          <Check size={13} /> Run it
        </button>
      </div>
    </article>
  )
}

function formatLeft(ms: number): string {
  const s = Math.ceil(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function EntryCard({ entry, latest, where }: { entry: Entry; latest: boolean; where?: string }) {
  // Secret values are masked everywhere; the person can reveal them here,
  // and only here. The raw text comes from main on demand and stays local.
  const [revealed, setRevealed] = useState<{ command: string; stdout: string; stderr: string } | null>(null)
  const [revealGone, setRevealGone] = useState(false)
  const out = stripAnsi(revealed?.stdout ?? entry.stdout)
  const err = stripAnsi(revealed?.stderr ?? entry.stderr)
  const toggleReveal = () => {
    if (revealed) return setRevealed(null)
    void window.tsheep.secrets.reveal(entry.id).then((r) => (r ? setRevealed(r) : setRevealGone(true)))
  }
  const lines = (out ? out.split('\n').length : 0) + (err ? err.split('\n').length : 0)
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (entry.status === 'running' || latest || lines <= 12)
  const running = entry.status === 'running'
  const denied = entry.status === 'denied'
  const halted = entry.status === 'stopped' || entry.status === 'timeout'
  const ms = (entry.finishedAt ?? Date.now()) - entry.startedAt
  const [stopping, setStopping] = useState(false)

  return (
    <article className={`entry ${entry.status}`}>
      <div className="entry-head">
        <span className={`entry-status ${entry.status}`}>
          {running ? <Loader2 size={12} className="spin" /> : entry.status === 'done' ? <Check size={12} strokeWidth={2.5} /> : entry.status === 'timeout' ? <Clock size={12} /> : entry.status === 'stopped' ? <Square size={10} strokeWidth={2.5} /> : denied ? <ShieldAlert size={12} strokeWidth={2.5} /> : <X size={12} strokeWidth={2.5} />}
        </span>
        <div className="grow">
          <div className="entry-title">{entry.description}</div>
          <div className="entry-sub">
            {where ? (
              <>
                <span className="mono">{where}</span>
                <span>·</span>
              </>
            ) : null}
            <span>{where ? `${new Date(entry.requestedAt).toLocaleDateString()} ` : ''}{clock(entry.requestedAt)}</span>
            {!denied ? (
              <>
                <span>·</span>
                <span>{running ? `running ${duration(ms)}` : duration(ms)}</span>
              </>
            ) : null}
            {entry.exitCode !== null ? (
              <>
                <span>·</span>
                <span className={entry.exitCode === 0 ? '' : 'badge red'}>exit {entry.exitCode}</span>
              </>
            ) : null}
            {entry.status === 'timeout' ? <span className="badge red">timed out</span> : null}
            {entry.status === 'stopped' ? <span className="badge amber">stopped</span> : null}
            {denied ? <span className="badge red">not run</span> : null}
            {entry.secretNames.length ? (
              <span className="badge purple" title="The values were inserted by tsheep and never shown to Claude">
                <KeyRound size={10} /> {entry.secretNames.join(', ')}
              </span>
            ) : null}
            <ShellBadges shell={entry.shell} />
            <span>·</span>
            <ByChip by={entry.by} claudeId={entry.byClaudeId} repo={entry.byRepo} branch={entry.byBranch} ownLabel={entry.byOwnLabel} ownId={entry.byOwnId} />
          </div>
        </div>
        {running && !where ? (
          <button
            type="button"
            className="btn sm danger"
            title="Ends this command (TERM, KILL after 5 s). The shell stays open."
            disabled={stopping}
            onClick={() => {
              setStopping(true)
              void window.tsheep.sessions.stop(entry.id)
            }}
          >
            <Square size={10} /> {stopping ? 'Stopping…' : 'Stop'}
          </button>
        ) : null}
      </div>
      <div className={`entry-cmd${revealed ? ' revealed' : ''}`}>
        <span className="prompt">$</span>
        <pre>{revealed?.command ?? entry.command}</pre>
        {entry.secretNames.length && !running && entry.status !== 'denied' ? (
          <button type="button" className="btn icon ghost sm reveal" title={revealGone ? 'The values of this command are gone (tsheep was restarted since)' : revealed ? 'Mask the secret values again' : 'Show the real values, only here, never to Claude'} onClick={toggleReveal} disabled={revealGone}>
            {revealed ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        ) : null}
        <CopyButton text={revealed?.command ?? entry.command} small />
      </div>
      {(denied || halted) && entry.reason ? <div className="entry-reason">{entry.reason}</div> : null}
      {out || err || running ? (
        <div className="entry-out">
          <button type="button" className="entry-out-bar" onClick={() => setOpen(!expanded)}>
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span>
              {running ? 'live output' : `${lines} line${lines === 1 ? '' : 's'}`}
              {err && !running ? ' · has stderr' : ''}
              {revealed ? ' · secrets revealed' : ''}
            </span>
          </button>
          {expanded ? (
            <>
              {out || running ? (
                <pre>
                  <Colored text={out} />
                  {running ? <span className="caret" /> : null}
                </pre>
              ) : null}
              {err ? (
                <pre className="stderr">
                  <Colored text={err} />
                </pre>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}
