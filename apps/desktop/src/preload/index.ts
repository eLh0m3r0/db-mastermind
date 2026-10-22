import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { API_CHANNEL, API_METHODS, type IpcResult, type MainEvents, type MastermindApi } from '../shared/api'

/** Error that keeps the database error code across the IPC boundary. */
class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    name?: string,
  ) {
    super(message)
    if (name) this.name = name
  }
}

// contextBridge copies plain objects only, so every method is listed explicitly.
const api = Object.fromEntries(
  API_METHODS.map((method) => [
    method,
    async (...args: unknown[]) => {
      const result = (await ipcRenderer.invoke(API_CHANNEL, method, args)) as IpcResult<unknown>
      if (result.ok) return result.value
      throw new ApiError(result.error.message, result.error.code, result.error.name)
    },
  ]),
) as unknown as MastermindApi

const bridge = {
  api,
  platform: process.platform,
  on<K extends keyof MainEvents>(channel: K, listener: (payload: MainEvents[K]) => void): () => void {
    const wrapped = (_e: unknown, payload: MainEvents[K]) => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  },
  /** Local path of a dropped file (File.path no longer exists in Electron). */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
  setTheme(theme: 'system' | 'light' | 'dark') {
    ipcRenderer.send('theme:set', theme)
  },
}

export type Bridge = typeof bridge

contextBridge.exposeInMainWorld('mastermind', bridge)
