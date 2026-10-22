import { watch, type FSWatcher } from 'node:fs'
import { BrowserWindow } from 'electron'
import { flushConnections, loadConnections } from './connections'
import { managedConfig } from './managed'
import { getSettings, updateSettings } from './settings'
import type { TeamStatus } from '@shared/api'
import { readTeamFolder, type TeamContents } from './team-folder'

let cache: { dir: string; contents: TeamContents } | undefined

/** The configured team folder, if any. */
export function teamDir(): string | undefined {
  return getSettings().teamFolder || undefined
}

/** What the team folder shares right now (read once, refreshed when its files change). */
export function team(): TeamContents | null {
  const dir = teamDir()
  if (!dir) return null
  if (cache?.dir !== dir) {
    try {
      cache = { dir, contents: readTeamFolder(dir) }
    } catch (err) {
      cache = { dir, contents: { connections: [], queries: [], error: (err as Error).message } }
    }
  }
  return cache.contents
}

export function invalidateTeam(): void {
  cache = undefined
}

export function teamStatus(): TeamStatus {
  const contents = team()
  return { folder: teamDir(), locked: !!managedConfig()?.teamFolder, connections: contents?.connections.length ?? 0, queries: contents?.queries.length ?? 0, error: contents?.error }
}

/** Re-reads the team folder and merges its connections again (after a change or a new folder). */
export async function reloadTeam(): Promise<void> {
  invalidateTeam()
  await flushConnections()
  await loadConnections()
}

export async function setTeamFolder(folder: string | null): Promise<TeamStatus> {
  if (managedConfig()?.teamFolder) throw new Error('The team folder is set by your organization')
  updateSettings({ teamFolder: folder ?? undefined })
  await reloadTeam()
  watchTeamFolder()
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('team:changed', undefined)
  return teamStatus()
}

let watcher: FSWatcher | undefined
let timer: NodeJS.Timeout | undefined

/** Watches the team folder; colleagues' changes reload connections and saved queries in every window. */
export function watchTeamFolder(onChange: () => Promise<void> = reloadTeam): void {
  watcher?.close()
  watcher = undefined
  const dir = teamDir()
  if (!dir) return
  try {
    watcher = watch(dir, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        invalidateTeam()
        void onChange().then(() => {
          for (const w of BrowserWindow.getAllWindows()) w.webContents.send('team:changed', undefined)
        })
      }, 500)
    })
    watcher.on('error', () => undefined)
  } catch {
    // Unreachable share: the contents load again on the next start or settings change.
  }
}
