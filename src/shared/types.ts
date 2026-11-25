/** One tsh binary together with the TELEPORT_HOME it reads its profiles from. */
export type Installation = {
  id: string
  /** Short name shown everywhere, e.g. "staging". */
  name: string
  tshPath: string
  /** null: tsh uses its own default (~/.tsh). */
  teleportHome: string | null
  /** host:port of the Teleport proxy. Read from the profile when not given. */
  proxy: string | null
  cluster: string | null
  /** Passed as --mfa-mode when set. "browser" avoids Windows Hello on this machine. */
  mfaMode: 'auto' | 'browser' | 'platform' | 'otp' | null
  /**
   * Auth connector for `tsh login --auth`. null means passwordless (a passkey
   * prompt, no terminal). "local" asks for a password and therefore opens a
   * terminal window; anything else is an SSO connector name.
   */
  auth: string | null
  source: 'discovered' | 'manual' | 'mcp'
}

export type InstallationStatus = {
  installationId: string
  version: string | null
  loggedIn: boolean
  user: string | null
  /** ISO timestamp the certificate expires, when logged in. */
  validUntil: string | null
  logins: string[]
  error: string | null
  checkedAt: number
}

export type TshNode = {
  name: string
  hostname: string
  addr: string
  labels: Record<string, string>
}

export type SessionMode = 'free' | 'approve'
export type SessionState = 'connecting' | 'ready' | 'busy' | 'pending' | 'closed'

export type Session = {
  id: string
  installationId: string
  installationName: string
  node: string
  user: string
  /** user@node, what tsh ssh gets. */
  target: string
  purpose: string
  mode: SessionMode
  /** The node rule that fixes this session to approve, when one does. */
  lockedBy: string | null
  /** The shell each command runs in on that node, once connected. */
  interpreter?: 'bash' | 'sh' | null
  state: SessionState
  createdAt: number
  lastUsedAt: number
  /** Client that opened it: an MCP client label or "ui". */
  openedBy: string
  openedByClaudeId: string | null
  /** Why it is closed, when it is. */
  error: string | null
  entryCount: number
}

export type EntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout' | 'stopped' | 'denied'

export type Entry = {
  id: string
  sessionId: string
  seq: number
  description: string
  command: string
  status: EntryStatus
  /** When it was asked for; `startedAt` is when it actually ran. */
  requestedAt: number
  startedAt: number
  finishedAt: number | null
  exitCode: number | null
  stdout: string
  stderr: string
  by: string
  /** The Claude session that ran it, to find and resume it later. */
  byClaudeId: string | null
  byRepo: string | null
  byBranch: string | null
  /** The client's own (generated) session when it ran on behalf of a root session. */
  byOwnLabel: string | null
  byOwnId: string | null
  /** Set while pending: when the request refuses itself. */
  expiresAt: number | null
  /** Why it did not run: the person's reason, or that nobody answered. */
  reason: string | null
  /** While pending: what the person has to give before it runs. */
  needs: { approval: boolean; secrets: string[] } | null
  /** Secret names the command referenced, for the timeline. Never values. */
  secretNames: string[]
  /** The node's shell settings this command ran (or will run) with. */
  shell?: NodeShell
}

/** What the History view searches by. `days` 0 means every day kept. */
export type HistoryFilter = { text: string; node: string; by: string; status: EntryStatus | ''; days: number }
export type HistoryHit = { entry: Entry; target: string; installation: string }
export type HistoryResult = { hits: HistoryHit[]; total: number; days: number }

export type SecretRemember = 'none' | 'session' | 'always'

export type ApprovalAnswer =
  | { allow: true; secrets?: Record<string, string>; remember?: SecretRemember }
  | { allow: false; reason: string }

/** The secret syntax Claude writes into a command. */
export const SECRET_PLACEHOLDER = /\{\{secret:([A-Za-z0-9_.-]{1,64})\}\}/g

export type McpClient = {
  id: string
  /** What the client called itself on connect, e.g. "claude-code 2.1". */
  name: string
  /** What tsheep shows: "Claude #3", or the session title once identified. */
  label: string
  /**
   * The Claude Code session the person should see and resume: the user-made
   * root session when the client named one, else the client's own.
   */
  claudeSessionId: string | null
  resumeCommand: string | null
  claudeUrl: string | null
  repo: string | null
  branch: string | null
  /** The client's own generated session, when it works for a root session. */
  ownSessionId: string | null
  ownLabel: string | null
  connectedAt: number
  lastSeenAt: number
}

/**
 * Who did something. `label`/`claudeSessionId` are what the person should see
 * and resume: the user-made root session when the client named one, else the
 * client's own session. `own*` keep the client's own session for the tooltip
 * and the logs when it differs from the root.
 */
