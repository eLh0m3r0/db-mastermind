import { parseConnectionString } from './connection-url.js'
import type { ConnectionConfig, DriverId } from './types.js'

/**
 * Connections from other database tools' own files. Each parser is pure (text in, connections out) so it can be
 * tested without the tools installed; finding the files is the app's job. Passwords are only taken when the tool
 * stores them in plain text; otherwise the user enters them on first connect.
 */
export type ImportedConnection = Omit<ConnectionConfig, 'id'>

const xmlText = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[e] ?? m,
  )
const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}
const str = (v: unknown) => (v === null || v === undefined || String(v).trim() === '' ? undefined : String(v))

/** JSON with // and /* comments and trailing commas (VS Code / Azure Data Studio settings). */
export function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') out += text[++i] ?? ''
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i === -1) break
      i++
    } else out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/** pgAdmin 4 "Import/Export Servers" file (servers.json). */
export function parsePgAdminServersJson(text: string): ImportedConnection[] {
  const data = JSON.parse(text) as { Servers?: Record<string, Record<string, unknown>> }
  return Object.values(data.Servers ?? {}).map((s) => {
    const params = (s.ConnectionParameters ?? {}) as Record<string, unknown>
    const sslmode = str(params.sslmode ?? s.SSLMode)
    return {
      name: str(s.Name) ?? str(s.Host) ?? 'pgAdmin server',
      driver: 'postgres' as const,
      host: str(s.Host ?? s.HostAddr),
      port: num(s.Port),
      database: str(s.MaintenanceDB),
      user: str(s.Username),
      group: str(s.Group),
      ssl: sslmode && sslmode !== 'disable' && sslmode !== 'allow' && sslmode !== 'prefer' ? { mode: sslmode === 'require' ? 'require' : sslmode === 'verify-ca' ? 'verify-ca' : 'verify-full' } : undefined,
      ssh: s.UseSSHTunnel ? { enabled: true, authMethod: 'password' as const, host: str(s.TunnelHost) ?? '', port: num(s.TunnelPort), user: str(s.TunnelUsername) ?? '' } : undefined,
    } as ImportedConnection
  })
}

/** Rows of pgAdmin 4's own `server` table (pgadmin4.db), read by the app. */
export function pgAdminServerRows(rows: Record<string, unknown>[]): ImportedConnection[] {
  return rows.map((r) => {
    let params: Record<string, unknown> = {}
    try {
      params = typeof r.connection_params === 'string' ? (JSON.parse(r.connection_params) as Record<string, unknown>) : {}
    } catch {
      // Older pgAdmin: SSL settings are separate columns.
    }
    const sslmode = str(params.sslmode ?? r.ssl_mode)
    return {
      name: str(r.name) ?? str(r.host) ?? 'pgAdmin server',
      driver: 'postgres',
      host: str(r.host ?? r.hostaddr),
      port: num(r.port),
      database: str(r.maintenance_db),
      user: str(r.username),
      ssl: sslmode && ['require', 'verify-ca', 'verify-full'].includes(sslmode) ? { mode: sslmode as 'require' } : undefined,
      ssh: r.use_ssh_tunnel ? { enabled: true, authMethod: 'password' as const, host: str(r.tunnel_host) ?? '', port: num(r.tunnel_port), user: str(r.tunnel_username) ?? '' } : undefined,
    } as ImportedConnection
  })
}

/** MySQL Workbench connections.xml (GRT object format). */
export function parseMySqlWorkbench(xml: string): ImportedConnection[] {
  const out: ImportedConnection[] = []
  for (const m of xml.matchAll(/<value[^>]*struct-name="db\.mgmt\.Connection"[^>]*>([\s\S]*?)<\/value>\s*(?=<value[^>]*struct-name="db\.mgmt\.Connection"|<\/value>\s*<\/data>|$)/g)) {
    const body = m[1]!
    const get = (key: string) => {
      const v = new RegExp(`<(?:value|link)[^>]*key="${key}"[^>]*>([^<]*)</(?:value|link)>`).exec(body)?.[1]
      return v === undefined ? undefined : xmlText(v)
    }
    const name = get('name')
    if (!name) continue
    const driver = /MariaDB/i.test(get('driver') ?? '') ? 'mariadb' : 'mysql'
    const sshHost = get('sshHost')
    out.push({
      name,
      driver,
      host: get('hostName') || 'localhost',
      port: num(get('port')),
      user: get('userName'),
      database: get('schema') || undefined,
      ssh: sshHost ? { enabled: true, authMethod: 'password' as const, host: sshHost.split(':')[0]!, port: num(sshHost.split(':')[1]), user: get('sshUserName') ?? '' } : undefined,
    })
  }
  return out
}

