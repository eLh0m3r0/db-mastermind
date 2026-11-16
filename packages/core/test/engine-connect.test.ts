import { describe, expect, it } from 'vitest'
import { DatabaseService, getDialect, type DatabaseDriver } from '../src/index.js'

describe('DatabaseService.connect', () => {
  it('closes a driver whose connect failed (an SSH tunnel up, the login refused) and keeps the error', async () => {
    let closed = 0
    const svc = new DatabaseService(() => ({ connect: async () => Promise.reject(new Error('Login failed')), close: async () => void closed++ }) as unknown as DatabaseDriver)
    await expect(svc.connect({ id: 'x', name: 'x', driver: 'postgres', host: 'h' })).rejects.toThrow('Login failed')
    expect(closed).toBe(1)
    expect(svc.isOpen('x')).toBe(false)
  })
})

describe('grid saves in a table tab’s transaction on Redshift (review finding)', () => {
  it('use no SAVEPOINT, which Redshift lacks', async () => {
    const ran: string[] = []
    let open = false
    const driver = {
      dialect: getDialect('postgres'),
      connect: async () => {},
      close: async () => {},
      serverInfo: async () => ({ product: 'Redshift', version: '1.0' }),
      transactionState: async () => (open ? 'open' : 'none'),
      execute: async (sql: string) => {
        ran.push(sql)
        if (sql === 'BEGIN') open = true
        if (/SAVEPOINT/.test(sql)) throw new Error('SAVEPOINT is not supported')
        return [{ fields: [], rows: [], affectedRows: 1, durationMs: 0 }]
      },
    } as unknown as DatabaseDriver
    const svc = new DatabaseService(() => driver)
    await svc.connect({ id: 'rs', name: 'rs', driver: 'postgres', host: 'h', manualCommit: true })
    await svc.applyChanges('rs', { schema: 'public', name: 't' }, [{ type: 'update', key: { id: '1' }, values: { v: '2' } }], { session: 'tab' })
    expect(ran.some((sql) => /SAVEPOINT/.test(sql))).toBe(false)
    expect(ran[0]).toBe('BEGIN')
    expect(ran.at(-1)).toMatch(/^UPDATE "public"\."t"/)
  })
})
