/// <reference path="./js-yaml.d.ts" />
import { load } from 'js-yaml'
import { parseConnectionString } from './connection-url.js'
import type { ImportedConnection } from './connection-imports.js'
import type { DriverId } from './types.js'

/**
 * Connections a project already describes: its `.env` files (a connection URL in any variable, or the DB_*, PG*,
 * MYSQL_*, POSTGRES_* sets), its docker-compose file (database services with a port published to this computer) and
 * its Prisma schema's datasource. Passwords are taken: the files are the user's own and hold them in plain text.
 * Pure functions: reading the files (one folder, top level only, 1 MB each) is the app's job.
 */

/** `KEY=value` lines: `export`, comments, single quotes (literal), double quotes (escapes), `${VAR}` and `${VAR:-default}` resolved within the file. */
export function parseDotenv(text: string, outer: Record<string, string> = {}): Record<string, string> {
  const vars: Record<string, string> = {}
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[=:]\s?(.*)$/.exec(lines[i]!)
    if (!m || /^\s*#/.test(lines[i]!)) continue
    const key = m[1]!
    let raw = m[2]!.trim()
    let value: string
    const quote = raw[0]
    if (quote === "'" || quote === '"' || quote === '`') {
      // A quoted value may go on over several lines.
      let body = raw.slice(1)
      while (!new RegExp(`(^|[^\\\\])${quote}\\s*(#.*)?$`).test(body) && i + 1 < lines.length) body += `\n${lines[++i]}`
      const end = body.search(new RegExp(`(?<!\\\\)${quote}\\s*(#.*)?$`))
      value = end === -1 ? body : body.slice(0, end)
      if (quote === '"') value = expand(value.replace(/\\([nrt"\\$])/g, (_, c: string) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c), vars, outer)
    } else {
      raw = raw.replace(/\s+#.*$/, '')
      value = expand(raw, vars, outer)
    }
    vars[key] = value
  }
  return vars
}

/** `${VAR}`, `${VAR:-default}`, `${VAR-default}` and `$VAR` from the variables read so far (then `outer`); `$$` is a `$`. */
export function expand(value: string, vars: Record<string, string>, outer: Record<string, string> = {}): string {
  const get = (name: string) => vars[name] ?? outer[name]
  return value.replace(/\$\$|\$\{([A-Za-z_]\w*)(?:(:?[-?])([^}]*))?\}|\$([A-Za-z_]\w*)/g, (whole, braced: string | undefined, op: string | undefined, fallback: string | undefined, bare: string | undefined) => {
    if (whole === '$$') return '$'
    const name = braced ?? bare!
    const v = get(name)
    if (op === ':-') return v ? v : expand(fallback ?? '', vars, outer)
    if (op === '-') return v !== undefined ? v : expand(fallback ?? '', vars, outer)
    return v ?? ''
  })
}

const URL_SCHEME = /^(postgres|postgresql|pg|mysql|mariadb|mssql|sqlserver|oracle|clickhouse|trino|cockroachdb|jdbc:[a-z]+)(\+[\w-]+)?:/i
const looksLikeUrl = (v: string) => URL_SCHEME.test(v.trim()) && /:\/\/|^jdbc:/i.test(v.trim())

/** A URL as people write them in .env files (`postgresql+asyncpg://`, `cockroachdb://`), as a connection. */
function fromUrl(value: string): ImportedConnection | undefined {
  const text = value.trim().replace(/^([a-z]+)\+[\w-]+:/i, '$1:').replace(/^cockroachdb:/i, 'postgresql:')
  try {
    const parsed = parseConnectionString(text)
    // A template (postgres://USER:PASSWORD@HOST:PORT/DB) parses as nothing useful: a port must be a number.
    if (parsed.port !== undefined && !Number.isFinite(parsed.port)) return undefined
    return { name: '', ...parsed }
  } catch {
    return undefined
  }
}

const SETS: { prefix: string; host: string; port: string[]; database: string[]; user: string[]; password: string[]; driver: (vars: Record<string, string>) => DriverId | undefined }[] = [
  {
    prefix: 'DB_HOST',
    host: 'DB_HOST',
    port: ['DB_PORT'],
    database: ['DB_DATABASE', 'DB_NAME'],
    user: ['DB_USERNAME', 'DB_USER'],
    password: ['DB_PASSWORD'],
    // Laravel's names for its drivers; without DB_CONNECTION the port says it.
    driver: (v) => (({ mysql: 'mysql', mariadb: 'mariadb', pgsql: 'postgres', postgres: 'postgres', postgresql: 'postgres', sqlsrv: 'mssql', sqlserver: 'mssql', sqlite: 'sqlite' }) as Record<string, DriverId>)[(v.DB_CONNECTION ?? '').toLowerCase()] ?? portDriver(v.DB_PORT),
  },
  { prefix: 'PGHOST', host: 'PGHOST', port: ['PGPORT'], database: ['PGDATABASE'], user: ['PGUSER'], password: ['PGPASSWORD'], driver: () => 'postgres' },
  { prefix: 'POSTGRES_HOST', host: 'POSTGRES_HOST', port: ['POSTGRES_PORT'], database: ['POSTGRES_DB', 'POSTGRES_DATABASE'], user: ['POSTGRES_USER'], password: ['POSTGRES_PASSWORD'], driver: () => 'postgres' },
  { prefix: 'MYSQL_HOST', host: 'MYSQL_HOST', port: ['MYSQL_PORT', 'MYSQL_TCP_PORT'], database: ['MYSQL_DATABASE', 'MYSQL_DB'], user: ['MYSQL_USER'], password: ['MYSQL_PASSWORD'], driver: () => 'mysql' },
]
const portDriver = (port: string | undefined): DriverId | undefined => (({ '5432': 'postgres', '3306': 'mysql', '1433': 'mssql' }) as Record<string, DriverId>)[port ?? '']

/** The connections of a `.env` file's variables, named after the variable with `label` (the project's folder). */
export function connectionsFromEnv(vars: Record<string, string>, label: string): ImportedConnection[] {
  const out: ImportedConnection[] = []
  for (const [key, value] of Object.entries(vars)) {
    if (!looksLikeUrl(value)) continue
    const c = fromUrl(value)
    if (c) out.push({ ...c, name: `${label} — ${key}` })
  }
  for (const set of SETS) {
    // The DB_* set may be SQLite: a file, no host.
    const sqlite = set.prefix === 'DB_HOST' && set.driver(vars) === 'sqlite'
    if (!vars[set.host] && !(sqlite && vars.DB_DATABASE)) continue
    const driver = set.driver(vars)
    if (!driver) continue
    const pick = (keys: string[]) => keys.map((k) => vars[k]).find((v) => v !== undefined && v !== '')
    if (sqlite) {
      out.push({ name: `${label} — DB_DATABASE`, driver: 'sqlite', filePath: vars.DB_DATABASE })
      continue
    }
    const port = Number(pick(set.port))
    out.push({ name: `${label} — ${set.prefix}`, driver, host: vars[set.host], port: Number.isFinite(port) && port > 0 ? port : undefined, database: pick(set.database), user: pick(set.user), password: pick(set.password) })
  }
  return out
}

interface Engine {
  driver: DriverId
  port: number
  user: (env: Record<string, string>) => string | undefined
  password: (env: Record<string, string>) => string | undefined
  database: (env: Record<string, string>) => string | undefined
  options?: Record<string, string | boolean>
}

const first = (env: Record<string, string>, ...keys: string[]) => keys.map((k) => env[k]).find((v) => v !== undefined && v !== '')
const POSTGRES: Engine = { driver: 'postgres', port: 5432, user: (e) => first(e, 'POSTGRES_USER') ?? 'postgres', password: (e) => first(e, 'POSTGRES_PASSWORD'), database: (e) => first(e, 'POSTGRES_DB') ?? first(e, 'POSTGRES_USER') ?? 'postgres' }
const MYSQL = (driver: DriverId): Engine => ({
  driver,
  port: 3306,
  // The application user when there is one, else root.
  user: (e) => first(e, 'MYSQL_USER', 'MARIADB_USER') ?? 'root',
  password: (e) => (first(e, 'MYSQL_USER', 'MARIADB_USER') ? first(e, 'MYSQL_PASSWORD', 'MARIADB_PASSWORD') : first(e, 'MYSQL_ROOT_PASSWORD', 'MARIADB_ROOT_PASSWORD')),
  database: (e) => first(e, 'MYSQL_DATABASE', 'MARIADB_DATABASE'),
})

/** Database images by name (the registry and tag aside), and how their environment names the login. */
const IMAGES: [RegExp, Engine][] = [
  [/^(library\/)?postgres$|^postgis\/postgis$|^timescale\/timescaledb(-ha|-postgis)?$|^pgvector\/pgvector$|^ankane\/pgvector$|^supabase\/postgres$/, POSTGRES],
  [/^bitnami\/postgresql$/, { driver: 'postgres', port: 5432, user: (e) => first(e, 'POSTGRESQL_USERNAME') ?? 'postgres', password: (e) => first(e, 'POSTGRESQL_PASSWORD', 'POSTGRESQL_POSTGRES_PASSWORD'), database: (e) => first(e, 'POSTGRESQL_DATABASE') ?? 'postgres' }],
  [/^(library\/)?mysql$|^mysql\/mysql-server$|^bitnami\/mysql$|^percona(\/percona-server)?$/, MYSQL('mysql')],
  [/^(library\/)?mariadb$|^bitnami\/mariadb$|^mariadb\/server$/, MYSQL('mariadb')],
  [/^mcr\.microsoft\.com\/(mssql\/server|azure-sql-edge)$|^microsoft\/mssql-server-linux$/, { driver: 'mssql', port: 1433, user: () => 'sa', password: (e) => first(e, 'MSSQL_SA_PASSWORD', 'SA_PASSWORD'), database: () => undefined, options: { trustServerCertificate: true } }],
  [/^(clickhouse\/clickhouse-server|yandex\/clickhouse-server|clickhouse)$/, { driver: 'clickhouse', port: 8123, user: (e) => first(e, 'CLICKHOUSE_USER') ?? 'default', password: (e) => first(e, 'CLICKHOUSE_PASSWORD'), database: (e) => first(e, 'CLICKHOUSE_DB') }],
  [/^cockroachdb\/cockroach$/, { driver: 'postgres', port: 26257, user: (e) => first(e, 'COCKROACH_USER') ?? 'root', password: (e) => first(e, 'COCKROACH_PASSWORD'), database: (e) => first(e, 'COCKROACH_DATABASE') ?? 'defaultdb' }],
  [/^gvenzl\/oracle-(free|xe)$|^container-registry\.oracle\.com\/database\/(free|express)$/, { driver: 'oracle', port: 1521, user: (e) => first(e, 'APP_USER') ?? 'system', password: (e) => (first(e, 'APP_USER') ? first(e, 'APP_USER_PASSWORD') : first(e, 'ORACLE_PASSWORD', 'ORACLE_PWD')), database: () => undefined }],
  [/^trinodb\/trino$/, { driver: 'trino', port: 8080, user: () => 'trino', password: () => undefined, database: () => undefined }],
]

/** The engine of a compose service's image: `postgres:16-alpine`, `docker.io/library/mysql:8`, `mcr.microsoft.com/mssql/server:2022-latest`. */
export function databaseImage(image: string): Engine | undefined {
  const name = image
    .trim()
    .replace(/@sha256:.*$/, '')
    .replace(/:[^/:]*$/, '')
    .replace(/^(docker\.io|index\.docker\.io|registry\.hub\.docker\.com)\//, '')
  return IMAGES.find(([re]) => re.test(name))?.[1]
}

export interface ComposeService {
  service: string
  driver: DriverId
  /** The port on this computer, when the service publishes the engine's one. */
  published?: number
  host: string
  connection?: ImportedConnection
}

/** The `environment` of a service as a map (compose writes it as a list or a map). */
function environmentOf(service: Record<string, unknown>, env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const e = service.environment
  if (Array.isArray(e)) {
    for (const item of e) {
      const s = String(item)
      const eq = s.indexOf('=')
      // `- KEY` alone takes the value from the environment compose runs in: here, the .env beside the file.
      if (eq === -1) {
        if (env[s.trim()] !== undefined) out[s.trim()] = env[s.trim()]!
      } else out[s.slice(0, eq).trim()] = expand(s.slice(eq + 1), {}, env)
    }
  } else if (e && typeof e === 'object') {
    for (const [k, v] of Object.entries(e as Record<string, unknown>)) {
      if (v === null || v === undefined) {
        if (env[k] !== undefined) out[k] = env[k]!
      } else out[k] = expand(String(v), {}, env)
    }
  }
  return out
}

/** Where a service's container port is published: `"54329:5432"`, `"127.0.0.1:5433:5432"`, `{ target: 5432, published: 5433 }`. */
function publishedPort(service: Record<string, unknown>, target: number, env: Record<string, string>): { port: number; host: string } | undefined {
  for (const p of Array.isArray(service.ports) ? service.ports : []) {
    if (p && typeof p === 'object') {
      const o = p as { target?: unknown; published?: unknown; host_ip?: unknown }
      if (Number(o.target) === target && o.published !== undefined) {
        const port = Number(expand(String(o.published), {}, env).split('-')[0])
        if (port > 0) return { port, host: hostOf(o.host_ip ? String(o.host_ip) : '') }
      }
      continue
    }
    const text = expand(String(p), {}, env).replace(/\/(tcp|udp)$/, '')
    // [host_ip:]published:target, the address possibly an IPv6 one in brackets.
    const m = /^(?:(\[[^\]]+\]|[\d.]+|[^:]*):)?(\d+)(?:-\d+)?:(\d+)(?:-\d+)?$/.exec(text)
    if (m && Number(m[3]) === target) return { port: Number(m[2]), host: hostOf(m[1] ?? '') }
  }
  return undefined
}
const hostOf = (ip: string) => (!ip || ip === '0.0.0.0' || ip === '[::]' || ip === '::' ? 'localhost' : ip.replace(/^\[|\]$/g, ''))

/**
 * The database services of a compose file. `env` is the `.env` beside the file (compose reads it for `${VAR}`);
 * services that don't publish the engine's port are listed without a connection (nothing on this computer reaches them).
 */
export function servicesFromCompose(yaml: string, env: Record<string, string>, label: string): ComposeService[] {
  let doc: { services?: Record<string, Record<string, unknown> | null> } | null
  try {
    // (`json`: a key given twice keeps its last value instead of failing the whole file.)
    doc = load(yaml, { json: true }) as typeof doc
  } catch (err) {
    throw new Error(`Not a readable compose file: ${String((err as Error).message).split('\n')[0]}`)
  }
  if (!doc || typeof doc !== 'object') return []
  const out: ComposeService[] = []
  for (const [name, service] of Object.entries(doc.services ?? {})) {
    if (!service || typeof service !== 'object' || typeof service.image !== 'string') continue
    const engine = databaseImage(expand(service.image, {}, env))
    if (!engine) continue
    const environment = environmentOf(service, env)
    // CockroachDB's container takes its SQL port from the command line too (--sql-addr=:26258): the default is assumed.
    const published = publishedPort(service, engine.port, env)
    const found: ComposeService = { service: name, driver: engine.driver, host: published?.host ?? 'localhost', ...(published ? { published: published.port } : {}) }
    if (published) {
      found.connection = {
        name: `${label} — ${name}`,
        driver: engine.driver,
        host: published.host,
        port: published.port,
        database: engine.database(environment),
        user: engine.user(environment),
        password: engine.password(environment),
        ...(engine.options ? { options: engine.options } : {}),
        // A container on this computer speaks plain text unless it is set up otherwise.
        ...(engine.driver === 'postgres' || engine.driver === 'mysql' || engine.driver === 'mariadb' ? { ssl: { mode: 'prefer' as const } } : {}),
        ...(engine.driver === 'oracle' ? { database: /free/.test(String(service.image)) ? 'FREEPDB1' : 'XEPDB1' } : {}),
      }
    }
    out.push(found)
  }
  return out
}

/** The datasource of a Prisma schema: its URL as written, or from the environment (`env("DATABASE_URL")`). */
export function connectionFromPrisma(schema: string, env: Record<string, string>, label: string): ImportedConnection | undefined {
  const block = /datasource\s+\w+\s*\{([^}]*)\}/.exec(schema.replace(/^\s*\/\/.*$/gm, ''))?.[1]
  if (!block) return undefined
  const url = /\burl\s*=\s*(?:env\(\s*"([^"]+)"\s*\)|"([^"]+)")/.exec(block)
  const value = url?.[1] ? env[url[1]] : url?.[2]
  if (!value || !looksLikeUrl(value)) return undefined
  const c = fromUrl(value)
  return c ? { ...c, name: `${label} — prisma ${url?.[1] ?? 'datasource'}` } : undefined
}

/** The same connection found in two files (a .env and the compose file it feeds) is offered once: the first name stays. */
export function uniqueConnections(list: ImportedConnection[]): ImportedConnection[] {
  const key = (c: ImportedConnection) => [c.driver, (c.host ?? '').toLowerCase().replace(/^127\.0\.0\.1$/, 'localhost'), c.port ?? '', c.database ?? '', c.user ?? '', c.filePath ?? ''].join('\u0000')
  const seen = new Map<string, ImportedConnection>()
  for (const c of list) {
    const k = key(c)
    const before = seen.get(k)
    if (!before) seen.set(k, c)
    // (A password one file has and the other not.)
    else if (!before.password && c.password) seen.set(k, { ...before, password: c.password })
  }
  return [...seen.values()]
}

/** Files of a project folder that describe connections (top level only; `prisma/schema.prisma` is Prisma's own place). */
export const PROJECT_ENV_FILE = /^\.env(\.[\w.-]+)?$/i
/** Templates hold placeholders, not the project's connections: read when chosen, skipped in a folder. */
export const ENV_TEMPLATE = /^\.env\.(example|sample|template|dist|defaults?)$/i
export const COMPOSE_FILE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i

/**
 * Connections of one project's files (`name` → text). `label` names the project (its folder). Hosts that are
 * compose service names (DB_HOST=db) become the port the service publishes on this computer.
 */
export function projectConnections(files: Record<string, string>, label: string, options: { folder?: boolean } = {}): ImportedConnection[] {
  const env: Record<string, string> = {}
  const envFiles = Object.keys(files).filter((n) => PROJECT_ENV_FILE.test(n) && !(options.folder && ENV_TEMPLATE.test(n)))
  // `.env` first: the others (.env.local, .env.development) are what a project layers over it.
  envFiles.sort((a, b) => (a === '.env' ? -1 : b === '.env' ? 1 : a.localeCompare(b)))
  const found: ImportedConnection[] = []
  for (const name of envFiles) {
    const vars = parseDotenv(files[name]!, env)
    if (name === '.env') Object.assign(env, vars)
    found.push(...connectionsFromEnv(vars, envFiles.length > 1 ? `${label} ${name}` : label))
  }
  const services: ComposeService[] = []
  for (const name of Object.keys(files).filter((n) => COMPOSE_FILE.test(n))) services.push(...servicesFromCompose(files[name]!, env, label))
  const prisma = files['prisma/schema.prisma'] ?? files['schema.prisma']
  const fromPrisma = prisma ? connectionFromPrisma(prisma, env, label) : undefined
  // A host named like a compose service is that service, as this computer reaches it.
  const reachable = [...found, ...(fromPrisma ? [fromPrisma] : [])].map((c) => {
    const service = services.find((s) => s.published && s.service === c.host)
    return service ? { ...c, host: service.host, port: service.published } : c
  })
  return uniqueConnections([...services.flatMap((s) => (s.connection ? [s.connection] : [])), ...reachable])
}
