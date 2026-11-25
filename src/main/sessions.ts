/**
 * Open shells, who uses them, and what ran in them.
 *
 * A session is one Shell on one target through one installation. Opening one
 * costs an MFA tap, so by default a request for a target that already has a
 * live session gets that session back; `dedicated` opts out of that.
 *
 * Before a command runs it may have to wait for a person: because the session
 * is in approve mode, or because the command names a secret tsheep does not
 * have yet. Both are one pending entry answered from the window.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { matchNodeRule, nodeShellFor, SECRET_PLACEHOLDER, type Actor, type ApprovalAnswer, type Entry, type Installation, type OpenSessionInput, type Session, type SessionMode, type SessionState } from '@shared/types'
import { answerApproval, askApproval } from './approvals'
import { config } from './config'
import { bus } from './events'
import { history } from './history'
import { installations } from './installations'
import { log, tail } from './log'
import { scrub, Scrubber } from './scrub'
import { secrets } from './secrets'
import { Shell, type ShellResult } from './shell'
import { tshEnv, tshShellArgs } from './tsh'

/** How long a fresh shell gets for its MFA tap and login banner. */
const CONNECT_MS = 180_000
const MAX_ENTRIES_PER_SESSION = 500

/** Files moved through the shell (upload/download), base64 on the wire. */
const TRANSFER_MAX = 100 * 1024 * 1024
const CHUNK_B64 = 512 * 1024

type Live = {
  session: Session
  shell: Shell | null
  idle: NodeJS.Timeout | null
  /** Commands take turns in a shell; this is the end of the line. */
  chain: Promise<unknown>
  /** The entry whose command runs right now. */
  current: string | null
  /** Queued entries stopped before their turn came. */
  cancelled: Set<string>
}

export type RunOptions = { byPerson?: boolean }

function newLive(session: Session): Live {
  return { session, shell: null, idle: null, chain: Promise.resolve(), current: null, cancelled: new Set() }
}

const live = new Map<string, Live>()
const entries = new Map<string, Entry[]>()
/**
 * Unscrubbed output of entries that used a secret, for the person's own eyes
 * in the window. Memory only: never in history, never in an MCP answer.
 */
const raw = new Map<string, { command: string; stdout: string; stderr: string }>()
let seq = 0

function publish(session: Session): void {
  bus.publish({ type: 'session', session: { ...session } })
}

function publishEntry(entry: Entry): void {
  bus.publish({ type: 'entry', entry: { ...entry } })
}

