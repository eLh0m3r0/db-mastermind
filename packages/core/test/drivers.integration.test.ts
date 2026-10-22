import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService, findTable } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

/**
 * One behavioural suite, run against every driver. Requires `npm run db:up`.
 * Set DBM_SKIP=mssql,mariadb to skip engines that aren't available.
 */

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(engine.id, () => {
    const svc = new DatabaseService()
    let config = engine.config
    const id = config.id
    const customers = { schema: engine.schema, name: 'customers' }
    const orders = { schema: engine.schema, name: 'orders' }

    beforeAll(async () => {
      config = await setupEngine(svc, engine)
    })
    afterAll(() => svc.disconnectAll())

    it('reports server info', () => {
      const info = svc.serverInfo(id)
      expect(info?.version).toMatch(/\d/)
    })

    it('introspects tables, columns, keys, indexes and comments', async () => {
      const snapshot = await svc.schema(id, true)
      expect(snapshot.schemas).toContain(engine.schema)
      const c = findTable(snapshot, customers)!
      const o = findTable(snapshot, orders)!
      expect(c.type).toBe('table')
      expect(c.columns.map((x) => x.name)).toEqual(['id', 'name', 'email', 'vip', 'created_at', 'meta'])
      expect(c.primaryKey).toEqual(['id'])
      expect(c.columns[0]!.isIdentity).toBe(true)
      expect(c.columns[0]!.isPrimaryKey).toBe(true)
      expect(c.columns[1]!.nullable).toBe(false)
      expect(c.columns[2]!.nullable).toBe(true)
      if (engine.id !== 'sqlite') {
        expect(c.comment).toBe('People who buy things')
        expect(c.columns.find((x) => x.name === 'vip')!.comment).toBe('Very important person')
      }
      expect(o.foreignKeys).toHaveLength(1)
      expect(o.foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers', refColumns: ['id'], onDelete: 'CASCADE' })
      const idx = o.indexes.find((i) => i.name === 'orders_status_idx')!
      expect(idx.columns).toEqual(['status', 'ordered_on'])
      expect(idx.unique).toBe(false)
      expect(findTable(snapshot, { schema: engine.schema, name: 'vip_customers' })?.type).toBe('view')
    })

    it('runs multi-statement scripts and reports per-statement outcomes', async () => {
      const script = engine.id === 'mssql' ? 'SELECT 1 AS a\nGO\nSELECT 2 AS b, 3 AS c\nGO\nSELECT * FROM nope' : 'SELECT 1 AS a; SELECT 2 AS b, 3 AS c; SELECT * FROM nope'
      const outcomes = await svc.runScript(id, script, { continueOnError: true })
      expect(outcomes).toHaveLength(3)
      expect(outcomes[0]!.results![0]!.rows).toEqual([[1]])
      expect(outcomes[1]!.results![0]!.fields.map((f) => f.name)).toEqual(['b', 'c'])
      expect(outcomes[2]!.error?.message).toMatch(/nope/i)
    })

    it('truncates large results at maxRows', async () => {
      const [outcome] = await svc.runScript(id, `SELECT * FROM ${svc.qualifiedName(id, orders)}`, { maxRows: 25 })
      const result = outcome!.results![0]!
      expect(result.rows).toHaveLength(25)
      expect(result.truncated).toBe(true)
      // The connection stays usable after stopping early.
      const [again] = await svc.runScript(id, 'SELECT 42 AS answer')
      expect(again!.results![0]!.rows).toEqual([[42]])
    })

    it('reports affected rows for DML', async () => {
      const [outcome] = await svc.runScript(id, `UPDATE ${svc.qualifiedName(id, orders)} SET status = 'paid' WHERE status = 'paid'`)
      expect(outcome!.error).toBeUndefined()
      expect(outcome!.results!.at(-1)!.affectedRows).toBe(60)
    })

    it('fetches a filtered, sorted page and counts it', async () => {
      const filter = {
        kind: 'group' as const,
        id: 'g',
        combinator: 'and' as const,
        children: [
          { kind: 'condition' as const, id: 'a', column: 'status', operator: 'eq' as const, value: 'paid' },
          { kind: 'condition' as const, id: 'b', column: 'total', operator: 'gte' as const, value: '1000' },
        ],
      }
      const page = await svc.fetchTable(id, { table: orders, filter, sort: [{ column: 'total', direction: 'desc' }], limit: 5, offset: 2 })
      expect(page.result.rows).toHaveLength(5)
      const totalIdx = page.result.fields.findIndex((f) => f.name === 'total')
      const totals = page.result.rows.map((r) => Number(r[totalIdx]))
      expect(totals).toEqual([...totals].sort((a, b) => b - a))
      expect(totals[0]).toBe(1218)
      expect(await svc.countTable(id, { table: orders, filter })).toBe(13)
    })

    it('filters with escaped LIKE patterns and unicode', async () => {
      const page = await svc.fetchTable(id, {
        table: customers,
        filter: { kind: 'condition', id: 'x', column: 'name', operator: 'contains', value: '50%_' },
        limit: 10,
      })
      expect(page.result.rows).toHaveLength(1)
      const nameIdx = page.result.fields.findIndex((f) => f.name === 'name')
      expect(page.result.rows[0]![nameIdx]).toBe('Čeněk 50%_off')
    })

    it('applies inserts, updates and deletes atomically', async () => {
      const affected = await svc.applyChanges(id, customers, [
        { type: 'insert', values: { name: 'Dana', email: 'dana@example.com' } },
        { type: 'update', key: { id: 2 }, values: { name: 'Bobby', vip: true } },
      ])
      expect(affected).toEqual([1, 1])
      await expect(
        svc.applyChanges(id, customers, [
          { type: 'update', key: { id: 1 }, values: { name: 'Should roll back' } },
          { type: 'insert', values: { name: 'Dup', email: 'dana@example.com' } },
        ]),
      ).rejects.toThrow()
      const [check] = await svc.runScript(id, `SELECT name FROM ${svc.qualifiedName(id, customers)} WHERE id = 1`)
      expect(check!.results![0]!.rows).toEqual([['Alice']])
      const deleted = await svc.applyChanges(id, customers, [{ type: 'delete', key: { email: 'dana@example.com' } }])
      expect(deleted).toEqual([1])
    })

    it('keeps transactions open across executions within a session', async () => {
      const t = svc.qualifiedName(id, customers)
      const begin = engine.id === 'mssql' ? 'BEGIN TRANSACTION' : 'BEGIN'
      await svc.runScript(id, begin, { session: 's1' })
      await svc.runScript(id, `UPDATE ${t} SET name = 'Temp' WHERE id = 3`, { session: 's1' })
      const [inside] = await svc.runScript(id, `SELECT name FROM ${t} WHERE id = 3`, { session: 's1' })
      expect(inside!.results![0]!.rows).toEqual([['Temp']])
      await svc.runScript(id, 'ROLLBACK', { session: 's1' })
      const [after] = await svc.runScript(id, `SELECT name FROM ${t} WHERE id = 3`, { session: 's1' })
      expect(after!.results![0]!.rows).toEqual([['Čeněk 50%_off']])
      await svc.releaseSession(id, 's1')
    })

    it('cancels a running query', async () => {
      const controller = new AbortController()
      const started = Date.now()
      setTimeout(() => controller.abort(), 700)
      const [outcome] = await svc.runScript(id, engine.sleep, { signal: controller.signal })
      expect(outcome!.error?.message).toMatch(/cancel/i)
      expect(Date.now() - started).toBeLessThan(10_000)
      const [again] = await svc.runScript(id, 'SELECT 1 AS ok')
      expect(again!.results![0]!.rows).toEqual([[1]])
    })

    it('enforces read-only connections', async () => {
      const ro = new DatabaseService()
      await ro.connect({ ...config, id: 'ro', readOnly: true })
      try {
        const [select] = await ro.runScript('ro', `SELECT count(*) FROM ${ro.qualifiedName('ro', customers)}`)
        expect(select!.error).toBeUndefined()
        const [del] = await ro.runScript('ro', `DELETE FROM ${ro.qualifiedName('ro', customers)}`)
        expect(del!.error?.message).toMatch(/read-only/i)
        await expect(ro.applyChanges('ro', customers, [{ type: 'delete', key: { id: 1 } }])).rejects.toThrow(/read-only/i)
      } finally {
        await ro.disconnectAll()
      }
    })

    it('normalizes values for transport', async () => {
      const page = await svc.fetchTable(id, { table: customers, sort: [{ column: 'id', direction: 'asc' }], limit: 1 })
      const row = page.result.rows[0]!
      const get = (name: string) => row[page.result.fields.findIndex((f) => f.name === name)]
      expect(typeof get('created_at')).toBe('string')
      expect(String(get('meta'))).toContain('gold')
      expect(() => structuredClone(page)).not.toThrow()
    })
  })
}
