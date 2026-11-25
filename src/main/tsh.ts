/**
 * Running tsh subcommands (not shells) for one installation: version, status,
 * ls. Each call is a short-lived process with the installation's TELEPORT_HOME.
 */
import { execFile } from 'node:child_process'
import type { Installation, InstallationStatus, TshNode } from '@shared/types'

export function tshEnv(inst: Pick<Installation, 'teleportHome'>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (inst.teleportHome) env.TELEPORT_HOME = inst.teleportHome
  else delete env.TELEPORT_HOME
  return env
}

function run(inst: Installation, args: string[], timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      inst.tshPath,
      args,
      { env: tshEnv(inst), timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error && typeof (error as NodeJS.ErrnoException).code === 'number' ? Number((error as NodeJS.ErrnoException).code) : error ? 1 : 0
        resolve({ stdout: String(stdout), stderr: String(stderr) + (error && !stderr ? error.message : ''), code })
      },
    )
  })
}

export async function tshVersion(inst: Installation): Promise<string | null> {
  const r = await run(inst, ['version', '--client'], 10_000)
  const m = r.stdout.match(/Teleport v([\d.]+)/)
  return m ? m[1] : null
}

type StatusJson = {
  active?: {
    username?: string
    cluster?: string
    logins?: string[]
    valid_until?: string
  } | null
}

export async function tshStatus(inst: Installation): Promise<InstallationStatus> {
  const base: InstallationStatus = {
    installationId: inst.id,
    version: null,
    loggedIn: false,
    user: null,
    validUntil: null,
    logins: [],
    error: null,
    checkedAt: Date.now(),
  }
  base.version = await tshVersion(inst)
  if (!base.version) {
    base.error = `tsh did not answer at ${inst.tshPath}`
    return base
  }
  const r = await run(inst, ['status', '--format=json'])
  // tsh prints the JSON and then, on an expired profile, "ERROR: Active profile expired."
  const jsonStart = r.stdout.indexOf('{')
  if (jsonStart !== -1) {
    try {
      const parsed = JSON.parse(r.stdout.slice(jsonStart)) as StatusJson
      const active = parsed.active
      if (active) {
        base.user = active.username ?? null
        base.validUntil = active.valid_until ?? null
        base.logins = active.logins ?? []
        base.loggedIn = Boolean(base.validUntil && Date.parse(base.validUntil) > Date.now())
      }
    } catch {
      /* fall through to the error below */
    }
  }
  if (!base.loggedIn) {
    const text = (r.stderr + r.stdout).trim()
    base.error = /expired/i.test(text) ? 'Certificate expired, log in again.' : /not logged in|no profile/i.test(text) ? 'Not logged in.' : text ? text.split('\n').slice(-1)[0] : 'Not logged in.'
  }
  return base
}

type NodeJson = {
  metadata?: { name?: string; labels?: Record<string, string> }
  spec?: { hostname?: string; addr?: string }
}

export async function tshNodes(inst: Installation): Promise<TshNode[]> {
  const r = await run(inst, ['ls', '--format=json'], 30_000)
  const jsonStart = r.stdout.indexOf('[')
  if (jsonStart === -1) throw new Error((r.stderr || r.stdout).trim() || 'tsh ls returned nothing')
  const list = JSON.parse(r.stdout.slice(jsonStart)) as NodeJson[]
  return list
    .map((n) => ({
      name: n.spec?.hostname || n.metadata?.name || '',
      hostname: n.spec?.hostname || '',
      addr: n.spec?.addr || '',
      labels: n.metadata?.labels ?? {},
    }))
    .filter((n) => n.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The argv for one interactive-free shell on a node. */
export function tshShellArgs(inst: Installation, target: string): string[] {
  const args = ['ssh']
  if (inst.proxy) args.push(`--proxy=${inst.proxy}`)
  if (inst.mfaMode) args.push(`--mfa-mode=${inst.mfaMode}`)
  args.push(target, '/bin/sh', '-s')
  return args
}

export function tshLoginArgs(inst: Installation, user: string | null, auth: string | null): string[] {
  const args = ['login']
  if (inst.proxy) args.push(`--proxy=${inst.proxy}`)
  if (user) args.push(`--user=${user}`)
  if (auth) args.push(`--auth=${auth}`)
  if (inst.mfaMode) args.push(`--mfa-mode=${inst.mfaMode}`)
  return args
}
