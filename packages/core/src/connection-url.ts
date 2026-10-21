import type { ConnectionConfig, DriverId, SslMode } from './types.js'

export const DEFAULT_PORTS: Record<DriverId, number | undefined> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mssql: 1433,
  sqlite: undefined,
}

const SCHEMES: Record<string, DriverId> = {
  postgres: 'postgres',
  postgresql: 'postgres',
  pg: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  mssql: 'mssql',
  sqlserver: 'mssql',
  sqlite: 'sqlite',
  file: 'sqlite',
}

export class ConnectionUrlError extends Error {
  override name = 'ConnectionUrlError'
}

type Parsed = Omit<ConnectionConfig, 'id' | 'name'>

/**
 * Parses connection URLs (`postgres://u:p@h:5432/db?sslmode=require`), JDBC URLs
 * (`jdbc:sqlserver://h:1433;databaseName=db;user=u`) and ADO.NET connection strings
 * (`Server=h,1433;Database=db;User Id=u;Password=p`).
 */
export function parseConnectionString(input: string): Parsed {
  let text = input.trim()
  if (!text) throw new ConnectionUrlError('Empty connection string')
  if (text.toLowerCase().startsWith('jdbc:')) text = text.slice(5)

  if (/^sqlserver:\/\/[^/]*;/i.test(text) || /^sqlserver:\/\/[^/;]*$/i.test(text)) return parseJdbcSqlServer(text)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /=/.test(text)) return parseAdoNet(text)

  const scheme = text.slice(0, text.indexOf(':')).toLowerCase()
  const driver = SCHEMES[scheme]
  if (!driver) throw new ConnectionUrlError(`Unsupported scheme "${scheme}"`)

  if (driver === 'sqlite') {
    const path = decodeURIComponent(text.replace(/^[a-z]+:(\/\/)?/i, ''))
    return { driver, filePath: path }
  }

  let url: URL
  try {
    url = new URL(text.replace(/^[a-z0-9+.-]+:/i, 'http:'))
  } catch {
    throw new ConnectionUrlError('Invalid connection URL')
  }
  const params = url.searchParams
  const config: Parsed = {
    driver,
    host: decodeURIComponent(url.hostname).replace(/^\[|\]$/g, '') || 'localhost',
    port: url.port ? Number(url.port) : DEFAULT_PORTS[driver],
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || params.get('database') || params.get('dbname') || undefined,
    user: url.username ? decodeURIComponent(url.username) : (params.get('user') ?? undefined),
    password: url.password ? decodeURIComponent(url.password) : (params.get('password') ?? undefined),
  }
  const sslmode = (params.get('sslmode') ?? params.get('ssl-mode') ?? '').toLowerCase()
  const sslFlag = (params.get('ssl') ?? params.get('encrypt') ?? '').toLowerCase()
  const modeMap: Record<string, SslMode> = {
    disable: 'disable',
    disabled: 'disable',
    allow: 'prefer',
    prefer: 'prefer',
    preferred: 'prefer',
    require: 'require',
    required: 'require',
    'verify-ca': 'verify-ca',
    verify_ca: 'verify-ca',
    'verify-full': 'verify-full',
    verify_identity: 'verify-full',
  }
  if (modeMap[sslmode]) config.ssl = { mode: modeMap[sslmode] }
  else if (sslFlag === 'true' || sslFlag === '1') config.ssl = { mode: 'require' }
  else if (sslFlag === 'false' || sslFlag === '0') config.ssl = { mode: 'disable' }
  return config
}

function parseKeyValues(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const part of text.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    out.set(part.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ' '), part.slice(eq + 1).trim())
  }
  return out
}

function parseJdbcSqlServer(text: string): Parsed {
  const rest = text.replace(/^sqlserver:\/\//i, '')
  const [hostPart = '', ...props] = rest.split(';')
  const kv = parseKeyValues(props.join(';'))
  const [hostAndInstance = '', port] = hostPart.split(':')
  const [host, instanceName] = hostAndInstance.split('\\')
  const options: Record<string, string | boolean> = {}
  if (instanceName) options.instanceName = instanceName
  if (kv.get('trustservercertificate') === 'true') options.trustServerCertificate = true
  if (kv.get('domain')) options.domain = kv.get('domain')!
  return {
    driver: 'mssql',
    host: host || 'localhost',
    port: port ? Number(port) : instanceName ? undefined : 1433,
    database: kv.get('databasename') ?? kv.get('database'),
    user: kv.get('user') ?? kv.get('username'),
    password: kv.get('password'),
    ssl: kv.get('encrypt') === 'false' ? { mode: 'disable' } : undefined,
    options: Object.keys(options).length ? options : undefined,
  }
}

function parseAdoNet(text: string): Parsed {
  const kv = parseKeyValues(text)
  const server = (kv.get('server') ?? kv.get('data source') ?? kv.get('address') ?? 'localhost').replace(/^tcp:/i, '')
  const [hostAndInstance = 'localhost', port] = server.split(',')
  const [host, instanceName] = hostAndInstance.split('\\')
  const options: Record<string, string | boolean> = {}
  if (instanceName) options.instanceName = instanceName
  if (kv.get('trustservercertificate')?.toLowerCase() === 'true') options.trustServerCertificate = true
  const encrypt = kv.get('encrypt')?.toLowerCase()
  return {
    driver: 'mssql',
    host: host === '.' || host === '(local)' ? 'localhost' : host,
    port: port ? Number(port) : instanceName ? undefined : 1433,
    database: kv.get('database') ?? kv.get('initial catalog'),
    user: kv.get('user id') ?? kv.get('uid') ?? kv.get('user'),
    password: kv.get('password') ?? kv.get('pwd'),
    ssl: encrypt === 'false' || encrypt === 'no' ? { mode: 'disable' } : undefined,
    options: Object.keys(options).length ? options : undefined,
  }
}
