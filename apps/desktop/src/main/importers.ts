import { execFileSync } from 'node:child_process'
import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BrowserWindow, dialog } from 'electron'
import {
  heidiSessions,
  navicatSessions,
  parseAzureDataStudio,
  parseDataGrip,
  parseDbVisualizer,
  parseHeidiPortable,
  parseMySqlWorkbench,
  parsePgAdminServersJson,
  parsePgpass,
  parsePlist,
  parseRegQuery,
  parseSqlDeveloper,
  parseSqlTools,
  parseSsmsRegisteredServers,
  pgAdminServerRows,
  sequelAceFavorites,
  tablePlusConnections,
  type ConnectionConfig,
  type DriverId,
  type Environment,
} from '@dbmastermind/core'
import type { ImportSourceId, StoredConnection } from '@shared/api'
import { listConnections, saveConnection } from './connections'

type Imported = Omit<ConnectionConfig, 'id'>

function appDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

const BEEKEEPER_TYPES: Record<string, DriverId> = {
  postgresql: 'postgres',
  cockroachdb: 'postgres',
  redshift: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  tidb: 'mysql',
  sqlserver: 'mssql',
  sqlite: 'sqlite',
}

/** Beekeeper's simple-encryptor format: HMAC-SHA256 (hex) + IV (hex) + AES-256-CBC (base64), keyed by sha256(key). */
function beekeeperDecrypt(key: string, text: string): unknown {
  const k = createHash('sha256').update(key).digest()
  const mac = text.slice(0, 64)
  const body = text.slice(64)
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), createHmac('sha256', k).update(body).digest())) throw new Error('Wrong key')
  const d = createDecipheriv('aes-256-cbc', k, Buffer.from(body.slice(0, 32), 'hex'))
  return JSON.parse(d.update(body.slice(32), 'base64', 'utf8') + d.final('utf8'))
}

/**
 * Beekeeper Studio's own key for its saved passwords: the `.key` file next to its database, encrypted with the
 * default key from Beekeeper's source (apps/studio/src/common/encryption_key.ts). Undefined when unreadable.
 */
function beekeeperKey(dir: string): string | undefined {
  try {
    const data = beekeeperDecrypt('38782F413F442A472D4B6150645367566B59703373367639792442264529482B', readFileSync(join(dir, '.key'), 'utf8').trim())
    const key = (data as { encryptionKey?: unknown }).encryptionKey
    return typeof key === 'string' ? key : undefined
  } catch {
    return undefined
  }
}

/** Beekeeper Studio keeps connections in its own SQLite database, passwords encrypted with its local key. */
function readBeekeeper(): Imported[] {
  const dir = join(appDataDir(), 'beekeeper-studio')
  const file = join(dir, 'app.db')
  if (!existsSync(file)) throw new Error('Beekeeper Studio data was not found on this computer')
  const key = beekeeperKey(dir)
  const secret = (v: unknown): string | undefined => {
    if (!key || typeof v !== 'string' || !v) return undefined
    try {
      const plain = beekeeperDecrypt(key, v)
      return typeof plain === 'string' && plain ? plain : undefined
    } catch {
      return undefined
    }
  }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db.prepare('SELECT * FROM saved_connection ORDER BY id').all() as Record<string, unknown>[]
    const out: Imported[] = []
    for (const r of rows) {
      const driver = BEEKEEPER_TYPES[String(r.connectionType)]
      if (!driver) continue
      const str = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v))
      out.push({
        name: String(r.name),
        driver,
        host: str(r.host),
        port: r.port ? Number(r.port) : undefined,
        user: str(r.username),
        password: Number(r.rememberPassword ?? 1) ? secret(r.password) : undefined,
        database: str(r.defaultDatabase),
        filePath: str(r.path),
        ssl: r.ssl ? { mode: Number(r.sslRejectUnauthorized) ? 'verify-full' : 'require' } : undefined,
        ssh: r.sshEnabled
          ? {
              enabled: true,
              host: String(r.sshHost ?? ''),
              port: r.sshPort ? Number(r.sshPort) : 22,
              user: String(r.sshUsername ?? ''),
              authMethod: r.sshMode === 'agent' ? 'agent' : r.sshMode === 'userpass' ? 'password' : 'privateKey',
              password: r.sshMode === 'userpass' ? secret(r.sshPassword) : undefined,
              passphrase: r.sshMode === 'keyfile' ? secret(r.sshKeyfilePassword) : undefined,
              privateKey: r.sshMode === 'keyfile' && typeof r.sshKeyfile === 'string' && existsSync(r.sshKeyfile) ? readFileSync(r.sshKeyfile, 'utf8') : undefined,
            }
          : undefined,
        options:
          driver === 'mssql'
            ? { trustServerCertificate: Boolean(Number(r.trustServerCertificate)), ...(r.domain ? { domain: String(r.domain) } : {}) }
            : undefined,
      })
    }
    return out
  } finally {
    db.close()
  }
}

