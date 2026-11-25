/**
 * What a Claude session can do through tsheep. The ones that change something:
 * register_installation and set_node_settings (config here), run and upload
 * (on a node), download (a file here), stop_command (ends a command).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { ServerNotification } from '@modelcontextprotocol/sdk/types.js'
import { ENV_KEY, matchNodeRule, nodeShellFor, type Entry } from '@shared/types'
import { config, setNodeShell } from './config'
import { installations } from './installations'
import { log, tail } from './log'
import { loginState, startLogin } from './login'
import { actorOf, identifyClient } from './mcp'
import { secrets } from './secrets'
import { resolveNode, sessions } from './sessions'

function text(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] }
}

function fail(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] }
}

const BACKGROUND_MAX_MS = 86_400_000

type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: ServerNotification) => Promise<void> }

/**
 * HTTP clients drop a response that stays silent for 300 s (undici and Bun
 * fetch idle timeouts), so a long command or approval wait would be lost.
 * A notification every 30 s on the request's stream keeps it alive.
 */
async function heartbeat<T>(extra: Extra, work: () => Promise<T>): Promise<T> {
  const started = Date.now()
  const token = extra._meta?.progressToken
  const beat = setInterval(() => {
    const secs = Math.round((Date.now() - started) / 1000)
    const note: ServerNotification = token !== undefined
      ? { method: 'notifications/progress', params: { progressToken: token, progress: secs, message: `still running after ${secs}s` } }
      : { method: 'notifications/message', params: { level: 'debug', logger: 'tsheep', data: `still going after ${secs}s` } }
    extra.sendNotification(note).catch(() => {})
  }, 30_000)
  try {
    return await work()
  } finally {
    clearInterval(beat)
  }
}

/** What a client gets back about a command; output tails when it is long. */
function report(entry: Entry, tail = Infinity) {
  if (entry.status === 'denied') return { status: 'denied', reason: entry.reason, note: 'The person did not allow this. Do not retry it unchanged; ask them or take another route.' }
  const cutTail = (s: string) => (s.length > tail ? `… ${s.length - tail} earlier characters left out\n${s.slice(-tail)}` : s)
  return {
    entry_id: entry.id,
    status: entry.status,
    exit_code: entry.exitCode,
    stdout: cutTail(entry.stdout),
    stderr: cutTail(entry.stderr),
    duration_ms: (entry.finishedAt ?? Date.now()) - entry.startedAt,
    ...(entry.status === 'stopped' || entry.status === 'timeout' ? { note: entry.reason ?? 'It was stopped; the session is still open.' } : {}),
  }
}

/** What list_installations says about a login that runs or just failed. */
function loginNote(installationId: string, loggedIn: boolean) {
  const { inProgress, lastResult } = loginState(installationId)
  if (inProgress) return { login_in_progress: true, note: 'A login is waiting for the person to approve the prompt. Look again in a few seconds; do not start another login.' }
  return !loggedIn && lastResult ? { last_login: lastResult } : {}
}

/**
 * Writes every tool call to the log: who, which target, how long, and the
 * error text if it failed. No command text and no output.
 */
function logCalls(server: McpServer): void {
  const register = server.registerTool.bind(server) as (name: string, cfg: unknown, handler: (...a: unknown[]) => Promise<ToolResult>) => unknown
  type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] }
  const keys = ['installation', 'node', 'user', 'session_id', 'entry_id', 'background', 'timeout_ms', 'wait_seconds']
  ;(server as { registerTool: unknown }).registerTool = (name: string, cfg: unknown, handler: (...a: unknown[]) => Promise<ToolResult>) =>
    register(name, cfg, async (...a) => {
      const started = Date.now()
      const args = (a.length > 1 ? a[0] : {}) as Record<string, unknown>
      const extra = a[a.length - 1] as { sessionId?: string } | undefined
      const what = { by: actorOf(extra?.sessionId).label, ...Object.fromEntries(keys.filter((k) => args?.[k] !== undefined).map((k) => [k, args[k]])) }
      try {
        const r = await handler(...a)
        log('mcp', name, { ...what, ms: Date.now() - started, ...(r?.isError ? { error: tail(r.content?.[0]?.text ?? '', 300) } : {}) })
        return r
      } catch (e) {
        log('mcp', name, { ...what, ms: Date.now() - started, threw: (e as Error).message })
        throw e
      }
    })
}

