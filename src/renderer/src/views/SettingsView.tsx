import { KeyRound, Lock, Plus, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { AttentionSound, AttentionWindow, NodeRule } from '@shared/types'
import { Badge, TopBar } from '../components/ui'
import { playSound } from '../sound'
import { useStore } from '../store'

/**
 * Modes fixed per node name. An approve rule is the one setting a person
 * cannot click away in the moment: sessions on matching nodes start in
 * approve and stay there until the rule is gone.
 */
function NodeRules() {
  const rules = useStore((s) => s.settings.nodeRules)
  const [pattern, setPattern] = useState('')
  const [mode, setMode] = useState<NodeRule['mode']>('approve')
  const save = (next: NodeRule[]) => void window.tsheep.settings.set({ nodeRules: next })
  const add = () => {
    const p = pattern.trim()
    if (!p) return
    save([...rules, { pattern: p, mode }])
    setPattern('')
  }

  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 6 }}>
        <Lock size={14} />
        <strong>Node rules</strong>
        <Badge>{rules.length}</Badge>
      </div>
      <div className="small muted" style={{ marginBottom: 10 }}>
        Match node names with <code>*</code> as wildcard; the first matching rule wins. <strong>Always approve</strong> locks every session on such nodes to approve, nothing and nobody can switch it to free. <strong>Starts free</strong> only sets the starting mode. Nodes without a rule use the default above.
      </div>
      {rules.map((r, i) => (
        <div key={`${r.pattern}-${i}`} className="client-row">
          <code>{r.pattern}</code>
          <Badge tone={r.mode === 'approve' ? 'purple' : 'green'}>{r.mode === 'approve' ? 'always approve' : 'starts free'}</Badge>
          <span className="grow" />
          <button type="button" className="btn sm ghost" disabled={i === 0} title="Move up" onClick={() => save(rules.map((x, j) => (j === i - 1 ? rules[i] : j === i ? rules[i - 1] : x)))}>
            ↑
          </button>
          <button type="button" className="btn sm ghost danger" onClick={() => save(rules.filter((_, j) => j !== i))}>
            <Trash2 size={13} /> Remove
          </button>
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        <input className="input mono" placeholder="web-*" value={pattern} onChange={(e) => setPattern(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <select className="select" style={{ width: 'auto' }} value={mode} onChange={(e) => setMode(e.target.value as NodeRule['mode'])}>
          <option value="approve">always approve (locked)</option>
          <option value="free">starts free</option>
        </select>
        <button type="button" className="btn primary" onClick={add} disabled={!pattern.trim()}>
          <Plus size={13} /> Add rule
        </button>
      </div>
    </div>
  )
}

/** Where this instance keeps its files, so a token or history question has an answer. */
function AboutCard() {
  const [paths, setPaths] = useState<Awaited<ReturnType<typeof window.tsheep.appPaths>> | null>(null)
  useEffect(() => {
    void window.tsheep.appPaths().then(setPaths)
  }, [])
  if (!paths) return null
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 6 }}>
        <strong>This tsheep</strong>
        <Badge mono>v{paths.version}</Badge>
        <Badge>{paths.packaged ? 'installed' : 'development'}</Badge>
      </div>
      <dl className="kv" style={{ marginTop: 4 }}>
        <dt>data folder</dt>
        <dd>{paths.userData}</dd>
        <dt>program</dt>
        <dd>{paths.exe}</dd>
      </dl>
      <div className="small muted" style={{ marginTop: 8 }}>
        config.json (installations, settings, MCP token), secrets.json (encrypted) and history/ (one JSONL per day) live in the data folder. Reinstalling keeps it.
      </div>
      <pre className="mono selectable small" style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>
        {[
          `config read ${new Date(paths.diagnostics.readAt).toLocaleTimeString()} from ${paths.diagnostics.path}`,
          paths.diagnostics.error ? `READ ERROR: ${paths.diagnostics.error}` : `${paths.diagnostics.bytes} bytes, token …${paths.diagnostics.tokenTail}, ${paths.diagnostics.rules} node rule(s)`,
          `head: ${paths.diagnostics.head.replace(/\s+/g, ' ')}`,
          `argv: ${paths.diagnostics.argv}`,
          `cwd: ${paths.diagnostics.cwd}`,
          `APPDATA: ${paths.diagnostics.appData}`,
        ].join('\n')}
      </pre>
    </div>
  )
}

