import { describe, expect, it } from 'vitest'
import { createScript, dropScript, generateMigration, getDialect, parseDbml, splitStatements, sqlTextProblem, stripLiterals, compareSchemas, type DriverId, type TableInfo } from '../src/index.js'

/** The statements of a script as our splitter reads them, with literals, names and comments blanked (what runs). */
const code = (script: string, d: DriverId) => splitStatements(script, d).map((s) => stripLiterals(s.text, d).trim())

// Review N1: whatever a model gives as SQL is one piece of the statement it goes into, in every dialect.
const DIALECTS: DriverId[] = ['postgres', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb']

describe('a piece of SQL from a model', () => {
  it('is fine when every quote and comment closes inside it and its parentheses balance', () => {
    for (const d of DIALECTS) {
      for (const ok of ["'a'", '(1 + 2) * 3', "lower(name) = 'x'", 'a /* note */ > 0', 'a > 0 -- note\n', 'now()']) expect(sqlTextProblem(ok, d), `${d}: ${ok}`).toBeUndefined()
    }
    expect(sqlTextProblem("E'it\\'s'", 'postgres')).toBeUndefined()
    expect(sqlTextProblem('[order] > 0', 'mssql')).toBeUndefined()
    expect(sqlTextProblem('`order` > 0', 'mysql')).toBeUndefined()
    expect(sqlTextProblem('a /* /* nested */ */ > 0', 'postgres')).toBeUndefined()
  })

  it('has a problem when it could end or swallow its statement', () => {
    const bad: [DriverId[], string][] = [
      [DIALECTS, "'a'); DROP TABLE victim; --"],
      [DIALECTS, '1); DROP TABLE victim'],
      [DIALECTS, "'unclosed"],
      [DIALECTS, '(1'],
      [DIALECTS, 'a > 0 -- runs to the end'],
      [DIALECTS, 'a /* unclosed'],
      [DIALECTS, 'a */ b'],
      // MySQL: a backslash escapes the quote, so this string never closes there.
      [['mysql', 'mariadb'], "'a\\'"],
      [['mysql', 'mariadb'], '"a\\" = "b)); DROP TABLE victim; CREATE TABLE z (q int, CHECK ("'],
      [['mysql', 'mariadb'], 'a # comment'],
      [['mysql', 'mariadb'], 'a--1'],
      [['mysql', 'mariadb'], 'a /*! DROP TABLE victim */'],
      [['mysql', 'mariadb'], 'x\ndelimiter //\n'],
      // PostgreSQL: dollar quoting, an E'' string whose \' doesn't close it, nested comments, psql commands.
      [['postgres', 'duckdb'], '$$a$$'],
      [['postgres', 'duckdb'], "E'a\\'"],
      [['postgres'], 'a /* /* */ > 0'],
      [['postgres'], 'x\n\\! rm -rf ~\n'],
      // SQL Server: brackets, and a GO line.
      [['mssql'], '[a]]; DROP TABLE victim'],
      [['mssql'], 'x\nGO\n'],
      [['oracle'], 'x\n/\n'],
      [['postgres', 'mssql', 'oracle'], '`a`'],
    ]
    for (const [dialects, text] of bad) for (const d of dialects) expect(sqlTextProblem(text, d), `${d}: ${text}`).toBeDefined()
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
