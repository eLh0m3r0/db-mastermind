import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, objectDefinition, sameType, tableDefinition, type DefinedObject } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

/** Per engine: routines to create, then call through `check` after their definition was run again. */
const ROUTINES: Record<string, { create: string[]; objects: (DefinedObject & { check: string; expect: unknown })[] } | undefined> = {
  postgres: {
    create: [
      `CREATE OR REPLACE FUNCTION shop.add_one(x int) RETURNS int LANGUAGE sql AS $$ SELECT x + 1 $$`,
      // An overload: the explorer lists both, each must open its own text.
      `CREATE OR REPLACE FUNCTION shop.add_one(x numeric) RETURNS numeric LANGUAGE sql AS $$ SELECT x + 1.5 $$`,
      `CREATE OR REPLACE PROCEDURE shop.touch(n int) LANGUAGE plpgsql AS $$ BEGIN PERFORM n; END $$`,
    ],
    objects: [
      { schema: 'shop', name: 'add_one', kind: 'function', arguments: 'x integer', check: 'SELECT shop.add_one(1)', expect: 2 },
      { schema: 'shop', name: 'add_one', kind: 'function', arguments: 'x numeric', check: 'SELECT shop.add_one(1.0)', expect: '2.5' },
      { schema: 'shop', name: 'touch', kind: 'procedure', arguments: 'IN n integer', check: 'CALL shop.touch(1)', expect: undefined },
    ],
  },
  mysql: {
    create: ['DROP FUNCTION IF EXISTS add_one', 'CREATE FUNCTION add_one(x INT) RETURNS INT DETERMINISTIC RETURN x + 1', 'DROP PROCEDURE IF EXISTS touch', 'DELIMITER $$\nCREATE PROCEDURE touch(n INT) BEGIN DECLARE m INT; IF n > 0 THEN SET m = n; END IF; SELECT m; END$$\nDELIMITER ;'],
    objects: [
      { name: 'add_one', kind: 'function', check: 'SELECT add_one(1)', expect: 2 },
      { name: 'touch', kind: 'procedure', check: 'CALL touch(1)', expect: undefined },
    ],
  },
  mssql: {
    create: [
      `IF OBJECT_ID('shop.add_one') IS NOT NULL DROP FUNCTION shop.add_one`,
      `CREATE FUNCTION shop.add_one(@x int) RETURNS int AS BEGIN RETURN @x + 1 END`,
      `IF OBJECT_ID('shop.touch') IS NOT NULL DROP PROCEDURE shop.touch`,
      `-- A comment before the CREATE\nCREATE PROCEDURE shop.touch @n int AS BEGIN SET NOCOUNT ON; SELECT @n AS n; END`,
    ],
    objects: [
      { schema: 'shop', name: 'add_one', kind: 'function', check: 'SELECT shop.add_one(1)', expect: 2 },
      { schema: 'shop', name: 'touch', kind: 'procedure', check: 'EXEC shop.touch 1', expect: 1 },
    ],
  },
  duckdb: {
    create: ['CREATE OR REPLACE MACRO add_one(x) AS x + 1', 'CREATE OR REPLACE MACRO first_customers(n) AS TABLE SELECT * FROM customers ORDER BY id LIMIT n'],
    objects: [
      { schema: 'main', name: 'add_one', kind: 'function', check: 'SELECT add_one(1)', expect: 2 },
      { schema: 'main', name: 'first_customers', kind: 'function', check: 'SELECT count(*) FROM first_customers(2)', expect: 2 },
    ],
  },
}
ROUTINES.mariadb = ROUTINES.mysql

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`object definitions on ${engine.id}`, () => {
    it('gives a view’s definition that runs again and changes the view', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const schema = engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : engine.id === 'mysql' || engine.id === 'mariadb' ? 'mastermind' : 'main'
        const view: DefinedObject = { schema: engine.id === 'sqlite' ? undefined : schema, name: 'vip_customers', kind: 'view' }
        const { sql } = await objectDefinition(svc, config.id, view)
        expect(sql).toMatch(/vip/i)
        // After the view's last mention of vip (however the catalog spells it): the changed view returns nothing.
        const vip = [...sql.matchAll(/[`"[]?vip[`"\]]?(\s*=\s*(1|true))?/gi)].at(-1)!
        const at = vip.index + vip[0].length
        const changed = `${sql.slice(0, at)} AND 1 = 0${sql.slice(at)}`
        expect(changed).not.toBe(sql)
        const outcomes = await svc.runScript(config.id, changed)
        expect(outcomes.filter((o) => o.error).map((o) => o.error!.message)).toEqual([])
        const qualified = svc.qualifiedName(config.id, { schema: view.schema, name: 'vip_customers' })
        const [o] = await svc.runScript(config.id, `SELECT count(*) AS n FROM ${qualified}`)
        expect(Number(o!.results![0]!.rows[0]![0])).toBe(0)
      } finally {
        await svc.disconnectAll()
      }
    })

    const routines = ROUTINES[engine.id]
    it.skipIf(!routines)('gives each routine’s definition, which runs again unchanged', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        for (const sql of routines!.create) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o?.error?.message).toBeUndefined()
        }
        const snapshot = await svc.schema(config.id, true)
        for (const object of routines!.objects) {
          expect(snapshot.routines.some((r) => r.name === object.name && (object.arguments === undefined || r.arguments === object.arguments))).toBe(true)
          const { sql } = await objectDefinition(svc, config.id, object)
          if (engine.id === 'mariadb') {
            // Replaced in one statement: a text that fails leaves the routine (and its grants) in place.
            expect(sql).not.toMatch(/DROP/)
            const broken = await svc.runScript(config.id, sql.replace(/\bRETURN\b|\bSELECT\b/, 'RETURNX'))
            expect(broken.some((o) => o.error)).toBe(true)
            const [still] = await svc.runScript(config.id, object.check)
            expect(still?.error?.message).toBeUndefined()
          }
          const outcomes = await svc.runScript(config.id, sql)
          expect(outcomes.filter((o) => o.error).map((o) => `${o.sql}\n→ ${o.error!.message}`)).toEqual([])
          const [called] = await svc.runScript(config.id, object.check)
          expect(called?.error?.message).toBeUndefined()
          if (object.expect !== undefined) expect(String(called!.results!.at(-1)!.rows[0]![0])).toBe(String(object.expect))
        }
      } finally {
        await svc.disconnectAll()
      }
    })

    it.skipIf(engine.id !== 'postgres')('keeps a PostgreSQL view’s options and check option (review finding)', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const options = async () => {
          const [o] = await svc.runScript(config.id, `SELECT array_to_string(reloptions, ',') FROM pg_class WHERE oid = 'shop.positive_customers'::regclass`)
          return String(o!.results![0]!.rows[0]![0])
        }
        const [made] = await svc.runScript(config.id, 'CREATE OR REPLACE VIEW shop.positive_customers WITH (security_invoker = true, security_barrier = true) AS SELECT id, name FROM shop.customers WHERE id > 0 WITH CASCADED CHECK OPTION')
        expect(made?.error?.message).toBeUndefined()
        const before = await options()
        expect(before).toMatch(/security_invoker=true/)
        const { sql } = await objectDefinition(svc, config.id, { schema: 'shop', name: 'positive_customers', kind: 'view' })
        expect(sql).toMatch(/WITH CASCADED CHECK OPTION;/)
        const outcomes = await svc.runScript(config.id, sql)
        expect(outcomes.filter((o) => o.error).map((o) => o.error!.message)).toEqual([])
        expect(await options()).toBe(before)
        await svc.runScript(config.id, 'DROP VIEW shop.positive_customers')
      } finally {
        await svc.disconnectAll()
      }
    })

    it('generates a table’s CREATE statement that creates the same columns', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const schema = engine.id === 'postgres' || engine.id === 'mssql' ? 'shop' : undefined
        const { sql } = await objectDefinition(svc, config.id, { schema, name: 'customers', kind: 'table' })
        expect(sql.startsWith('-- Generated from the catalog')).toBe(true)
        expect(sql).toMatch(/CREATE TABLE/i)
        expect(sql).toMatch(/email/)
        // The same generator, run: the table made under a scratch schema (database in MySQL, attached file in
        // SQLite) has the same columns, types, NOT NULLs and key (review finding).
        const scratch = 'dbm_scratch'
        const run = async (statement: string) => {
          const outcomes = await svc.runScript(config.id, statement)
          expect(outcomes.filter((o) => o.error).map((o) => `${o.sql}\n→ ${o.error!.message}`)).toEqual([])
        }
        const setup: Record<string, [string[], string[]]> = {
          postgres: [[`DROP SCHEMA IF EXISTS ${scratch} CASCADE`, `CREATE SCHEMA ${scratch}`], [`DROP SCHEMA ${scratch} CASCADE`]],
          mssql: [[`IF OBJECT_ID('${scratch}.customers') IS NOT NULL DROP TABLE ${scratch}.customers`, `IF SCHEMA_ID('${scratch}') IS NULL EXEC('CREATE SCHEMA ${scratch}')`], [`DROP TABLE ${scratch}.customers`, `DROP SCHEMA ${scratch}`]],
          mysql: [[`DROP DATABASE IF EXISTS ${scratch}`, `CREATE DATABASE ${scratch}`], [`DROP DATABASE ${scratch}`]],
          duckdb: [[`DROP SCHEMA IF EXISTS ${scratch} CASCADE`, `CREATE SCHEMA ${scratch}`], [`DROP SCHEMA ${scratch} CASCADE`]],
          sqlite: [[`ATTACH DATABASE ':memory:' AS ${scratch}`], [`DETACH DATABASE ${scratch}`]],
        }
        setup.mariadb = setup.mysql!
        const [before, after] = setup[engine.id]!
        for (const statement of before) await run(statement)
        const original = (await svc.schema(config.id, true)).tables.find((t) => t.name === 'customers' && (schema === undefined || t.schema === schema))!
        await run(tableDefinition({ ...original, schema: scratch }, engine.id))
        const copy = (await svc.driver(config.id).introspect({ schemas: [scratch] })).tables.find((t) => t.schema === scratch && t.name === 'customers')!
        const shape = (t: typeof original) => t.columns.map((c) => [c.name, c.nullable])
        expect(shape(copy)).toEqual(shape(original))
        for (const [i, c] of copy.columns.entries()) expect(sameType(c.dataType, original.columns[i]!.dataType), `${c.name}: ${c.dataType} / ${original.columns[i]!.dataType}`).toBe(true)
        expect(copy.primaryKey).toEqual(original.primaryKey)
        for (const statement of after) await run(statement)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}
