import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { AddInstallationInput, ApprovalAnswer, AppEvent, HistoryFilter, OpenSessionInput, SessionMode, Settings, UpdateInstallationInput } from '../shared/types'

const api = {
  snapshot: () => ipcRenderer.invoke(IPC.SNAPSHOT),
  platform: () => ipcRenderer.invoke(IPC.WINDOW_PLATFORM),
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.invoke(IPC.WINDOW_CONTROL, action),
  appPaths: () => ipcRenderer.invoke(IPC.APP_PATHS),
  openLogs: () => ipcRenderer.invoke(IPC.LOGS_OPEN),
  onEvent: (listener: (event: AppEvent) => void) => {
    const wrapped = (_e: unknown, event: AppEvent) => listener(event)
    ipcRenderer.on(IPC.EVENT, wrapped)
    return () => ipcRenderer.off(IPC.EVENT, wrapped)
  },
  installations: {
    discover: () => ipcRenderer.invoke(IPC.INSTALLATIONS_DISCOVER),
    add: (input: AddInstallationInput) => ipcRenderer.invoke(IPC.INSTALLATIONS_ADD, input),
    remove: (id: string) => ipcRenderer.invoke(IPC.INSTALLATIONS_REMOVE, id),
    update: (id: string, patch: UpdateInstallationInput) => ipcRenderer.invoke(IPC.INSTALLATIONS_UPDATE, id, patch),
    refresh: (id: string) => ipcRenderer.invoke(IPC.INSTALLATIONS_REFRESH, id),
    login: (id: string, user: string | null) => ipcRenderer.invoke(IPC.INSTALLATIONS_LOGIN, id, user),
    nodes: (id: string, force?: boolean) => ipcRenderer.invoke(IPC.NODES_LIST, id, force),
    setNodeShell: (node: string, patch: { login?: boolean; env?: Record<string, string | null> }) => ipcRenderer.invoke(IPC.NODES_SET_SHELL, node, patch),
  },
  sessions: {
    open: (input: OpenSessionInput) => ipcRenderer.invoke(IPC.SESSIONS_OPEN, input),
    close: (id: string, remove?: boolean) => ipcRenderer.invoke(IPC.SESSIONS_CLOSE, id, remove),
    setMode: (id: string, mode: SessionMode) => ipcRenderer.invoke(IPC.SESSIONS_SET_MODE, id, mode),
    run: (id: string, command: string) => ipcRenderer.invoke(IPC.SESSIONS_RUN, id, command),
    stop: (entryId: string) => ipcRenderer.invoke(IPC.ENTRIES_STOP, entryId),
  },
  history: {
    search: (filter: HistoryFilter) => ipcRenderer.invoke(IPC.HISTORY_SEARCH, filter),
    export: (filter: HistoryFilter, kind: 'md' | 'jsonl') => ipcRenderer.invoke(IPC.HISTORY_EXPORT, filter, kind),
  },
  approvals: {
    answer: (entryId: string, answer: ApprovalAnswer) => ipcRenderer.invoke(IPC.APPROVALS_ANSWER, entryId, answer),
  },
  secrets: {
    forget: (name: string) => ipcRenderer.invoke(IPC.SECRETS_FORGET, name),
    reveal: (entryId: string) => ipcRenderer.invoke(IPC.ENTRIES_REVEAL, entryId),
  },
  mcp: {
    connectInfo: () => ipcRenderer.invoke(IPC.MCP_CONNECT_INFO),
    rotateToken: () => ipcRenderer.invoke(IPC.MCP_ROTATE_TOKEN),
  },
  settings: {
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  },
}

contextBridge.exposeInMainWorld('tsheep', api)

export type TsheepApi = typeof api
