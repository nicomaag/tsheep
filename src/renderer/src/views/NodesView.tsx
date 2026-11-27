import { ArrowRight, KeyRound, Loader2, Plus, RefreshCw, Search, Server, Settings2, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ENV_KEY, matchNodeRule, nodeShellFor, type TshNode } from '@shared/types'
import { Badge, TopBar } from '../components/ui'
import { until } from '../format'
import { useSessionList, useStore } from '../store'

/**
 * The mode for one node, right on its row. Saved as a rule with the exact
 * node name at the front of the list, so it beats any wildcard rule; choosing
 * "default" removes that exact rule again and a wildcard, if any, shows through.
 */
function NodeModePicker({ node }: { node: string }) {
  const rules = useStore((s) => s.settings.nodeRules)
  const exact = rules.find((r) => r.pattern.trim().toLowerCase() === node.toLowerCase())
  const effective = matchNodeRule(rules, node)
  const value = exact ? exact.mode : 'default'
  const set = (next: string) => {
    const rest = rules.filter((r) => r.pattern.trim().toLowerCase() !== node.toLowerCase())
    void window.tsheep.settings.set({ nodeRules: next === 'default' ? rest : [{ pattern: node, mode: next as 'approve' | 'free' }, ...rest] })
  }
  // A wildcard rule shows through in the "default" option's own text, so the
  // row stays one line and the select keeps one width for every node.
  const viaRule = !exact && effective ? ` (${effective.mode === 'approve' ? 'always approve' : 'starts free'} via ${effective.pattern})` : ''
  return (
    <select
      className={`select node-mode ${exact ? value : effective ? `via-${effective.mode}` : 'default'}`}
      value={value}
      onChange={(e) => set(e.target.value)}
      title="Mode for sessions on this node"
    >
      <option value="default">default{viaRule}</option>
      <option value="approve">always approve (locked)</option>
      <option value="free">starts free</option>
    </select>
  )
}

/** The cog on a node row; it shows a dot when the node has shell settings. */
function NodeShellButton({ node, open, onToggle }: { node: string; open: boolean; onToggle: () => void }) {
  const all = useStore((s) => s.settings.nodeShell)
  const s = nodeShellFor(all, node)
  const set = s.login || Object.keys(s.env).length > 0
  return (
    <button type="button" className={`btn icon sm${open ? '' : ' ghost'} node-cog${set ? ' set' : ''}`} onClick={onToggle} title="How commands start on this node">
      <Settings2 size={14} />
    </button>
  )
}

/**
 * How commands start on one node: login shell or not, plus variables. Saved
 * at once; Claude sessions can change the same thing through set_node_settings.
 */