const DBEAVER_PROVIDERS: Record<string, DriverId> = {
  postgresql: 'postgres',
  mysql: 'mysql',
  mariadb: 'mariadb',
  sqlserver: 'mssql',
  mssql: 'mssql',
  sqlite: 'sqlite',
}

/** DBeaver's well-known default key for credentials-config.json. */
/** ~/.pgpass (Windows: %APPDATA%\\postgresql\\pgpass.conf), honouring PGPASSFILE. */
/** JetBrains IDEs keep global data sources in <config>/options/dataSources.xml (newest version wins). */
async function readDataGrip(): Promise<Imported[]> {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'JetBrains')
      : process.platform === 'win32'
        ? join(appDataDir(), 'JetBrains')
        : join(homedir(), '.config', 'JetBrains')
  const dirs = existsSync(base)
    ? readdirSync(base)
        .filter((d) => /^(DataGrip|IntelliJIdea|IdeaIC|PyCharm|WebStorm|PhpStorm|Rider|GoLand|RubyMine|CLion|RustRover)/i.test(d))
        .sort()
        .reverse()
    : []
  const seen = new Set<string>()
  const out: Imported[] = []
  const add = (xml: string, local: string) => {
    for (const c of parseDataGrip(xml, local)) {
      const key = `${c.driver}|${c.host}|${c.port}|${c.database}|${c.name}`
      if (!seen.has(key)) {
        seen.add(key)
        out.push(c)
      }
    }
  }
  for (const d of dirs) {
    const file = join(base, d, 'options', 'dataSources.xml')
    if (!existsSync(file)) continue
    const local = join(base, d, 'options', 'dataSources.local.xml')
    add(readFileSync(file, 'utf8'), existsSync(local) ? readFileSync(local, 'utf8') : '')
  }
  // A project's .idea/dataSources.xml can be picked with "From a file…".
  return out
}

function readPgpass(): Imported[] {
  const file = process.env.PGPASSFILE ?? (process.platform === 'win32' ? join(appDataDir(), 'postgresql', 'pgpass.conf') : join(homedir(), '.pgpass'))
  if (!existsSync(file)) throw new Error('No .pgpass file was found on this computer')
  return parsePgpass(readFileSync(file, 'utf8'))
}

const DBEAVER_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex')

function readDbeaver(): Imported[] {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'DBeaverData')
      : process.platform === 'win32'
        ? join(appDataDir(), 'DBeaverData')
        : join(homedir(), '.local', 'share', 'DBeaverData')
  const dir = join(base, 'workspace6', 'General', '.dbeaver')
  const sourcesFile = join(dir, 'data-sources.json')
  if (!existsSync(sourcesFile)) throw new Error('DBeaver data was not found on this computer')
  const sources = JSON.parse(readFileSync(sourcesFile, 'utf8')) as {
    connections?: Record<string, { provider?: string; driver?: string; name?: string; folder?: string; configuration?: Record<string, unknown> }>
  }
  let credentials: Record<string, { '#connection'?: { user?: string; password?: string } }> = {}
  const credFile = join(dir, 'credentials-config.json')
  if (existsSync(credFile)) {
    try {
      const data = readFileSync(credFile)
      const decipher = createDecipheriv('aes-128-cbc', DBEAVER_KEY, data.subarray(0, 16))
      const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8')
      credentials = JSON.parse(plain)
    } catch {
      // Custom master password: import without credentials.
    }
  }
  const envMap: Record<string, Environment> = { dev: 'development', test: 'test', prod: 'production' }
  const out: Imported[] = []
  for (const [id, c] of Object.entries(sources.connections ?? {})) {
    const provider = (c.provider ?? '').toLowerCase()
    const driver =
      DBEAVER_PROVIDERS[provider] ?? (/(mariadb)/i.test(c.driver ?? '') ? 'mariadb' : DBEAVER_PROVIDERS[(c.driver ?? '').split('-')[0]!])
    if (!driver) continue
    const cfg = c.configuration ?? {}
    const cred = credentials[id]?.['#connection']
    const str = (v: unknown) => (v === null || v === undefined || v === '' ? undefined : String(v))
    out.push({
      name: c.name ?? id,
      driver,
      host: str(cfg.host),
      port: cfg.port ? Number(cfg.port) : undefined,
      database: str(cfg.database),
      filePath: driver === 'sqlite' ? str(cfg.database) : undefined,
      user: cred?.user ?? str(cfg.user),
      password: cred?.password,
      environment: envMap[String(cfg.type ?? '')],
      group: str(c.folder),
    })
  }
  return out
}

