import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createScript, DatabaseService, getDialect, tableDefinition } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * PostgreSQL indexes beyond plain columns: "Definition (SQL)" printed CREATE INDEX … ("lower(email)") and lost WHERE,
 * DESC, INCLUDE and USING gin. Requires `npm run db:up`.
 */
const pg = engines.find((e) => e.id === 'postgres')!
const db = new DatabaseService()
const id = 'pg-indexes'

describe.skipIf(skip.has('postgres'))('PostgreSQL index definitions', () => {
  beforeAll(async () => {
    await db.connect({ ...pg.config, id })
    const out = await db.runScript(
      id,
      `DROP SCHEMA IF EXISTS dbm_ix CASCADE; DROP SCHEMA IF EXISTS dbm_ix_copy CASCADE;
       CREATE SCHEMA dbm_ix; CREATE SCHEMA dbm_ix_copy;
       CREATE TABLE dbm_ix.people (id int PRIMARY KEY, email text, "Nick" text, active boolean, tags text[], created timestamptz);
       CREATE INDEX people_lower ON dbm_ix.people (lower(email));
       CREATE UNIQUE INDEX people_active ON dbm_ix.people (created DESC, "Nick") INCLUDE (email) WHERE active;
       CREATE INDEX people_tags ON dbm_ix.people USING gin (tags);
       CREATE INDEX "People Nick" ON dbm_ix.people ("Nick");`,
    )
    expect(out.filter((o) => o.error)).toEqual([])
  })
  afterAll(async () => {
    await db.runScript(id, 'DROP SCHEMA IF EXISTS dbm_ix CASCADE; DROP SCHEMA IF EXISTS dbm_ix_copy CASCADE').catch(() => {})
    await db.disconnect(id).catch(() => {})
  })

  it("the table's definition creates the indexes the server has", async () => {
    const snapshot = await db.schema(id, true)
    const people = snapshot.tables.find((t) => t.schema === 'dbm_ix' && t.name === 'people')!
    expect(people.indexes.find((i) => i.name === 'People Nick')?.columns).toEqual(['Nick'])
    const sql = tableDefinition(people, 'postgres')
    expect(sql).toContain('CREATE INDEX people_lower ON dbm_ix.people USING btree (lower(email))')
    expect(sql).toContain('CREATE UNIQUE INDEX people_active ON dbm_ix.people USING btree (created DESC, "Nick") INCLUDE (email) WHERE active')
    expect(sql).toContain('CREATE INDEX people_tags ON dbm_ix.people USING gin (tags)')
    expect(sql).toContain('CREATE INDEX "People Nick" ON dbm_ix.people USING btree ("Nick")')
    expect(sql).toMatch(/CONSTRAINT "?people_pkey"? PRIMARY KEY/)
  })

  it('the same table elsewhere gets indexes that run (expressions are not quoted as names)', async () => {
    const snapshot = await db.schema(id, true)
    const people = snapshot.tables.find((t) => t.schema === 'dbm_ix' && t.name === 'people')!
    const script = createScript([{ ...people, schema: 'dbm_ix_copy' }], getDialect('postgres'))
    expect(script).not.toContain('"lower(email)"')
    const out = await db.runScript(id, script)
    expect(out.filter((o) => o.error).map((o) => o.error?.message)).toEqual([])
    const copy = (await db.schema(id, true)).tables.find((t) => t.schema === 'dbm_ix_copy' && t.name === 'people')!
    // (A copy names its primary key itself.)
    const names = (t: typeof people) => t.indexes.filter((i) => !i.primary).map((i) => i.name).sort()
    expect(names(copy)).toEqual(names(people))
  })
})
