import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { ConnectionConfig } from '@dbmastermind/core'

/** How a database is backed up or restored: an external tool, SQL the app runs, or SQL the user runs on the server. */
export type BackupPlan =
  | { kind: 'tool'; tool: string; args: string[]; env: Record<string, string>; stdinFile?: string }
  | { kind: 'sql'; sql: string }
  | { kind: 'server-sql'; sql: string; note: string }

export type BackupFormat = 'custom' | 'sql'

const quoteSql = (s: string) => `'${s.replaceAll("'", "''")}'`

/** Placeholder in DuckDB backup SQL for the current database name. */
export const CURRENT_DATABASE = '__dbm_current_database__'

/** File extension and save-dialog filter for a backup of this connection. */
export function backupFileType(driver: ConnectionConfig['driver'], format: BackupFormat): { ext: string; name: string } {
  if (driver === 'postgres') return format === 'custom' ? { ext: 'dump', name: 'PostgreSQL custom dump' } : { ext: 'sql', name: 'SQL script' }
  if (driver === 'sqlite') return { ext: 'db', name: 'SQLite database' }
  if (driver === 'duckdb') return { ext: 'duckdb', name: 'DuckDB database' }
  if (driver === 'mssql') return { ext: 'bak', name: 'SQL Server backup' }
  return { ext: 'sql', name: 'SQL script' }
}

/** Backup of the connection's database into `file`. */
export function backupPlan(c: ConnectionConfig, file: string, format: BackupFormat = 'custom'): BackupPlan {
  if (c.ssh?.enabled && c.driver !== 'sqlite' && c.driver !== 'duckdb') throw new Error('Backups through an SSH tunnel are not supported yet: run the dump tool on the server')
  switch (c.driver) {
    case 'postgres':
      return {
        kind: 'tool',
        tool: 'pg_dump',
        args: [...pgArgs(c), `--format=${format === 'custom' ? 'custom' : 'plain'}`, '--no-owner', `--file=${file}`],
        env: pgEnv(c),
      }
    case 'mysql':
    case 'mariadb':
      return {
        kind: 'tool',
        tool: c.driver === 'mariadb' ? 'mariadb-dump' : 'mysqldump',
        args: [...myArgs(c), '--single-transaction', '--routines', '--triggers', '--events', `--result-file=${file}`, c.database ?? ''].filter(Boolean),
        env: myEnv(c),
      }
    case 'sqlite':
      // A consistent copy while the database stays in use.
      return { kind: 'sql', sql: `VACUUM INTO ${quoteSql(file)}` }
    case 'duckdb':
      // CURRENT_DATABASE is replaced with the attached database's name (the file's base name).
      return { kind: 'sql', sql: `ATTACH ${quoteSql(file)} AS dbm_backup; COPY FROM DATABASE "${CURRENT_DATABASE}" TO dbm_backup; DETACH dbm_backup` }
    case 'mssql':
      return {
        kind: 'server-sql',
        sql: `-- Runs on the server: the path is on the SQL Server machine, not on this computer.\nBACKUP DATABASE [${(c.database ?? 'master').replaceAll(']', ']]')}]\n  TO DISK = N${quoteSql(file)}\n  WITH COPY_ONLY, COMPRESSION, INIT, STATS = 10;`,
        note: 'SQL Server writes backups on the server',
      }
    case 'oracle':
      throw new Error('Oracle backups are made with Data Pump (expdp) on the server')
  }
}

