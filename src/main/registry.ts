/**
 * Asking the local Claude session registry what a session is called.
 *
 * Claude Code tells the MCP nothing about its session; the session id comes
 * from the client through `identify`. With it, the registry (when there is
 * one) gives the title the person sees in Claude, the resume command and the
 * repo. Without a registry, or when it is slow, nothing here is needed: the
 * client keeps the name it gave.
 */
import { config } from './config'

export type RegistryInfo = {
  displayName: string | null
  resumeCommand: string | null
  claudeUrl: string | null
  repo: string | null
  branch: string | null
}

type StateSession = {
  sessionId?: string
  displayName?: string
  resumeCommand?: string
  claudeUrl?: string
  repoName?: string
  branch?: string
}

const cache = new Map<string, RegistryInfo>()
/** The registry runs git for every session it knows and can take a while. */
const TIMEOUT_MS = 25_000

export async function lookupSession(sessionId: string): Promise<RegistryInfo | null> {
  const base = config.settings().sessionRegistryUrl.trim().replace(/\/$/, '')
  if (!base) return null
  const hit = cache.get(sessionId)
  if (hit) return hit
  try {
    const res = await fetch(`${base}/api/state`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return null
    const state = (await res.json()) as { sessions?: StateSession[] }
    const s = state.sessions?.find((x) => x.sessionId === sessionId)
    if (!s) return null
    const info: RegistryInfo = {
      displayName: s.displayName ?? null,
      resumeCommand: s.resumeCommand ?? `claude -r ${sessionId}`,
      claudeUrl: s.claudeUrl ?? null,
      repo: s.repoName ?? null,
      branch: s.branch ?? null,
    }
    cache.set(sessionId, info)
    return info
  } catch {
    return null
  }
}
