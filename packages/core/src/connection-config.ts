import type { ConnectionConfig } from './types.js'

/**
 * What an open connection was made with. Anything else (name, color, AI permissions, manual commit…) is read as
 * the connection is used, so changing it needs no new connection, and open transactions stay open.
 */
const CONNECTION_KEYS = ['driver', 'host', 'port', 'database', 'user', 'password', 'passwordCommand', 'filePath', 'ssl', 'ssh', 'options', 'readOnly'] as const

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? '') === JSON.stringify(b ?? '')

export function needsReconnect(before: ConnectionConfig, after: ConnectionConfig): boolean {
  return CONNECTION_KEYS.some((key) => !same(before[key], after[key]))
}

/** Databases with transactions an editor tab can hold open (the others commit every statement). */
export function supportsManualCommit(driver: ConnectionConfig['driver']): boolean {
  return !['clickhouse', 'bigquery', 'trino'].includes(driver)
}

/** Servers with several databases behind one login, where another database is just another connection. */
export function supportsOtherDatabases(driver: ConnectionConfig['driver']): boolean {
  return ['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse'].includes(driver)
}

/** The same server and login (what `database` aside makes a connection): a database's connection is found by it. */
export function sameServer(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const key = (c: ConnectionConfig) =>
    JSON.stringify([c.driver, c.host ?? '', c.port ?? '', c.user ?? '', c.ssh?.host ?? '', c.ssh?.port ?? '', c.ssh?.user ?? '', c.options?.instanceName ?? '', c.options?.domain ?? ''])
  return key(a) === key(b)
}