/** HeidiSQL network types (from its source): which database each saved session talks to. */
function heidiDriver(netType: number): DriverId | null {
  if ([0, 1, 2, 11, 16].includes(netType)) return 'mysql'
  if (netType >= 3 && netType <= 7) return 'mssql'
  if (netType === 8 || netType === 9) return 'postgres'
  if (netType === 10) return 'sqlite'
  return null
}

/** HeidiSQL sessions as name → value map (from the registry or portable_settings.txt). */
export function heidiSessions(sessions: Record<string, Record<string, string>>): ImportedConnection[] {
  const out: ImportedConnection[] = []
  for (const [name, v] of Object.entries(sessions)) {
    const driver = heidiDriver(Number(v.NetType ?? 0))
    if (!driver) continue
    if (driver === 'sqlite') {
      out.push({ name, driver, filePath: v.Hostname ?? v.Host })
      continue
    }
    out.push({
      name: name.split('\\').pop() ?? name,
      driver,
      host: v.Hostname ?? v.Host,
      port: num(v.Port),
      user: v.User || undefined,
      database: (v.Databases ?? '').split(';').filter(Boolean)[0],
      group: name.includes('\\') ? name.slice(0, name.lastIndexOf('\\')) : undefined,
      options: driver === 'mssql' && v.WindowsAuth === '1' ? { authentication: 'windows' } : undefined,
    })
  }
  return out
}

/** HeidiSQL portable_settings.txt: `Servers\Name\Key<|||>type<|||>value` lines. */
export function parseHeidiPortable(text: string): ImportedConnection[] {
  const sessions: Record<string, Record<string, string>> = {}
  for (const line of text.split(/\r?\n/)) {
    const [path, , value] = line.split('<|||>')
    const m = /^Servers\\(.+)\\([^\\]+)$/.exec(path ?? '')
    if (!m || value === undefined) continue
    ;(sessions[m[1]!] ??= {})[m[2]!] = value
  }
  return heidiSessions(sessions)
}

/** Output of `reg query HKCU\Software\HeidiSQL\Servers /s` (also Navicat's server keys). */
export function parseRegQuery(text: string, root: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  let current: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    if (/^HKEY_/i.test(raw)) {
      const idx = raw.toLowerCase().indexOf(root.toLowerCase())
      current = idx >= 0 ? raw.slice(idx + root.length).replace(/^\\/, '') : undefined
      if (current === '') current = undefined
      continue
    }
    const m = /^\s+(\S[^\t]*?)\s+REG_(\w+)\s+(.*)$/.exec(raw)
    if (!m || !current) continue
    const value = m[2] === 'DWORD' ? String(parseInt(m[3]!, 16)) : m[3]!
    ;(out[current] ??= {})[m[1]!] = value
  }
  return out
}

/** Navicat sessions from the registry (per product: Navicat = MySQL, NavicatPG, NavicatMSSQL, NavicatOra). */
export function navicatSessions(sessions: Record<string, Record<string, string>>, driver: DriverId): ImportedConnection[] {
  return Object.entries(sessions)
    .filter(([name]) => !name.includes('\\'))
    .map(([name, v]) => ({
      name,
      driver,
      host: v.Host,
      port: num(v.Port),
      user: v.UserName || v.Username || undefined,
      database: v.InitialDatabase || v.Database || undefined,
    }))
}

const ADS_PROVIDERS: Record<string, DriverId> = { MSSQL: 'mssql', PGSQL: 'postgres', MySQL: 'mysql' }