export const sessions = {
  /** Reads back what earlier runs left in the history files. */
  restore(): void {
    const past = history.load()
    for (const s of past.sessions) {
      live.set(s.id, newLive(s))
      entries.set(s.id, [])
    }
    for (const e of past.entries) {
      if (!entries.has(e.sessionId)) continue
      entries.get(e.sessionId)!.push(e)
      seq = Math.max(seq, e.seq)
    }
    for (const [id, list] of entries) {
      const l = live.get(id)
      if (l) l.session.entryCount = list.length
    }
  },

  list(): Session[] {
    return [...live.values()].map((l) => ({ ...l.session }))
  },

  get(id: string): Session | null {
    const l = live.get(id)
    return l ? { ...l.session } : null
  },

  /** The output with secret values in place, for the window only. */
  reveal(entryId: string): { command: string; stdout: string; stderr: string } | null {
    return raw.get(entryId) ?? null
  },

  entries(sessionId?: string): Entry[] {
    if (sessionId) return [...(entries.get(sessionId) ?? [])]
    return [...entries.values()].flat().sort((a, b) => a.seq - b.seq)
  },

  /** A live session on the same installation and target, if any. */
  find(installationId: string, target: string): Session | null {
    for (const l of live.values()) {
      if (l.session.installationId === installationId && l.session.target === target && l.session.state !== 'closed') {
        return { ...l.session }
      }
    }
    return null
  },

  async open(input: OpenSessionInput, openedBy: Actor): Promise<Session> {
    const inst = installations.get(input.installationId)
    if (!inst) throw new Error(`No installation with id ${input.installationId}`)
    // tsh would also accept an IP, an FQDN or a node id. Rules match on the
    // node name, so the caller's spelling is resolved to the canonical name
    // from `tsh ls` first; the shell is opened to that name and nothing else.
    const node = await resolveNode(inst.id, input.node)
    const target = `${input.user}@${node}`
    // A node rule replaces the default; an approve rule also locks. On top of
    // that the caller may only ever tighten, never loosen.
    const rule = matchNodeRule(config.settings().nodeRules, node)
    const base = rule?.mode ?? config.settings().defaultMode
    const mode: SessionMode = base === 'approve' || input.mode === 'approve' ? 'approve' : 'free'
    const session: Session = {
      id: config.newId(),
      installationId: inst.id,
      installationName: inst.name,
      node,
      user: input.user,
      target,
      purpose: input.purpose,
      mode,
      lockedBy: rule?.mode === 'approve' ? rule.pattern : null,
      interpreter: null,
      state: 'connecting',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      openedBy: openedBy.label,
      openedByClaudeId: openedBy.claudeSessionId,
      error: null,
      entryCount: 0,
    }
    const entry = newLive(session)
    live.set(session.id, entry)
    entries.set(session.id, [])
    publish(session)

    const args = tshShellArgs(inst, target)
    const tag = { session: session.id, target, installation: inst.name }
    log('shell', 'connecting', { ...tag, tsh: inst.tshPath, args, by: openedBy.label })
    const shell = new Shell(inst.tshPath, args, tshEnv(inst))
    entry.shell = shell
    let died = false
    shell.onDeath = (why) => {
      died = true
      log('shell', 'tsh exited', { ...tag, why })
      if (session.state === 'closed') return
      session.state = 'closed'
      session.error = why
      publish(session)
      history.session(session)
    }
    try {
      // Swallows the login banner and gives a person time to tap.
      const probe = await shell.run(':', CONNECT_MS)
      if (probe.timedOut) {
        const said = tail(probe.stderr, 300)
        throw new Error(`No MFA approval within 3 minutes; the shell was not opened. Ask the person to approve the prompt and try again.${said ? `\ntsh said: ${said}` : ''}`)
      }
      log('shell', 'connected', { ...tag, ms: Date.now() - session.createdAt, tsh_said: tail(probe.stderr, 300) })
    } catch (e) {
      // Closed by a person or another client while it was still connecting.
      const closedBefore = session.state === 'closed' && !died
      log('shell', 'not connected', { ...tag, ms: Date.now() - session.createdAt, error: (e as Error).message, tsh_said: tail(shell.stderrSoFar, 300) })
      shell.kill()
      session.state = 'closed'
      session.error = describeFailure(inst, (e as Error).message)
      publish(session)
      if (!closedBefore) history.session(session)
      throw new Error(closedBefore ? `The shell was closed before it connected: ${session.error}` : session.error)
    }
    if (session.state === 'closed') throw new Error(session.error ?? 'shell closed')
    // Commands run in bash when the node has it, so bash syntax works there;
    // with setsid a stop reaches everything a command started.
    const probe = await shell.run('command -v bash; command -v setsid; true', 20_000).catch(() => null)
    const found = probe?.stdout ?? ''
    if (/\/bash\s*$/m.test(found)) shell.interpreter = 'bash'
    if (/\/setsid\s*$/m.test(found)) shell.group = true
    shell.ready = true
    session.interpreter = shell.interpreter
    session.state = 'ready'
    publish(session)
    // Written now and again on close, so a tsheep that is killed still leaves
    // the session behind for the next start.
    history.session(session)
    touch(entry)
    return { ...session }
  },

  /** Runs a command and waits until it ended. */
  run(sessionId: string, command: string, description: string, actor: Actor, timeoutMs = 120_000, opts: RunOptions = {}): Promise<Entry> {
    return this.start(sessionId, command, description, actor, timeoutMs, opts).done
  },

  /**
   * Starts a command. The entry exists at once (a background job hands its id
   * back right away); `done` resolves when the command ended, was stopped or
   * was denied.
   */
  start(sessionId: string, command: string, description: string, actor: Actor, timeoutMs = 120_000, opts: RunOptions = {}): { entry: Entry; done: Promise<Entry> } {
    const l = openLive(sessionId)
    const secretNames = [...new Set([...command.matchAll(SECRET_PLACEHOLDER)].map((m) => m[1]))]
    const missing = secretNames.filter((n) => !secrets.has(n))
    const entry = addEntry(l, command, description, actor, secretNames)

    const done = (async (): Promise<Entry> => {
      // Values typed for this command only. Remembered ones also go to the store.
      const given: Record<string, string> = {}
      // What the person types into tsheep needs no approval from that person.
      const approval = l.session.mode === 'approve' && !opts.byPerson
      if (approval || missing.length) {
        const answer = await waitForPerson(l, entry, { approval, secrets: missing }, actor.label)
        if (!answer.allow) return finishDenied(l, entry, answer.reason)
        for (const name of missing) {
          const value = answer.secrets?.[name]
          if (!value) return finishDenied(l, entry, `No value was given for secret "${name}".`)
          given[name] = value
          if (answer.remember && answer.remember !== 'none') secrets.set(name, value, answer.remember)
        }
        entry.status = 'running'
        entry.expiresAt = null
        entry.needs = null
      }

      const known = [...secrets.values(), ...Object.entries(given).map(([name, value]) => ({ name, value }))].sort((a, b) => b.value.length - a.value.length)
      const resolved = command.replace(SECRET_PLACEHOLDER, (whole, name: string) => given[name] ?? secrets.get(name) ?? whole)
      const out = new Scrubber(known)
      const err = new Scrubber(known)
      return inTurn(l, entry, async (shell) => {
        const r = await shell.run(resolved, timeoutMs, (stream, text) => {
          const safe = (stream === 'stdout' ? out : err).push(text)
          if (!safe) return
          entry[stream] += safe
          bus.publish({ type: 'entry-chunk', entryId: entry.id, stream, text: safe })
        }, entry.shell)
        if (secretNames.length) raw.set(entry.id, { command: resolved, stdout: r.stdout, stderr: r.stderr })
        return { ...r, stdout: scrub(r.stdout, known), stderr: scrub(r.stderr, known) }
      }, (m) => scrub(m, known))
    })()
    return { entry: { ...entry }, done }
  },

  /** The entry with this id, wherever it is. */
  entry(entryId: string): Entry | null {
    const e = findEntry(entryId)
    return e ? { ...e } : null
  },

  /**
   * Stops a command: a running one gets TERM (KILL after five seconds), a
   * queued one never starts, a pending one is denied. The shell stays open.
   */
  stop(entryId: string, by: string): boolean {
    const e = findEntry(entryId)
    if (!e) throw new Error(`No command ${entryId}`)
    if (e.status === 'pending') return answerApproval(e.id, { allow: false, reason: `Stopped by ${by} before it ran.` })
    if (e.status !== 'running') return false
    const l = live.get(e.sessionId)
    if (!l?.shell) return false
    e.reason = `Stopped by ${by}.`
    if (l.current === e.id) return l.shell.stop()
    l.cancelled.add(e.id)
    return true
  },

  /**
   * Copies a local file to the node through the open shell, so no second
   * connection (and MFA tap) is needed: base64 in chunks, checked with
   * sha256sum, moved into place at the end.
   */
  upload(sessionId: string, localPath: string, remotePath: string, description: string, actor: Actor, overwrite = false): Promise<Entry> {
    const l = openLive(sessionId)
    const st = statSync(localPath, { throwIfNoEntry: false })
    if (!st?.isFile()) throw new Error(`${localPath} is not a file`)
    if (st.size > TRANSFER_MAX) throw new Error(`${localPath} is ${mb(st.size)}; transfers go up to ${mb(TRANSFER_MAX)}`)
    const entry = addEntry(l, `# upload ${localPath} → ${remotePath} (${mb(st.size)})`, description, actor, [])
    return transfer(l, entry, async (shell) => {
      const data = readFileSync(localPath)
      const sum = createHash('sha256').update(data).digest('hex')
      const r = q(remotePath)
      const part = q(`${remotePath}.tsheep-part`)
      const first = await shell.script(`if [ -e ${r} ] && [ ${overwrite ? 1 : 0} = 0 ]; then echo ${q(`${remotePath} exists; pass overwrite to replace it`)} >&2; false; else : > ${part}; fi`, 30_000)
      if (first.code !== 0) return { ...first, stdout: '' }
      const b64 = data.toString('base64')
      for (let i = 0; i < b64.length; i += CHUNK_B64) {
        const lines = b64.slice(i, i + CHUNK_B64).replace(/.{1,76}/g, '$&\n')
        const step = await shell.script(`base64 -d >> ${part} <<'${shell.marker}_B64'\n${lines}${shell.marker}_B64`, 120_000)
        if (step.code !== 0 || step.timedOut) {
          await shell.script(`rm -f ${part}`, 30_000).catch(() => null)
          return { ...step, stdout: '', stderr: step.stderr || 'writing the file on the node failed' }
        }
      }
      const check = await shell.script(`[ "$(sha256sum < ${part} | cut -d' ' -f1)" = ${sum} ] && mv -f ${part} ${r} || { rm -f ${part}; echo 'checksum mismatch, nothing written' >&2; false; }`, 120_000)
      return { ...check, stdout: check.code === 0 ? `uploaded ${mb(st.size)} to ${remotePath}, sha256 ${sum}` : '' }
    })
  },

  /** Copies a file from the node to this machine through the open shell. */
  download(sessionId: string, remotePath: string, localPath: string, description: string, actor: Actor, overwrite = false): Promise<Entry> {
    const l = openLive(sessionId)
    if (!overwrite && existsSync(localPath)) throw new Error(`${localPath} exists; pass overwrite to replace it`)
    const entry = addEntry(l, `# download ${remotePath} → ${localPath}`, description, actor, [])
    return transfer(l, entry, async (shell) => {
      const r = q(remotePath)
      const size = await shell.run(`wc -c < ${r}`, 30_000)
      if (size.code !== 0) return { ...size, stdout: '' }
      const bytes = Number(size.stdout.trim())
      if (!(bytes <= TRANSFER_MAX)) return { ...size, code: 1, stdout: '', stderr: `${remotePath} is ${mb(bytes)}; transfers go up to ${mb(TRANSFER_MAX)}` }
      const got = await shell.run(`sha256sum < ${r} | cut -d' ' -f1; base64 < ${r}`, 600_000)
      if (got.code !== 0 || got.timedOut || got.stopped) return { ...got, stdout: '' }
      const nl = got.stdout.indexOf('\n')
      const sum = got.stdout.slice(0, nl).trim()
      const data = Buffer.from(got.stdout.slice(nl + 1).replace(/\s+/g, ''), 'base64')
      if (createHash('sha256').update(data).digest('hex') !== sum) return { ...got, code: 1, stdout: '', stderr: 'checksum mismatch, nothing written' }
      mkdirSync(dirname(localPath), { recursive: true })
      writeFileSync(localPath, data)
      return { ...got, stdout: `downloaded ${mb(data.length)} to ${localPath}, sha256 ${sum}` }
    })
  },

  /** Re-applies the node rules to open sessions after the rules changed. */
  applyRules(): void {
    const rules = config.settings().nodeRules
    for (const l of live.values()) {
      if (l.session.state === 'closed') continue
      const rule = matchNodeRule(rules, l.session.node)
      const lockedBy = rule?.mode === 'approve' ? rule.pattern : null
      if (lockedBy === l.session.lockedBy) continue
      l.session.lockedBy = lockedBy
      if (lockedBy) l.session.mode = 'approve'
      publish(l.session)
    }
  },

  setMode(sessionId: string, mode: SessionMode): Session {
    const l = live.get(sessionId)
    if (!l) throw new Error(`No session ${sessionId}`)
    if (mode === 'free' && l.session.lockedBy) throw new Error(`${l.session.node} is fixed to approve by the node rule "${l.session.lockedBy}"`)
    l.session.mode = mode
    publish(l.session)
    return { ...l.session }
  },

  close(sessionId: string, why = 'closed'): void {
    const l = live.get(sessionId)
    if (!l) return
    if (l.idle) clearTimeout(l.idle)
    if (l.session.state !== 'closed') log('shell', 'closed', { session: sessionId, target: l.session.target, was: l.session.state, why })
    l.shell?.kill(why)
    for (const e of entries.get(sessionId) ?? []) {
      if (e.status === 'pending') answerApproval(e.id, { allow: false, reason: 'The shell was closed before the command ran.' })
    }
    if (l.session.state !== 'closed') {
      l.session.state = 'closed'
      l.session.error = why
      publish(l.session)
      history.session(l.session)
    }
  },

  /** Drops a closed session and its timeline from the lists. */
  remove(sessionId: string): void {
    this.close(sessionId)
    live.delete(sessionId)
    for (const e of entries.get(sessionId) ?? []) raw.delete(e.id)
    entries.delete(sessionId)
    bus.publish({ type: 'session-removed', sessionId })
  },

  closeAll(): void {
    for (const id of live.keys()) this.close(id, 'tsheep quit')
  },
}