/** Restore of `file` into the connection's database. */
export function restorePlan(c: ConnectionConfig, file: string): BackupPlan {
  if (c.ssh?.enabled) throw new Error('Restoring through an SSH tunnel is not supported yet: run the restore tool on the server')
  switch (c.driver) {
    case 'postgres':
      // Custom-format dumps go through pg_restore, plain SQL through psql.
      return /\.(dump|backup|custom)$/i.test(file)
        ? { kind: 'tool', tool: 'pg_restore', args: [...pgArgs(c), '--no-owner', '--clean', '--if-exists', '--exit-on-error', file], env: pgEnv(c) }
        : { kind: 'tool', tool: 'psql', args: [...pgArgs(c), '--set=ON_ERROR_STOP=1', '--quiet', `--file=${file}`], env: pgEnv(c) }
    case 'mysql':
    case 'mariadb':
      return { kind: 'tool', tool: c.driver === 'mariadb' ? 'mariadb' : 'mysql', args: [...myArgs(c), c.database ?? ''].filter(Boolean), env: myEnv(c), stdinFile: file }
    case 'mssql':
      return {
        kind: 'server-sql',
        sql: `-- Runs on the server: the path is on the SQL Server machine. This replaces the database!\nUSE master;\nRESTORE DATABASE [${(c.database ?? '').replaceAll(']', ']]')}]\n  FROM DISK = N${quoteSql(file)}\n  WITH REPLACE, STATS = 10;`,
        note: 'SQL Server restores from a file on the server',
      }
    default:
      throw new Error('Open the backup file as its own connection instead')
  }
}

function pgArgs(c: ConnectionConfig): string[] {
  return [`--host=${c.host ?? 'localhost'}`, `--port=${c.port ?? 5432}`, ...(c.user ? [`--username=${c.user}`] : []), `--dbname=${c.database ?? 'postgres'}`, '--no-password']
}

function pgEnv(c: ConnectionConfig): Record<string, string> {
  const env: Record<string, string> = {}
  if (c.password) env.PGPASSWORD = c.password
  if (c.ssl && c.ssl.mode !== 'disable') env.PGSSLMODE = c.ssl.mode === 'prefer' ? 'prefer' : 'require'
  return env
}

function myArgs(c: ConnectionConfig): string[] {
  return [`--host=${c.host ?? 'localhost'}`, `--port=${c.port ?? 3306}`, ...(c.user ? [`--user=${c.user}`] : []), ...(c.ssl && c.ssl.mode !== 'disable' ? ['--ssl-mode=REQUIRED'] : [])]
}

function myEnv(c: ConnectionConfig): Record<string, string> {
  return c.password ? { MYSQL_PWD: c.password } : {}
}

/** Finds a database command-line tool on PATH or where its installers usually put it. */
export function findTool(tool: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const exe = platform === 'win32' ? `${tool}.exe` : tool
  const dirs = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  if (platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/Applications/Postgres.app/Contents/Versions/latest/bin', '/opt/homebrew/opt/libpq/bin', '/opt/homebrew/opt/mysql-client/bin', '/usr/local/mysql/bin')
  if (platform === 'linux') dirs.push('/usr/bin', '/usr/local/bin', '/usr/lib/postgresql')
  if (platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files'
    for (const [root, sub] of [['PostgreSQL', 'bin'], ['MySQL', 'bin'], ['MariaDB', 'bin']] as const) {
      const base = join(pf, root)
      // Newest version first: C:\Program Files\PostgreSQL\17\bin, …\MySQL\MySQL Server 8.4\bin
      if (existsSync(base)) for (const v of readdirSync(base).sort().reverse()) dirs.push(join(base, v, sub))
    }
  }
  if (platform === 'linux' && existsSync('/usr/lib/postgresql')) for (const v of readdirSync('/usr/lib/postgresql').sort().reverse()) dirs.push(join('/usr/lib/postgresql', v, 'bin'))
  for (const dir of dirs) {
    const path = join(dir, exe)
    if (existsSync(path)) return path
  }
  return null
}

export function toolInstallHint(tool: string): string {
  if (/^pg_|^psql$/.test(tool)) return 'Install the PostgreSQL client tools (Windows: the PostgreSQL installer, "Command Line Tools"; macOS: brew install libpq)'
  return 'Install the MySQL or MariaDB client (Windows: MySQL Installer → MySQL Shell/Client; macOS: brew install mysql-client)'
}