export function SettingsView() {
  const platform = useStore((s) => s.platform)
  const settings = useStore((s) => s.settings)
  const secrets = useStore((s) => s.secrets)

  const update = (patch: Partial<typeof settings>) => void window.tsheep.settings.set(patch)

  return (
    <>
      <TopBar title="Settings" platform={platform} />
      <div className="main-scroll">
        <div className="content stack" style={{ gap: 14 }}>
          <div className="card card-pad form-grid">
            <div className="field">
              <label>Appearance</label>
              <select className="select" value={settings.theme} onChange={(e) => update({ theme: e.target.value as 'system' | 'light' | 'dark' })}>
                <option value="system">Follow system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <div className="field">
              <label>Default mode for new sessions</label>
              <select className="select" value={settings.defaultMode} onChange={(e) => update({ defaultMode: e.target.value as 'free' | 'approve' })}>
                <option value="free">free – Claude runs commands without asking</option>
                <option value="approve">approve – every command waits for your OK in tsheep</option>
              </select>
              <span className="hint">Can be switched per session in its header. In approve mode the window comes to the front for each command.</span>
            </div>
            <div className="field">
              <label>Close idle shells after (minutes)</label>
              <input className="input" type="number" min={0} max={1440} value={settings.idleMinutes} onChange={(e) => update({ idleMinutes: Math.max(0, Number(e.target.value) || 0) })} />
              <span className="hint">0 keeps them open until closed. Each reopen costs an MFA tap.</span>
            </div>
            <div className="field">
              <label>MCP port</label>
              <input className="input" type="number" min={1024} max={65535} value={settings.port} onChange={(e) => update({ port: Number(e.target.value) || settings.port })} />
              <span className="hint">Changing it restarts the server; connected Claude sessions need the new URL.</span>
            </div>
            <div className="field">
              <label>Approval timeout (minutes)</label>
              <input className="input" type="number" min={1} max={60} value={settings.approvalTimeoutMinutes} onChange={(e) => update({ approvalTimeoutMinutes: Math.min(60, Math.max(1, Number(e.target.value) || 5)) })} />
              <span className="hint">How long a command waits for your answer before it is refused on its own.</span>
            </div>
            <div className="field">
              <label>Closing the window</label>
              <select className="select" value={settings.closeToTray ? 'tray' : 'quit'} onChange={(e) => update({ closeToTray: e.target.value === 'tray' })}>
                <option value="tray">keeps tsheep running in the tray</option>
                <option value="quit">quits tsheep and closes all shells</option>
              </select>
              <span className="hint">The MCP server only answers while tsheep runs.</span>
            </div>
            <div className="field">
              <label>Claude session registry</label>
              <input className="input mono" value={settings.sessionRegistryUrl} placeholder="http://localhost:47870 (empty = off)" onChange={(e) => update({ sessionRegistryUrl: e.target.value })} />
              <span className="hint">When a Claude session identifies itself with its id, tsheep asks this registry for the session's title, repo and resume command.</span>
            </div>
            <div className="field">
              <label>When a command waits for you: window</label>
              <select className="select" value={settings.attentionWindow} onChange={(e) => update({ attentionWindow: e.target.value as AttentionWindow })}>
                <option value="front">comes to the front and takes the keyboard</option>
                <option value="flash">stays where it is, the taskbar entry flashes</option>
                <option value="none">does nothing</option>
              </select>
              <span className="hint">Applies to approvals and to secrets Claude asks for.</span>
            </div>
            <div className="field">
              <label>When a command waits for you: notification</label>
              <select className="select" value={settings.attentionNotification ? 'on' : 'off'} onChange={(e) => update({ attentionNotification: e.target.value === 'on' })}>
                <option value="on">show a system notification</option>
                <option value="off">none</option>
              </select>
              <span className="hint">A click on it opens tsheep.</span>
            </div>
            <div className="field">
              <label>When a command waits for you: sound</label>
              <select
                className="select"
                value={settings.attentionSound}
                onChange={(e) => {
                  update({ attentionSound: e.target.value as AttentionSound })
                  playSound(e.target.value as AttentionSound)
                }}
              >
                <option value="none">none</option>
                <option value="chime">chime – two rising notes</option>
                <option value="ping">ping – one high note</option>
                <option value="knock">knock – two low taps</option>
              </select>
              <span className="hint">
                With a sound chosen the notification itself stays silent.{' '}
                {settings.attentionSound !== 'none' ? (
                  <button type="button" className="link" onClick={() => playSound(settings.attentionSound)}>
                    Play it
                  </button>
                ) : null}
              </span>
            </div>
            <div className="field">
              <label>Diagnostic log</label>
              <select className="select" value={settings.diagnosticLog ? 'on' : 'off'} onChange={(e) => update({ diagnosticLog: e.target.value === 'on' })}>
                <option value="off">off</option>
                <option value="on">on – write logins, shell connects and MCP calls to a file</option>
              </select>
              <span className="hint">
                For finding out why a login or a shell hung. One file per day in logs/ in the data folder, kept two weeks; no command text and no output.{' '}
                <button type="button" className="link" onClick={() => void window.tsheep.openLogs()}>
                  Open the folder
                </button>
              </span>
            </div>
            {platform !== 'linux' ? (
              <div className="field">
                <label>Start with the system</label>
                <select className="select" value={settings.openAtLogin ? 'yes' : 'no'} onChange={(e) => update({ openAtLogin: e.target.value === 'yes' })}>
                  <option value="no">no</option>
                  <option value="yes">yes, open tsheep at login</option>
                </select>
              </div>
            ) : null}
          </div>

          <NodeRules />

          <AboutCard />

          <div className="card card-pad">
            <div className="row" style={{ marginBottom: 6 }}>
              <KeyRound size={14} />
              <strong>Secrets tsheep knows</strong>
              <Badge>{secrets.length}</Badge>
            </div>
            <div className="small muted" style={{ marginBottom: 8 }}>
              Values Claude referenced as {'{{secret:NAME}}'} and you typed in. Names only; the values are in memory or encrypted on this machine and are never shown again.
            </div>
            {secrets.length === 0 ? <div className="small muted">None yet.</div> : null}
            {secrets.map((s) => (
              <div key={s.name} className="client-row">
                <code>{s.name}</code>
                <Badge tone={s.where === 'always' ? 'purple' : undefined}>{s.where === 'always' ? 'on this machine' : 'until quit'}</Badge>
                <span className="grow" />
                <button type="button" className="btn sm ghost danger" onClick={() => void window.tsheep.secrets.forget(s.name)}>
                  <Trash2 size={13} /> Forget
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
