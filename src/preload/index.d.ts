import type {
  AddInstallationInput,
  ApprovalAnswer,
  AppEvent,
  HistoryFilter,
  HistoryResult,
  Installation,
  InstallationStatus,
  McpStatus,
  NodeShell,
  OpenSessionInput,
  Session,
  SessionMode,
  Settings,
  Snapshot,
  TshNode,
  UpdateInstallationInput,
} from '../shared/types'

export type TsheepApi = {
  snapshot: () => Promise<Snapshot>
  platform: () => Promise<NodeJS.Platform>
  windowControl: (action: 'minimize' | 'maximize' | 'close') => Promise<void>
  openLogs: () => Promise<void>
  appPaths: () => Promise<{
    userData: string
    exe: string
    version: string
    packaged: boolean
    diagnostics: { path: string; readAt: number; error: string | null; bytes: number; head: string; tokenTail: string; argv: string; cwd: string; appData: string; rules: number }
  }>
  onEvent: (listener: (event: AppEvent) => void) => () => void
  installations: {
    discover: () => Promise<Installation[]>
    add: (input: AddInstallationInput) => Promise<Installation>
    remove: (id: string) => Promise<void>
    update: (id: string, patch: UpdateInstallationInput) => Promise<Installation>
    refresh: (id: string) => Promise<InstallationStatus>
    login: (id: string, user: string | null) => Promise<string>
    nodes: (id: string, force?: boolean) => Promise<TshNode[]>
    setNodeShell: (node: string, patch: { login?: boolean; env?: Record<string, string | null> }) => Promise<NodeShell>
  }
  sessions: {
    open: (input: OpenSessionInput) => Promise<Session>
    close: (id: string, remove?: boolean) => Promise<void>
    setMode: (id: string, mode: SessionMode) => Promise<Session>
    run: (id: string, command: string) => Promise<void>
    stop: (entryId: string) => Promise<boolean>
  }
  history: {
    search: (filter: HistoryFilter) => Promise<HistoryResult>
    export: (filter: HistoryFilter, kind: 'md' | 'jsonl') => Promise<{ path: string; count: number } | null>
  }
  approvals: {
    answer: (entryId: string, answer: ApprovalAnswer) => Promise<boolean>
  }
  secrets: {
    forget: (name: string) => Promise<void>
    reveal: (entryId: string) => Promise<{ command: string; stdout: string; stderr: string } | null>
  }
  mcp: {
    connectInfo: () => Promise<{ command: string; token: string; status: McpStatus }>
    rotateToken: () => Promise<string>
  }
  settings: {
    set: (patch: Partial<Settings>) => Promise<Settings>
  }
}

declare global {
  interface Window {
    tsheep: TsheepApi
  }
}
