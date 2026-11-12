import { deliverOpenedFilesTo, filesFromArgs, openFileInApp } from './opened-files'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme, screen, shell } from 'electron'
import { describeError, sqliteWorkersAlive, useKnownHostsFile } from '@dbmastermind/core'
import { API_CHANNEL, type IpcResult, type MastermindApi } from '@shared/api'
import { api, db } from './api'
import { buildMenu } from './menu'
import { flushHistory } from './library'
import { flushConnections, loadConnections } from './connections'
import { getSettings, loadSettings } from './settings'
import { watchTeamFolder } from './team'
import { applyMcpHttp } from './mcp-http'
import { isMcpMode, runMcpMode } from './mcp-mode'
import { configureDataDir, dataPath, readJson, writeJson } from './storage'
import { swapMacUpdateBeforeKill } from './mac-update'
import { startUpdateChecks } from './updates'

configureDataDir()

let mainWindow: BrowserWindow | null = null

interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

/**
 * E2E runs on a machine someone is using (DBM_E2E_BACKGROUND, development builds only): no Dock icon, the app never
 * becomes active, and the window opens off-screen without taking the focus.
 */
const e2eBackground = !app.isPackaged && !!process.env.DBM_E2E_BACKGROUND

function createWindow() {
  const state = readJson<WindowState>('window.json', { width: 1440, height: 900 })
  const theme = getSettings().theme
  nativeTheme.themeSource = theme
  // A test run's window stays on the main display, in its far corner: a window placed off every screen is moved by
  // macOS onto the nearest display, which can be a second monitor somebody is working on.
  const main = e2eBackground ? screen.getPrimaryDisplay().workArea : undefined
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: main ? main.x + main.width - 40 : state.x,
    y: main ? main.y + main.height - 40 : state.y,
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

  mainWindow.once('ready-to-show', () => (e2eBackground ? mainWindow?.showInactive() : mainWindow?.show()))
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
  // Once the page has asked for the files it was started with, later ones go straight to it.
  const window = mainWindow
  window.webContents.on('did-finish-load', () => deliverOpenedFilesTo(undefined))
  ipcMain.removeAllListeners('files:listening')
  ipcMain.on('files:listening', () => deliverOpenedFilesTo((path) => !window.isDestroyed() && window.webContents.send('file:open', path)))
  window.on('closed', () => deliverOpenedFilesTo(undefined))
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
  if (e2eBackground && process.platform === 'darwin') app.setActivationPolicy('accessory')
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

  // Files handed to the app: on the command line (Windows, Linux, `open -a`), by macOS (double-click, Open With)
  // or by a second launch, which passes its arguments to this instance.
  for (const file of filesFromArgs(process.argv.slice(1))) openFileInApp(file)
  app.on('open-file', (event, path) => {
    event.preventDefault()
    openFileInApp(path)
  })
  app.on('second-instance', (_event, argv, cwd) => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    for (const file of filesFromArgs(argv.slice(1), cwd)) openFileInApp(file)
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('dev.dbmastermind.app')
    app.setAboutPanelOptions({ copyright: '© 2026 Václav Mudra · MIT license', website: 'https://dbmastermind.app', credits: 'Václav Mudra · vaclavmudra.com' })
    useKnownHostsFile(dataPath('known-hosts.json'))
    // Settings first: they name the team folder that contributes connections.
    await loadSettings()
    await loadConnections()
    watchTeamFolder()
    buildMenu()
    createWindow()
    void applyMcpHttp()
    const tell = (channel: 'update:available' | 'update:ready', info: unknown) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false
      mainWindow.webContents.send(channel, info)
      return true
    }
    startUpdateChecks(
      (info) => tell('update:available', info),
      (info) => tell('update:ready', info),
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
    void Promise.race([db.disconnectAll(), new Promise((r) => setTimeout(r, 3000))])
      .then(() => flushConnections())
      .finally(() => {
        // A SQLite worker stuck in a runaway query can't be stopped, and exiting would wait for it forever.
        if (sqliteWorkersAlive() > 0) {
          swapMacUpdateBeforeKill()
          process.kill(process.pid, 'SIGKILL')
        }
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (isMcpMode) void runMcpMode()
else startApp()
