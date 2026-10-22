import { app } from 'electron'
import { managedConfigPaths, readManagedConfig, type ManagedConfig } from './managed-config'
import type { ManagedInfo } from '@shared/api'

let loaded: { config: ManagedConfig; info: ManagedInfo } | null | undefined

/** The organization's managed configuration, read once per run (null when there is none). */
export function managed(): { config: ManagedConfig; info: ManagedInfo } | null {
  loaded ??= readManagedConfig(managedConfigPaths(app.getPath('exe'), process.platform, process.env))
  return loaded
}

export function managedConfig(): ManagedConfig | null {
  return managed()?.config ?? null
}

/** Throws when the organization turned AI off. */
export function assertAiAllowed(): void {
  if (managedConfig()?.policies?.allowAi === false) throw new Error('AI is turned off by your organization (managed configuration)')
}
