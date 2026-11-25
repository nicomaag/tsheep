/**
 * Finding tsh installations on this machine without being told.
 *
 * Two kinds of thing are looked for: tsh binaries (PATH, Teleport Connect, a
 * Tools folder) and TELEPORT_HOME directories (~/.tsh*), whose profile YAML
 * says proxy and cluster. They are paired by version number where the folder
 * name carries one (~/.tsh17 goes with a v17 binary); ~/.tsh goes with the
 * PATH tsh. Anything that cannot be paired is still offered, so a person or
 * their Claude can register it by hand.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type { AddInstallationInput } from '@shared/types'

type Binary = { path: string; major: number | null }
type Home = { path: string; suffix: string; proxy: string | null; cluster: string | null }

const isWin = process.platform === 'win32'
const exe = isWin ? 'tsh.exe' : 'tsh'

export function discoverInstallations(): AddInstallationInput[] {
  const binaries = findBinaries()
  const homes = findHomes()
  const result: AddInstallationInput[] = []
  const usedBinaries = new Set<string>()

  for (const home of homes) {
    const wanted = home.suffix ? Number(home.suffix) : null
    const bin =
      binaries.find((b) => !usedBinaries.has(b.path) && wanted !== null && b.major === wanted) ??
      binaries.find((b) => !usedBinaries.has(b.path) && wanted === null && !/teleport-\d+/.test(b.path)) ??
      null
    if (!bin) continue
    usedBinaries.add(bin.path)
    result.push({
      name: `tsh${home.suffix}`,
      tshPath: bin.path,
      teleportHome: home.path,
      proxy: home.proxy,
      mfaMode: null,
      source: 'discovered',
    })
  }
  for (const bin of binaries) {
    if (usedBinaries.has(bin.path)) continue
    result.push({
      name: bin.major ? `tsh${bin.major}` : basename(dirname(bin.path)),
      tshPath: bin.path,
      teleportHome: null,
      proxy: null,
      mfaMode: null,
      source: 'discovered',
    })
  }
  return result
}

function findBinaries(): Binary[] {
  const candidates = new Set<string>()
  for (const dir of (process.env.PATH ?? '').split(isWin ? ';' : ':')) {
    if (!dir) continue
    const p = join(dir, exe)
    if (existsSync(p)) candidates.add(p)
  }
  const home = homedir()
  const fixed = isWin
    ? [
        join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'teleport-connect', 'resources', 'bin', exe),
        join(home, 'Tools'),
      ]
    : [
        '/Applications/Teleport Connect.app/Contents/Resources/bin/tsh',
        '/usr/local/bin/tsh',
        '/opt/homebrew/bin/tsh',
        join(home, 'Tools'),
      ]
  for (const p of fixed) {
    if (!existsSync(p)) continue
    if (statSync(p).isDirectory()) {
      // A Tools folder with teleport-<version> subfolders.
      for (const sub of readdirSync(p)) {
        const candidate = join(p, sub, exe)
        if (/teleport/i.test(sub) && existsSync(candidate)) candidates.add(candidate)
      }
    } else {
      candidates.add(p)
    }
  }
  return [...candidates].map((path) => ({ path, major: versionMajor(path) }))
}

function versionMajor(path: string): number | null {
  const fromName = dirname(path).match(/teleport-(\d+)/i)
  if (fromName) return Number(fromName[1])
  try {
    const out = execFileSync(path, ['version', '--client'], { timeout: 8000, windowsHide: true, encoding: 'utf8' })
    const m = out.match(/Teleport v(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

function findHomes(): Home[] {
  const home = homedir()
  const homes: Home[] = []
  for (const name of readdirSync(home)) {
    const m = name.match(/^\.tsh(\d*)$/)
    if (!m) continue
    const path = join(home, name)
    if (!statSync(path).isDirectory()) continue
    homes.push({ path, suffix: m[1], ...readProfile(path) })
  }
  return homes
}

/** Proxy and cluster from the current profile YAML. Flat key: value lines, no YAML parser needed. */
export function readProfile(teleportHome: string): { proxy: string | null; cluster: string | null } {
  try {
    let yaml: string | null = null
    const current = join(teleportHome, 'current-profile')
    if (existsSync(current)) {
      const name = readFileSync(current, 'utf8').trim()
      const p = join(teleportHome, `${name}.yaml`)
      if (existsSync(p)) yaml = readFileSync(p, 'utf8')
    }
    if (!yaml) {
      const first = readdirSync(teleportHome).find((f) => f.endsWith('.yaml'))
      if (first) yaml = readFileSync(join(teleportHome, first), 'utf8')
    }
    if (!yaml) return { proxy: null, cluster: null }
    const get = (key: string) => yaml!.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null
    return { proxy: get('web_proxy_addr'), cluster: get('cluster') }
  } catch {
    return { proxy: null, cluster: null }
  }
}