/**
 * "From a file…": our own export, or another tool's file, recognized by its content: pgAdmin servers.json,
 * DataGrip dataSources.xml, MySQL Workbench connections.xml, SSMS RegSrvr.xml, SQL Developer connections.json,
 * DbVisualizer dbvis.xml, HeidiSQL portable_settings.txt, TablePlus / Sequel Ace .plist.
 */
async function readFileExport(): Promise<Imported[]> {
  const window = BrowserWindow.getFocusedWindow()
  const options = { title: 'Import connections', properties: ['openFile' as const], filters: [{ name: 'Connections', extensions: ['json', 'xml', 'txt', 'plist'] }] }
  const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  const file = r.filePaths[0]
  if (r.canceled || !file) return []
  const text = readPlistFile(file) ?? readFileSync(file, 'utf8')
  return parseAnyConnectionFile(text, file)
}

function parseAnyConnectionFile(text: string, file: string): Imported[] {
  const t = text.trimStart()
  if (t.startsWith('{') || t.startsWith('[')) {
    const data = JSON.parse(text) as Record<string, unknown> | Imported[]
    if (Array.isArray(data)) return data
    if (data.Servers) return parsePgAdminServersJson(text)
    if (Array.isArray(data.connections) && (data.connections as { info?: unknown }[]).some((c) => c.info)) return parseSqlDeveloper(text)
    if (Array.isArray(data.connections)) return data.connections as Imported[]
    throw new Error('This JSON file has no connections DB Mastermind knows')
  }
  if (/<plist/.test(t)) {
    const plist = parsePlist(text)
    return Array.isArray(plist) ? tablePlusConnections(plist as Record<string, unknown>[]) : sequelAceFavorites(plist)
  }
  if (/DataSourceManagerImpl|dataSourceStorage|<data-source/.test(t)) {
    const local = file.replace(/dataSources\.xml$/i, 'dataSources.local.xml')
    return parseDataGrip(text, local !== file && existsSync(local) ? readFileSync(local, 'utf8') : '')
  }
  if (/db\.mgmt\.Connection/.test(t)) return parseMySqlWorkbench(text)
  if (/RegisteredServers:RegisteredServer/.test(t)) return parseSsmsRegisteredServers(text)
  if (/<Database\b/.test(t) && /<Url>/.test(t)) return parseDbVisualizer(text)
  if (/<\|\|\|>/.test(t)) return parseHeidiPortable(text)
  throw new Error('Unknown file: pick a connection export from DB Mastermind or another database tool')
}

/** XML text of a property list (binary plists converted with plutil on macOS). */
function readPlistFile(file: string): string | null {
  if (!/\.plist$/i.test(file)) return null
  const raw = readFileSync(file)
  if (raw.subarray(0, 6).toString() !== 'bplist') return raw.toString('utf8')
  if (process.platform !== 'darwin') throw new Error('Binary property lists can only be read on macOS')
  return execFileSync('plutil', ['-convert', 'xml1', '-o', '-', file], { encoding: 'utf8' })
}

/** `reg query <key> /s` as text (Windows only; empty when the key doesn't exist). */
function regQuery(key: string): string {
  try {
    return execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return ''
  }
}

const home = () => homedir()
const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p))
const readIf = (path: string | undefined) => (path && existsSync(path) ? readFileSync(path, 'utf8') : undefined)
/** Matching files one level below each directory (e.g. versioned settings folders). */
function globDirs(base: string, pattern: RegExp, ...rest: string[]): string[] {
  if (!existsSync(base)) return []
  return readdirSync(base)
    .filter((d) => pattern.test(d))
    .sort()
    .reverse()
    .map((d) => join(base, d, ...rest))
    .filter((p) => existsSync(p))
}

function readPgAdmin(): Imported[] {
  const file = firstExisting(process.platform === 'win32' ? [join(appDataDir(), 'pgAdmin', 'pgadmin4.db')] : [join(home(), '.pgadmin', 'pgadmin4.db')])
  if (!file) return []
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return pgAdminServerRows(db.prepare('SELECT * FROM server').all() as Record<string, unknown>[])
  } finally {
    db.close()
  }
}