/** Azure Data Studio settings.json (`datasource.connections`). */
export function parseAzureDataStudio(text: string): ImportedConnection[] {
  const settings = parseJsonc(text) as Record<string, unknown>
  const groups = new Map(((settings['datasource.connectionGroups'] as { id: string; name: string }[] | undefined) ?? []).map((g) => [g.id, g.name]))
  const list = (settings['datasource.connections'] as { options?: Record<string, unknown>; providerName?: string; groupId?: string }[] | undefined) ?? []
  return list.flatMap((c) => {
    const driver = ADS_PROVIDERS[c.providerName ?? 'MSSQL']
    const o = c.options ?? {}
    if (!driver) return []
    const [host, port] = String(o.server ?? '').split(',')
    return [
      {
        name: str(o.connectionName) ?? `${host}${o.database ? `/${o.database}` : ''}`,
        driver,
        host: host || undefined,
        port: num(port ?? o.port),
        database: str(o.database),
        user: o.authenticationType === 'Integrated' ? undefined : str(o.user),
        group: c.groupId ? groups.get(c.groupId) : undefined,
        options: driver === 'mssql' && o.authenticationType === 'Integrated' ? { authentication: 'windows' } : undefined,
      } as ImportedConnection,
    ]
  })
}

const SQLTOOLS_DRIVERS: Record<string, DriverId> = { PostgreSQL: 'postgres', MySQL: 'mysql', MariaDB: 'mariadb', MSSQL: 'mssql', SQLite: 'sqlite', OracleDB: 'oracle' }

/** VS Code SQLTools extension (`sqltools.connections` in settings.json). */
export function parseSqlTools(text: string): ImportedConnection[] {
  const settings = parseJsonc(text) as Record<string, unknown>
  const list = (settings['sqltools.connections'] as Record<string, unknown>[] | undefined) ?? []
  return list.flatMap((c) => {
    const driver = SQLTOOLS_DRIVERS[String(c.driver)]
    if (!driver) return []
    if (driver === 'sqlite') return [{ name: str(c.name) ?? 'SQLite', driver, filePath: str(c.database) }]
    return [
      {
        name: str(c.name) ?? str(c.server) ?? 'SQLTools',
        driver,
        host: str(c.server),
        port: num(c.port),
        database: str(c.database),
        user: str(c.username),
        password: c.askForPassword ? undefined : str(c.password),
        group: str(c.group),
      } as ImportedConnection,
    ]
  })
}

/** SQL Server Management Studio registered servers (RegSrvr.xml). */
export function parseSsmsRegisteredServers(xml: string): ImportedConnection[] {
  const out: ImportedConnection[] = []
  for (const m of xml.matchAll(/<RegisteredServers:RegisteredServer>([\s\S]*?)<\/RegisteredServers:RegisteredServer>/g)) {
    const body = m[1]!
    const get = (tag: string) => {
      const v = new RegExp(`<RegisteredServers:${tag}[^>]*>([^<]*)</RegisteredServers:${tag}>`).exec(body)?.[1]
      return v === undefined ? undefined : xmlText(v)
    }
    const cs = get('ConnectionStringWithEncryptedPassword')
    if (!cs || get('ServerType') === 'AnalysisServices') continue
    try {
      // The encrypted password can't be used outside SSMS: drop it.
      const parsed = parseConnectionString(cs.replace(/;?\s*password=[^;]*/i, ''))
      out.push({ ...parsed, driver: 'mssql', name: get('Name') ?? parsed.host ?? 'SQL Server', password: undefined } as ImportedConnection)
    } catch {
      // Not a SQL Server connection string: skipped.
    }
  }
  return out
}

/** Oracle SQL Developer connections.json. */
export function parseSqlDeveloper(text: string): ImportedConnection[] {
  const data = JSON.parse(text) as { connections?: { name?: string; info?: Record<string, unknown> }[] }
  return (data.connections ?? []).flatMap((c) => {
    const i = c.info ?? {}
    if (i.customUrl) {
      try {
        return [{ ...parseConnectionString(String(i.customUrl)), name: c.name ?? 'Oracle', user: str(i.user) } as ImportedConnection]
      } catch {
        return []
      }
    }
    if (!i.hostname) return []
    return [{ name: c.name ?? String(i.hostname), driver: 'oracle', host: str(i.hostname), port: num(i.port), database: str(i.serviceName ?? i.sid), user: str(i.user) } as ImportedConnection]
  })
}

/** DbVisualizer dbvis.xml: databases with JDBC URLs. */
export function parseDbVisualizer(xml: string): ImportedConnection[] {
  const out: ImportedConnection[] = []
  for (const m of xml.matchAll(/<Database\b[^>]*>([\s\S]*?)<\/Database>/g)) {
    const body = m[1]!
    const get = (tag: string) => {
      const v = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(body)?.[1]
      return v === undefined ? undefined : xmlText(v)
    }
    const url = get('Url')
    if (!url) continue
    try {
      const parsed = parseConnectionString(url)
      out.push({ ...parsed, name: get('Alias') ?? parsed.host ?? 'DbVisualizer', user: parsed.user ?? get('Userid') } as ImportedConnection)
    } catch {
      // Unsupported database: skipped.
    }
  }
  return out
}

