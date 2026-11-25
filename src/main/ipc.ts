import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type { Actor, AddInstallationInput, ApprovalAnswer, HistoryFilter, OpenSessionInput, SessionMode, Settings, Snapshot, UpdateInstallationInput } from '@shared/types'
import { history } from './history'
import { answerApproval } from './approvals'
import { config, configDiagnostics, setNodeShell } from './config'
import { bus } from './events'
import { installations } from './installations'
import { logDir } from './log'
import { startLogin } from './login'
import { connectCommand, mcpStatus, restartMcp } from './mcp'
import { secrets } from './secrets'
import { sessions } from './sessions'

/** The person at the window, as the author of what they do there. */
const YOU: Actor = { label: 'you', claudeSessionId: null, repo: null, branch: null, ownLabel: null, ownSessionId: null }
/** Commands typed in tsheep; the Stop button ends them sooner. */
const TYPED_TIMEOUT_MS = 3_600_000

export function snapshot(): Snapshot {
  return {
    installations: installations.list(),
    statuses: installations.statuses(),
    sessions: sessions.list(),
    entries: sessions.entries(),
    settings: config.settings(),
    mcp: mcpStatus(),
    secrets: secrets.list(),
  }
}

export function registerIpc(): void {
  ipcMain.handle(IPC.SNAPSHOT, () => snapshot())
  ipcMain.handle(IPC.WINDOW_PLATFORM, () => process.platform)
  ipcMain.handle(IPC.APP_PATHS, () => ({
    userData: app.getPath('userData'),
    exe: process.execPath,
    version: app.getVersion(),
    packaged: app.isPackaged,
    diagnostics: {
      ...configDiagnostics,
      tokenTail: config.token().slice(-4),
      argv: process.argv.slice(1).join(' '),
      cwd: process.cwd(),
      appData: process.env.APPDATA ?? '',
      rules: config.settings().nodeRules.length,
    },
  }))

  ipcMain.handle(IPC.LOGS_OPEN, () => void shell.openPath(logDir()))

  ipcMain.handle(IPC.INSTALLATIONS_DISCOVER, () => installations.discover())
  ipcMain.handle(IPC.INSTALLATIONS_ADD, (_e, input: AddInstallationInput) => installations.add(input))
  ipcMain.handle(IPC.INSTALLATIONS_REMOVE, (_e, id: string) => installations.remove(id))
  ipcMain.handle(IPC.INSTALLATIONS_UPDATE, (_e, id: string, patch: UpdateInstallationInput) => installations.update(id, patch))
  ipcMain.handle(IPC.INSTALLATIONS_REFRESH, (_e, id: string) => installations.refresh(id))
  ipcMain.handle(IPC.INSTALLATIONS_LOGIN, (_e, id: string, user: string | null) => startLogin(id, user))

  ipcMain.handle(IPC.NODES_SET_SHELL, (_e, node: string, patch: { login?: boolean; env?: Record<string, string | null> }) => setNodeShell(node, patch))
  ipcMain.handle(IPC.NODES_LIST,(_e, id: string, force?: boolean) => installations.nodes(id, Boolean(force)))

  ipcMain.handle(IPC.SESSIONS_OPEN, (_e, input: OpenSessionInput) => sessions.open(input, { label: 'ui', claudeSessionId: null, repo: null, branch: null, ownLabel: null, ownSessionId: null }))
  ipcMain.handle(IPC.SESSIONS_CLOSE, (_e, id: string, remove?: boolean) => (remove ? sessions.remove(id) : sessions.close(id, 'closed in tsheep')))
  ipcMain.handle(IPC.SESSIONS_SET_MODE, (_e, id: string, mode: SessionMode) => sessions.setMode(id, mode))
  ipcMain.handle(IPC.APPROVALS_ANSWER, (_e, entryId: string, answer: ApprovalAnswer) => answerApproval(entryId, answer))
  ipcMain.handle(IPC.SECRETS_FORGET, (_e, name: string) => secrets.forget(name))
  ipcMain.handle(IPC.ENTRIES_REVEAL, (_e, entryId: string) => sessions.reveal(entryId))
  ipcMain.handle(IPC.ENTRIES_STOP, (_e, entryId: string) => sessions.stop(entryId, 'you in tsheep'))
  // A command the person typed: no approval from that same person, no Claude behind it.
  ipcMain.handle(IPC.SESSIONS_RUN, (_e, sessionId: string, command: string) => {
    sessions.start(sessionId, command, 'Typed in tsheep', YOU, TYPED_TIMEOUT_MS, { byPerson: true })
  })
  ipcMain.handle(IPC.HISTORY_SEARCH, (_e, filter: HistoryFilter) => history.search(filter))
  ipcMain.handle(IPC.HISTORY_EXPORT, async (e, filter: HistoryFilter, kind: 'md' | 'jsonl') => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const name = `tsheep-history-${new Date().toISOString().slice(0, 10)}.${kind === 'md' ? 'md' : 'jsonl'}`
    const pick = await (win ? dialog.showSaveDialog(win, { defaultPath: name }) : dialog.showSaveDialog({ defaultPath: name }))
    if (pick.canceled || !pick.filePath) return null
    const result = history.search({ ...filter })
    writeFileSync(pick.filePath, history.format(result, kind), 'utf8')
    return { path: pick.filePath, count: result.hits.length }
  })

  ipcMain.handle(IPC.MCP_ROTATE_TOKEN, async () => {
    config.rotateToken()
    await restartMcp()
    return connectCommand()
  })
  ipcMain.handle(IPC.MCP_CONNECT_INFO, () => ({ command: connectCommand(), token: config.token(), status: mcpStatus() }))

  ipcMain.handle(IPC.SETTINGS_SET, async (_e, patch: Partial<Settings>) => {
    const before = config.settings().port
    const next = config.setSettings(patch)
    bus.publish({ type: 'settings', settings: next })
    if (patch.nodeRules) sessions.applyRules()
    if (next.port !== before) await restartMcp()
    return next
  })

  bus.onEvent((event) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send(IPC.EVENT, event)
    }
  })
}
