import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from 'electron'
import { describeError } from '@dbmastermind/core'
import { API_CHANNEL, type IpcResult, type MastermindApi } from '@shared/api'
import { api, db } from './api'
import { buildMenu } from './menu'
import { flushHistory } from './library'
import { flushConnections, loadConnections } from './connections'
import { getSettings, loadSettings } from './settings'
import { watchTeamFolder } from './team'
import { applyMcpHttp } from './mcp-http'
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
      // The preload is one CommonJS bundle that only needs contextBridge/ipcRenderer/webUtils, so it runs sandboxed.
      sandbox: true,
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

  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.dbmastermind.app')
    // Settings first: they name the team folder that contributes connections.
    await loadSettings()
    await loadConnections()
    watchTeamFolder()
    buildMenu()
    createWindow()
    void applyMcpHttp()
    void checkForUpdates(
      (info) => mainWindow?.webContents.send('update:available', info),
      (info) => mainWindow?.webContents.send('update:ready', info),
    )
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
    void Promise.race([Promise.all([db.disconnectAll(), flushConnections()]), new Promise((r) => setTimeout(r, 3000))]).finally(() => app.quit())
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (isMcpMode) void runMcpMode()
else startApp()