export type Actor = {
  label: string
  claudeSessionId: string | null
  repo: string | null
  branch: string | null
  ownLabel: string | null
  ownSessionId: string | null
}

export type Theme = 'system' | 'light' | 'dark'

/**
 * A mode fixed per node name. `pattern` is a glob on the node name
 * (`web-*`, `*prod*`), first match wins. An `approve` rule locks the
 * session: nobody, not the person's toggle and not a client, can switch it to
 * free. A `free` rule only sets the starting mode.
 */
export type NodeRule = { pattern: string; mode: SessionMode }

/**
 * How commands start on one node. tsheep's shells are non-interactive, so by
 * default no profile file is read; `login` runs each command as a login shell
 * (/etc/profile, ~/.profile, ~/.bash_profile), `env` sets variables on top.
 */
export type NodeShell = { login: boolean; env: Record<string, string> }

export const DEFAULT_NODE_SHELL: NodeShell = { login: false, env: {} }

export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

export function nodeShellFor(all: Record<string, NodeShell> | undefined, node: string): NodeShell {
  const s = all?.[node.toLowerCase()]
  return { login: s?.login ?? false, env: { ...(s?.env ?? {}) } }
}

export function matchNodeRule(rules: NodeRule[], node: string): NodeRule | null {
  for (const rule of rules) {
    const re = new RegExp('^' + rule.pattern.trim().split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i')
    if (rule.pattern.trim() && re.test(node)) return rule
  }
  return null
}

export type Settings = {
  port: number
  defaultMode: SessionMode
  idleMinutes: number
  approvalTimeoutMinutes: number
  theme: Theme
  /** Closing the window keeps tsheep (and its MCP) running in the tray. */
  closeToTray: boolean
  openAtLogin: boolean
  nodeRules: NodeRule[]
  /** Shell settings per node, keyed by the lower-cased canonical node name. */
  nodeShell: Record<string, NodeShell>
  /**
   * A local Claude session registry (Nico's claude-session-registry) that
   * answers /api/state with session titles. Empty disables the lookup.
   */
  sessionRegistryUrl: string
  /** Writes logins, shell connects and MCP calls to logs/ in the data folder. */
  diagnosticLog: boolean
  /** What the window does when a command waits for the person. */
  attentionWindow: AttentionWindow
  attentionNotification: boolean
  attentionSound: AttentionSound
}

/** front: comes to the front and takes the keyboard. flash: only the taskbar entry flashes. */
export type AttentionWindow = 'front' | 'flash' | 'none'
export type AttentionSound = 'none' | 'chime' | 'ping' | 'knock'

export type SecretInfo = { name: string; where: 'session' | 'always' }

export type McpStatus = {
  running: boolean
  port: number
  url: string
  error: string | null
  clients: McpClient[]
}

export type Snapshot = {
  installations: Installation[]
  statuses: InstallationStatus[]
  sessions: Session[]
  entries: Entry[]
  settings: Settings
  mcp: McpStatus
  secrets: SecretInfo[]
}

/** Pushed from main to the renderer as things happen. */
export type AppEvent =
  | { type: 'installations'; installations: Installation[] }
  | { type: 'installation-status'; status: InstallationStatus }
  | { type: 'session'; session: Session }
  | { type: 'session-removed'; sessionId: string }
  | { type: 'entry'; entry: Entry }
  | { type: 'entry-chunk'; entryId: string; stream: 'stdout' | 'stderr'; text: string }
  | { type: 'mcp'; status: McpStatus }
  | { type: 'settings'; settings: Settings }
  /** A command waits for a person. The window comes to the front for this. */
  | { type: 'attention'; sessionId: string; entryId: string; title: string; body: string }
  | { type: 'secrets'; secrets: SecretInfo[] }

export type OpenSessionInput = {
  installationId: string
  node: string
  user: string
  purpose: string
  mode?: SessionMode
}

export type AddInstallationInput = {
  name: string
  tshPath: string
  teleportHome?: string | null
  proxy?: string | null
  mfaMode?: Installation['mfaMode']
  auth?: string | null
  source?: Installation['source']
}

export type UpdateInstallationInput = Partial<Pick<Installation, 'name' | 'proxy' | 'mfaMode' | 'auth'>>

export const DEFAULT_SETTINGS: Settings = {
  port: 47830,
  defaultMode: 'free',
  idleMinutes: 120,
  approvalTimeoutMinutes: 5,
  theme: 'system',
  closeToTray: true,
  openAtLogin: false,
  nodeRules: [],
  nodeShell: {},
  sessionRegistryUrl: 'http://localhost:47870',
  diagnosticLog: false,
  attentionWindow: 'front',
  attentionNotification: true,
  attentionSound: 'none',
}
