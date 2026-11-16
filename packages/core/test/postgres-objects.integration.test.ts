import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseService, findTableOrPartition, objectDefinition, rowKey, tableDefinition, type SchemaSnapshot } from '../src/index.js'
import { engines, skip } from './fixtures.js'

/**
 * What the PostgreSQL explorer shows besides tables and routines: partitions under their parent, triggers, row-level
 * security, sequences, types and extensions — and a table definition that re-creates all of it. Requires `npm run db:up`.
 */
const pg = engines.find((e) => e.id === 'postgres')!
const db = new DatabaseService()
const id = 'pg-objects'

const setup = `
DROP SCHEMA IF EXISTS dbm_obj CASCADE;
CREATE SCHEMA dbm_obj;
CREATE EXTENSION "uuid-ossp" SCHEMA dbm_obj;
CREATE TYPE dbm_obj.mood AS ENUM ('ok', 'it''s fine', 'bad');
CREATE DOMAIN dbm_obj.positive AS integer NOT NULL CONSTRAINT positive_check CHECK (VALUE > 0);
CREATE TYPE dbm_obj.money_pair AS (amount numeric(12,2), currency text);
CREATE SEQUENCE dbm_obj.invoice_no START WITH 1000 INCREMENT BY 5;
CREATE TABLE dbm_obj.events (
  id bigint GENERATED ALWAYS AS IDENTITY,
  happened date NOT NULL,
  region text NOT NULL,
  seq serial,
  mood dbm_obj.mood,
  PRIMARY KEY (id, happened, region)
) PARTITION BY RANGE (happened);
CREATE TABLE dbm_obj.events_2026 PARTITION OF dbm_obj.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01') PARTITION BY LIST (region);
CREATE TABLE dbm_obj.events_2026_eu PARTITION OF dbm_obj.events_2026 FOR VALUES IN ('eu');
CREATE TABLE dbm_obj.events_old PARTITION OF dbm_obj.events DEFAULT;
CREATE FUNCTION dbm_obj.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.code := lower(NEW.code); RETURN NEW; END$$;
CREATE TABLE dbm_obj.notes (code text NOT NULL, body text, owner text);
CREATE UNIQUE INDEX notes_code ON dbm_obj.notes (code);
CREATE TRIGGER notes_touch BEFORE INSERT OR UPDATE ON dbm_obj.notes FOR EACH ROW EXECUTE FUNCTION dbm_obj.touch();
ALTER TABLE dbm_obj.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY own_notes ON dbm_obj.notes FOR SELECT TO PUBLIC USING (owner = current_user);
INSERT INTO dbm_obj.notes VALUES ('a', 'first', 'postgres');
INSERT INTO dbm_obj.events (happened, region) VALUES ('2026-03-01', 'eu');
`

