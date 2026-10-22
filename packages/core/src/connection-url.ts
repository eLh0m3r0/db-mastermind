import type { ConnectionConfig, DriverId, SslMode } from './types.js'

export const DEFAULT_PORTS: Record<DriverId, number | undefined> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  mssql: 1433,
  sqlite: undefined,
  oracle: 1521,
  duckdb: undefined,
  clickhouse: 8123,
  bigquery: undefined,
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
  oracle: 'oracle',
  duckdb: 'duckdb',
  clickhouse: 'clickhouse',
  ch: 'clickhouse',
  bigquery: 'bigquery',
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

  if (/^oracle:thin:/i.test(text)) return parseOracleThin(text)
  if (/^sqlserver:\/\/[^/]*;/i.test(text) || /^sqlserver:\/\/[^/;]*$/i.test(text)) return parseJdbcSqlServer(text)
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) && /=/.test(text)) return parseAdoNet(text)

  const scheme = text.slice(0, text.indexOf(':')).toLowerCase()
  const driver = SCHEMES[scheme]
  if (!driver) throw new ConnectionUrlError(`Unsupported scheme "${scheme}"`)

  if (driver === 'sqlite' || driver === 'duckdb') {
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

/** Entries of a PostgreSQL password file (host:port:database:user:password, `*` wildcards, `\\:` escapes). */
export function parsePgpass(text: string): Omit<ConnectionConfig, 'id'>[] {
  const out: Omit<ConnectionConfig, 'id'>[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const fields = line.split(/(?<!\\):/).map((f) => f.replace(/\\([:\\])/g, '$1'))
    if (fields.length < 5) continue
    const [host, port, database, user] = fields as [string, string, string, string]
    // Wildcard hosts or users can't become a connection; a wildcard database means the server's default.
    if (host === '*' || user === '*') continue
    out.push({
      name: `${host}${database !== '*' ? `/${database}` : ''}`,
      driver: 'postgres',
      host,
      port: port !== '*' ? Number(port) : 5432,
      database: database !== '*' ? database : undefined,
      user,
      password: fields.slice(4).join(':'),
    })
  }
  return out
}

/** `oracle:thin:@host:1521/service`, `@//host:1521/service`, `@host:1521:SID` or `@(DESCRIPTION=…)`. */
function parseOracleThin(text: string): Parsed {
  const target = text.replace(/^oracle:thin:/i, '')
  const userPart = /^([^/@]+)(?:\/([^@]*))?@/.exec(target)
  const rest = target.slice(target.indexOf('@') + 1)
  const out: Parsed = { driver: 'oracle', user: userPart?.[1], password: userPart?.[2] || undefined }
  if (rest.startsWith('(')) {
    const pick = (key: string) => new RegExp(`\\(\\s*${key}\\s*=\\s*([^)\\s]+)`, 'i').exec(rest)?.[1]
    return { ...out, host: pick('HOST'), port: Number(pick('PORT')) || undefined, database: pick('SERVICE_NAME') ?? pick('SID') }
  }
  const m = /^(?:\/\/)?([^:/]+)(?::(\d+))?(?:[/:]([^?]+))?/.exec(rest)
  if (!m) throw new ConnectionUrlError('Invalid Oracle JDBC URL')
  return { ...out, host: m[1], port: m[2] ? Number(m[2]) : undefined, database: m[3] }
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const xmlText = (s: string) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (XML_ENTITIES[e] ?? m)))

/**
 * Connections from JetBrains DataGrip / IntelliJ `dataSources.xml` (JDBC URLs) and the matching
 * `dataSources.local.xml` (user names). Passwords live in the OS keychain and are not imported.
 */
export function parseDataGrip(xml: string, localXml = ''): Omit<ConnectionConfig, 'id'>[] {
  const users = new Map<string, string>()
  for (const m of localXml.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g)) {
    const uuid = /\buuid="([^"]+)"/.exec(m[1]!)?.[1]
    const user = /<user-name>([\s\S]*?)<\/user-name>/.exec(m[2]!)?.[1]
    if (uuid && user) users.set(uuid, xmlText(user.trim()))
  }
  const out: Omit<ConnectionConfig, 'id'>[] = []
  for (const m of xml.matchAll(/<data-source\b([^>]*)>([\s\S]*?)<\/data-source>/g)) {
    const name = xmlText(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? '')
    const uuid = /\buuid="([^"]+)"/.exec(m[1]!)?.[1]
    const url = /<jdbc-url>([\s\S]*?)<\/jdbc-url>/.exec(m[2]!)?.[1]
    if (!url) continue
    try {
      const parsed = parseConnectionString(xmlText(url.trim()))
      out.push({ ...parsed, name: name || parsed.database || parsed.host || 'DataGrip', user: parsed.user ?? (uuid ? users.get(uuid) : undefined) })
    } catch {
      // Unsupported database (Redis, ClickHouse…): skipped.
    }
  }
  return out
}
