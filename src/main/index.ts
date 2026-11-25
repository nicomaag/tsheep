import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, Notification, shell, Tray } from 'electron'
import { IPC } from '@shared/ipc'
import { config } from './config'
import { bus } from './events'
import { installations } from './installations'
import { registerIpc } from './ipc'
import { log } from './log'
import { startMcp } from './mcp'
import { sessions } from './sessions'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const LIGHT_BG = '#f5f5f7'
const DARK_BG = '#1c1c1e'

function background(): string {
  return nativeTheme.shouldUseDarkColors ? DARK_BG : LIGHT_BG
}

/** Icon files: next to the sources in development, in extraResources once packaged. */
function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'resources') : join(app.getAppPath(), 'resources')
}

function iconPath(): string {
  const file = process.platform === 'win32' ? 'icon.ico' : 'icon.png'
  return join(resourcesDir(), file)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: background(),
    title: 'tsheep',
    icon: iconPath(),
    // Own window chrome everywhere: macOS keeps its traffic lights, Windows and
    // Linux get controls drawn by the renderer, which fit the rest of the UI.
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 16 } } : { frame: false }),
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => {
    if (!win) return
    // Set again once the window exists: in development the taskbar otherwise
    // keeps the icon of electron.exe.
    win.setIcon(nativeImage.createFromPath(iconPath()))
    win.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Closing keeps tsheep running in the tray, so the MCP stays reachable for
  // the next Claude session. Quit is in the tray menu.
  win.on('close', (e) => {
    if (quitting || !config.settings().closeToTray) return
    e.preventDefault()
    win?.hide()
  })
  win.on('closed', () => (win = null))

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

export function focusMainWindow(): void {
  if (!win) createWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/**
 * A command waits for a person who is probably looking at a terminal, not at
 * tsheep: the window comes to the front, the taskbar entry flashes and a
 * notification says what is asked. The settings say which of these happen;
 * the sound is played by the window itself.
 */
function attention(title: string, body: string): void {
  const s = config.settings()
  if (!win) createWindow()
  if (win && s.attentionWindow === 'flash') {
    win.flashFrame(true)
    win.once('focus', () => win?.flashFrame(false))
  }
  if (win && s.attentionWindow === 'front') {
    // Windows keeps keyboard focus with the active program and only lets a
    // window in front, which is useless for typing. Restoring from minimised
    // is one of the few things that also moves the focus, so a visible window
    // takes that detour; always-on-top for a moment keeps it in front.
    if (process.platform === 'win32' && !win.isFocused()) {
      if (!win.isMinimized()) win.minimize()
      win.restore()
    } else if (win.isMinimized()) {
      win.restore()
    }
    win.setAlwaysOnTop(true)
    win.show()
    app.focus({ steal: true })
    win.focus()
    win.moveTop()
    win.webContents.focus()
    win.setAlwaysOnTop(false)
    win.flashFrame(true)
    win.once('focus', () => win?.flashFrame(false))
    // The card that takes the keyboard is rendered a moment after the event
    // that opened it; hand the page focus again once it is there.
    for (const ms of [120, 400, 900]) {
      setTimeout(() => {
        if (!win || win.isDestroyed()) return
        win.focus()
        win.webContents.focus()
      }, ms)
    }
  }
  if (s.attentionNotification && Notification.isSupported()) {
    // tsheep's own sound replaces the system's notification sound.
    const n = new Notification({ title, body, icon: iconPath(), silent: s.attentionSound !== 'none' })
    n.on('click', focusMainWindow)
    n.show()
  }
}

function trayImage(): Electron.NativeImage {
  const dir = resourcesDir()
  if (process.platform === 'darwin') {
    // A template image: macOS tints the black glyph for light and dark menu bars.
    const image = nativeImage.createFromPath(join(dir, 'trayTemplate.png'))
    image.setTemplateImage(true)
    return image
  }
  if (process.platform === 'win32') return nativeImage.createFromPath(join(dir, 'icon.ico'))
  return nativeImage.createFromPath(join(dir, 'icon.png')).resize({ width: 22, height: 22 })
}

function createTray(): void {
  tray = new Tray(trayImage())
  tray.setToolTip('tsheep')
  const refresh = () => {
    const open = sessions.list().filter((s) => s.state !== 'closed').length
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open tsheep', click: focusMainWindow },
        { label: open === 1 ? '1 open shell' : `${open} open shells`, enabled: false },
        { type: 'separator' },
        {
          label: 'Quit tsheep',
          click: () => {
            quitting = true
            app.quit()
          },
        },
      ]),
    )
  }
  refresh()
  tray.on('click', focusMainWindow)
  bus.onEvent((e) => {
    if (e.type === 'session' || e.type === 'session-removed') refresh()
  })
}

function applyTheme(): void {
  nativeTheme.themeSource = config.settings().theme
  win?.setBackgroundColor(background())
}

function applyLoginItem(): void {
  if (process.platform === 'linux') return
  app.setLoginItemSettings({ openAtLogin: config.settings().openAtLogin })
}

const single = app.requestSingleInstanceLock()
if (!single) {
  app.quit()
} else {
  app.on('second-instance', focusMainWindow)

  app.whenReady().then(async () => {
    // Windows ties notifications and the taskbar icon to this id. Electron
    // creates a Start Menu shortcut for it on the first notification, and
    // that shortcut's icon then wins for every window with the id. In
    // development that shortcut would point at electron.exe with Electron's
    // own icon, so development uses an id of its own; the installer makes the
    // real shortcut for the real id.
    app.setAppUserModelId(app.isPackaged ? 'de.nicomaag.tsheep' : 'de.nicomaag.tsheep.dev')
    applyTheme()
    applyLoginItem()
    log('app', 'started', { version: app.getVersion(), packaged: app.isPackaged })
    nativeTheme.on('updated', () => win?.setBackgroundColor(background()))
    registerIpc()
    ipcMain.handle(IPC.WINDOW_CONTROL, (_e, action: 'minimize' | 'maximize' | 'close') => {
      if (!win) return
      if (action === 'minimize') win.minimize()
      else if (action === 'maximize') (win.isMaximized() ? win.unmaximize() : win.maximize())
      else win.close()
    })
    bus.onEvent((e) => {
      if (e.type === 'settings') {
        applyTheme()
        applyLoginItem()
      }
      if (e.type === 'attention') attention(e.title, e.body)
    })
    sessions.restore()
    if (installations.list().length === 0) installations.discover()
    void installations.refreshAll()
    await startMcp()
    createTray()
    createWindow()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else focusMainWindow()
  })

  app.on('window-all-closed', () => {
    // Stays alive for the tray unless closing was meant as quitting.
    if (!config.settings().closeToTray) app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    sessions.closeAll()
  })
}
