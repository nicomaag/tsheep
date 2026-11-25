import { KeyRound, Loader2, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { AddInstallationInput, Installation } from '@shared/types'
import { Badge, TopBar } from '../components/ui'
import { until } from '../format'
import { useStore } from '../store'

export function InstallationsView() {
  const platform = useStore((s) => s.platform)
  const installations = useStore((s) => s.installations)
  const [discovering, setDiscovering] = useState(false)
  const [adding, setAdding] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const discover = async () => {
    setDiscovering(true)
    try {
      const added = await window.tsheep.installations.discover()
      setMessage(added.length ? `Found ${added.length} new: ${added.map((a) => a.name).join(', ')}` : 'Nothing new found. Add one by hand, or ask your Claude to register it.')
    } finally {
      setDiscovering(false)
    }
  }

  return (
    <>
      <TopBar title="Installations" platform={platform}>
        <button type="button" className="btn sm" onClick={() => void discover()} disabled={discovering}>
          {discovering ? <Loader2 size={13} className="spin" /> : <Search size={13} />} Discover
        </button>
        <button type="button" className="btn sm primary" onClick={() => setAdding((v) => !v)}>
          <Plus size={13} /> Add
        </button>
      </TopBar>
      <div className="main-scroll">
        <div className="content stack" style={{ gap: 14 }}>
          <p className="page-lead" style={{ margin: 0 }}>
            A tsh installation is one tsh binary plus the TELEPORT_HOME it keeps its profile in. Several can live side by side, one per Teleport cluster or version. Your Claude can register one too, through the <code>register_installation</code> tool.
          </p>
          {message ? <div className="notice blue">{message}</div> : null}
          {adding ? <AddForm onDone={() => setAdding(false)} /> : null}
          {installations.length === 0 && !adding ? (
            <div className="empty card">
              <h3>No installation yet</h3>
              <div>Press Discover to look in PATH, Teleport Connect and ~/.tsh* folders.</div>
            </div>
          ) : null}
          <div className="inst-grid">
            {installations.map((i) => (
              <InstallationCard key={i.id} inst={i} />
            ))}
          </div>
        </div>
      </div>
    </>
  )
}

function InstallationCard({ inst }: { inst: Installation }) {
  const status = useStore((s) => s.statuses[inst.id])
  const [busy, setBusy] = useState(false)
  const [loginOut, setLoginOut] = useState<string | null>(null)

  const refresh = () => {
    setBusy(true)
    void window.tsheep.installations.refresh(inst.id).finally(() => setBusy(false))
  }
  const login = () => {
    setBusy(true)
    setLoginOut(null)
    void window.tsheep.installations
      .login(inst.id, status?.user ?? null)
      .then((out) => setLoginOut(out))
      .finally(() => setBusy(false))
  }

  return (
    <div className="card card-pad">
      <div className="row">
        <strong style={{ fontSize: 15 }}>{inst.name}</strong>
        {status?.version ? <Badge mono>v{status.version}</Badge> : null}
        {status ? status.loggedIn ? <Badge tone="green">logged in · {until(status.validUntil)}</Badge> : <Badge tone="amber">{status.error ?? 'not logged in'}</Badge> : <Badge>checking…</Badge>}
        <span className="grow" />
        <Badge>{inst.source}</Badge>
      </div>
      <dl className="kv">
        <dt>binary</dt>
        <dd>{inst.tshPath}</dd>
        <dt>home</dt>
        <dd>{inst.teleportHome ?? <span className="muted">default (~/.tsh)</span>}</dd>
        <dt>proxy</dt>
        <dd>{inst.proxy ?? <span className="muted">from profile</span>}</dd>
        <dt>cluster</dt>
        <dd>{inst.cluster ?? <span className="muted">unknown</span>}</dd>
        <dt>user</dt>
        <dd>{status?.user ?? <span className="muted">–</span>}</dd>
        <dt>logins</dt>
        <dd>{status?.logins.length ? status.logins.join(', ') : <span className="muted">–</span>}</dd>
        <dt>login via</dt>
        <dd>
          <AuthPicker value={inst.auth} onChange={(auth) => void window.tsheep.installations.update(inst.id, { auth })} />
        </dd>
        <dt>mfa</dt>
        <dd>
          <select className="select" style={{ height: 24, width: 'auto', fontSize: 12 }} value={inst.mfaMode ?? ''} onChange={(e) => void window.tsheep.installations.update(inst.id, { mfaMode: (e.target.value || null) as Installation['mfaMode'] })}>
            <option value="">tsh default</option>
            <option value="browser">browser</option>
            <option value="platform">platform</option>
            <option value="otp">otp</option>
            <option value="auto">auto</option>
          </select>
        </dd>
      </dl>
      {busy && !loginOut ? <div className="notice blue" style={{ marginTop: 10 }}>A terminal window opened for tsh login. Finish it there; this card updates on its own.</div> : null}
      {loginOut ? <div className="notice blue selectable" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{loginOut}</div> : null}
      <div className="row" style={{ marginTop: 14 }}>
        <button type="button" className="btn sm" onClick={refresh} disabled={busy}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} /> Refresh
        </button>
        {status && !status.loggedIn ? (
          <button type="button" className="btn sm primary" onClick={login} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <KeyRound size={13} />} tsh login
          </button>
        ) : null}
        <span className="grow" />
        <button type="button" className="btn sm ghost danger" onClick={() => void window.tsheep.installations.remove(inst.id)}>
          <Trash2 size={13} /> Remove
        </button>
      </div>
    </div>
  )
}