describe.skipIf(skip.has('postgres'))('PostgreSQL objects in the explorer', () => {
  let snapshot: SchemaSnapshot
  beforeAll(async () => {
    await db.connect({ ...pg.config, id })
    const out = await db.runScript(id, setup)
    expect(out.filter((o) => o.error).map((o) => `${o.sql}\n→ ${o.error?.message}`)).toEqual([])
    snapshot = await db.schema(id, true)
  })
  afterAll(async () => {
    await db.runScript(id, 'DROP SCHEMA IF EXISTS dbm_obj CASCADE').catch(() => {})
    await db.disconnect(id).catch(() => {})
  })

  it('partitions sit under their parent, nested ones under theirs; they are no tables of their own', () => {
    const events = snapshot.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'events')!
    expect(events.partitionBy).toBe('RANGE (happened)')
    expect(events.partitions?.map((p) => [p.name, p.bound])).toEqual([
      ['events_2026', "FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')"],
      ['events_old', 'DEFAULT'],
    ])
    expect(events.partitions?.[0]?.partitionBy).toBe('LIST (region)')
    expect(events.partitions?.[0]?.partitions?.map((p) => p.name)).toEqual(['events_2026_eu'])
    expect(snapshot.tables.some((t) => t.name.startsWith('events_'))).toBe(false)
    // A partition's data tab: the parent's columns and key.
    const eu = findTableOrPartition(snapshot, { schema: 'dbm_obj', name: 'events_2026_eu' })!
    expect(eu.name).toBe('events_2026_eu')
    expect(eu.primaryKey).toEqual(['id', 'happened', 'region'])
  })

  it('sequences, types and extensions, with definitions that run', async () => {
    const mine = (snapshot.objects ?? []).filter((o) => o.schema === 'dbm_obj').map((o) => `${o.kind} ${o.name} (${o.detail})`)
    expect(mine).toEqual(
      expect.arrayContaining(['sequence invoice_no (bigint)', 'sequence events_seq_seq (integer)', 'type mood (enum)', 'type positive (domain)', 'type money_pair (composite)', expect.stringMatching(/^extension uuid-ossp \(/)]),
    )
    // The identity column's sequence belongs to the column; the extension's own objects to the extension.
    expect(mine.some((o) => o.includes('events_id_seq'))).toBe(false)
    const def = async (kind: 'sequence' | 'type', name: string) => (await objectDefinition(db, id, { schema: 'dbm_obj', name, kind })).sql
    expect(await def('type', 'mood')).toContain("AS ENUM ('ok', 'it''s fine', 'bad')")
    expect(await def('type', 'positive')).toContain('CONSTRAINT positive_check CHECK (VALUE > 0)')
    expect(await def('sequence', 'invoice_no')).toMatch(/START WITH 1000 CACHE 1 NO CYCLE/)
    expect(await def('sequence', 'events_seq_seq')).toContain('OWNED BY dbm_obj.events.seq')
    // Dropped and run again from their definitions.
    for (const [kind, name, drop] of [
      ['sequence', 'invoice_no', 'DROP SEQUENCE dbm_obj.invoice_no'],
      ['type', 'money_pair', 'DROP TYPE dbm_obj.money_pair'],
    ] as const) {
      const sql = await def(kind, name)
      const out = await db.runScript(id, `${drop};\n${sql}`)
      expect(out.filter((o) => o.error).map((o) => o.error?.message)).toEqual([])
    }
  })

  it("a table's definition re-creates its partitions, triggers and row-level security", async () => {
    const events = snapshot.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'events')!
    const notes = snapshot.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'notes')!
    expect(notes.triggers?.map((t) => t.name)).toEqual(['notes_touch'])
    expect(notes.rowSecurity).toBe(true)
    expect(notes.policies?.[0]?.definition).toContain('AS PERMISSIVE FOR SELECT TO public')
    const eventsSql = tableDefinition(events, 'postgres')
    expect(eventsSql).toContain(') PARTITION BY RANGE (happened)')
    expect(eventsSql).toContain(`CREATE TABLE "dbm_obj"."events_2026_eu" PARTITION OF "dbm_obj"."events_2026" FOR VALUES IN ('eu');`)
    for (const [sql, drop] of [
      [eventsSql, 'DROP TABLE dbm_obj.events'],
      [tableDefinition(notes, 'postgres'), 'DROP TABLE dbm_obj.notes'],
    ]) {
      const out = await db.runScript(id, `${drop};\n${sql}`)
      expect(out.filter((o) => o.error).map((o) => `${o.sql}\n→ ${o.error?.message}`)).toEqual([])
    }
    const again = await db.schema(id, true)
    const notes2 = again.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'notes')!
    expect(notes2.triggers?.map((t) => t.definition)).toEqual(notes.triggers?.map((t) => t.definition))
    expect(notes2.policies).toEqual(notes.policies)
    const events2 = again.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'events')!
    expect(JSON.stringify(events2.partitions)).toBe(JSON.stringify(events.partitions))
  })

  it('a table without a primary key is edited through its unique index', async () => {
    const notes = snapshot.tables.find((t) => t.schema === 'dbm_obj' && t.name === 'notes')!
    expect(notes.primaryKey).toEqual([])
    expect(rowKey(notes)).toEqual(['code'])
    await db.runScript(id, "INSERT INTO dbm_obj.notes VALUES ('b', 'second', 'postgres')")
    const affected = await db.applyChanges(id, { schema: 'dbm_obj', name: 'notes' }, [{ type: 'update', key: { code: 'b' }, values: { body: 'changed' } }])
    expect(affected).toEqual([1])
    const [r] = await db.runScript(id, "SELECT body FROM dbm_obj.notes WHERE code = 'b'")
    expect(r?.results?.[0]?.rows).toEqual([['changed']])
  })
})
