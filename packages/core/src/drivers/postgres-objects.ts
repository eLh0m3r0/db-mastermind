import { postgresDialect, qualify } from '../dialect.js'
import type { PartitionInfo, SchemaObject, TableInfo } from '../types.js'

type Query = <R>(text: string, values?: unknown[]) => Promise<{ rows: R[] }>

const q = (s: string) => postgresDialect.quoteIdent(s)
const name = (schema: string, n: string) => qualify(postgresDialect, { schema, name: n })
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`

/**
 * What the explorer shows besides tables and routines, read from PostgreSQL's catalog: partitions (under their
 * parent), triggers, row-level security policies, sequences, types and extensions. Each part is read on its own: a
 * catalog that lacks one (CockroachDB, an old server) leaves just that part out.
 * `where` filters by `n.nspname` (the schema of the table or object).
 */
export async function readPostgresObjects(query: Query, where: string, params: unknown[], tables: Map<string, TableInfo>, key: (schema: string, name: string) => string): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = []
  const part = async (work: () => Promise<void>) => {
    try {
      await work()
    } catch {
      // Not in this catalog.
    }
  }
  const notFromExtension = (classid: string, oid: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${classid}'::regclass AND d.objid = ${oid} AND d.deptype = 'e')`

  await part(async () => {
    const keys = await query<{ schema: string; name: string; partition_by: string }>(
      `SELECT n.nspname AS schema, c.relname AS name, pg_get_partkeydef(c.oid) AS partition_by
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'p' AND ${where}`,
      params,
    )
    const rows = await query<{ parent_schema: string; parent: string; schema: string; name: string; bound: string; partition_by: string | null }>(
      `SELECT n.nspname AS parent_schema, p.relname AS parent, cn.nspname AS schema, c.relname AS name,
              pg_get_expr(c.relpartbound, c.oid) AS bound,
              CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_by
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_namespace cn ON cn.oid = c.relnamespace
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE c.relispartition AND ${where}
        ORDER BY cn.nspname, c.relname`,
      params,
    )
    for (const k of keys.rows) {
      const t = tables.get(key(k.schema, k.name))
      if (t) t.partitionBy = k.partition_by
    }
    const byName = new Map<string, PartitionInfo>()
    for (const r of rows.rows) byName.set(key(r.schema, r.name), { schema: r.schema, name: r.name, bound: r.bound, ...(r.partition_by ? { partitionBy: r.partition_by } : {}) })
    for (const r of rows.rows) {
      const p = byName.get(key(r.schema, r.name))!
      const parent = tables.get(key(r.parent_schema, r.parent)) ?? byName.get(key(r.parent_schema, r.parent))
      if (parent) (parent.partitions ??= []).push(p)
    }
  })

  await part(async () => {
    const rows = await query<{ schema: string; table: string; name: string; def: string; enabled: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS table, t.tgname AS name, pg_get_triggerdef(t.oid, true) AS def, t.tgenabled <> 'D' AS enabled
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND ${where}
        ORDER BY n.nspname, c.relname, t.tgname`,
      params,
    )
    for (const t of tables.values()) if (t.type === 'table' || t.type === 'view' || t.type === 'foreign_table') t.triggers = []
    for (const r of rows.rows) tables.get(key(r.schema, r.table))?.triggers?.push({ name: r.name, definition: `${r.def};${r.enabled ? '' : `\nALTER TABLE ${name(r.schema, r.table)} DISABLE TRIGGER ${q(r.name)};`}`, enabled: r.enabled })
  })

  await part(async () => {
    const secured = await query<{ schema: string; table: string }>(
      `SELECT n.nspname AS schema, c.relname AS table FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relrowsecurity AND ${where}`,
      params,
    )
    for (const r of secured.rows) {
      const t = tables.get(key(r.schema, r.table))
      if (t) t.rowSecurity = true
    }
    const rows = await query<{ schema: string; table: string; name: string; permissive: boolean; cmd: string; roles: string[]; qual: string | null; check: string | null }>(
      `SELECT n.nspname AS schema, c.relname AS table, pol.polname AS name, pol.polpermissive AS permissive, pol.polcmd::text AS cmd,
              CASE WHEN pol.polroles = '{0}' THEN ARRAY['public'] ELSE ARRAY(SELECT quote_ident(r.rolname) FROM pg_roles r WHERE r.oid = ANY (pol.polroles) ORDER BY r.rolname) END::text[] AS roles,
              pg_get_expr(pol.polqual, pol.polrelid) AS qual, pg_get_expr(pol.polwithcheck, pol.polrelid) AS check
         FROM pg_policy pol JOIN pg_class c ON c.oid = pol.polrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${where}
        ORDER BY n.nspname, c.relname, pol.polname`,
      params,
    )
    const commands: Record<string, string> = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' }
    for (const r of rows.rows) {
      const t = tables.get(key(r.schema, r.table))
      if (!t) continue
      const definition = [
        `CREATE POLICY ${q(r.name)} ON ${name(r.schema, r.table)}`,
        `  AS ${r.permissive ? 'PERMISSIVE' : 'RESTRICTIVE'} FOR ${commands[r.cmd] ?? 'ALL'} TO ${r.roles.join(', ')}`,
        ...(r.qual ? [`  USING (${r.qual})`] : []),
        ...(r.check ? [`  WITH CHECK (${r.check})`] : []),
      ].join('\n')
      ;(t.policies ??= []).push({ name: r.name, definition: `${definition};` })
    }
  })

  await part(async () => {
    const rows = await query<{ schema: string; name: string; type: string; start: string; increment: string; min: string; max: string; cache: string; cycle: boolean; owned_by: string | null }>(
      `SELECT n.nspname AS schema, c.relname AS name, format_type(s.seqtypid, NULL) AS type, s.seqstart::text AS start,
              s.seqincrement::text AS increment, s.seqmin::text AS min, s.seqmax::text AS max, s.seqcache::text AS cache, s.seqcycle AS cycle,
              (SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname)
                 FROM pg_depend d JOIN pg_class tc ON tc.oid = d.refobjid JOIN pg_namespace tn ON tn.oid = tc.relnamespace
                 JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_class'::regclass AND d.deptype = 'a' LIMIT 1) AS owned_by
         FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE ${where} AND ${notFromExtension('pg_class', 'c.oid')}
          -- Identity columns' sequences belong to their column (GENERATED … AS IDENTITY).
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i')
        ORDER BY n.nspname, c.relname`,
      params,
    )
    for (const r of rows.rows) {
      const lines = [
        `CREATE SEQUENCE ${name(r.schema, r.name)}`,
        `  AS ${r.type}`,
        `  INCREMENT BY ${r.increment} MINVALUE ${r.min} MAXVALUE ${r.max}`,
        `  START WITH ${r.start} CACHE ${r.cache}${r.cycle ? ' CYCLE' : ' NO CYCLE'};`,
      ]
      if (r.owned_by) lines.push(`ALTER SEQUENCE ${name(r.schema, r.name)} OWNED BY ${r.owned_by};`)
      objects.push({ schema: r.schema, name: r.name, kind: 'sequence', detail: r.type, definition: lines.join('\n') })
    }
  })

  await part(async () => {
    const rows = await query<{ schema: string; name: string; kind: string; labels: string[] | null; base: string | null; not_null: boolean; default: string | null; checks: string[] | null; attributes: string | null }>(
      `SELECT n.nspname AS schema, t.typname AS name, t.typtype::text AS kind,
              CASE WHEN t.typtype = 'e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = t.oid ORDER BY e.enumsortorder) END AS labels,
              CASE WHEN t.typtype = 'd' THEN format_type(t.typbasetype, t.typtypmod) END AS base,
              t.typnotnull AS not_null, t.typdefault AS default,
              CASE WHEN t.typtype = 'd' THEN ARRAY(SELECT 'CONSTRAINT ' || quote_ident(con.conname) || ' ' || pg_get_constraintdef(con.oid, true) FROM pg_constraint con WHERE con.contypid = t.oid ORDER BY con.conname) END AS checks,
              CASE WHEN t.typtype = 'c' THEN (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
                                                FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped) END AS attributes
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE ${where} AND ${notFromExtension('pg_type', 't.oid')}
          AND (t.typtype IN ('e', 'd') OR (t.typtype = 'c' AND (SELECT c.relkind FROM pg_class c WHERE c.oid = t.typrelid) = 'c'))
        ORDER BY n.nspname, t.typname`,
      params,
    )
    for (const r of rows.rows) {
      const full = name(r.schema, r.name)
      if (r.kind === 'e') {
        objects.push({ schema: r.schema, name: r.name, kind: 'type', detail: 'enum', definition: `CREATE TYPE ${full} AS ENUM (${(r.labels ?? []).map(literal).join(', ')});` })
      } else if (r.kind === 'd') {
        const parts = [`CREATE DOMAIN ${full} AS ${r.base}`, ...(r.default ? [`DEFAULT ${r.default}`] : []), ...(r.not_null ? ['NOT NULL'] : []), ...(r.checks ?? [])]
        objects.push({ schema: r.schema, name: r.name, kind: 'type', detail: 'domain', definition: `${parts.join('\n  ')};` })
      } else {
        objects.push({ schema: r.schema, name: r.name, kind: 'type', detail: 'composite', definition: `CREATE TYPE ${full} AS (${r.attributes ?? ''});` })
      }
    }
  })

  await part(async () => {
    const rows = await query<{ schema: string; name: string; version: string }>(
      `SELECT n.nspname AS schema, e.extname AS name, e.extversion AS version
         FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
        WHERE ${where}
        ORDER BY n.nspname, e.extname`,
      params,
    )
    for (const r of rows.rows) {
      objects.push({ schema: r.schema, name: r.name, kind: 'extension', detail: r.version, definition: `CREATE EXTENSION IF NOT EXISTS ${q(r.name)} WITH SCHEMA ${q(r.schema)} VERSION ${literal(r.version)};` })
    }
  })

  return objects
}
