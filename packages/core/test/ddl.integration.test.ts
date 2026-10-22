import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DatabaseService,
  designId,
  diffTables,
  findTable,
  generateMigration,
  getDialect,
  migrationScript,
  toDesignTable,
  type DesignTable,
} from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const TYPES: Record<string, { text150: string; money: string; note: string; int: string }> = {
  postgres: { text150: 'varchar(150)', money: 'numeric(12,2)', note: 'varchar(200)', int: 'integer' },
  mysql: { text150: 'varchar(150)', money: 'decimal(12,2)', note: 'varchar(200)', int: 'int' },
  mariadb: { text150: 'varchar(150)', money: 'decimal(12,2)', note: 'varchar(200)', int: 'int' },
  mssql: { text150: 'nvarchar(150)', money: 'decimal(12,2)', note: 'nvarchar(200)', int: 'int' },
  sqlite: { text150: 'VARCHAR(150)', money: 'NUMERIC', note: 'TEXT', int: 'INTEGER' },
}

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`schema migrations on ${engine.id}`, () => {
    it('designs changes on a live schema and applies the generated migration', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const types = TYPES[engine.id]!
        const snapshot = await svc.schema(config.id, true)
        const customers = findTable(snapshot, { schema: engine.schema, name: 'customers' })!
        const orders = findTable(snapshot, { schema: engine.schema, name: 'orders' })!

        // Edit customers: rename email, retype name, add phone.
        const draftCustomers = toDesignTable(customers)
        draftCustomers.columns = draftCustomers.columns.map((c) =>
          c.name === 'email' ? { ...c, name: 'email_address' } : c.name === 'name' ? { ...c, dataType: types.text150 } : c,
        )
        draftCustomers.columns.push({ id: designId(), name: 'phone', dataType: types.note, nullable: true })

        // Edit orders: index on ordered_on.
        const draftOrders = toDesignTable(orders)
        draftOrders.indexes.push({ id: designId(), name: 'ix_orders_ordered_on', columns: ['ordered_on'], unique: false })

        // New table referencing orders.
        const payments: DesignTable = {
          id: designId(),
          schema: engine.schema,
          name: 'payments',
          columns: [
            { id: designId(), name: 'id', dataType: types.int, nullable: false, identity: true },
            { id: designId(), name: 'order_id', dataType: engine.id === 'sqlite' ? 'INTEGER' : 'bigint', nullable: false },
            { id: designId(), name: 'amount', dataType: types.money, nullable: false },
            { id: designId(), name: 'note', dataType: types.note, nullable: true, comment: engine.id === 'sqlite' ? null : 'Free text' },
          ],
          primaryKey: ['id'],
          foreignKeys: [{ id: designId(), columns: ['order_id'], refSchema: engine.schema, refTable: 'orders', refColumns: ['id'], onDelete: 'CASCADE' }],
          indexes: [{ id: designId(), columns: ['order_id'], unique: false }],
        }

        const changes = diffTables(snapshot.tables, [draftCustomers, draftOrders, payments])
        expect(changes.map((c) => c.kind)).toEqual(
          expect.arrayContaining(['create_table', 'rename_column', 'alter_column', 'add_column', 'add_index']),
        )
        const migration = generateMigration(changes, getDialect(engine.id), snapshot.tables)
        if (engine.id !== 'sqlite' && engine.id !== 'mssql') {
          expect(migration.warnings.some((w) => /may fail or truncate/.test(w.message))).toBe(engine.id === 'postgres')
        }
        const script = migrationScript(migration, getDialect(engine.id))
        const outcomes = await svc.runScript(config.id, script)
        const failed = outcomes.find((o) => o.error)
        expect(failed?.error?.message, failed?.sql).toBeUndefined()

        const after = await svc.schema(config.id, true)
        const c2 = findTable(after, { schema: engine.schema, name: 'customers' })!
        expect(c2.columns.map((c) => c.name)).toEqual(expect.arrayContaining(['email_address', 'phone']))
        expect(c2.columns.map((c) => c.name)).not.toContain('email')
        expect(c2.columns.find((c) => c.name === 'name')!.dataType.toLowerCase()).toContain('150')
        const p = findTable(after, { schema: engine.schema, name: 'payments' })!
        expect(p.primaryKey).toEqual(['id'])
        expect(p.foreignKeys[0]).toMatchObject({ columns: ['order_id'], refTable: 'orders' })
        expect(findTable(after, { schema: engine.schema, name: 'orders' })!.indexes.map((i) => i.name)).toContain('ix_orders_ordered_on')

        // Data survived the migration (including SQLite table rebuilds).
        const [count] = await svc.runScript(config.id, `SELECT COUNT(*) FROM ${svc.qualifiedName(config.id, { schema: engine.schema, name: 'customers' })}`)
        expect(Number(count!.results![0]!.rows[0]![0])).toBe(3)

        // Diffing the new schema against itself yields nothing.
        expect(diffTables(after.tables, after.tables.map(toDesignTable))).toEqual([])

        // Clean up so other suites start fresh.
        await svc.runScript(config.id, `DROP TABLE ${svc.qualifiedName(config.id, { schema: engine.schema, name: 'payments' })}`)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}
