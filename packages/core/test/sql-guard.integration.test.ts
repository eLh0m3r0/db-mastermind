import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { compareSchemas, createScript, DatabaseService, getDialect, type ConnectionConfig, type DriverId, type TableInfo } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

/**
 * Wave 6: the script guard must never leave out legitimate SQL. Each engine gets a schema with what people really
 * have (casts, nextval, arrays and JSON, E'' and dollar quotes, checks with comments, computed columns, expression
 * and partial indexes, MySQL backslash defaults, ON UPDATE, enum values with quotes, SQL Server N'' and brackets,
 * Oracle q'' and virtual columns). It is read through the driver, scripted again for the same engine and for
 * PostgreSQL, run, and read back: the same tables, and not one `Left out` line.
 */
const svc = new DatabaseService()
afterAll(async () => {
  await svc.disconnectAll()
  rmSync(tmp, { recursive: true, force: true })
})

const ORACLE: ConnectionConfig = { id: 'ora-guard', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }

const SCHEMAS: Partial<Record<DriverId, { drop: string[]; create: string[] }>> = {
  postgres: {
    drop: ['DROP TABLE IF EXISTS gsrc_t, gdst_t CASCADE', 'DROP SEQUENCE IF EXISTS gsrc_seq'],
    create: [
      'CREATE SEQUENCE gsrc_seq',
      `CREATE TABLE gsrc_t (
        id int DEFAULT nextval('gsrc_seq'::regclass) PRIMARY KEY,
        tags text[] DEFAULT ARRAY['a', 'b']::text[],
        doc jsonb DEFAULT '{"a": 1}'::jsonb,
        e text DEFAULT E'it\\'s',
        d text DEFAULT $$dollar 'quoted'$$,
        code text CHECK (code ~ '^[a-z\\d]+$'),
        price numeric CHECK (price > 0 -- positive
          AND price < 1000 /* a cap */),
        total numeric GENERATED ALWAYS AS (price * 2) STORED,
        name text COLLATE "C"
      )`,
      'CREATE INDEX gsrc_lower ON gsrc_t (lower(name) text_pattern_ops)',
      'CREATE INDEX gsrc_part ON gsrc_t (code) WHERE price > 10',
    ],
  },
  mysql: {
    drop: ['DROP TABLE IF EXISTS gsrc_t', 'DROP TABLE IF EXISTS gdst_t'],
    create: [
      `CREATE TABLE gsrc_t (
        id int NOT NULL AUTO_INCREMENT PRIMARY KEY,
        path varchar(50) DEFAULT 'C:\\\\tmp',
        code varchar(10) CHECK (code REGEXP '^\\\\d+$'),
        updated timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        kind enum('it''s', 'b\\\\c') DEFAULT 'it''s',
        doc json,
        qty int,
        total int GENERATED ALWAYS AS (qty * 2) VIRTUAL,
        KEY gsrc_lower ((lower(code)))
      )`,
    ],
  },
  mssql: {
    drop: ['DROP TABLE IF EXISTS dbo.gsrc_t', 'DROP TABLE IF EXISTS dbo.gdst_t'],
    create: [
      `CREATE TABLE dbo.gsrc_t (
        id int IDENTITY(1,1) PRIMARY KEY,
        [we]]ird] nvarchar(10) DEFAULT (N'x'),
        created datetime DEFAULT (getdate()),
        note nvarchar(20) DEFAULT ('it''s'),
        price int,
        qty int,
        total AS ([price]*[qty]),
        CONSTRAINT gsrc_ck CHECK (price > 0 /* /* nested */ */)
      )`,
    ],
  },
  oracle: {
    drop: ["BEGIN EXECUTE IMMEDIATE 'DROP TABLE gsrc_t'; EXCEPTION WHEN OTHERS THEN NULL; END;", "BEGIN EXECUTE IMMEDIATE 'DROP TABLE gdst_t'; EXCEPTION WHEN OTHERS THEN NULL; END;"],
    create: ["CREATE TABLE gsrc_t (id NUMBER(10) PRIMARY KEY, created DATE DEFAULT SYSDATE, note VARCHAR2(20) DEFAULT q'[it's]', price NUMBER, total NUMBER GENERATED ALWAYS AS (price * 2) VIRTUAL)"],
  },
  sqlite: {
    drop: ['DROP TABLE IF EXISTS gsrc_t', 'DROP TABLE IF EXISTS gdst_t'],
    create: [`CREATE TABLE gsrc_t (id INTEGER PRIMARY KEY, created TEXT DEFAULT (datetime('now')), "na""me" TEXT DEFAULT 'it''s', code TEXT CHECK (code GLOB '[a-z]*'))`],
  },
  duckdb: {
    drop: ['DROP TABLE IF EXISTS gsrc_t', 'DROP TABLE IF EXISTS gdst_t'],
    create: [`CREATE TABLE gsrc_t (id INTEGER PRIMARY KEY, d VARCHAR DEFAULT 'it''s', tags VARCHAR[] DEFAULT ['a', 'b'], code VARCHAR CHECK (code ~ '^[a-z]+$'))`],
  },
}
// MariaDB has no functional key parts.
SCHEMAS.mariadb = { drop: SCHEMAS.mysql!.drop, create: SCHEMAS.mysql!.create.map((s) => s.replace(/,\s*KEY gsrc_lower \(\(lower\(code\)\)\)/, '').replace('doc json,', 'doc longtext,')) }

