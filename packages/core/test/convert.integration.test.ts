import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createScript, DatabaseService, getDialect, type TableInfo } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const pg = engines.find((e) => e.id === 'postgres')!

/** The PostgreSQL shop tables renamed (conv_*) into the target's schema, so they don't clash with the fixture. */
function retarget(tables: TableInfo[], schema: string | undefined): TableInfo[] {
  const rename = (n: string) => `conv_${n}`
  return tables.map((t) => ({
    ...t,
    schema,
    name: rename(t.name),
    indexes: t.indexes.map((i) => ({ ...i, name: rename(i.name) })),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, name: rename(f.name), refSchema: schema, refTable: rename(f.refTable) })),
  }))
}

for (const target of engines.filter((e) => e.id !== 'postgres')) {
  describe.skipIf(skip.has('postgres') || skip.has(target.id))(`PostgreSQL schema as ${target.id} DDL`, () => {
    it('runs on the target database', async () => {
      const svc = new DatabaseService()
      try {
        const source = await setupEngine(svc, pg)
        const snapshot = await svc.schema(source.id, true)
        const tables = snapshot.tables.filter((t) => t.schema === 'shop' && t.type === 'table')
        const config = await setupEngine(svc, target)
        const schema = target.id === 'mssql' ? 'shop' : undefined
        const drop = retarget(tables, schema)
          .reverse()
          .map((t) => `DROP TABLE IF EXISTS ${svc.qualifiedName(config.id, t)}`)
        for (const sql of drop) await svc.runScript(config.id, sql)
        const script = createScript(retarget(tables, schema), getDialect(target.id), { translateTypes: true })
        const outcomes = await svc.runScript(config.id, script)
        const failed = outcomes.find((o) => o.error)
        expect(failed?.error?.message, `${failed?.sql}\n\n${script}`).toBeUndefined()
        const after = await svc.schema(config.id, true)
        const orders = after.tables.find((t) => t.name === 'conv_orders')!
        expect(orders.foreignKeys[0]?.refTable).toBe('conv_customers')
        for (const sql of drop) await svc.runScript(config.id, sql)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}

// A MySQL model's UNSIGNED and ZEROFILL numbers as every other engine's DDL (review M7): each runs there.
const UNSIGNED: TableInfo[] = [
  {
    name: 'conv_numbers',
    type: 'table',
    columns: ['int unsigned', 'bigint unsigned', 'smallint unsigned zerofill', 'decimal(10,2) unsigned', 'float unsigned', 'double unsigned zerofill', 'numeric(5) unsigned'].map((dataType, i) => ({ name: `c${i}`, ordinal: i + 1, dataType, nullable: i > 0, defaultValue: null, isPrimaryKey: i === 0, isIdentity: false, comment: null })),
    primaryKey: ['c0'],
    foreignKeys: [],
    indexes: [{ name: 'conv_numbers_pk', columns: ['c0'], unique: true, primary: true }],
  },
]
for (const target of engines.filter((e) => e.id !== 'mysql' && e.id !== 'mariadb')) {
  describe.skipIf(skip.has(target.id))(`MySQL UNSIGNED as ${target.id} DDL`, () => {
    it('runs on the target database', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, target)
        const tables = UNSIGNED.map((t) => ({ ...t, schema: target.id === 'mssql' ? 'shop' : undefined }))
        const drop = `DROP TABLE IF EXISTS ${svc.qualifiedName(config.id, tables[0]!)}`
        await svc.runScript(config.id, drop)
        const script = createScript(tables, getDialect(target.id), { translateTypes: true, from: 'mysql' })
        expect(script).not.toMatch(/unsigned|zerofill/i)
        const outcomes = await svc.runScript(config.id, script)
        const failed = outcomes.find((o) => o.error)
        expect(failed?.error?.message, `${failed?.sql}\n\n${script}`).toBeUndefined()
        await svc.runScript(config.id, drop)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}