/**
 * The canonical node name for whatever the caller wrote: the name itself, the
 * hostname or the address of a node `tsh ls` lists. Anything else is refused,
 * so a rule on the name cannot be dodged by another spelling.
 */
export async function resolveNode(installationId: string, given: string): Promise<string> {
  const wanted = given.trim().toLowerCase()
  const find = (nodes: Awaited<ReturnType<typeof installations.nodes>>) =>
    nodes.find((n) => [n.name, n.hostname, n.addr, n.addr.split(':')[0]].some((v) => v && v.toLowerCase() === wanted))
  let node = find(await installations.nodes(installationId))
  // Not in the cached list: the node may be new, ask tsh once more.
  if (!node) node = find(await installations.nodes(installationId, true))
  if (!node) throw new Error(`"${given}" is not a node of this installation. Use a node name from list_nodes.`)
  return node.name
}

/** Marks the entry pending, brings a person to the window, waits for the answer. */
async function waitForPerson(l: Live, entry: Entry, needs: { approval: boolean; secrets: string[] }, by: string): Promise<ApprovalAnswer> {
  const waitMs = config.settings().approvalTimeoutMinutes * 60_000
  entry.status = 'pending'
  entry.expiresAt = Date.now() + waitMs
  entry.needs = needs
  l.session.state = 'pending'
  publish(l.session)
  publishEntry(entry)
  const what = needs.secrets.length ? `needs ${needs.secrets.length === 1 ? `the secret ${needs.secrets[0]}` : `${needs.secrets.length} secrets`}` : 'wants to run a command'
  bus.publish({ type: 'attention', sessionId: l.session.id, entryId: entry.id, title: `${by} ${what} on ${l.session.target}`, body: entry.description })
  const answer = await askApproval(entry.id, waitMs)
  // Read afresh: the shell may have been closed while we waited.
  const closedMeanwhile = (l.session.state as SessionState) === 'closed'
  if (!closedMeanwhile && !hasPending(l.session.id, entry.id)) l.session.state = 'ready'
  if (closedMeanwhile) return { allow: false, reason: 'The shell was closed before the command ran.' }
  return answer
}

