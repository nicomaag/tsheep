/**
 * Values Claude must never see.
 *
 * A command may say `{{secret:DB_PASSWORD}}`. The value comes from the person,
 * typed into tsheep, and lives here: in memory for this run, or on disk
 * encrypted with Electron's safeStorage (the OS keychain / DPAPI) when they
 * chose "always". It is put into the command right before it is written to the
 * shell and taken back out of everything that comes back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { SecretInfo } from '@shared/types'
import { bus } from './events'

const memory = new Map<string, string>()
const persistent = new Map<string, string>()
let loaded = false

function file(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (!existsSync(file()) || !safeStorage.isEncryptionAvailable()) return
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, string>
    for (const [name, b64] of Object.entries(raw)) {
      try {
        persistent.set(name, safeStorage.decryptString(Buffer.from(b64, 'base64')))
      } catch {
        /* a value from another machine or user; skip it */
      }
    }
  } catch {
    /* unreadable file: start empty */
  }
}

function save(): void {
  const out: Record<string, string> = {}
  for (const [name, value] of persistent) out[name] = safeStorage.encryptString(value).toString('base64')
  mkdirSync(dirname(file()), { recursive: true })
  writeFileSync(file(), JSON.stringify(out), { encoding: 'utf8', mode: 0o600 })
}

function publish(): void {
  bus.publish({ type: 'secrets', secrets: secrets.list() })
}

export const secrets = {
  get(name: string): string | undefined {
    load()
    return memory.get(name) ?? persistent.get(name)
  },

  has(name: string): boolean {
    return this.get(name) !== undefined
  },

  set(name: string, value: string, remember: 'session' | 'always'): void {
    load()
    if (remember === 'always' && safeStorage.isEncryptionAvailable()) {
      persistent.set(name, value)
      memory.delete(name)
      save()
    } else {
      // "always" without encryption available degrades to this run only.
      memory.set(name, value)
    }
    publish()
  },

  forget(name: string): void {
    load()
    memory.delete(name)
    if (persistent.delete(name)) save()
    publish()
  },

  list(): SecretInfo[] {
    load()
    const out: SecretInfo[] = []
    for (const name of persistent.keys()) out.push({ name, where: 'always' })
    for (const name of memory.keys()) if (!persistent.has(name)) out.push({ name, where: 'session' })
    return out.sort((a, b) => a.name.localeCompare(b.name))
  },

  /** Every value we know, longest first, for scrubbing output. */
  values(): { name: string; value: string }[] {
    load()
    const all = new Map<string, string>([...persistent, ...memory])
    return [...all]
      .map(([name, value]) => ({ name, value }))
      .filter((s) => s.value.length >= 3)
      .sort((a, b) => b.value.length - a.value.length)
  },
}
