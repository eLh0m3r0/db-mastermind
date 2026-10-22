import { describe, expect, it } from 'vitest'
import { backupFileType, backupPlan, findTool, restorePlan } from '../src/main/backup-commands'

const pg = { id: 'pg', name: 'pg', driver: 'postgres' as const, host: 'db', port: 5433, user: 'jan', password: 's3cret', database: 'shop', ssl: { mode: 'require' as const } }

describe('backup plans', () => {
  it('runs pg_dump with the password in the environment, never on the command line', () => {
    const plan = backupPlan(pg, '/tmp/shop.dump')
    expect(plan).toEqual({
      kind: 'tool',
      tool: 'pg_dump',
      args: ['--host=db', '--port=5433', '--username=jan', '--dbname=shop', '--no-password', '--format=custom', '--no-owner', '--file=/tmp/shop.dump'],
      env: { PGPASSWORD: 's3cret', PGSSLMODE: 'require' },
    })
    expect(backupPlan(pg, '/tmp/shop.sql', 'sql')).toMatchObject({ args: expect.arrayContaining(['--format=plain']) })
  })
  it('restores custom dumps with pg_restore and SQL files with psql', () => {
    expect(restorePlan(pg, '/tmp/a.dump')).toMatchObject({ tool: 'pg_restore', args: expect.arrayContaining(['--clean', '--if-exists', '/tmp/a.dump']) })
    expect(restorePlan(pg, '/tmp/a.sql')).toMatchObject({ tool: 'psql', args: expect.arrayContaining(['--file=/tmp/a.sql', '--set=ON_ERROR_STOP=1']) })
  })
  it('uses mysqldump / mariadb-dump and pipes restores through stdin', () => {
    const my = { id: 'm', name: 'm', driver: 'mariadb' as const, host: 'h', user: 'u', password: 'p', database: 'shop' }
    expect(backupPlan(my, '/tmp/x.sql')).toMatchObject({ tool: 'mariadb-dump', env: { MYSQL_PWD: 'p' }, args: expect.arrayContaining(['--single-transaction', '--result-file=/tmp/x.sql', 'shop']) })
    expect(restorePlan(my, '/tmp/x.sql')).toMatchObject({ tool: 'mariadb', stdinFile: '/tmp/x.sql' })
  })
  it('copies SQLite with VACUUM INTO and gives SQL Server the BACKUP statement', () => {
    expect(backupPlan({ id: 's', name: 's', driver: 'sqlite', filePath: '/a.db' }, "/tmp/it's.db")).toEqual({ kind: 'sql', sql: "VACUUM INTO '/tmp/it''s.db'" })
    const ms = backupPlan({ id: 'x', name: 'x', driver: 'mssql', database: 'ERP' }, 'C:\\Backup\\erp.bak')
    expect(ms).toMatchObject({ kind: 'server-sql', sql: expect.stringContaining("BACKUP DATABASE [ERP]\n  TO DISK = N'C:\\Backup\\erp.bak'") })
    expect(backupFileType('postgres', 'custom').ext).toBe('dump')
  })
  it('refuses connections through SSH and Oracle', () => {
    expect(() => backupPlan({ ...pg, ssh: { enabled: true, host: 'b', user: 'u' } }, '/x')).toThrow(/SSH/)
    expect(() => backupPlan({ id: 'o', name: 'o', driver: 'oracle' }, '/x')).toThrow(/Data Pump/)
  })
  it('finds tools on PATH', () => {
    expect(findTool('definitely-not-a-tool', { PATH: '/usr/bin' }, 'linux')).toBeNull()
    expect(findTool('sh', { PATH: '/bin:/usr/bin' }, 'linux')).toMatch(/\/sh$/)
  })
})