function NodeShellPanel({ node }: { node: string }) {
  const all = useStore((s) => s.settings.nodeShell)
  const s = nodeShellFor(all, node)
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const patch = (p: { login?: boolean; env?: Record<string, string | null> }) =>
    window.tsheep.installations
      .setNodeShell(node, p)
      .then(() => setError(null))
      .catch((e: Error) => setError(e.message))
  const add = () => {
    const k = key.trim()
    if (!ENV_KEY.test(k)) return setError('Variable names are letters, digits and _, not starting with a digit.')
    void patch({ env: { [k]: value } })
    setKey('')
    setValue('')
  }

  return (
    <div className="node-shell">
      <label className="row">
        <input type="checkbox" checked={s.login} onChange={(e) => void patch({ login: e.target.checked })} />
        <span>
          <strong>Login shell</strong> <span className="muted">reads /etc/profile, ~/.profile and ~/.bash_profile before each command, like your own login does</span>
        </span>
      </label>
      <div className="small muted" style={{ margin: '10px 0 6px' }}>
        Variables for every command on this node
      </div>
      {Object.entries(s.env).map(([k, v]) => (
        <div key={k} className="env-row">
          <code>{k}</code>
          <code className="grow truncate selectable">{v}</code>
          <button type="button" className="btn sm ghost danger" onClick={() => void patch({ env: { [k]: null } })}>
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input className="input mono" style={{ width: 180 }} placeholder="KUBECONFIG" value={key} onChange={(e) => setKey(e.target.value)} />
        <input className="input mono grow" placeholder="/etc/kubernetes/admin.conf" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button type="button" className="btn sm" onClick={add} disabled={!key.trim()}>
          <Plus size={13} /> Add
        </button>
      </div>
      {error ? (
        <div className="notice red" style={{ marginTop: 8 }}>
          {error}
        </div>
      ) : null}
    </div>
  )
}

const WAIT = 'Another shell is still connecting. One MFA prompt at a time, or they block each other.'

export function NodesView() {
  const platform = useStore((s) => s.platform)
  const installations = useStore((s) => s.installations)
  const statuses = useStore((s) => s.statuses)
  const settings = useStore((s) => s.settings)
  const setView = useStore((s) => s.setView)
  const [instId, setInstId] = useState<string | null>(null)
  const [nodes, setNodes] = useState<TshNode[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [configuring, setConfiguring] = useState<string | null>(null)
  const [user, setUser] = useState('')
  const [purpose, setPurpose] = useState('')
  const [opening, setOpening] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)

  const inst = installations.find((i) => i.id === instId) ?? installations[0] ?? null
  const status = inst ? statuses[inst.id] : undefined
  const sessions = useSessionList()
  // One MFA prompt at a time: a second tsh ssh while one still waits for its
  // tap blocks both. Counts shells Claude sessions are opening as well.
  const pendingShell = sessions.find((s) => s.state === 'connecting')
  const connecting = opening || Boolean(pendingShell)
  /** The newest shell on a node that is not closed, to jump to instead of opening another. */
  const openOn = (node: string) => sessions.find((s) => s.installationId === inst?.id && s.node === node && s.state !== 'closed')

  useEffect(() => {
    if (!inst) return
    setNodes(null)
    setError(null)
    setPicked(null)
    if (!status?.loggedIn) return
    setLoading(true)
    window.tsheep.installations
      .nodes(inst.id)
      .then(setNodes)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }, [inst?.id, status?.loggedIn])

  // The login belongs to the installation: switching from one whose logins are
  // root/ubuntu to one with only ec2-user must not keep "root".
  useEffect(() => {
    const logins = status?.logins ?? []
    if (logins.length && !logins.includes(user)) setUser(logins[0])
  }, [status?.logins, user])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (nodes ?? []).filter((n) => !q || n.name.toLowerCase().includes(q) || Object.values(n.labels).some((v) => v.toLowerCase().includes(q)))
  }, [nodes, query])

  const refresh = () => {
    if (!inst) return
    setLoading(true)
    void window.tsheep.installations
      .refresh(inst.id)
      .then(() => window.tsheep.installations.nodes(inst.id, true))
      .then(setNodes)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))
  }

  const login = () => {
    if (!inst) return
    setLoginBusy(true)
    void window.tsheep.installations.login(inst.id, status?.user ?? null).finally(() => setLoginBusy(false))
  }

  const open = async (node: string) => {
    if (!inst || !user || connecting || purpose.trim().length < 8) return
    setError(null)
    setOpening(true)
    try {
      const session = await window.tsheep.sessions.open({ installationId: inst.id, node, user, purpose: purpose.trim(), mode: settings.defaultMode })
      setView({ kind: 'session', id: session.id })
      setPurpose('')
      setPicked(null)
    } catch (e) {
      // Electron puts "Error invoking remote method …" in front; a connect the
      // person cancelled themselves is not an error to show.
      const message = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setError(message.includes('closed in tsheep') ? null : message)
    } finally {
      setOpening(false)
    }
  }

  return (
    <>
      <TopBar title="Nodes" platform={platform}>
        {inst ? (
          <button type="button" className="btn sm" onClick={refresh} disabled={loading}>
            <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
        ) : null}
      </TopBar>
      <div className="main-scroll">
        <div className="content stack" style={{ gap: 14 }}>
          {installations.length === 0 ? (
            <div className="empty card">
              <Server size={20} />
              <h3>No tsh installation registered</h3>
              <div>Go to Installations and press Discover, or tell your Claude: “register my tsh at C:\…\tsh.exe with TELEPORT_HOME …”.</div>
              <button type="button" className="btn" style={{ marginTop: 14 }} onClick={() => setView({ kind: 'installations' })}>
                Open Installations
              </button>
            </div>
          ) : (
            <>
              <div className="row wrap">
                <div className="tabs">
                  {installations.map((i) => (
                    <button key={i.id} type="button" className={`tab${inst?.id === i.id ? ' active' : ''}`} onClick={() => setInstId(i.id)}>
                      {i.name}
                    </button>
                  ))}
                </div>
                <span className="grow" />
                {status?.loggedIn ? (
                  <span className="row small muted">
                    <Badge tone="green">logged in</Badge> {status.user} · {inst?.cluster ?? inst?.proxy} · {until(status.validUntil)}
                  </span>
                ) : (
                  <span className="row small">
                    <Badge tone="amber">{status?.error ?? 'status unknown'}</Badge>
                    <button type="button" className="btn sm" onClick={login} disabled={loginBusy}>
                      {loginBusy ? <Loader2 size={13} className="spin" /> : <KeyRound size={13} />} tsh login
                    </button>
                  </span>
                )}
              </div>

              {status?.loggedIn ? (
                <>
                  <div className="row">
                    <Search size={14} className="muted" />
                    <input className="input" placeholder="Filter nodes by name or label" value={query} onChange={(e) => setQuery(e.target.value)} />
                  </div>
                  {error ? <div className="notice red">{error}</div> : null}
                  {pendingShell ? (
                    <div className="notice amber">
                      <Loader2 size={15} className="spin" />
                      <span className="grow">
                        Connecting to {pendingShell.target}, waiting for your MFA approval. Other shells can be opened once this one is connected.
                      </span>
                      <button type="button" className="btn sm" onClick={() => void window.tsheep.sessions.close(pendingShell.id)}>
                        Cancel
                      </button>
                    </div>
                  ) : null}
                  <div className="card node-list">
                    {loading && !nodes ? (
                      <div className="empty">
                        <Loader2 size={18} className="spin" />
                        <div style={{ marginTop: 8 }}>Asking tsh for nodes…</div>
                      </div>
                    ) : null}
                    {nodes && filtered.length === 0 ? <div className="empty">No nodes match.</div> : null}
                    {filtered.map((n) => {
                      const existing = openOn(n.name)
                      return (
                        <div key={n.name}>
                          <div className="node-row">
                            <Server size={15} className="muted" />
                            <div className="grow">
                              <div className="node-name">{n.name}</div>
                              <div className="node-labels">
                                {Object.entries(n.labels)
                                  .slice(0, 6)
                                  .map(([k, v]) => (
                                    <span key={k} className="badge mono">
                                      {k}={v}
                                    </span>
                                  ))}
                              </div>
                            </div>
                            <NodeModePicker node={n.name} />
                            <NodeShellButton node={n.name} open={configuring === n.name} onToggle={() => setConfiguring(configuring === n.name ? null : n.name)} />
                            {existing && picked !== n.name ? (
                              <>
                                <button
                                  type="button"
                                  className="btn icon sm ghost"
                                  onClick={() => setPicked(n.name)}
                                  disabled={connecting}
                                  title={connecting ? WAIT : 'Open another shell on this node, e.g. as another login'}
                                >
                                  <Plus size={14} />
                                </button>
                                <button type="button" className="btn sm" onClick={() => setView({ kind: 'session', id: existing.id })} title={`${existing.target} · ${existing.purpose}`}>
                                  Go to session <ArrowRight size={13} />
                                </button>
                              </>
                            ) : (
                              <button
                                type="button"
                                className={`btn sm${picked === n.name ? '' : ' primary'}`}
                                onClick={() => setPicked(picked === n.name ? null : n.name)}
                                disabled={connecting}
                                title={connecting ? WAIT : undefined}
                              >
                                {picked === n.name ? 'Cancel' : 'Open shell'}
                              </button>
                            )}
                          </div>
                          {configuring === n.name ? <NodeShellPanel node={n.name} /> : null}
                          {picked === n.name ? (
                            <div className="node-open">
                              <div className="field">
                                <label>Login as</label>
                                <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>
                                  {(status.logins.length ? status.logins : [user]).map((l) => (
                                    <option key={l} value={l}>
                                      {l}
                                    </option>
                                  ))}
                                </select>
                              </div>
                              <div className="field">
                                <label>Purpose (shown on the session)</label>
                                <input
                                  className="input"
                                  placeholder="e.g. Check disk usage on the runtime node"
                                  value={purpose}
                                  onChange={(e) => setPurpose(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && void open(n.name)}
                                  autoFocus
                                />
                              </div>
                              <button
                                type="button"
                                className="btn primary"
                                disabled={connecting || purpose.trim().length < 8}
                                title={connecting && !opening ? WAIT : undefined}
                                onClick={() => void open(n.name)}
                              >
                                {opening ? <Loader2 size={13} className="spin" /> : null} Open
                              </button>
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="notice amber">
                  <KeyRound size={15} />
                  <span>{inst?.name} has no valid certificate. Press “tsh login”, approve MFA in the browser, and the nodes appear here.</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  )
}
