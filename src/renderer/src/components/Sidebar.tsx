import { ChevronDown, ChevronRight, Download, History, Plug, Server, Settings, X } from 'lucide-react'
import { useState } from 'react'
import iconDark from '../../../../resources/icon-dark.png'
import iconLight from '../../../../resources/icon.png'
import { usePendingCounts, useSessionList, useStore, type View } from '../store'
import { Dot } from './ui'

/** Which session lists are folded; kept per machine in localStorage. */
type Folded = { open: boolean; closed: boolean }
const FOLDED_KEY = 'tsheep.sidebar.folded'

function loadFolded(): Folded {
  try {
    return { open: false, closed: false, ...JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '{}') }
  } catch {
    return { open: false, closed: false }
  }
}

function Chevron({ folded }: { folded: boolean }) {
  return folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />
}

export function Sidebar() {
  const platform = useStore((s) => s.platform)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const unseen = useStore((s) => s.unseen)
  const mcp = useStore((s) => s.mcp)
  const sessions = useSessionList()
  const pendingCounts = usePendingCounts()
  const open = sessions.filter((s) => s.state !== 'closed')
  const closed = sessions.filter((s) => s.state === 'closed')
  const [folded, setFolded] = useState<Folded>(loadFolded)
  /** Closed sessions ticked for removal; null while not selecting. */
  const [picked, setPicked] = useState<Set<string> | null>(null)

  const toggle = (key: keyof Folded) => {
    const next = { ...folded, [key]: !folded[key] }
    setFolded(next)
    try {
      localStorage.setItem(FOLDED_KEY, JSON.stringify(next))
    } catch {
      /* not kept, fine */
    }
  }
  const pick = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (!next.delete(id)) next.add(id)
      return next
    })
  const removeAll = (ids: string[]) => {
    for (const id of ids) void window.tsheep.sessions.close(id, true)
    setPicked(null)
  }

  const is = (v: View) => (view.kind === v.kind && (v.kind !== 'session' || (view as { id?: string }).id === (v as { id: string }).id) ? ' active' : '')

  return (
    <aside className="sidebar">
      <div className={`sidebar-top drag${platform === 'darwin' ? ' mac' : ''}`}>
        <div className="brand">
          <picture>
            <source srcSet={iconDark} media="(prefers-color-scheme: dark)" />
            <img className="brand-mark" src={iconLight} alt="" width={22} height={22} />
          </picture>
          tsheep
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="side-section">
          <button type="button" className="side-section-title side-toggle" onClick={() => toggle('open')}>
            <span>
              <Chevron folded={folded.open} /> Sessions
            </span>
            {open.length ? <span className="muted">{open.length}</span> : null}
          </button>
          {!folded.open && open.length === 0 ? <div className="side-empty">No open shells</div> : null}
          {!folded.open &&
            open.map((s) => (
              <button key={s.id} type="button" className={`side-item side-session${is({ kind: 'session', id: s.id })}`} onClick={() => setView({ kind: 'session', id: s.id })}>
                <Dot session={s} />
                <span className="side-session-main">
                  <span className="side-session-target">{s.target}</span>
                  <span className="side-session-sub">
                    {s.state === 'connecting' ? 'waiting for MFA' : s.state === 'pending' ? 'waiting for you' : s.openedBy} · {s.installationName}
                  </span>
                </span>
                {pendingCounts[s.id] ? <span className="count purple">{pendingCounts[s.id]}</span> : unseen[s.id] ? <span className="count">{unseen[s.id]}</span> : null}
              </button>
            ))}
          {closed.length ? (
            <>
              <div className="side-section-title side-closed-title">
                <button type="button" className="side-toggle" onClick={() => toggle('closed')}>
                  <Chevron folded={folded.closed} /> Closed <span className="side-num">{closed.length}</span>
                </button>
                {folded.closed ? null : picked ? (
                  <span className="side-actions">
                    <button type="button" onClick={() => setPicked(picked.size === closed.length ? new Set() : new Set(closed.map((s) => s.id)))}>
                      {picked.size === closed.length ? 'None' : 'All'}
                    </button>
                    <button type="button" className="danger" disabled={!picked.size} onClick={() => removeAll([...picked])}>
                      Remove{picked.size ? ` ${picked.size}` : ''}
                    </button>
                    <button type="button" onClick={() => setPicked(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <span className="side-actions">
                    <button type="button" onClick={() => setPicked(new Set())}>
                      Select
                    </button>
                  </span>
                )}
              </div>
              {folded.closed
                ? null
                : closed.map((s) => (
                    <div key={s.id} className="side-row">
                      <button
                        type="button"
                        className={`side-item side-session${picked ? '' : is({ kind: 'session', id: s.id })}`}
                        onClick={() => (picked ? pick(s.id) : setView({ kind: 'session', id: s.id }))}
                      >
                        {picked ? <input type="checkbox" className="side-check" checked={picked.has(s.id)} readOnly tabIndex={-1} /> : <Dot session={s} />}
                        <span className="side-session-main">
                          <span className="side-session-target muted">{s.target}</span>
                          <span className="side-session-sub">{s.entryCount} commands</span>
                        </span>
                      </button>
                      {picked ? null : (
                        <button type="button" className="side-remove" title="Remove from the list (History keeps it)" onClick={() => removeAll([s.id])}>
                          <X size={13} />
                        </button>
                      )}
                    </div>
                  ))}
            </>
          ) : null}
        </div>

        <div className="side-section">
          <div className="side-section-title">
            <span>Browse</span>
          </div>
          <button type="button" className={`side-item${is({ kind: 'nodes' })}`} onClick={() => setView({ kind: 'nodes' })}>
            <Server size={15} /> Nodes
          </button>
          <button type="button" className={`side-item${is({ kind: 'history' })}`} onClick={() => setView({ kind: 'history' })}>
            <History size={15} /> History
          </button>
          <button type="button" className={`side-item${is({ kind: 'installations' })}`} onClick={() => setView({ kind: 'installations' })}>
            <Download size={15} /> Installations
          </button>
          <button type="button" className={`side-item${is({ kind: 'connect' })}`} onClick={() => setView({ kind: 'connect' })}>
            <Plug size={15} /> Connect Claude
          </button>
          <button type="button" className={`side-item${is({ kind: 'settings' })}`} onClick={() => setView({ kind: 'settings' })}>
            <Settings size={15} /> Settings
          </button>
        </div>
      </div>

      <div className="side-bottom">
        <button type="button" className="mcp-pill" onClick={() => setView({ kind: 'connect' })}>
          <span className={`dot inline ${mcp.running ? 'ready' : 'error'}`} />
          <span className="grow truncate">{mcp.running ? `MCP on :${mcp.port}` : (mcp.error ?? 'MCP stopped')}</span>
          <span className="muted">
            {mcp.clients.length} client{mcp.clients.length === 1 ? '' : 's'}
          </span>
        </button>
      </div>
    </aside>
  )
}