function readWorkbench(): Imported[] {
  const file =
    process.platform === 'darwin'
      ? join(appDataDir(), 'MySQL', 'Workbench', 'connections.xml')
      : process.platform === 'win32'
        ? join(appDataDir(), 'MySQL', 'Workbench', 'connections.xml')
        : join(home(), '.mysql', 'workbench', 'connections.xml')
  const xml = readIf(file)
  return xml ? parseMySqlWorkbench(xml) : []
}

function readHeidi(): Imported[] {
  if (process.platform !== 'win32') return []
  return heidiSessions(parseRegQuery(regQuery('HKCU\\Software\\HeidiSQL\\Servers'), 'Software\\HeidiSQL\\Servers'))
}

function readNavicat(): Imported[] {
  if (process.platform !== 'win32') return []
  const products: [string, DriverId][] = [['Navicat', 'mysql'], ['NavicatPG', 'postgres'], ['NavicatMSSQL', 'mssql'], ['NavicatOra', 'oracle'], ['NavicatMARIADB', 'mariadb']]
  return products.flatMap(([product, driver]) => {
    const root = `Software\\PremiumSoft\\${product}\\Servers`
    return navicatSessions(parseRegQuery(regQuery(`HKCU\\${root}`), root), driver)
  })
}

const editorSettings = (app: string) => join(appDataDir(), app, 'User', 'settings.json')

function readAzureDataStudio(): Imported[] {
  const text = readIf(editorSettings('azuredatastudio'))
  return text ? parseAzureDataStudio(text) : []
}

function readSqlTools(): Imported[] {
  return ['Code', 'Code - Insiders', 'Cursor', 'VSCodium'].flatMap((app) => {
    const text = readIf(editorSettings(app))
    return text && text.includes('sqltools.connections') ? parseSqlTools(text) : []
  })
}

function readSsms(): Imported[] {
  if (process.platform !== 'win32') return []
  const files = [
    ...globDirs(join(appDataDir(), 'Microsoft', 'Microsoft SQL Server'), /^\d+$/, 'Tools', 'Shell', 'RegSrvr.xml'),
    ...globDirs(join(appDataDir(), 'Microsoft', 'SQL Server Management Studio'), /^[\d.]+$/, 'RegSrvr.xml'),
  ]
  return files.flatMap((f) => parseSsmsRegisteredServers(readFileSync(f, 'utf8')))
}

function readSqlDeveloper(): Imported[] {
  const base = process.platform === 'win32' ? join(appDataDir(), 'SQL Developer') : join(home(), '.sqldeveloper')
  return globDirs(base, /^system/)
    .flatMap((system) => globDirs(system, /^o\.jdeveloper\.db\.connection/, 'connections.json'))
    .slice(0, 1)
    .flatMap((f) => parseSqlDeveloper(readFileSync(f, 'utf8')))
}

function readDbVisualizer(): Imported[] {
  const xml = readIf(firstExisting(globDirs(join(home(), '.dbvis'), /^config/, 'dbvis.xml')))
  return xml ? parseDbVisualizer(xml) : []
}

function readTablePlus(): Imported[] {
  if (process.platform === 'darwin') {
    const file = join(appDataDir(), 'com.tinyapp.TablePlus', 'Data', 'Connections.plist')
    if (!existsSync(file)) return []
    const plist = parsePlist(readPlistFile(file)!)
    return Array.isArray(plist) ? tablePlusConnections(plist as Record<string, unknown>[]) : []
  }
  return []
}

function readSequelAce(): Imported[] {
  if (process.platform !== 'darwin') return []
  const file = firstExisting([
    join(home(), 'Library', 'Containers', 'com.sequel-ace.sequel-ace', 'Data', 'Library', 'Application Support', 'Sequel Ace', 'Data', 'Favorites.plist'),
    join(appDataDir(), 'Sequel Pro', 'Data', 'Favorites.plist'),
  ])
  return file ? sequelAceFavorites(parsePlist(readPlistFile(file)!)) : []
}