/**
 * How `tsh login` authenticates: passkey (no terminal), password (a terminal
 * window opens) or a named SSO connector.
 */
function AuthPicker({ value, onChange }: { value: string | null; onChange: (auth: string | null) => void }) {
  const preset = value === null || value === 'passwordless' ? 'passwordless' : value === 'local' ? 'local' : 'sso'
  const [sso, setSso] = useState(preset === 'sso' ? value ?? '' : '')
  return (
    <span className="row">
      <select
        className="select"
        style={{ height: 24, width: 'auto', fontSize: 12 }}
        value={preset}
        onChange={(e) => {
          const v = e.target.value
          if (v === 'passwordless') onChange(null)
          else if (v === 'local') onChange('local')
          else onChange(sso || 'github')
        }}
      >
        <option value="passwordless">passkey (passwordless)</option>
        <option value="local">password (local, terminal window)</option>
        <option value="sso">SSO connector…</option>
      </select>
      {preset === 'sso' ? <input className="input mono" style={{ height: 24, width: 140, fontSize: 12 }} value={sso} placeholder="connector name" onChange={(e) => setSso(e.target.value)} onBlur={() => sso && onChange(sso)} /> : null}
    </span>
  )
}

function AddForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<AddInstallationInput>({ name: '', tshPath: '', teleportHome: '', proxy: '', mfaMode: null, auth: null })
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<AddInstallationInput>) => setForm((f) => ({ ...f, ...patch }))

  const submit = async () => {
    setError(null)
    try {
      await window.tsheep.installations.add({
        name: form.name.trim(),
        tshPath: form.tshPath.trim(),
        teleportHome: form.teleportHome?.trim() || null,
        proxy: form.proxy?.trim() || null,
        mfaMode: form.mfaMode ?? null,
        auth: form.auth ?? null,
        source: 'manual',
      })
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="card card-pad stack">
      <div className="form-grid">
        <div className="field">
          <label>Name</label>
          <input className="input" placeholder="staging" value={form.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label>MFA mode</label>
          <select className="select" value={form.mfaMode ?? ''} onChange={(e) => set({ mfaMode: (e.target.value || null) as AddInstallationInput['mfaMode'] })}>
            <option value="">tsh default</option>
            <option value="browser">browser</option>
            <option value="platform">platform (Windows Hello / Touch ID)</option>
            <option value="otp">otp</option>
            <option value="auto">auto</option>
          </select>
        </div>
        <div className="field full">
          <label>Path to tsh binary</label>
          <input className="input mono" placeholder="C:\Users\me\Tools\teleport\tsh.exe" value={form.tshPath} onChange={(e) => set({ tshPath: e.target.value })} />
        </div>
        <div className="field">
          <label>TELEPORT_HOME</label>
          <input className="input mono" placeholder="C:\Users\me\.tsh-staging (optional)" value={form.teleportHome ?? ''} onChange={(e) => set({ teleportHome: e.target.value })} />
          <span className="hint">Proxy and cluster are read from the profile in it.</span>
        </div>
        <div className="field">
          <label>Proxy</label>
          <input className="input mono" placeholder="teleport.example.com:443 (optional)" value={form.proxy ?? ''} onChange={(e) => set({ proxy: e.target.value })} />
        </div>
        <div className="field full">
          <label>Login via</label>
          <AuthPicker value={form.auth ?? null} onChange={(auth) => set({ auth })} />
        </div>
      </div>
      {error ? <div className="notice red">{error}</div> : null}
      <div className="row">
        <button type="button" className="btn primary" disabled={!form.name.trim() || !form.tshPath.trim()} onClick={() => void submit()}>
          Add installation
        </button>
        <button type="button" className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}
