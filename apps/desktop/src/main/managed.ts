import { app } from 'electron'
import { managedConfigPaths, readManagedConfig, type ManagedConfig } from './managed-config'
import type { ManagedInfo } from '@shared/api'

let loaded: { config: ManagedConfig; info: ManagedInfo } | null | undefined

/** The organization's managed configuration, read once per run (null when there is none). */
export function managed(): { config: ManagedConfig; info: ManagedInfo } | null {
  loaded ??= readManagedConfig(managedConfigPaths(app.getPath('exe'), process.platform, process.env))
  return loaded
}

/** Reads the managed configuration again on next use (the `--mcp` process, which outlives changes to it). */
export function reloadManaged(): void {
  loaded = undefined
}

export function managedConfig(): ManagedConfig | null {
  return managed()?.config ?? null
}

