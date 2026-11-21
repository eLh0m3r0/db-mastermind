import type { DriverId, SslMode } from './types.js'

/**
 * Cloud services that run a database engine the app already speaks, recognised by their host names. Only services
 * that run the real engine are named; compatible reimplementations are not claimed until tested.
 */
export interface CloudService {
  /** The service's name as it calls itself: "Supabase", "Amazon Aurora". */
  name: string
  /** Every one of them takes connections over TLS only, or should. */
  tls: SslMode
  /** One sentence where something about the service is certain and matters for connecting. */
  note?: string
}

const SERVICES: { pattern: RegExp; name: string; drivers: DriverId[] }[] = [
  { pattern: /\.supabase\.(co|com)$/i, name: 'Supabase', drivers: ['postgres'] },
  { pattern: /\.neon\.tech$/i, name: 'Neon', drivers: ['postgres'] },
  { pattern: /\.tsdb\.cloud\.timescale\.com$/i, name: 'Timescale', drivers: ['postgres'] },
  // Aurora's endpoints are a cluster's (cluster-…, cluster-ro-…); the others are RDS instances or proxies.
  { pattern: /\.cluster-(ro-)?[a-z0-9]+\.[a-z0-9-]+\.rds\.amazonaws\.com(\.cn)?$/i, name: 'Amazon Aurora', drivers: ['postgres', 'mysql', 'mariadb'] },
  { pattern: /\.rds\.amazonaws\.com(\.cn)?$/i, name: 'Amazon RDS', drivers: ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle'] },
  { pattern: /\.postgres\.database\.azure\.com$/i, name: 'Azure Database for PostgreSQL', drivers: ['postgres'] },
  { pattern: /\.(mysql|mariadb)\.database\.azure\.com$/i, name: 'Azure Database for MySQL', drivers: ['mysql', 'mariadb'] },
  { pattern: /\.database\.windows\.net$/i, name: 'Azure SQL', drivers: ['mssql'] },
  { pattern: /\.sql\.goog$/i, name: 'Google Cloud SQL', drivers: ['postgres', 'mysql', 'mssql'] },
]

export const SUPABASE_POOLER =
  "Port 6543 is Supabase's transaction pooler: session settings (default schema, statement timeout, read-only) and transactions across statements don't carry over. Port 5432 keeps the session."

/** The service a host belongs to, when its name says so (and the engine fits the service). */
export function detectService(host: string | undefined, driver?: DriverId, port?: number): CloudService | undefined {
  const h = (host ?? '').trim().replace(/\.$/, '')
  if (!h) return undefined
  const found = SERVICES.find((s) => s.pattern.test(h) && (!driver || s.drivers.includes(driver)))
  if (!found) return undefined
  const service: CloudService = { name: found.name, tls: 'require' }
  // Supabase's transaction pooler: one statement's server connection is not the next one's (PgBouncer in transaction
  // mode), so nothing set for the session carries over.
  if (found.name === 'Supabase' && port === 6543) service.note = SUPABASE_POOLER
  return service
}
