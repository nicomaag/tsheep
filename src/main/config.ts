/**
 * Everything tsheep remembers between runs: installations, settings and the MCP
 * token. One JSON file in userData, written whole on every change.
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_SETTINGS, ENV_KEY, nodeShellFor, type Installation, type NodeShell, type Settings } from '@shared/types'
import { bus } from './events'

type ConfigFile = {
  installations: Installation[]
  settings: Settings
  token: string
}

let file: ConfigFile | null = null

/** What happened when the config was first read, for the diagnostics card. */
export const configDiagnostics = { path: '', readAt: 0, error: null as string | null, bytes: 0, head: '' }

function path(): string {
  return join(app.getPath('userData'), 'config.json')
}

function load(): ConfigFile {
  if (file) return file
  configDiagnostics.path = path()
  configDiagnostics.readAt = Date.now()
  try {
    const raw = readFileSync(path(), 'utf8')
    configDiagnostics.bytes = raw.length
    configDiagnostics.head = raw.slice(0, 120)
    const parsed = JSON.parse(raw) as Partial<ConfigFile>
    file = {
      installations: parsed.installations ?? [],
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      token: parsed.token || newToken(),
    }
  } catch (e) {
    configDiagnostics.error = (e as Error).message
    file = { installations: [], settings: { ...DEFAULT_SETTINGS }, token: newToken() }
  }
  return file
}

function save(): void {
  const target = path()
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(load(), null, 2), { encoding: 'utf8', mode: 0o600 })
}

function newToken(): string {
  return randomBytes(24).toString('hex')
}

/**
 * Changes one node's shell settings. `env` merges; a null value removes that
 * variable. A node left with no login shell and no variables is dropped.
 */
export function setNodeShell(node: string, patch: { login?: boolean; env?: Record<string, string | null> }): NodeShell {
  const key = node.toLowerCase()
  const all = { ...config.settings().nodeShell }
  const cur = nodeShellFor(all, key)
  const env = { ...cur.env }
  for (const [k, v] of Object.entries(patch.env ?? {})) {
    if (!ENV_KEY.test(k)) throw new Error(`"${k}" is not a valid variable name`)
    if (v === null) delete env[k]
    else env[k] = v
  }
  const next: NodeShell = { login: patch.login ?? cur.login, env }
  if (!next.login && Object.keys(next.env).length === 0) delete all[key]
  else all[key] = next
  const settings = config.setSettings({ nodeShell: all })
  bus.publish({ type: 'settings', settings })
  return next
}

export const config = {
  installations(): Installation[] {
    return load().installations
  },
  setInstallations(list: Installation[]): void {
    load().installations = list
    save()
  },
  settings(): Settings {
    return load().settings
  },
  setSettings(next: Partial<Settings>): Settings {
    load().settings = { ...load().settings, ...next }
    save()
    return load().settings
  },
  token(): string {
    return load().token
  },
  rotateToken(): string {
    load().token = newToken()
    save()
    return load().token
  },
  newId(): string {
    return randomUUID()
  },
}
