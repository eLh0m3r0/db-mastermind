import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { createScript, DatabaseService, getDialect, type DriverId, type IndexInfo, type TableInfo } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

/**
 * Indexes the column list can't describe — expressions, prefixes, WHERE, INCLUDE, DESC, FULLTEXT — keep the
 * server's own CREATE INDEX: dropped and re-created from it, the index is the same; a copy of the table elsewhere
 * still gets indexes that run. (PostgreSQL in detail: postgres-indexes.integration.test.ts.) Requires `npm run db:up`.
 */
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

interface Case {
  setup: string[]
  /** The table as the snapshot names it, and where its copy goes. */
  table: { schema: string; name: string }
  copySchema?: string
  /** Each special index with a piece its definition must keep. */
  expect: Record<string, RegExp>
  drop: (index: string) => string
}

const cases: Partial<Record<DriverId, Case>> = {
  mysql: {
    setup: [
      'DROP TABLE IF EXISTS dbm_ix_people',
      'CREATE TABLE dbm_ix_people (id int PRIMARY KEY, email text, nick varchar(50), created datetime, bio text)',
      'CREATE INDEX people_email ON dbm_ix_people (email(20))',
      'CREATE INDEX people_lower ON dbm_ix_people ((lower(nick)))',
      'CREATE INDEX people_recent ON dbm_ix_people (created DESC, nick)',
      'CREATE FULLTEXT INDEX people_bio ON dbm_ix_people (bio)',
    ],
    table: { schema: 'mastermind', name: 'dbm_ix_people' },
    expect: { people_email: /`email`\(20\)/, people_lower: /\(lower\(`nick`\)\)/, people_recent: /`created` DESC, `nick`/, people_bio: /^CREATE FULLTEXT INDEX/ },
    drop: (i) => `DROP INDEX \`${i}\` ON dbm_ix_people`,
  },
  mariadb: {
    setup: [
      'DROP TABLE IF EXISTS dbm_ix_people',
      'CREATE TABLE dbm_ix_people (id int PRIMARY KEY, email text, nick varchar(50), bio text)',
      'CREATE INDEX people_email ON dbm_ix_people (email(20))',
      'CREATE FULLTEXT INDEX people_bio ON dbm_ix_people (bio)',
    ],
    table: { schema: 'mastermind', name: 'dbm_ix_people' },
    expect: { people_email: /`email`\(20\)/, people_bio: /^CREATE FULLTEXT INDEX/ },
    drop: (i) => `DROP INDEX \`${i}\` ON dbm_ix_people`,
  },
  mssql: {
    setup: [
      "IF SCHEMA_ID('dbm_copy') IS NULL EXEC('CREATE SCHEMA dbm_copy')",
      'DROP TABLE IF EXISTS dbm_copy.dbm_ix_people',
      'DROP TABLE IF EXISTS dbo.dbm_ix_people',
      'CREATE TABLE dbo.dbm_ix_people (id int PRIMARY KEY, email nvarchar(200), active bit, created datetime2)',
      'CREATE INDEX people_active ON dbo.dbm_ix_people (created DESC) INCLUDE (email) WHERE active = 1',
    ],
    table: { schema: 'dbo', name: 'dbm_ix_people' },
    copySchema: 'dbm_copy',
    expect: { people_active: /\[created\] DESC\) INCLUDE \(\[email\]\) WHERE \(\[active\]=\(1\)\)/ },
    drop: (i) => `DROP INDEX [${i}] ON dbo.dbm_ix_people`,
  },
  sqlite: {
    setup: [
      'DROP TABLE IF EXISTS dbm_ix_people',
      'CREATE TABLE dbm_ix_people (id integer PRIMARY KEY, email text, active int)',
      'CREATE INDEX people_lower ON dbm_ix_people (lower(email)) WHERE active = 1',
    ],
    table: { schema: 'main', name: 'dbm_ix_people' },
    expect: { people_lower: /\(lower\(email\)\) WHERE active = 1/ },
    drop: (i) => `DROP INDEX ${i}`,
  },
}

for (const engine of engines) {
  const c = cases[engine.id as DriverId]
  if (!c) continue
  describe.skipIf(skip.has(engine.id))(`index definitions on ${engine.id}`, () => {
    it('keep the server’s own CREATE INDEX, and a copy elsewhere still runs', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        for (const sql of c.setup) {
          const [o] = await svc.runScript(config.id, sql)
          expect(o?.error?.message, sql).toBeUndefined()
        }
        const find = async () => (await svc.schema(config.id, true)).tables.find((t) => t.schema === c.table.schema && t.name === c.table.name)!
        const table = await find()
        const byName = (t: TableInfo, n: string) => t.indexes.find((i) => i.name === n) as IndexInfo
        for (const [name, piece] of Object.entries(c.expect)) {
          const ix = byName(table, name)
          expect(ix?.definition, name).toMatch(piece)
          // Dropped and created again from its own text: the same index.
          for (const sql of [c.drop(name), ix.definition!]) {
            const [o] = await svc.runScript(config.id, sql)
            expect(o?.error?.message, sql).toBeUndefined()
          }
          expect(byName(await find(), name).definition).toBe(ix.definition)
        }
        // The table's definition uses that text.
        const script = createScript([table], getDialect(config.driver))
        for (const name of Object.keys(c.expect)) expect(script).toContain(byName(table, name).definition)
        // A copy (another name, or another schema) is generated, and runs.
        const copy: TableInfo = c.copySchema ? { ...table, schema: c.copySchema } : { ...table, name: `${table.name}_copy`, indexes: table.indexes.map((i) => ({ ...i, name: `${i.name}_c` })) }
        await svc.runScript(config.id, `DROP TABLE IF EXISTS ${svc.qualifiedName(config.id, copy)}`)
        const copyScript = createScript([copy], getDialect(config.driver))
        const out = await svc.runScript(config.id, copyScript)
        expect(out.filter((o) => o.error).map((o) => `${o.sql}\n→ ${o.error?.message}`)).toEqual([])
        await svc.runScript(config.id, `DROP TABLE IF EXISTS ${svc.qualifiedName(config.id, copy)}`)
      } finally {
        await svc.disconnectAll()
      }
    }, 60_000)
  })
}
