import { describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'

/**
 * Windows integrated authentication (msnodesqlv8 + ODBC). Runs only where configured, e.g. the Windows CI
 * job with SQL Server LocalDB: DBM_WINAUTH=1 [DBM_WINAUTH_HOST=(localdb)] [DBM_WINAUTH_INSTANCE=MSSQLLocalDB]
 */
describe.skipIf(process.env.DBM_WINAUTH !== '1')('SQL Server Windows authentication', () => {
  it('connects as the current Windows user and runs queries', async () => {
    const svc = new DatabaseService()
    try {
      await svc.connect({
        id: 'win',
        name: 'win',
        driver: 'mssql',
        host: process.env.DBM_WINAUTH_HOST ?? '(localdb)',
        database: 'master',
        options: { authentication: 'windows', instanceName: process.env.DBM_WINAUTH_INSTANCE ?? 'MSSQLLocalDB' },
        ssl: { mode: 'disable' },
      })
      const [who] = await svc.runScript('win', 'SELECT SUSER_SNAME() AS login, 42 AS answer')
      expect(who!.error).toBeUndefined()
      expect(who!.results![0]!.rows[0]![1]).toBe(42)
      expect(String(who!.results![0]!.rows[0]![0])).toMatch(/\\/)
      const [multi] = await svc.runScript('win', 'SELECT name FROM sys.databases ORDER BY name', { maxRows: 2 })
      expect(multi!.results![0]!.rows.length).toBeLessThanOrEqual(2)
      const snapshot = await svc.schema('win', true)
      expect(snapshot.database).toBe('master')
    } finally {
      await svc.disconnectAll()
    }
  })
})
