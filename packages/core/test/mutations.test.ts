import { describe, expect, it } from 'vitest'
import { buildChangeStatements, checkCellExpression, inlineParams, mssqlDialect, mysqlDialect, postgresDialect } from '../src/index.js'

describe('buildChangeStatements', () => {
  it('builds parameterized insert/update/delete', () => {
    const [ins, upd, del] = buildChangeStatements(
      { schema: 'public', name: 'users' },
      [
        { type: 'insert', values: { name: 'Ann', created_at: { $default: true }, note: null } },
        { type: 'update', key: { id: '7' }, values: { name: "O'Hara" } },
        { type: 'delete', key: { id: '8', tenant: null } },
      ],
      postgresDialect,
    )
    expect(ins).toEqual({
      sql: 'INSERT INTO "public"."users" ("name", "created_at", "note") VALUES ($1, DEFAULT, NULL)',
      params: ['Ann'],
    })
    expect(upd).toEqual({ sql: 'UPDATE "public"."users" SET "name" = $1 WHERE "id" = $2', params: ["O'Hara", '7'] })
    expect(del).toEqual({ sql: 'DELETE FROM "public"."users" WHERE "id" = $1 AND "tenant" IS NULL', params: ['8'] })
  })

  it('refuses keyless updates', () => {
    expect(() => buildChangeStatements({ name: 't' }, [{ type: 'delete', key: {} }], postgresDialect)).toThrow(/without a key/)
  })

  it('uses dialect-specific empty inserts', () => {
    expect(buildChangeStatements({ name: 't' }, [{ type: 'insert', values: {} }], mysqlDialect)[0]!.sql).toBe(
      'INSERT INTO `t` () VALUES ()',
    )
    expect(buildChangeStatements({ name: 't' }, [{ type: 'insert', values: {} }], mssqlDialect)[0]!.sql).toBe(
      'INSERT INTO [t] DEFAULT VALUES',
    )
  })
})

describe('inlineParams', () => {
  it('renders previews with escaped literals', () => {
    const [q] = buildChangeStatements({ name: 'u' }, [{ type: 'update', key: { id: 1 }, values: { a: "it's", b: true } }], mssqlDialect)
    expect(inlineParams(q!, mssqlDialect)).toBe("UPDATE [u] SET [a] = N'it''s', [b] = 1 WHERE [id] = 1")
    const many = { sql: Array.from({ length: 11 }, (_, i) => `$${i + 1}`).join(','), params: Array.from({ length: 11 }, (_, i) => i) }
    expect(inlineParams(many, postgresDialect)).toBe('0,1,2,3,4,5,6,7,8,9,10')
  })
})

describe('SQL expressions in cells', () => {
  it('puts the expression into the statement as written, in parentheses, next to bound values', () => {
    const [u, i] = buildChangeStatements(
      { schema: 'shop', name: 'orders' },
      [
        { type: 'update', key: { id: 7 }, values: { status: 'paid', paid_at: { $sql: 'now()' } } },
        { type: 'insert', values: { total: { $sql: "price * 1.21 + length('a;b')" } } },
      ],
      postgresDialect,
    )
    expect(u).toEqual({ sql: 'UPDATE "shop"."orders" SET "status" = $1, "paid_at" = (now()) WHERE "id" = $2', params: ['paid', 7] })
    expect(i!.sql).toBe(`INSERT INTO "shop"."orders" ("total") VALUES ((price * 1.21 + length('a;b')))`)
  })

  it('refuses anything that could be a second statement or hide one', () => {
    expect(checkCellExpression('now()')).toBeNull()
    expect(checkCellExpression("'a;b' || x")).toBeNull()
    expect(checkCellExpression('1); DROP TABLE x')).toMatch(/semicolon/)
    expect(checkCellExpression('1 -- x')).toMatch(/comment/)
    expect(checkCellExpression('1 /* x */')).toMatch(/comment/)
    expect(checkCellExpression('  ')).toMatch(/expression/)
    // Closing the parentheses early would comment out the WHERE or change another column.
    expect(checkCellExpression('1) --')).toMatch(/comment|parenthes/)
    expect(checkCellExpression('1), other = (2')).toMatch(/parenthes/)
    expect(checkCellExpression("coalesce(x, ')')")).toBeNull()
    expect(checkCellExpression("'unclosed")).toMatch(/not closed/)
    expect(checkCellExpression('1 # mysql comment')).toMatch(/comment/)
  })

  it('refuses quoting the database reads differently from the check (review finding)', () => {
    // MySQL: \' does not end the string, so the check would see a string where MySQL sees code.
    expect(checkCellExpression("'\\'+') WHERE id = ? OR 1=1 # '", 'mysql')).toMatch(/backslash/)
    expect(checkCellExpression("E'\\'' ) WHERE true --'", 'postgres')).toMatch(/backslash/)
    expect(checkCellExpression("$$'$$ ) WHERE true -- '", 'postgres')).toMatch(/dollar/)
    expect(checkCellExpression("(q'(')') WHERE 1=1 --'", 'oracle')).toMatch(/q'/)
    // Second review: national q-quoting and BigQuery triple quotes.
    expect(checkCellExpression("(nq'(')') WHERE 1=1 --'", 'oracle')).toMatch(/q'/)
    expect(checkCellExpression(`'''a' "''' ) WHERE TRUE -- "`, 'bigquery')).toMatch(/triple/)
    // Third review: comments that end at a line break, ClickHouse quoting and comments.
    expect(checkCellExpression("1 # '\n) WHERE TRUE -- '", 'bigquery')).toMatch(/one line/)
    expect(checkCellExpression("1 # ' ) WHERE TRUE '", 'bigquery')).toMatch(/comment/)
    expect(checkCellExpression("$x$'$x$ ) WHERE TRUE -- '", 'clickhouse')).toMatch(/dollar/)
    expect(checkCellExpression("1 // ' ) '", 'clickhouse')).toMatch(/comment/)
    expect(checkCellExpression("1 #! ' ) '", 'clickhouse')).toMatch(/comment/)
    // Fourth review: non-ASCII dollar tags; DuckDB's // is division, not a comment.
    expect(checkCellExpression("$é$'$é$ ) WHERE TRUE -- '", 'postgres')).toMatch(/dollar/)
    expect(checkCellExpression('5 // 2', 'duckdb')).toBeNull()
    expect(checkCellExpression('$1 + $2', 'postgres')).toBeNull()
    // Brackets quote only in SQL Server; elsewhere what is inside them still counts.
    expect(checkCellExpression('x[) WHERE true --]', 'postgres')).toMatch(/comment|parenthes/)
    expect(checkCellExpression("[a)b]", 'mssql')).toBeNull()
    // Everyday expressions still pass.
    for (const [expr, driver] of [["now() + interval '1 day'", 'postgres'], ['gen_random_uuid()', 'postgres'], ["N'Příliš'", 'mssql'], ['price * 1.21', 'mysql'], ["data #>> '{a}'", 'postgres'], ['$1', 'mysql']] as const) {
      expect(checkCellExpression(expr, driver), expr).toBeNull()
    }
    expect(() => buildChangeStatements({ name: 't' }, [{ type: 'update', key: { id: 1 }, values: { a: { $sql: '1; DELETE FROM t' } } }], mssqlDialect)).toThrow(/semicolon/)
  })
})