/** Tools whose saved connections can be imported, in menu order. */
export const IMPORT_SOURCES: { id: ImportSourceId; label: string; read: () => Imported[] | Promise<Imported[]>; note?: string }[] = [
  { id: 'beekeeper', label: 'Beekeeper Studio', read: () => readBeekeeper(), note: 'passwords' },
  { id: 'dbeaver', label: 'DBeaver', read: () => readDbeaver() },
  { id: 'datagrip', label: 'DataGrip / IntelliJ', read: () => readDataGrip(), note: 'passwords' },
  { id: 'pgadmin', label: 'pgAdmin 4', read: () => readPgAdmin(), note: 'passwords' },
  { id: 'ssms', label: 'SQL Server Management Studio', read: () => readSsms(), note: 'passwords' },
  { id: 'azuredatastudio', label: 'Azure Data Studio', read: () => readAzureDataStudio(), note: 'passwords' },
  { id: 'workbench', label: 'MySQL Workbench', read: () => readWorkbench(), note: 'passwords' },
  { id: 'heidisql', label: 'HeidiSQL', read: () => readHeidi(), note: 'passwords' },
  { id: 'navicat', label: 'Navicat', read: () => readNavicat(), note: 'passwords' },
  { id: 'sqldeveloper', label: 'Oracle SQL Developer', read: () => readSqlDeveloper(), note: 'passwords' },
  { id: 'dbvisualizer', label: 'DbVisualizer', read: () => readDbVisualizer(), note: 'passwords' },
  { id: 'tableplus', label: 'TablePlus', read: () => readTablePlus(), note: 'passwords' },
  { id: 'sequelace', label: 'Sequel Ace / Sequel Pro', read: () => readSequelAce(), note: 'passwords' },
  { id: 'sqltools', label: 'VS Code SQLTools', read: () => readSqlTools() },
  { id: 'pgpass', label: '.pgpass (PostgreSQL)', read: () => readPgpass() },
]

/** Which tools on this computer have connections to import, with how many. */
export async function detectImportSources(): Promise<{ id: ImportSourceId; label: string; count: number }[]> {
  const out: { id: ImportSourceId; label: string; count: number }[] = []
  for (const source of IMPORT_SOURCES) {
    try {
      const count = (await source.read()).length
      if (count) out.push({ id: source.id, label: source.label, count })
    } catch {
      // Not installed, or a file we can't read: not offered.
    }
  }
  return out
}

/** Connections for colleagues: everything except secrets (passwords, keys) and personal metadata. */
export async function exportConnections(ids?: string[]): Promise<string | null> {
  const chosen = listConnections().filter((c) => !ids?.length || ids.includes(c.id))
  if (!chosen.length) throw new Error('No connections to export')
  const window = BrowserWindow.getFocusedWindow()
  const options = { title: 'Export connections', defaultPath: 'db-mastermind-connections.json', filters: [{ name: 'JSON', extensions: ['json'] }] }
  const r = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  if (r.canceled || !r.filePath) return null
  const connections = chosen.map((c) => {
    const { id: _id, password: _pw, createdAt: _c, updatedAt: _u, lastUsedAt: _l, pinnedTables: _p, hiddenSchemas: _h, ...rest } = c
    return {
      ...rest,
      ssh: c.ssh ? { ...c.ssh, password: undefined, privateKey: undefined, passphrase: undefined } : undefined,
      ssl: c.ssl ? { ...c.ssl, key: undefined } : undefined,
    }
  })
  writeFileSync(r.filePath, `${JSON.stringify({ format: 'db-mastermind-connections', version: 1, connections }, null, 2)}\n`, 'utf8')
  return r.filePath
}

/**
 * Adds the connections that aren't here yet. A connection already here (same name, driver and host; the database
 * may have been changed since) only gets passwords it lacks, so importing again fills in what an earlier import
 * couldn't read.
 */
export async function importConnections(source: ImportSourceId | 'file'): Promise<{ added: number; passwords: number }> {
  const reader = IMPORT_SOURCES.find((x) => x.id === source)
  const items = source === 'file' ? await readFileExport() : reader ? await reader.read() : []
  const existing = listConnections()
  let added = 0
  let passwords = 0
  for (const item of items) {
    const same = existing.find((c) => c.name === item.name && c.driver === item.driver && c.host === item.host)
    if (!same) {
      saveConnection({ ...item, id: '' })
      added++
      continue
    }
    const fill: Partial<StoredConnection> = {}
    if (!same.password && item.password) fill.password = item.password
    if (same.ssh && item.ssh && !same.ssh.password && item.ssh.password) fill.ssh = { ...same.ssh, password: item.ssh.password }
    if (!Object.keys(fill).length || same.managed) continue
    saveConnection({ ...same, ...fill })
    passwords++
  }
  return { added, passwords }
}
