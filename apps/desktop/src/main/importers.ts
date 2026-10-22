import { createDecipheriv } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { BrowserWindow, dialog } from 'electron'
import { parsePgpass, type ConnectionConfig, type DriverId, type Environment } from '@dbmastermind/core'
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

/** Beekeeper Studio keeps connections in its own SQLite database. Passwords are encrypted there, so they aren't imported. */
function readBeekeeper(): Imported[] {
  const file = join(appDataDir(), 'beekeeper-studio', 'app.db')
  if (!existsSync(file)) throw new Error('Beekeeper Studio data was not found on this computer')
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
    connections?: Record<string, { provider?: string; driver?: string; name?: string; configuration?: Record<string, unknown> }>
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
    })
  }
  return out
}

async function readFileExport(): Promise<Imported[]> {
  const window = BrowserWindow.getFocusedWindow()
  const r = await dialog.showOpenDialog(window!, { filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] })
  if (r.canceled || !r.filePaths[0]) return []
  const parsed = JSON.parse(readFileSync(r.filePaths[0], 'utf8')) as Imported[] | { connections: Imported[] }
  return Array.isArray(parsed) ? parsed : parsed.connections
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

export async function importConnections(source: 'beekeeper' | 'dbeaver' | 'pgpass' | 'file'): Promise<number> {
  const items = source === 'beekeeper' ? readBeekeeper() : source === 'dbeaver' ? readDbeaver() : source === 'pgpass' ? readPgpass() : await readFileExport()
  const existing = listConnections()
  let count = 0
  for (const item of items) {
    const duplicate = existing.some(
      (c) => c.name === item.name && c.driver === item.driver && c.host === item.host && c.database === item.database,
    )
    if (duplicate) continue
    saveConnection({ ...item, id: '' })
    count++
  }
  return count
}