function finishDenied(l: Live, entry: Entry, reason: string | null): Entry {
  entry.status = 'denied'
  entry.reason = reason
  entry.finishedAt = Date.now()
  entry.expiresAt = null
  entry.needs = null
  publish(l.session)
  publishEntry(entry)
  history.entry(entry)
  return { ...entry }
}

function openLive(sessionId: string): Live {
  const l = live.get(sessionId)
  if (!l || !l.shell || l.session.state === 'closed') throw new Error(`Session ${sessionId} is not open`)
  if (l.session.state === 'connecting') throw new Error(`Session ${sessionId} is still connecting`)
  return l
}

function findEntry(entryId: string): Entry | null {
  for (const list of entries.values()) {
    const e = list.find((x) => x.id === entryId)
    if (e) return e
  }
  return null
}

function addEntry(l: Live, command: string, description: string, actor: Actor, secretNames: string[]): Entry {
  const entry: Entry = {
    id: config.newId(),
    sessionId: l.session.id,
    seq: ++seq,
    description,
    command,
    status: 'running',
    requestedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: null,
    exitCode: null,
    stdout: '',
    stderr: '',
    by: actor.label,
    byClaudeId: actor.claudeSessionId,
    byRepo: actor.repo,
    byBranch: actor.branch,
    byOwnLabel: actor.ownLabel,
    byOwnId: actor.ownSessionId,
    expiresAt: null,
    reason: null,
    needs: null,
    secretNames,
    // Taken now, so the command runs with exactly what the approval card showed.
    shell: nodeShellFor(config.settings().nodeShell, l.session.node),
  }
  const list = entries.get(l.session.id)!
  list.push(entry)
  if (list.length > MAX_ENTRIES_PER_SESSION) list.splice(0, list.length - MAX_ENTRIES_PER_SESSION)
  l.session.entryCount = list.length
  l.session.lastUsedAt = Date.now()
  if (l.idle) clearTimeout(l.idle)
  publishEntry(entry)
  return entry
}

