/**
 * The registered tsh installations and what tsh says about each one.
 */
import type { AddInstallationInput, Installation, InstallationStatus, TshNode, UpdateInstallationInput } from '@shared/types'
import { config } from './config'
import { discoverInstallations, readProfile } from './discovery'
import { bus } from './events'
import { tshNodes, tshStatus } from './tsh'

const statuses = new Map<string, InstallationStatus>()
const nodeCache = new Map<string, { at: number; nodes: TshNode[] }>()
const NODE_CACHE_MS = 60_000

function publishList(): void {
  bus.publish({ type: 'installations', installations: config.installations() })
}

export const installations = {
  list(): Installation[] {
    return config.installations()
  },

  get(id: string): Installation | null {
    return config.installations().find((i) => i.id === id) ?? null
  },

  byName(name: string): Installation | null {
    return config.installations().find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? null
  },

  statuses(): InstallationStatus[] {
    return [...statuses.values()]
  },

  add(input: AddInstallationInput): Installation {
    const list = config.installations()
    const existing = list.find((i) => samePath(i.tshPath, input.tshPath) && (i.teleportHome ?? null) === (input.teleportHome ?? null))
    if (existing) {
      // Registering the same binary again updates what was given this time.
      if (input.proxy) existing.proxy = input.proxy
      if (input.mfaMode) existing.mfaMode = input.mfaMode
      if (input.auth !== undefined) existing.auth = input.auth
      config.setInstallations(list)
      publishList()
      return existing
    }
    if (list.some((i) => i.name.toLowerCase() === input.name.toLowerCase())) {
      throw new Error(`An installation named "${input.name}" already exists`)
    }
    const profile = input.teleportHome ? readProfile(input.teleportHome) : { proxy: null, cluster: null }
    const inst: Installation = {
      id: config.newId(),
      name: input.name,
      tshPath: input.tshPath,
      teleportHome: input.teleportHome ?? null,
      proxy: input.proxy ?? profile.proxy,
      cluster: profile.cluster,
      mfaMode: input.mfaMode ?? null,
      auth: input.auth ?? null,
      source: input.source ?? 'manual',
    }
    config.setInstallations([...list, inst])
    publishList()
    void this.refresh(inst.id)
    return inst
  },

  update(id: string, patch: UpdateInstallationInput): Installation {
    const list = config.installations()
    const inst = list.find((i) => i.id === id)
    if (!inst) throw new Error(`No installation with id ${id}`)
    Object.assign(inst, patch)
    config.setInstallations(list)
    publishList()
    return inst
  },

  remove(id: string): void {
    config.setInstallations(config.installations().filter((i) => i.id !== id))
    statuses.delete(id)
    nodeCache.delete(id)
    publishList()
  },

  /** Adds whatever discovery finds that is not registered yet. */
  discover(): Installation[] {
    const added: Installation[] = []
    for (const found of discoverInstallations()) {
      const before = config.installations().length
      const inst = this.add(found)
      if (config.installations().length > before) added.push(inst)
    }
    return added
  },

  async refresh(id: string): Promise<InstallationStatus> {
    const inst = this.get(id)
    if (!inst) throw new Error(`No installation with id ${id}`)
    const status = await tshStatus(inst)
    statuses.set(id, status)
    bus.publish({ type: 'installation-status', status })
    return status
  },

  async refreshAll(): Promise<void> {
    await Promise.all(this.list().map((i) => this.refresh(i.id)))
  },

  async nodes(id: string, force = false): Promise<TshNode[]> {
    const inst = this.get(id)
    if (!inst) throw new Error(`No installation with id ${id}`)
    const cached = nodeCache.get(id)
    if (!force && cached && Date.now() - cached.at < NODE_CACHE_MS) return cached.nodes
    const nodes = await tshNodes(inst)
    nodeCache.set(id, { at: Date.now(), nodes })
    return nodes
  },
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase()
  return process.platform === 'win32' ? norm(a) === norm(b) : a === b
}
