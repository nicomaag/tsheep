import { Eye, EyeOff, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Badge, ByChip, CopyButton, TopBar } from '../components/ui'
import { ago } from '../format'
import { useStore } from '../store'

export function ConnectView() {
  const platform = useStore((s) => s.platform)
  const mcp = useStore((s) => s.mcp)
  const [command, setCommand] = useState('')
  const [token, setToken] = useState('')
  const [show, setShow] = useState(false)

  const load = () =>
    window.tsheep.mcp.connectInfo().then((info) => {
      setCommand(info.command)
      setToken(info.token)
    })

  useEffect(() => {
    void load()
  }, [mcp.port])

  const rotate = async () => {
    await window.tsheep.mcp.rotateToken()
    await load()
  }

  const masked = token ? token.slice(0, 4) + '•'.repeat(Math.max(8, token.length - 8)) + token.slice(-4) : ''

  return (
    <>
      <TopBar title="Connect Claude" platform={platform} />
      <div className="main-scroll">
        <div className="content stack" style={{ gap: 14 }}>
          <p className="page-lead" style={{ margin: 0 }}>
            tsheep speaks MCP over HTTP on this machine only. Run the command once per computer and every Claude Code session can list nodes, open shells and run commands here, each one shown live in tsheep.
          </p>

          <div className="card card-pad stack">
            <div className="row">
              <strong>Server</strong>
              {mcp.running ? <Badge tone="green">running</Badge> : <Badge tone="red">{mcp.error ?? 'stopped'}</Badge>}
            </div>
            <div className="copy-block">
              <code>{mcp.url}</code>
              <CopyButton text={mcp.url} small />
            </div>
            <div className="row">
              <strong>Token</strong>
              <button type="button" className="btn icon ghost sm" onClick={() => setShow((v) => !v)} title={show ? 'Hide' : 'Show'}>
                {show ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <div className="copy-block">
              <code>{show ? token : masked}</code>
              <CopyButton text={token} small />
            </div>
            <div className="row">
              <strong>Add to Claude Code</strong>
              <span className="muted small">user scope, so it works in every repo</span>
            </div>
            <div className="copy-block">
              <code>{show ? command : command.replace(token, masked)}</code>
              <CopyButton text={command} small />
            </div>
            <div className="row">
              <button type="button" className="btn sm" onClick={() => void rotate()}>
                <RefreshCw size={13} /> Rotate token
              </button>
              <span className="muted small">Rotating disconnects every client; they need the new command.</span>
            </div>
          </div>

          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 6 }}>
              <strong>Connected clients</strong>
              <Badge>{mcp.clients.length}</Badge>
            </div>
            {mcp.clients.length === 0 ? <div className="muted small">No Claude session is connected right now.</div> : null}
            {mcp.clients.map((c) => (
              <div key={c.id} className="client-row">
                <ByChip by={c.label} claudeId={c.claudeSessionId} repo={c.repo} branch={c.branch} ownLabel={c.ownLabel} ownId={c.ownSessionId} />
                <span className="grow muted small truncate">
                  {c.name}
                  {c.repo ? ` · ${c.repo}${c.branch ? ` @ ${c.branch}` : ''}` : ''}
                </span>
                {c.resumeCommand ? (
                  <span className="row small" style={{ gap: 4 }}>
                    <code>{c.resumeCommand}</code>
                    <CopyButton text={c.resumeCommand} small />
                  </span>
                ) : null}
                <span className="muted small">
                  connected {ago(c.connectedAt)} · active {ago(c.lastSeenAt)}
                </span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <strong>What Claude gets</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--text-2)' }}>
              <li>
                <code>identify</code> – names the Claude session (repo and task), shown next to each of its commands
              </li>
              <li>
                <code>list_installations</code>, <code>register_installation</code>, <code>login</code> – which tsh exists here, add one, start a login
              </li>
              <li>
                <code>list_nodes</code>, <code>list_sessions</code>, <code>open_session</code> – find a node, reuse or open a shell (one MFA tap)
              </li>
              <li>
                <code>run</code> – one command with a mandatory description, answered with stdout, stderr and exit code
              </li>
              <li>
                <code>list_secrets</code>, <code>forget_secret</code> – names of remembered secrets (never values), and dropping one
              </li>
              <li>
                <code>close_session</code> – when a shell is no longer needed
              </li>
            </ul>
          </div>
        </div>
      </div>
    </>
  )
}