function resolveInstallation(ref: string) {
  const inst = installations.get(ref) ?? installations.byName(ref)
  if (!inst) {
    const names = installations.list().map((i) => i.name).join(', ') || 'none registered'
    throw new Error(`No installation "${ref}". Known: ${names}. Use list_installations, or register_installation to add one.`)
  }
  return inst
}

export function registerTools(server: McpServer): void {
  logCalls(server)
  server.registerTool(
    'identify',
    {
      title: 'Say which Claude session this is',
      description:
        'Call once at the start, before anything else. Pass your Claude Code session id (the SessionStart hook prints it as "Diese Session: <id>"); tsheep then shows the session\'s title and a resume command next to every command you run, so the person knows where it came from. ' +
        'If another Claude session started you (your brief names a root session id, or you work on behalf of one), pass that as root_session_id: the person wants to see and resume the session they made themselves, not a generated one; your own id is kept for the logs. ' +
        'Add a name when there is no session id or no registry, e.g. "webshop: fix order export". Without identify you appear as "Claude #n".',
      inputSchema: {
        session_id: z.string().uuid().optional().describe('Your own Claude Code session id'),
        root_session_id: z.string().uuid().optional().describe('The user-made session you work for, when another Claude session started yours'),
        name: z.string().min(3).max(80).optional().describe('Fallback label: repository and task'),
      },
    },
    async (args, extra) => {
      if (!args.session_id && !args.name && !args.root_session_id) return fail('Give session_id, root_session_id, name, or some of them.')
      const c = await identifyClient(extra.sessionId, args.session_id ?? null, args.root_session_id ?? null, args.name?.trim() ?? null)
      return c ? text({ label: c.label, shown_session_id: c.claudeSessionId, resume: c.resumeCommand, repo: c.repo, branch: c.branch, own_session: c.ownSessionId ? { id: c.ownSessionId, label: c.ownLabel } : null }) : fail('No MCP session to name; initialise first.')
    },
  )

  server.registerTool(
    'list_installations',
    {
      title: 'List tsh installations',
      description:
        'The tsh binaries tsheep knows about, each with its Teleport cluster, whether it is logged in, until when, and which remote logins (users) the certificate allows. Start here.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      await installations.refreshAll()
      const statuses = new Map(installations.statuses().map((s) => [s.installationId, s]))
      return text(
        installations.list().map((i) => {
          const s = statuses.get(i.id)
          return {
            id: i.id,
            name: i.name,
            tsh_path: i.tshPath,
            teleport_home: i.teleportHome,
            proxy: i.proxy,
            cluster: i.cluster,
            version: s?.version ?? null,
            logged_in: s?.loggedIn ?? false,
            user: s?.user ?? null,
            valid_until: s?.validUntil ?? null,
            logins: s?.logins ?? [],
            error: s?.error ?? null,
            ...loginNote(i.id, s?.loggedIn ?? false),
          }
        }),
      )
    },
  )

  server.registerTool(
    'register_installation',
    {
      title: 'Register a tsh installation',
      description:
        'Adds a tsh binary to tsheep so sessions can be opened through it. Give the path to the tsh binary and, when it has its own TELEPORT_HOME (profile directory), that directory. Proxy and cluster are read from the profile when not given. Use when list_installations does not show the tsh the person wants to use.',
      inputSchema: {
        name: z.string().min(1).max(40).describe('Short name, e.g. "staging"'),
        tsh_path: z.string().min(1).describe('Absolute path to the tsh binary'),
        teleport_home: z.string().optional().describe('TELEPORT_HOME directory, e.g. C:\\Users\\me\\.tsh-staging. Omit for the default ~/.tsh'),
        proxy: z.string().optional().describe('Teleport proxy host:port, if the profile does not say'),
        mfa_mode: z.enum(['auto', 'browser', 'platform', 'otp']).optional().describe('Forces --mfa-mode on tsh ssh. "browser" when the platform authenticator does not hold the passkey'),
        auth: z.string().optional().describe('How tsh login authenticates: "passwordless" (default, passkey prompt), "local" (password, opens a terminal window) or an SSO connector name'),
      },
    },
    async (args) => {
      try {
        const inst = installations.add({
          name: args.name,
          tshPath: args.tsh_path,
          teleportHome: args.teleport_home ?? null,
          proxy: args.proxy ?? null,
          mfaMode: args.mfa_mode ?? null,
          auth: args.auth ?? null,
          source: 'mcp',
        })
        const status = await installations.refresh(inst.id)
        return text({ installation: inst, status })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'login',
    {
      title: 'Start tsh login',
      description:
        'Starts `tsh login` for an installation whose certificate is missing or expired. Passwordless by default: the person gets a passkey prompt from their OS or password manager; tell them to approve it, then check list_installations. Returns at once. ' +
        'The person may need a minute: while list_installations shows login_in_progress, wait and look again; do not start a second login, neither here nor with tsh directly, and do not open a session yet. Two MFA prompts at once block each other. If the login failed, last_login says why.',
      inputSchema: {
        installation: z.string().describe('Installation name or id'),
        user: z.string().optional().describe('Teleport username, when the profile has none yet'),
        auth: z.string().optional().describe('Overrides the installation\'s auth connector for this login only'),
      },
    },
    async (args) => {
      try {
        const inst = resolveInstallation(args.installation)
        void startLogin(inst.id, args.user ?? null, args.auth ?? null)
        return text({ started: true, message: `tsh login started for ${inst.name}. Ask the person to approve the passkey prompt, then call list_installations.` })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'list_nodes',
    {
      title: 'List nodes',
      description: 'The nodes (servers) reachable through one installation, from `tsh ls`. Needs a valid login. `mode_rule` on a node says the person fixed sessions there to approve or free.',
      inputSchema: {
        installation: z.string().describe('Installation name or id'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const inst = resolveInstallation(args.installation)
        const nodes = await installations.nodes(inst.id)
        const status = installations.statuses().find((s) => s.installationId === inst.id)
        const rules = config.settings().nodeRules
        return text({
          installation: inst.name,
          logins: status?.logins ?? [],
          nodes: nodes.map((n) => {
            const s = nodeShellFor(config.settings().nodeShell, n.name)
            return { name: n.name, addr: n.addr, labels: n.labels, mode_rule: matchNodeRule(rules, n.name)?.mode ?? null, login_shell: s.login, env: Object.keys(s.env) }
          }),
        })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'list_sessions',
    {
      title: 'List open sessions',
      description: 'Shells that are open right now, with target, mode (free or approve), purpose and who opened them. Reuse one with run instead of opening another when it fits.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(sessions.list().map(publicSession)),
  )

  server.registerTool(
    'open_session',
    {
      title: 'Open a shell session',
      description:
        'Opens a shell on a node through an installation, or returns the open session for that target unless dedicated is true. A new shell triggers an MFA prompt on the person\'s machine: tell them to approve it; this call waits up to 3 minutes for that. Every command later goes through run with a description. Pass mode "approve" when the work touches production state, so the person confirms each command.',
      inputSchema: {
        installation: z.string().describe('Installation name or id'),
        node: z.string().describe('Node name as list_nodes shows it'),
        user: z.string().describe('Remote login, e.g. "ubuntu". Must be one of the installation\'s logins'),
        purpose: z.string().min(8).max(200).describe('What this session is for, shown to the person, e.g. "Debug nginx container restarts"'),
        dedicated: z.boolean().optional().describe('Open a separate shell even if one to this target exists'),
        mode: z
          .enum(['free', 'approve'])
          .optional()
          .describe('"approve" makes every command wait for the person\'s OK, use it for anything risky. It can only tighten: the person\'s default and their per-node rules win over "free". Only the person can switch a session to free.'),
      },
    },
    async (args, extra) => {
      try {
        const inst = resolveInstallation(args.installation)
        const target = `${args.user}@${args.node}`
        // Reuse matches the canonical target only; another spelling of the
        // same node falls through to open(), which resolves and reuses nothing.
        if (!args.dedicated) {
          const existing = sessions.find(inst.id, target)
          if (existing && existing.state !== 'connecting') {
            // A reused shell can be tightened by the client, never loosened.
            if (args.mode === 'approve' && existing.mode !== 'approve') sessions.setMode(existing.id, 'approve')
            return text({ reused: true, session: publicSession(sessions.get(existing.id) ?? existing) })
          }
        }
        const session = await sessions.open({ installationId: inst.id, node: args.node, user: args.user, purpose: args.purpose, mode: args.mode }, actorOf(extra.sessionId))
        return text({ reused: false, session: publicSession(session) })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'run',
    {
      title: 'Run a command',
      description:
        'Runs one shell command in an open session and returns stdout, stderr and the exit code. The description is mandatory and is what the person reads in tsheep, so say plainly what the command does and why. In a session in approve mode the call waits until the person allows it. ' +
        'Each run is a fresh child shell: bash when the node has it (see `shell` in open_session/list_sessions), else POSIX sh, with stdin from /dev/null. `cd` and `export` do not carry over to the next run, so use absolute paths or chain with &&. A syntax error fails only this run, the session stays open. ' +
        'On timeout the command is stopped (TERM, KILL after 5 s) and the session stays open. For anything longer than a few minutes (dumps, restores, rollouts, waiting on a pod) pass background: true: you get an entry_id at once and follow it with get_command; stop_command ends it. A running command holds its session until it ends, so open a second session (dedicated: true) for other work meanwhile. ' +
        'The shell is non-interactive and reads no profile unless the node has login_shell on; if a variable such as KUBECONFIG is missing, check get_node_settings and fix it once with set_node_settings instead of exporting it in every command. ' +
        'Never put a password, token or key into a command: write {{secret:NAME}} instead (e.g. mysql -p\'{{secret:DB_PASSWORD}}\'). tsheep asks the person for the value, inserts it when the command runs and removes it from the output; you only ever see the placeholder. list_secrets shows names tsheep already has. To copy files use upload/download, not base64 through run.',
      inputSchema: {
        session_id: z.string().describe('From open_session or list_sessions'),
        command: z.string().min(1).describe('The command, verbatim, as /bin/sh runs it'),
        description: z.string().min(10).max(300).describe('One sentence: what this does and why'),
        timeout_ms: z.number().int().min(1000).max(BACKGROUND_MAX_MS).optional().describe(`Default 120000. Up to 900000 when waiting, up to ${BACKGROUND_MAX_MS} (24 h) with background (default 3600000 there)`),
        background: z.boolean().optional().describe('Return at once with an entry_id instead of waiting; follow with get_command'),
      },
    },
    async (args, extra) => {
      try {
        const actor = actorOf(extra.sessionId)
        if (args.background) {
          const { entry } = sessions.start(args.session_id, args.command, args.description, actor, args.timeout_ms ?? 3_600_000)
          return text({ entry_id: entry.id, status: entry.status, note: 'Running in the background. get_command with this entry_id shows output and status (wait_seconds waits for it to end); stop_command stops it.' })
        }
        if ((args.timeout_ms ?? 0) > 900_000) return fail('timeout_ms above 900000 needs background: true.')
        const entry = await heartbeat(extra, () => sessions.run(args.session_id, args.command, args.description, actor, args.timeout_ms ?? 120_000))
        return text(report(entry))
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'get_command',
    {
      title: 'Follow a command',
      description: 'Status and output of a command by its entry_id (from run with background: true, or any earlier run). With wait_seconds it waits up to that long for the command to end. Output is the tail, up to tail_chars per stream.',
      inputSchema: {
        entry_id: z.string(),
        wait_seconds: z.number().int().min(0).max(600).optional().describe('Wait up to this long for the command to end. Default 0'),
        tail_chars: z.number().int().min(100).max(200_000).optional().describe('Default 20000'),
      },
    },
    async (args, extra) => {
      try {
        const end = Date.now() + (args.wait_seconds ?? 0) * 1000
        const busy = (s: string) => s === 'running' || s === 'pending'
        let entry = sessions.entry(args.entry_id)
        if (!entry) return fail(`No command ${args.entry_id}`)
        if (busy(entry.status) && Date.now() < end) {
          entry = await heartbeat(extra, async () => {
            let e = sessions.entry(args.entry_id)
            while (e && busy(e.status) && Date.now() < end) {
              await new Promise((r) => setTimeout(r, 1000))
              e = sessions.entry(args.entry_id)
            }
            return e
          })
          if (!entry) return fail(`No command ${args.entry_id}`)
        }
        return text(report(entry, args.tail_chars ?? 20_000))
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'stop_command',
    {
      title: 'Stop a command',
      description: 'Stops a command by its entry_id: a running one gets TERM (KILL after 5 s), a queued one never starts, one waiting for approval is withdrawn. The session stays open.',
      inputSchema: { entry_id: z.string() },
    },
    async (args, extra) => {
      try {
        const ok = sessions.stop(args.entry_id, actorOf(extra.sessionId).label)
        return text({ stopping: ok, note: ok ? 'get_command shows when it has ended.' : 'It is not running any more.' })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'upload',
    {
      title: 'Copy a file to a node',
      description: `Copies a file from this machine to the node through the open session (no second MFA tap), checked with sha256. Up to 100 MB. Refuses to replace an existing remote file unless overwrite is true. In approve mode the person confirms it like a command.`,
      inputSchema: {
        session_id: z.string(),
        local_path: z.string().describe('Absolute path on this machine'),
        remote_path: z.string().describe('Absolute path on the node'),
        description: z.string().min(10).max(300).describe('One sentence: what this file is and why it goes there'),
        overwrite: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const entry = await heartbeat(extra, () => sessions.upload(args.session_id, args.local_path, args.remote_path, args.description, actorOf(extra.sessionId), args.overwrite ?? false))
        return text(report(entry))
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'download',
    {
      title: 'Copy a file from a node',
      description: 'Copies a file from the node to this machine through the open session, checked with sha256. Up to 100 MB. Refuses to replace an existing local file unless overwrite is true. In approve mode the person confirms it like a command.',
      inputSchema: {
        session_id: z.string(),
        remote_path: z.string().describe('Absolute path on the node'),
        local_path: z.string().describe('Absolute path on this machine'),
        description: z.string().min(10).max(300).describe('One sentence: what this file is and why you need it'),
        overwrite: z.boolean().optional(),
      },
    },
    async (args, extra) => {
      try {
        const entry = await heartbeat(extra, () => sessions.download(args.session_id, args.remote_path, args.local_path, args.description, actorOf(extra.sessionId), args.overwrite ?? false))
        return text(report(entry))
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'get_node_settings',
    {
      title: 'Show how commands start on a node',
      description:
        'The node\'s shell settings: login_shell (each command runs as a login shell and reads /etc/profile, ~/.profile, ~/.bash_profile) and env (variables set for every command), plus its mode rule. tsheep shells are non-interactive, so without login_shell no profile file is read: that is why e.g. KUBECONFIG from ~/.bash_profile is missing.',
      inputSchema: {
        installation: z.string().describe('Installation name or id'),
        node: z.string().describe('Node name as list_nodes shows it'),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      try {
        const inst = resolveInstallation(args.installation)
        const node = await resolveNode(inst.id, args.node)
        const s = nodeShellFor(config.settings().nodeShell, node)
        return text({ node, login_shell: s.login, env: s.env, mode_rule: matchNodeRule(config.settings().nodeRules, node)?.mode ?? null })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'set_node_settings',
    {
      title: 'Change how commands start on a node',
      description:
        'Sets the node\'s shell settings for every later command, from any Claude session. Refused on nodes in approve mode (a rule or an open approve session): there only the person changes them, so ask them. Prefer login_shell: true when the profile files already set what is needed (e.g. KUBECONFIG in ~/.bash_profile); use env only for what no profile sets. env merges: a value of null removes that variable. The person sees these settings on every command and on every approval card. Does not touch the mode rule; only the person can change that.',
      inputSchema: {
        installation: z.string().describe('Installation name or id'),
        node: z.string().describe('Node name as list_nodes shows it'),
        login_shell: z.boolean().optional(),
        env: z
          .record(z.string().regex(ENV_KEY, 'letters, digits and _ only, not starting with a digit'), z.string().max(4096).nullable())
          .optional()
          .describe('e.g. {"KUBECONFIG": "/etc/kubernetes/admin.conf"}; null removes a variable'),
      },
    },
    async (args) => {
      try {
        const inst = resolveInstallation(args.installation)
        const node = await resolveNode(inst.id, args.node)
        // Where every command needs the person's OK, a variable such as
        // BASH_ENV or LD_PRELOAD would make an approved harmless command run
        // something else. So there only the person changes the settings.
        const rule = matchNodeRule(config.settings().nodeRules, node)
        const approving = sessions.list().some((x) => x.node.toLowerCase() === node.toLowerCase() && x.state !== 'closed' && x.mode === 'approve')
        if (rule?.mode === 'approve' || approving) {
          return fail(`${node} is in approve mode, so its shell settings can only be changed by the person in tsheep (cog on the node row). Tell them what to set and why.`)
        }
        const s = setNodeShell(node, { login: args.login_shell, env: args.env })
        return text({ node, login_shell: s.login, env: s.env })
      } catch (e) {
        return fail((e as Error).message)
      }
    },
  )

  server.registerTool(
    'list_secrets',
    {
      title: 'List known secret names',
      description: 'Names of secrets the person already gave tsheep, usable as {{secret:NAME}} in run without being asked again. Names only, never values.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => text(secrets.list().map((s) => ({ name: s.name, remembered: s.where === 'always' ? 'on this machine' : 'until tsheep quits' }))),
  )

  server.registerTool(
    'forget_secret',
    {
      title: 'Forget a secret',
      description: 'Drops a remembered secret from tsheep, in memory and from the encrypted store. The next {{secret:NAME}} asks the person again. Use when a value was rotated or should not stay on this machine.',
      inputSchema: {
        name: z.string().min(1).max(64),
      },
    },
    async (args) => {
      const known = secrets.list().some((s) => s.name === args.name)
      if (!known) return fail(`No secret named "${args.name}". list_secrets shows the known names.`)
      secrets.forget(args.name)
      return text({ forgotten: args.name })
    },
  )

  server.registerTool(
    'close_session',
    {
      title: 'Close a session',
      description: 'Closes a shell. Leave sessions open when another Claude session may still want them; the idle timeout closes them anyway.',
      inputSchema: {
        session_id: z.string(),
      },
    },
    async (args, extra) => {
      const s = sessions.get(args.session_id)
      if (!s) return fail(`No session ${args.session_id}`)
      sessions.close(args.session_id, `closed by ${actorOf(extra.sessionId).label}`)
      return text({ closed: true })
    },
  )
}

function publicSession(s: ReturnType<typeof sessions.list>[number]) {
  return {
    id: s.id,
    installation: s.installationName,
    node: s.node,
    user: s.user,
    target: s.target,
    purpose: s.purpose,
    mode: s.mode,
    locked_to_approve_by: s.lockedBy,
    shell: s.interpreter ?? null,
    state: s.state,
    opened_by: s.openedBy,
    opened_by_claude_session: s.openedByClaudeId,
    created_at: new Date(s.createdAt).toISOString(),
    last_used_at: new Date(s.lastUsedAt).toISOString(),
    commands_run: s.entryCount,
    error: s.error,
  }
}
