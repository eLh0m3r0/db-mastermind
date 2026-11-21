import { describe, expect, it } from 'vitest'
import { createScript, getDialect, isPlainCheck, isPlainType, plainDefault, tablesFromDrawDb, tablesFromMermaid, type TableInfo } from '../src/index.js'

/** The tables without comments: the notes say the hostile text, as text. */
export const withoutComments = (tables: TableInfo[]) => tables.map((t) => ({ ...t, comment: null, columns: t.columns.map((c) => ({ ...c, comment: null })) }))

// SQL text from other tools' files (review L12): what isn't plain is a note, never SQL.
describe('the grammar for SQL from other tools', () => {
  it('takes values, known calls, plain types and checks', () => {
    for (const d of ['0', '-1.5', "'abc'", "'it''s'", "N'x'", "b'01'", 'TRUE', 'null', 'CURRENT_TIMESTAMP', 'current_timestamp(6)', 'now()', 'gen_random_uuid()', '(uuid())', "nextval('orders_id_seq'::regclass)", "datetime('now')", "'{}'::jsonb"]) expect(plainDefault(d), d).toBe(d)
    for (const t of ['int', 'varchar(255)', 'decimal(10, 2)', 'double precision', 'timestamp(3) with time zone', "enum('a','b')", 'int unsigned', 'text[]', 'nvarchar(max)']) expect(isPlainType(t), t).toBe(true)
    for (const c of ['price > 0', "status IN ('new', 'paid')", 'length(name) BETWEEN 1 AND 50', '"from" <> "to"', 'a IS NOT NULL OR b = 2']) expect(isPlainCheck(c), c).toBe(true)
  })

  it('refuses anything that could end the statement it is written into', () => {
    for (const d of ["'a'); DROP TABLE users; --'", "'a\\'", "'x' || pg_sleep(10)", 'pg_sleep(10)', 'evil(1)', "now(); DROP TABLE t", "'x'/*", '(1); drop table t; --', "E'\\x27'"]) expect(plainDefault(d), d).toBeUndefined()
    for (const t of ["int); DROP TABLE users; --", "enum('a\\','b')", 'varchar(10) /* x */', 'int -- x', 'int;']) expect(isPlainType(t), t).toBe(false)
    for (const c of ['price > 0); DROP TABLE users; --', 'a > 0 -- x', "a = 'x\\'", 'a > (select max(b) from t)', 'a = 1; drop table t', '|', 'a > 0) OR (1 = 1', 'a /* x */ > 0']) expect(isPlainCheck(c), c).toBe(false)
  })
})

describe('hostile text in a drawDB diagram', () => {
  const field = (id: number, name: string, extra: Record<string, unknown>) => ({ id, name, type: 'VARCHAR', size: 50, notNull: false, primary: false, unique: false, increment: false, comment: '', ...extra })
  const diagram = JSON.stringify({
    database: 'mysql',
    tables: [
      {
        id: 0,
        name: 'users',
        fields: [
          field(0, 'id', { type: 'INT', size: '', primary: true }),
          field(1, 'a', { default: "'a'); DROP TABLE users; --'" }),
          field(2, 'b', { default: 'evil(1)' }),
          field(3, 'c', { default: 'plain text\\' }),
          field(4, 'd', { check: "d <> '') ; DROP TABLE users; --" }),
          field(5, 'e', { type: 'INT', size: '1); DROP TABLE users; --' }),
          field(6, 'f', { type: 'ENUM', size: '', values: ['\\', ') , x int); DROP TABLE users; --'] }),
          field(7, 'g', { default: "'fine'", check: "g <> ''" }),
        ],
      },
    ],
    relationships: [],
  })

  it('keeps it as notes, counts it, and never writes it into a script', () => {
    const m = tablesFromDrawDb(diagram)
    expect(m.leftOut).toMatchObject({ defaults: 3, checks: 1, types: 2 })
    const users = m.tables[0]!
    expect(users.columns.find((c) => c.name === 'a')).toMatchObject({ defaultValue: null, comment: "drawDB default (not taken): 'a'); DROP TABLE users; --'" })
    expect(users.columns.find((c) => c.name === 'g')).toMatchObject({ defaultValue: "'fine'" })
    expect(users.checks).toEqual([{ expression: "g <> ''", column: 'g' }])
    for (const driver of ['mysql', 'postgres', 'sqlite', 'mssql'] as const) {
      const script = createScript(withoutComments(m.tables), getDialect(driver), { translateTypes: true, from: 'mysql' })
      expect(script, driver).not.toMatch(/DROP TABLE|evil|plain text/)
    }
  })
})

describe('hostile text in a Mermaid diagram', () => {
  it('Mermaid: a type that is not a type is text, with a note', () => {
    const m = tablesFromMermaid('erDiagram\n  users {\n    int id PK\n    varchar(1),x id\n  }\n')
    expect(m.tables[0]!.columns.map((c) => c.dataType)).not.toContain('varchar(1),x')
  })

})
