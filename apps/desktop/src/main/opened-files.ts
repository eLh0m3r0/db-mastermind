import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** Files the app opens when they are handed to it: models, and data files that are queried with SQL. */
const OPENABLE = /\.(dbml|dez|dezproj|csv|tsv|parquet|json|jsonl|ndjson|xlsx|sqlite|sqlite3|db3|duckdb)$/i

let pending: string[] = []
let deliver: ((path: string) => void) | undefined

/** File paths among command-line arguments (flags, the app's own path and anything that is not a file are skipped). */
export function filesFromArgs(args: string[], cwd = process.cwd()): string[] {
  return args
    .filter((a) => !a.startsWith('-') && OPENABLE.test(a))
    .map((a) => resolve(cwd, a))
    .filter((a) => existsSync(a))
}

/** A file to open: sent to the window when it is listening, kept for it otherwise. */
export function openFileInApp(path: string): void {
  if (!OPENABLE.test(path)) return
  if (deliver) deliver(path)
  else pending.push(path)
}

/** The window asks for the files that arrived before it was ready; later ones are pushed to it. */
export function takeOpenedFiles(): string[] {
  const out = pending
  pending = []
  return out
}

export function deliverOpenedFilesTo(send: ((path: string) => void) | undefined): void {
  deliver = send
}
