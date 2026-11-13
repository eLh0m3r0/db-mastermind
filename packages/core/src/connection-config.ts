import type { ConnectionConfig } from './types.js'

/**
 * What an open connection was made with. Anything else (name, color, AI permissions, manual commit…) is read as
 * the connection is used, so changing it needs no new connection, and open transactions stay open.
 */
const CONNECTION_KEYS = ['driver', 'host', 'port', 'database', 'user', 'password', 'filePath', 'ssl', 'ssh', 'options', 'readOnly'] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '')

export function needsReconnect(before: ConnectionConfig, after: ConnectionConfig): boolean {
  return CONNECTION_KEYS.some((key) => !same(before[key], after[key]))
}

/** Databases with transactions an editor tab can hold open (the others commit every statement). */
export function supportsManualCommit(driver: ConnectionConfig['driver']): boolean {
  return !['clickhouse', 'bigquery', 'trino'].includes(driver)
}
