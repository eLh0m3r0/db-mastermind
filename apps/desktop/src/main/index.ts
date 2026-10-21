import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron'
import { describeError } from '@dbmastermind/core'
import { API_CHANNEL, type IpcResult, type MastermindApi } from '@shared/api'
import { api, db } from './api'
import { flushHistory } from './library'
import { getSettings } from './settings'
import { isMcpMode, runMcpMode } from './mcp-mode'
import { configureDataDir, readJson, writeJson } from './storage'
import { checkForUpdates } from './updates'

configureDataDir()

let mainWindow: BrowserWindow | null = null

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

function createWindow() {
  const state = readJson<WindowState>('window.json', { width: 1440, height: 900 })
  const theme = getSettings().theme
  nativeTheme.themeSource = theme
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 900,
    minHeight: 560,
    show: false,
    title: 'DB Mastermind',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16181d' : '#ffffff',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 13 },
    icon: join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })
  if (state.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', () => {
    if (!mainWindow) return
    const bounds = mainWindow.getNormalBounds()
    writeJson('window.json', { ...bounds, maximized: mainWindow.isMaximized() } satisfies WindowState)
  })
  mainWindow.on('closed', () => (mainWindow = null))

  // Links open in the browser, never inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function sendCommand(command: string) {
  mainWindow?.webContents.send('menu:command', command)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  // Accelerators are only displayed; the renderer's keymap handles the keys (see lib/keymap.ts).
  const cmd = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => sendCommand(command),
  })
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              cmd('Settings…', 'settings', 'CmdOrCtrl+,'),
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: 'File',
      submenu: [
        cmd('New Query Tab', 'new-query', 'CmdOrCtrl+T'),
        cmd('New Connection…', 'new-connection', 'CmdOrCtrl+Shift+N'),
        { type: 'separator' },
        cmd('Close Tab', 'close-tab', 'CmdOrCtrl+W'),
        cmd('Reopen Closed Tab', 'reopen-tab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        cmd('Save Query', 'save-query', 'CmdOrCtrl+S'),
        cmd('Export Results…', 'export', 'CmdOrCtrl+Shift+E'),
        { type: 'separator' },
        cmd('Disconnect', 'disconnect'),
        ...(isMac ? [] : [{ type: 'separator' } as const, cmd('Settings…', 'settings', 'Ctrl+,'), { role: 'quit' } as const]),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        cmd('Command Palette…', 'palette', 'CmdOrCtrl+K'),
        cmd('Quick Open Table…', 'quick-open', 'CmdOrCtrl+P'),
        { type: 'separator' },
        cmd('Toggle Sidebar', 'toggle-sidebar', 'CmdOrCtrl+B'),
        cmd('Toggle AI Assistant', 'toggle-ai', 'CmdOrCtrl+J'),
        { type: 'separator' },
        cmd('Refresh Schema', 'refresh-schema', 'F5'),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const, { role: 'reload' } as const]),
      ],
    },
    {
      label: 'Query',
      submenu: [
        cmd('Run Statement / Selection', 'run-current', 'CmdOrCtrl+Enter'),
        cmd('Run All', 'run-all', 'CmdOrCtrl+Shift+Enter'),
        cmd('Cancel Query', 'cancel-query', 'CmdOrCtrl+.'),
        { type: 'separator' },
        cmd('Format SQL', 'format-sql', 'CmdOrCtrl+Shift+F'),
        cmd('Ask AI…', 'ask-ai', 'CmdOrCtrl+I'),
        { type: 'separator' },
        cmd('History', 'history', 'CmdOrCtrl+Y'),
        cmd('Saved Queries', 'saved-queries'),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal('https://github.com/eLh0m3r0/db-mastermind#readme') },
        { label: 'Roadmap', click: () => void shell.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md') },
        { label: 'Report an Issue', click: () => void shell.openExternal('https://github.com/eLh0m3r0/db-mastermind/issues/new') },
        { type: 'separator' },
        cmd('Keyboard Shortcuts', 'shortcuts'),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startApp() {
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  ipcMain.handle(API_CHANNEL, async (_event, method: keyof MastermindApi, args: unknown[]): Promise<IpcResult<unknown>> => {
    const fn = api[method] as ((...a: unknown[]) => Promise<unknown>) | undefined
    if (typeof fn !== 'function') return { ok: false, error: { message: `Unknown method ${String(method)}` } }
    try {
      return { ok: true, value: await fn(...args) }
    } catch (err) {
      return { ok: false, error: { ...describeError(err), name: err instanceof Error ? err.name : undefined } }
    }
  })

  ipcMain.on('theme:set', (_e, theme: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = theme
  })

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('dev.dbmastermind.app')
    buildMenu()
    createWindow()
    void checkForUpdates((info) => mainWindow?.webContents.send('update:available', info))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  let quitting = false
  app.on('before-quit', (event) => {
    flushHistory()
    if (quitting) return
    quitting = true
    event.preventDefault()
    // Close database connections cleanly (rolls back open sessions) before exiting.
    void Promise.race([db.disconnectAll(), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (isMcpMode) void runMcpMode()
else startApp()
