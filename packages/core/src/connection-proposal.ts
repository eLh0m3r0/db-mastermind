import { parseConnectionString } from './connection-url.js'
import { isFileDriver, type ConnectionConfig, type DriverId } from './types.js'

const DRIVERS: DriverId[] = ['postgres', 'mssql', 'mysql', 'mariadb', 'sqlite', 'oracle', 'duckdb', 'clickhouse', 'bigquery', 'trino']

/**
 * A connection an agent asks the user to add (MCP `propose_connection`). Never a password, a key or SSH settings:
 * the user reviews it in the connection form, types the password there and saves it, or dismisses it.
 */
export interface ConnectionProposal {
  name: string
  driver: DriverId
  host?: string
  port?: number
  database?: string
  user?: string
  filePath?: string
  /** The agent that proposed it (the MCP client's name), for the notice. */
  proposedBy?: string
  proposedAt: string
}

const text = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' && typeof v !== 'number') throw new Error('Expected text')
  const s = String(v).trim()
  if (s.length > max) throw new Error(`Too long (max ${max} characters)`)
  // No control characters: the values end up in the UI and in connection settings.
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error('Control characters are not allowed')
  return s || undefined
}

/**
 * Validates what an agent sent: a connection URL (its password is dropped) or driver / host / port / database / user.
 * Throws with a message the agent can act on.
 */
export function connectionProposal(input: Record<string, unknown>, proposedBy?: string, now = new Date()): ConnectionProposal {
  const url = text(input.url, 2000)
  const fromUrl: Partial<ConnectionConfig> = url ? parseConnectionString(url) : {}
  const driver = (text(input.driver, 20) ?? fromUrl.driver) as DriverId | undefined
  if (!driver || !DRIVERS.includes(driver)) throw new Error(`driver must be one of ${DRIVERS.join(', ')} (or give a connection url)`)
  const portValue = input.port ?? fromUrl.port
  const port = portValue === undefined || portValue === null || portValue === '' ? undefined : Number(portValue)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new Error('port must be a number from 1 to 65535')
  const proposal: ConnectionProposal = {
    name: text(input.name, 100) ?? '',
    driver,
    host: text(input.host, 255) ?? fromUrl.host,
    port,
    database: text(input.database, 255) ?? fromUrl.database,
    user: text(input.user, 255) ?? fromUrl.user,
    filePath: text(input.filePath ?? input.file, 1000) ?? fromUrl.filePath,
    proposedBy: text(proposedBy, 100),
    proposedAt: now.toISOString(),
  }
  if (isFileDriver(driver) ? !proposal.filePath : !proposal.host && driver !== 'bigquery') throw new Error(isFileDriver(driver) ? 'filePath is required for this database' : 'host is required')
  if (!proposal.name) proposal.name = isFileDriver(driver) ? (proposal.filePath!.split(/[\\/]/).pop() ?? driver) : `${proposal.host ?? driver}${proposal.database ? `/${proposal.database}` : ''}`
  return Object.fromEntries(Object.entries(proposal).filter(([, v]) => v !== undefined)) as unknown as ConnectionProposal
}

/** The connection form's starting point for a proposal: read-only until the user decides otherwise. */
export function proposalDraft(p: ConnectionProposal): Partial<ConnectionConfig> {
  return { name: p.name, driver: p.driver, host: p.host, port: p.port, database: p.database, user: p.user, filePath: p.filePath, readOnly: true }
}
