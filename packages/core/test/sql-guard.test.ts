import { describe, expect, it } from 'vitest'
import { canonicalPiece, createScript, dropScript, generateMigration, getDialect, guardStatements, parseDbml, splitStatements, sqlTextProblem, stripLiterals, compareSchemas, type DriverId, type TableInfo } from '../src/index.js'

/** The statements of a script as our splitter reads them, with literals, names and comments blanked (what runs). */
const code = (script: string, d: DriverId) => splitStatements(script, d).map((s) => stripLiterals(s.text, d).trim())

// Review N1: whatever a model gives as SQL is one piece of the statement it goes into, in every dialect.
const DIALECTS: DriverId[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb']

describe('a piece of SQL from a model', () => {
  // What real models have (review M3, wave 6): written again from its tokens, its meaning kept. [dialect, piece, as written]
  const MUST_PASS: [DriverId, string, string][] = [
    ['postgres', "nextval('seq'::regclass)", "nextval('seq'::regclass)"],
    ['postgres', 'a */ b', 'a * / b'],
    ['postgres', "E'it\\'s'", "'it''s'"],
    ['postgres', '$$hello$$', "'hello'"],
    ['postgres', "$fn$it's$fn$", "'it''s'"],
    ['postgres', "col ~ '^[a-z\\d]+$'", "col ~ '^[a-z\\d]+$'"],
    ['postgres', "ARRAY['a','b']::text[]", "ARRAY['a','b']::text[]"],
    ['postgres', 'price > 0 -- must be positive', 'price > 0'],
    ['postgres', 'price > 0 -- positive\n  AND qty >= 0 /* never negative */', 'price > 0 AND qty >= 0'],
    ['postgres', 'a /* /* nested */ */ > 0', 'a > 0'],
    ['postgres', "U&'d\\0061t\\+000061'", "U&'d\\0061t\\+000061'"],
    ['postgres', 'lower(name) text_pattern_ops', 'lower(name) text_pattern_ops'],
    ['postgres', '(name COLLATE "C")', '(name COLLATE "C")'],
    ['postgres', "'{\"a\": 1}'::jsonb", "'{\"a\": 1}'::jsonb"],
    ['mysql', "'C:\\\\tmp'", "'C:\\\\tmp'"],
    ['mysql', "code REGEXP '^\\\\d+$'", "code REGEXP '^\\\\d+$'"],
    ['mysql', "json_extract(doc, '$.a')", "json_extract(doc, '$.a')"],
    ['mysql', 'CURRENT_TIMESTAMP(6)', 'CURRENT_TIMESTAMP(6)'],
    ['mysql', "enum('it''s','b')", "enum('it''s','b')"],
    ['mysql', "enum('it\\'s','b\\\\c')", "enum('it''s','b\\\\c')"],
    ['mysql', 'a--1', 'a- -1'],
    ['mysql', 'a > 0 # note\n', 'a > 0'],
    ['mysql', '"double quoted"', "'double quoted'"],
    ['mysql', "_utf8mb4'x'", "_utf8mb4 'x'"],
    ['mssql', "(N'x')", "(N'x')"],
    ['mssql', '(getdate())', '(getdate())'],
    ['mssql', '[a]]b] > 0', '[a]]b] > 0'],
    ['mssql', '([price]*[qty])', '([price]*[qty])'],
    ['mssql', 'a /* /* nested */ */ > 0', 'a > 0'],
    ['oracle', 'SYSDATE', 'SYSDATE'],
    ['oracle', "q'[it's]'", "'it''s'"],
    ['sqlite', "(datetime('now'))", "(datetime('now'))"],
    ['sqlite', '[order] > 0', '"order" > 0'],
  ]
  // Pieces that end or swallow their statement, or run as code. [dialects, piece]
  const MUST_REFUSE: [DriverId[], string][] = [
    [DIALECTS, "'a'); DROP TABLE victim; --"],
    [DIALECTS, '1); DROP TABLE victim'],
    [DIALECTS, "'unclosed"],
    [DIALECTS, '(1'],
    [DIALECTS, 'a /* unclosed'],
    [['mysql', 'mariadb'], "'a\\'"],
    [['mysql', 'mariadb'], '"a\\" = "b)); DROP TABLE victim; CREATE TABLE z (q int, CHECK ("'],
    [['mysql', 'mariadb'], 'a /*! DROP TABLE victim */'],
    [['postgres', 'duckdb'], "E'a\\'"],
    [['postgres'], 'a /* /* */ > 0'],
    [['postgres'], 'x\n\\! rm -rf ~\n'],
    [['mssql'], '[a]]; DROP TABLE victim'],
    [['postgres', 'mssql', 'oracle'], '`a`'],
    // Review round 2 (H1): what the old lexer let through.
    [['postgres'], "$é$'$é$ || ''); DROP TABLE s.victim; COMMIT; CREATE TABLE s.z (id int, --'"],
    [['mssql'], "0 /* /* */ ' */ ) DROP TABLE victim COMMIT CREATE TABLE z (id int --'"],
  ]
  it('real models: written again with their meaning kept', () => {
    for (const [d, text, expected] of MUST_PASS) expect(canonicalPiece(text, d), `${d}: ${text}`).toEqual({ sql: expected })
  })
  it('pieces that could end or swallow their statement are refused', () => {
    for (const [dialects, text] of MUST_REFUSE) for (const d of dialects) expect(sqlTextProblem(text, d), `${d}: ${text}`).toBeDefined()
  })
  it('across dialects: a MySQL string with backslashes keeps its value in PostgreSQL, a PostgreSQL XOR never becomes a MySQL comment', () => {
    expect(canonicalPiece("'C:\\\\tmp'", 'postgres', 'mysql')).toEqual({ sql: "'C:\\tmp'" })
    expect(canonicalPiece("'C:\\tmp'", 'mysql', 'postgres')).toEqual({ sql: "'C:\\\\tmp'" })
    expect(canonicalPiece('$$a$$', 'mssql', 'postgres')).toEqual({ sql: "'a'" })
    expect(canonicalPiece('a # b', 'mysql', 'postgres').problem).toBeDefined()
    expect(canonicalPiece('"name"', 'mysql', 'postgres')).toEqual({ sql: '`name`' })
  })
})

const col = (name: string, extra: Partial<TableInfo['columns'][number]> = {}) => ({ name, ordinal: 1, dataType: 'int', nullable: true, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null, ...extra })

/** Hostile pieces for each place a model's SQL goes; a script must still be exactly the intended statements. */
function hostile(d: DriverId): TableInfo[] {
  const evil = d === 'mysql' || d === 'mariadb' ? "'a\\'); DROP TABLE victim; --" : d === 'postgres' ? "$x$); DROP TABLE victim; --$x$" : "'a'); DROP TABLE victim; --"
  return [
    {
      name: 't',
      type: 'table',
      comment: "a\\'); DROP TABLE victim; --",
      columns: [
        col('id', { isPrimaryKey: true, nullable: false }),
        col('a', { defaultValue: evil, comment: "it\\'s; DROP TABLE victim; --" }),
        col('b', { dataType: 'int); DROP TABLE victim; --' }),
        col('c', { collation: 'x; DROP TABLE victim' }),
        col('d', { dataType: 'varchar(10)' }),
      ],
      primaryKey: ['id'],
      foreignKeys: [{ name: 'fk_t', columns: ['d'], refTable: 'p', refColumns: ['id'], onDelete: 'CASCADE; DROP TABLE victim' }],
      indexes: [
        { name: 't_pkey', columns: ['id'], unique: true, primary: true },
        { name: 'ix_evil', columns: ['(a)); DROP TABLE victim; CREATE TABLE z ((q)'], unique: false, primary: false },
        { name: 'ix_ok', columns: ['d'], unique: false, primary: false },
      ],
      checks: [{ name: 'ck_evil', expression: d === 'mssql' ? '[a]]) DROP TABLE victim; --' : '"a\\" = "b)); DROP TABLE victim; CREATE TABLE z (q int, CHECK ("' }, { name: 'ck_ok', expression: 'a > 0' }],
    },
    { name: 'p', type: 'table', comment: null, columns: [col('id', { isPrimaryKey: true, nullable: false })], primaryKey: ['id'], foreignKeys: [], indexes: [{ name: 'p_pkey', columns: ['id'], unique: true, primary: true }] },
  ]
}

describe('what the generators write (review N1, the invariant)', () => {
  it('leaves out every hostile piece, says so, and the script is exactly its intended statements', () => {
    for (const d of DIALECTS) {
      const script = createScript(hostile(d), getDialect(d))
      const statements = code(script, d)
      expect(statements.join('\n'), d).not.toMatch(/DROP|victim|CREATE TABLE z/i)
      expect(script, d).toMatch(/-- WARNING: Left out: column t\.b \(its type\)/)
      expect(script, d).toMatch(/Left out: index ix_evil of t/)
      for (const s of statements) expect(s, d).toMatch(/^(BEGIN|COMMIT|SET XACT_ABORT|CREATE (TABLE|INDEX|SEQUENCE)|ALTER TABLE|COMMENT ON|EXEC sys\.sp_addextendedproperty|PRAGMA)/i)
      // The good parts are all there: two tables, ix_ok, ck_ok.
      expect(script, d).toMatch(/ix_ok/)
      expect(script, d).toMatch(/ck_ok|a > 0/)
    }
  })

  it('writes MySQL comments with backslashes as strings that close', () => {
    const script = createScript([{ name: 't', type: 'table', comment: 'ends with \\', columns: [col('id', { comment: "a\\'b" })], primaryKey: [], foreignKeys: [], indexes: [] }], getDialect('mysql'))
    expect(splitStatements(script, 'mysql').length).toBe(2)
    expect(script).toContain("COMMENT 'a\\\\''b'")
  })

  it('also for a stranger\'s .dbml (backtick expressions are raw SQL there), migrations and the DROP script', () => {
    const dbml = 'Table t {\n  id int [pk]\n  a int [default: `1); DROP TABLE victim; --`]\n  b int [check: `b > 0) ; DROP TABLE victim; --`]\n  indexes {\n    `lower(x)); DROP TABLE victim; --` [name: \'ix\']\n  }\n}\n'
    const model = parseDbml(dbml).tables
    for (const d of DIALECTS) {
      const script = createScript(model, getDialect(d))
      expect(code(script, d).join('\n'), d).not.toMatch(/victim/)
      const changed = generateMigration(compareSchemas(model, [{ ...model[0]!, columns: model[0]!.columns.slice(0, 1), indexes: [], checks: [] }], { model: true }), getDialect(d))
      expect(changed.statements.join('\n'), d).not.toMatch(/DROP TABLE victim/)
      expect(changed.rollback.join('\n'), d).not.toMatch(/DROP TABLE victim/)
      expect(code(dropScript(model, getDialect(d)), d).join('\n'), d).not.toMatch(/victim/)
    }
  })

  it('warnings are one line each, whatever a name holds', () => {
    const script = createScript([{ name: 'x\nDROP TABLE victim;\n', type: 'table', comment: null, columns: [col('id', { dataType: "int'" })], primaryKey: [], foreignKeys: [], indexes: [] }], getDialect('postgres'))
    expect(script).toMatch(/-- WARNING: Left out: column x DROP TABLE victim; \.id/)
    expect(code(script, 'postgres').join('\n')).not.toMatch(/victim/)
  })
})

describe('what the statement check must let through (wave 6: real models)', () => {
  it('a statement ending in a comment, and a rollback step that is a comment alone', () => {
    const before = { name: 't', type: 'table' as const, comment: null, columns: [col('id', { isPrimaryKey: true, nullable: false }), col('a', { dataType: 'smallint' })], primaryKey: ['id'], foreignKeys: [], indexes: [{ name: 't_pkey', columns: ['id'], unique: true, primary: true }] }
    for (const d of DIALECTS) {
      const dropColumn = generateMigration(compareSchemas([{ ...before, columns: before.columns.slice(0, 1) }], [before], { model: true }), getDialect(d))
      const dropTable = generateMigration(compareSchemas([], [before]), getDialect(d))
      for (const m of [dropColumn, dropTable]) expect(m.warnings.filter((w) => /Left out/.test(w.message)), d).toEqual([])
      expect(dropColumn.rollback.length + dropTable.rollback.length, d).toBeGreaterThan(0)
    }
  })
})

describe('the review inputs (H1) meet a second layer of their own', () => {
  it('the statement check alone leaves out a statement the piece broke, as if the piece had not been read first', () => {
    const pg = `CREATE TABLE s.t (a int DEFAULT $é$'$é$ || ''); DROP TABLE s.victim; COMMIT; CREATE TABLE s.z (id int, --')`
    const ms = "CREATE TABLE t (a int DEFAULT 0 /* /* */ ' */ ) DROP TABLE victim COMMIT CREATE TABLE z (id int --')"
    for (const [d, sql] of [['postgres', pg], ['mssql', ms]] as const) {
      const out = guardStatements({ statements: [sql, 'CREATE TABLE ok (id int)'], rollback: [], warnings: [], transactional: true }, getDialect(d))
      expect(out.statements, d).toEqual(['CREATE TABLE ok (id int)'])
      expect(out.warnings.map((w) => w.message).join(' '), d).toMatch(/would not be one statement/)
    }
  })
})
