import { create } from 'zustand'
import type { AppEvent, Entry, Installation, InstallationStatus, McpStatus, SecretInfo, Session, Settings, Snapshot } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { playSound } from './sound'

export type View = { kind: 'session'; id: string } | { kind: 'nodes' } | { kind: 'history' } | { kind: 'installations' } | { kind: 'connect' } | { kind: 'settings' }

type State = {
  ready: boolean
  platform: string
  installations: Installation[]
  statuses: Record<string, InstallationStatus>
  sessions: Record<string, Session>
  entries: Record<string, Entry>
  settings: Settings
  mcp: McpStatus
  secrets: SecretInfo[]
  view: View
  /** Sessions with activity since they were last looked at. */
  unseen: Record<string, number>
  setView: (view: View) => void
  boot: () => Promise<void>
  apply: (event: AppEvent) => void
}

export const useStore = create<State>((set, get) => ({
  ready: false,
  platform: 'win32',
  installations: [],
  statuses: {},
  sessions: {},
  entries: {},
  settings: DEFAULT_SETTINGS,
  mcp: { running: false, port: 0, url: '', error: null, clients: [] },
  secrets: [],
  view: { kind: 'nodes' },
  unseen: {},

  setView: (view) =>
    set((s) => {
      const unseen = { ...s.unseen }
      if (view.kind === 'session') delete unseen[view.id]
      return { view, unseen }
    }),

  boot: async () => {
    const [snap, platform] = await Promise.all([window.tsheep.snapshot(), window.tsheep.platform()])
    set(fromSnapshot(snap, platform))
    window.tsheep.onEvent((event) => {
      get().apply(event)
      if (event.type === 'attention') playSound(get().settings.attentionSound)
    })
  },

  apply: (event) =>
    set((s) => {
      switch (event.type) {
        case 'installations':
          return { installations: event.installations }
        case 'installation-status':
          return { statuses: { ...s.statuses, [event.status.installationId]: event.status } }
        case 'settings':
          return { settings: event.settings }
        case 'mcp':
          return { mcp: event.status }
        case 'session': {
          const isNew = !s.sessions[event.session.id]
          const next: Partial<State> = { sessions: { ...s.sessions, [event.session.id]: event.session } }
          // A shell opened by a Claude session is shown as it opens, so the MFA
          // prompt and the first command are seen without hunting for them.
          if (isNew && event.session.openedBy !== 'ui') next.view = { kind: 'session', id: event.session.id }
          return next
        }
        case 'session-removed': {
          const sessions = { ...s.sessions }
          delete sessions[event.sessionId]
          const entries = Object.fromEntries(Object.entries(s.entries).filter(([, e]) => e.sessionId !== event.sessionId))
          const view: View = s.view.kind === 'session' && s.view.id === event.sessionId ? { kind: 'nodes' } : s.view
          return { sessions, entries, view }
        }
        case 'entry': {
          const looking = s.view.kind === 'session' && s.view.id === event.entry.sessionId
          const unseen = looking || s.entries[event.entry.id] ? s.unseen : { ...s.unseen, [event.entry.sessionId]: (s.unseen[event.entry.sessionId] ?? 0) + 1 }
          return { entries: { ...s.entries, [event.entry.id]: event.entry }, unseen }
        }
        case 'attention':
          return { view: { kind: 'session', id: event.sessionId } }
        case 'secrets':
          return { secrets: event.secrets }
        case 'entry-chunk': {
          const entry = s.entries[event.entryId]
          if (!entry || entry.status !== 'running') return {}
          const patched = { ...entry, [event.stream]: entry[event.stream] + event.text }
          return { entries: { ...s.entries, [event.entryId]: patched } }
        }
      }
    }),
}))

function fromSnapshot(snap: Snapshot, platform: string): Partial<State> {
  return {
    ready: true,
    platform,
    installations: snap.installations,
    statuses: Object.fromEntries(snap.statuses.map((s) => [s.installationId, s])),
    sessions: Object.fromEntries(snap.sessions.map((s) => [s.id, s])),
    entries: Object.fromEntries(snap.entries.map((e) => [e.id, e])),
    settings: snap.settings,
    mcp: snap.mcp,
    secrets: snap.secrets,
  }
}

export function useSessionList(): Session[] {
  const sessions = useStore((s) => s.sessions)
  return Object.values(sessions).sort((a, b) => b.createdAt - a.createdAt)
}

export function usePendingCounts(): Record<string, number> {
  const entries = useStore((s) => s.entries)
  const counts: Record<string, number> = {}
  for (const e of Object.values(entries)) if (e.status === 'pending') counts[e.sessionId] = (counts[e.sessionId] ?? 0) + 1
  return counts
}

export function useEntriesFor(sessionId: string): Entry[] {
  const entries = useStore((s) => s.entries)
  return Object.values(entries)
    .filter((e) => e.sessionId === sessionId)
    .sort((a, b) => b.seq - a.seq)
}
