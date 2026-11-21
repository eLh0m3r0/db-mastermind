import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

/**
 * Files and folders the user handed to the app: picked in a native dialog, dropped on the window (the path is
 * resolved in the preload from the dropped File itself, see preload `pathForFile`), or given on the command line /
 * by the system (open-file). Paths that come from the renderer as text are read only when they are one of these:
 * a page that was made to misbehave must not get main to read ~/.ssh or ~/.aws through a model or project import.
 * Kept in main's data folder so a recent model opens again after a restart.
 */
const chosen = new Set<string>()
const LIMIT = 500
let store: string | undefined

export function keepChosenPathsIn(file: string): void {
  store = file
  chosen.clear()
  try {
    const list: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (Array.isArray(list)) for (const p of list.slice(-LIMIT)) if (typeof p === 'string') chosen.add(p)
  } catch {
    // None yet, or unreadable: dialogs and drops fill it again.
  }
}

export function rememberChosenPath(path: string): void {
  if (typeof path !== 'string' || !path || !isAbsolute(path)) return
  const full = resolve(path)
  chosen.delete(full)
  chosen.add(full)
  while (chosen.size > LIMIT) chosen.delete(chosen.values().next().value!)
  if (!store) return
  try {
    mkdirSync(dirname(store), { recursive: true })
    const tmp = `${store}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify([...chosen]), 'utf8')
    renameSync(tmp, store)
  } catch {
    // Not kept for the next start; this session still knows it.
  }
}

export const isChosenPath = (path: string) => typeof path === 'string' && chosen.has(resolve(path))

/** The path, when the user handed it to the app; otherwise an error (nothing is read). */
export function checkChosenPath(path: string): string {
  if (!isChosenPath(path)) throw new Error('Open the file through the app (a dialog, a drop on the window or the command line) first')
  return resolve(path)
}