/** An upload or download: approval like a command, then its turn in the shell. */
async function transfer(l: Live, entry: Entry, work: (shell: Shell) => Promise<ShellResult>): Promise<Entry> {
  if (l.session.mode === 'approve') {
    const answer = await waitForPerson(l, entry, { approval: true, secrets: [] }, entry.by)
    if (!answer.allow) return finishDenied(l, entry, answer.reason)
    entry.status = 'running'
    entry.expiresAt = null
    entry.needs = null
  }
  return inTurn(l, entry, work)
}

/**
 * Runs `work` when the shell is free: commands take turns, and a background
 * job holds the shell until it ended. Records the outcome on the entry.
 */
function inTurn(l: Live, entry: Entry, work: (shell: Shell) => Promise<ShellResult>, clean: (s: string) => string = (s) => s): Promise<Entry> {
  const turn = l.chain.then(async (): Promise<Entry> => {
    const shell = l.shell
    if (l.cancelled.delete(entry.id) || !shell || shell.dead || l.session.state === 'closed') {
      entry.status = shell && !shell.dead && l.session.state !== 'closed' ? 'stopped' : 'failed'
      if (entry.status === 'failed') entry.stderr = 'The shell was closed before the command ran.'
      entry.finishedAt = Date.now()
      publishEntry(entry)
      history.entry(entry)
      return { ...entry }
    }
    l.current = entry.id
    entry.startedAt = Date.now()
    l.session.state = 'busy'
    publish(l.session)
    publishEntry(entry)
    try {
      const r = await work(shell)
      entry.stdout = r.stdout
      entry.stderr = r.stderr
      entry.exitCode = r.code
      entry.status = r.stopped ? 'stopped' : r.timedOut ? 'timeout' : r.code === 0 ? 'done' : 'failed'
      if (shell.dead) {
        l.session.state = 'closed'
        l.session.error = 'A command did not end after it was stopped, so the shell was closed (its output boundary is lost).'
      }
    } catch (e) {
      entry.stderr = clean((e as Error).message)
      entry.status = 'failed'
      l.session.state = 'closed'
      l.session.error = clean((e as Error).message)
    } finally {
      l.current = null
    }
    entry.finishedAt = Date.now()
    if (l.session.state !== 'closed') {
      l.session.state = hasPending(l.session.id) ? 'pending' : 'ready'
      touch(l)
    }
    publish(l.session)
    publishEntry(entry)
    history.entry(entry)
    if (l.session.state === 'closed') history.session(l.session)
    return { ...entry }
  })
  l.chain = turn.catch(() => undefined)
  return turn
}

/** Single-quoted for the remote shell. */
function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function mb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`
}

/** Whether another command in this session still waits for a person. */
function hasPending(sessionId: string, except?: string): boolean {
  return (entries.get(sessionId) ?? []).some((e) => e.status === 'pending' && e.id !== except)
}

function touch(l: Live): void {
  if (l.idle) clearTimeout(l.idle)
  const minutes = config.settings().idleMinutes
  if (minutes <= 0) return
  // A long background job is not idleness: look again later.
  l.idle = setTimeout(() => (l.current ? touch(l) : sessions.close(l.session.id, `idle for ${minutes} minutes`)), minutes * 60_000)
}

function describeFailure(inst: Installation, message: string): string {
  if (/expired|not logged in|certificate|login/i.test(message)) {
    return `${message}\nThe Teleport certificate may be expired. Log in again: ${inst.tshPath} login${inst.proxy ? ` --proxy=${inst.proxy}` : ''}`
  }
  return message
}