/** Minimal XML property list reader (TablePlus, Sequel Ace): dicts, arrays, strings, numbers, booleans. */
export function parsePlist(xml: string): unknown {
  const tokens = [...xml.matchAll(/<(\/?)(dict|array|key|string|integer|real|true|false|date|data)(\s*\/)?>([^<]*)/g)]
  let i = 0
  const value = (): unknown => {
    const t = tokens[i++]
    if (!t) return undefined
    const [, close, tag, selfClose, text] = t as unknown as [string, string, string, string | undefined, string]
    if (close) return undefined
    switch (tag) {
      case 'dict': {
        if (selfClose) return {}
        const obj: Record<string, unknown> = {}
        while (i < tokens.length && !(tokens[i]![1] && tokens[i]![2] === 'dict')) {
          const k = tokens[i++]!
          if (k[2] !== 'key') continue
          i++ // </key>
          obj[xmlText(k[4]!)] = value()
        }
        i++
        return obj
      }
      case 'array': {
        if (selfClose) return []
        const arr: unknown[] = []
        while (i < tokens.length && !(tokens[i]![1] && tokens[i]![2] === 'array')) arr.push(value())
        i++
        return arr
      }
      case 'true':
        return true
      case 'false':
        return false
      case 'integer':
      case 'real':
        i++
        return Number(text)
      default:
        if (selfClose) return ''
        i++
        return xmlText(text)
    }
  }
  while (i < tokens.length && tokens[i]![2] !== 'dict' && tokens[i]![2] !== 'array') i++
  return value()
}

const TABLEPLUS_DRIVERS: Record<string, DriverId> = { PostgreSQL: 'postgres', MySQL: 'mysql', MariaDB: 'mariadb', SQLServer: 'mssql', SQLite: 'sqlite', Oracle: 'oracle', DuckDB: 'duckdb', ClickHouse: 'clickhouse', CockroachDB: 'postgres', Redshift: 'postgres' }

/** TablePlus Connections.plist (or the same records as JSON on Windows). */
export function tablePlusConnections(list: Record<string, unknown>[]): ImportedConnection[] {
  return list.flatMap((c) => {
    const driver = TABLEPLUS_DRIVERS[String(c.Driver)]
    if (!driver) return []
    if (driver === 'sqlite' || driver === 'duckdb') return [{ name: str(c.ConnectionName) ?? 'SQLite', driver, filePath: str(c.DatabasePath) }]
    return [
      {
        name: str(c.ConnectionName) ?? str(c.DatabaseHost) ?? 'TablePlus',
        driver,
        host: str(c.DatabaseHost),
        port: num(c.DatabasePort),
        database: str(c.DatabaseName),
        user: str(c.DatabaseUser),
        ssh: c.isOverSSH || c.OverSSH ? { enabled: true, authMethod: 'password' as const, host: str(c.ServerAddress) ?? '', port: num(c.ServerPort), user: str(c.ServerUser) ?? '' } : undefined,
      } as ImportedConnection,
    ]
  })
}

/** Sequel Ace / Sequel Pro Favorites.plist (MySQL). */
export function sequelAceFavorites(root: unknown): ImportedConnection[] {
  const out: ImportedConnection[] = []
  const walk = (node: unknown, group?: string) => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    if (Array.isArray(n.Children)) {
      for (const child of n.Children) walk(child, n.Name && n.Name !== 'FAVORITES' ? String(n.Name) : group)
      return
    }
    if (n.host === undefined && n.type === undefined) return
    out.push({
      name: str(n.name) ?? str(n.host) ?? 'MySQL',
      driver: 'mysql',
      host: Number(n.type) === 1 ? 'localhost' : str(n.host),
      port: num(n.port),
      user: str(n.user),
      database: str(n.database),
      group,
      ssh: Number(n.type) === 2 ? { enabled: true, authMethod: 'password' as const, host: str(n.sshHost) ?? '', port: num(n.sshPort), user: str(n.sshUser) ?? '' } : undefined,
    } as ImportedConnection)
  }
  walk((root as Record<string, unknown> | undefined)?.['Favorites Root'] ?? root)
  return out
}
