/**
 * `tsh login` for one installation.
 *
 * Passwordless first: tsh then talks to the OS authenticator (a passkey in
 * Windows Hello, Touch ID or a password manager) and needs no terminal. Only
 * when tsh insists on a terminal (a password-based connector) does the login
 * open in a terminal window of its own, and tsheep watches the profile until
 * the certificate is valid.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Installation } from '@shared/types'
import { installations } from './installations'
import { log, tail } from './log'
import { tshEnv, tshLoginArgs } from './tsh'

const running = new Map<string, Promise<string>>()
const last = new Map<string, string>()
const HEADLESS_MS = 180_000
const TERMINAL_WAIT_MS = 300_000
const POLL_MS = 4_000

export function startLogin(installationId: string, user: string | null, authOverride?: string | null): Promise<string> {
  const inst = installations.get(installationId)
  if (!inst) return Promise.reject(new Error(`No installation with id ${installationId}`))
  const existing = running.get(installationId)
  if (existing) return existing

  const started = Date.now()
  const task = attempt(inst, user, authOverride)
    .then((result) => {
      last.set(installationId, result)
      log('login', 'ended', { installation: inst.name, ms: Date.now() - started, result })
      return result
    })
    .finally(() => running.delete(installationId))
  running.set(installationId, task)
  return task
}

async function attempt(inst: Installation, user: string | null, authOverride?: string | null): Promise<string> {
  const auth = authOverride ?? inst.auth ?? 'passwordless'
  const args = tshLoginArgs(inst, user, auth)
  log('login', 'started', { installation: inst.name, tsh: inst.tshPath, args })
  if (auth === 'local') {
    // A password connector never works headless; go straight to a terminal.
    return loginInTerminal(inst, args)
  }
  const headless = await runHeadless(inst, args)
  log('login', 'tsh answered', { installation: inst.name, ok: headless.ok, output: tail(headless.output) })
  if (headless.ok) {
    const status = await installations.refresh(inst.id)
    return `Logged in as ${status.user ?? user ?? ''}.`.replace(/ \.$/, '.')
  }
  if (!/terminal/i.test(headless.output)) {
    void installations.refresh(inst.id)
    return `tsh login failed:\n${headless.output.trim()}`
  }
  // A connector that wants a password after all: hand it a terminal.
  return loginInTerminal(inst, args)
}

/** Whether a login runs right now, and how the last one since start ended. */
export function loginState(installationId: string): { inProgress: boolean; lastResult: string | null } {
  return { inProgress: running.has(installationId), lastResult: last.get(installationId) ?? null }
}

async function loginInTerminal(inst: Installation, args: string[]): Promise<string> {
  openTerminal(inst, args)
  const before = installations.statuses().find((s) => s.installationId === inst.id)?.validUntil ?? null
  const deadline = Date.now() + TERMINAL_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const status = await installations.refresh(inst.id)
    if (status.loggedIn && status.validUntil !== before) return `Logged in as ${status.user}.`
  }
  return 'No login within 5 minutes. Finish it in the terminal window and press Refresh.'
}

function runHeadless(inst: Installation, args: string[]): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(inst.tshPath, args, { env: tshEnv(inst), windowsHide: true })
    child.stdout.setEncoding('utf8').on('data', (d: string) => (output += d))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (output += d))
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, output: `${output}\nNo answer from the authenticator within 3 minutes.` })
    }, HEADLESS_MS)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, output: `could not start tsh: ${e.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, output })
    })
  })
}

function openTerminal(inst: Installation, args: string[]): void {
  const dir = join(tmpdir(), 'tsheep')
  mkdirSync(dir, { recursive: true })
  const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`

  if (process.platform === 'win32') {
    const file = join(dir, `login-${inst.name}.cmd`)
    const lines = [
      '@echo off',
      `title tsh login (${inst.name})`,
      inst.teleportHome ? `set "TELEPORT_HOME=${inst.teleportHome}"` : 'set TELEPORT_HOME=',
      `"${inst.tshPath}" ${args.join(' ')}`,
      'echo.',
      'echo You can close this window now. tsheep picks the login up on its own.',
      'pause >nul',
    ]
    writeFileSync(file, lines.join('\r\n'), 'utf8')
    spawn('cmd.exe', ['/c', 'start', `tsh login (${inst.name})`, file], { detached: true, stdio: 'ignore', windowsHide: false }).unref()
    return
  }

  const file = join(dir, `login-${inst.name}.command`)
  const lines = [
    '#!/bin/sh',
    inst.teleportHome ? `export TELEPORT_HOME=${q(inst.teleportHome)}` : 'unset TELEPORT_HOME',
    `${q(inst.tshPath)} ${args.map(q).join(' ')}`,
    'echo',
    'echo "You can close this window now. tsheep picks the login up on its own."',
  ]
  writeFileSync(file, lines.join('\n'), { encoding: 'utf8', mode: 0o755 })
  if (process.platform === 'darwin') spawn('open', [file], { detached: true, stdio: 'ignore' }).unref()
  else spawn('x-terminal-emulator', ['-e', file], { detached: true, stdio: 'ignore' }).unref()
}
