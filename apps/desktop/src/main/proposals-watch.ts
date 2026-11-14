import { watch, type FSWatcher } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { BrowserWindow } from 'electron'
import { PROPOSALS_FOLDER } from './connection-proposals'
import { dataPath } from './storage'

let watcher: FSWatcher | undefined
let timer: ReturnType<typeof setTimeout> | undefined

export const proposalsDir = () => dataPath(PROPOSALS_FOLDER)

/** Tells the windows when an agent proposed a connection (the MCP server may be another process). */
export function notifyProposals(): void {
  clearTimeout(timer)
  timer = setTimeout(() => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('connection:proposals', undefined)
  }, 150)
}

export async function watchProposals(): Promise<void> {
  if (watcher) return
  await mkdir(proposalsDir(), { recursive: true }).catch(() => {})
  try {
    watcher = watch(proposalsDir(), () => notifyProposals())
    watcher.on('error', () => {
      watcher?.close()
      watcher = undefined
    })
  } catch {
    // Without a watcher the proposals still show on the next start.
  }
}
