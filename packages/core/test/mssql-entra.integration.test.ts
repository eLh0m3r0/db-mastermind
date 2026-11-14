import { describe, expect, it } from 'vitest'
import { DatabaseService } from '../src/index.js'
import { skip } from './fixtures.js'

/**
 * Microsoft Entra ID can't be tested without Azure: against the local SQL Server it must fail with the credential's
 * own explanation (no Azure sign-in here), not hang and not crash. Real Entra sign-in is unverified in CI.
 */
describe.skipIf(skip.has('mssql'))('SQL Server with Microsoft Entra ID, without Azure', () => {
  it('fails clearly when there is no Azure sign-in to use', async () => {
    const svc = new DatabaseService()
    const started = Date.now()
    try {
      await expect(
        svc.connect({ id: 'entra', name: 'entra', driver: 'mssql', host: '127.0.0.1', port: 14339, database: 'master', options: { authentication: 'entra', trustServerCertificate: true } }),
      ).rejects.toThrow(/credential|token|did not accept Microsoft Entra ID/i)
      expect(Date.now() - started).toBeLessThan(60_000)
    } finally {
      await svc.disconnectAll()
    }
  }, 90_000)
})