/** The source tables as the target ones: names (and the names of their keys and indexes) start gdst_ (in their case). */
const swap = (name: string) => name.replace(/gsrc_/g, 'gdst_').replace(/GSRC_/g, 'GDST_')
const renamed = (tables: TableInfo[]) =>
  tables.map((t) => ({
    ...t,
    name: swap(t.name),
    indexes: t.indexes.map((i) => ({ ...i, name: swap(i.name), ...(i.definition ? { definition: swap(i.definition) } : {}) })),
    ...(t.checks ? { checks: t.checks.map((c) => ({ ...c, ...(c.name ? { name: swap(c.name) } : {}) })) } : {}),
  }))

const leftOut = (script: string) => script.split('\n').filter((l) => /Left out/.test(l))

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb'] as DriverId[]) {
  describe.skipIf(skip.has(driver))(`a real ${driver} schema scripted again`, () => {
    it('comes back the same, and nothing is left out', { timeout: 300_000 }, async () => {
      const engine = engines.find((e) => e.id === driver)
      let id: string
      if (driver === 'oracle') {
        await svc.connect(ORACLE)
        id = ORACLE.id
      } else id = (await setupEngine(svc, engine!)).id
      const run = async (sql: string) => {
        const outcomes = await svc.runScript(id, sql, { readOnly: false })
        return outcomes.filter((o) => o.error).map((o) => `${o.error!.message} | ${o.sql.slice(0, 160)}`)
      }
      for (const sql of SCHEMAS[driver]!.drop) await run(sql)
      for (const sql of SCHEMAS[driver]!.create) expect(await run(sql), sql).toEqual([])
      // (Only the engine's own schema: PostgreSQL also holds what the other engines' runs made there.)
      const read = (await svc.schema(id, true)).tables.filter((t) => /^gsrc_t$/i.test(t.name) && (driver !== 'postgres' || t.schema === 'public'))
      expect(read.length).toBe(1)
      const target = renamed(read)
      const script = createScript(target, getDialect(driver))
      expect(leftOut(script), script).toEqual([])
      expect(await run(script), script).toEqual([])
      const back = (await svc.schema(id, true)).tables.filter((t) => t.name === target[0]!.name && t.schema === target[0]!.schema)
      const changes = compareSchemas(target, back, { driver })
      expect(changes.map((c) => `${c.kind} ${'column' in c ? String(c.column) : ''}`), script).toEqual([])
      for (const sql of SCHEMAS[driver]!.drop) await run(sql)

      // The same tables for PostgreSQL: whatever has a clear meaning there is written, not left out.
      if (driver !== 'postgres' && !skip.has('postgres')) {
        const pg = await setupEngine(svc, engines.find((e) => e.id === 'postgres')!)
        const forPg = createScript(target.map((t) => ({ ...t, schema: 'public' })), getDialect('postgres'), { translateTypes: true, from: driver })
        const lines = leftOut(forPg)
        console.log(`${driver} → PostgreSQL: ${lines.length} Left out lines${lines.length ? `: ${lines.join(' | ').slice(0, 400)}` : ''}`)
        const dropPg = `DROP TABLE IF EXISTS "public"."${target[0]!.name}" CASCADE`
        await svc.runScript(pg.id, dropPg, { readOnly: false })
        const errors = (await svc.runScript(pg.id, forPg, { readOnly: false })).filter((o) => o.error).map((o) => o.error!.message)
        console.log(`${driver} → PostgreSQL: ${errors.length} statements failed${errors.length ? `: ${errors.join(' | ').slice(0, 400)}` : ''}`)
        await svc.runScript(pg.id, dropPg, { readOnly: false })
      }
    })
  })
}
