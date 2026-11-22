import { describe, expect, it } from 'vitest'
import { clickhouseLiteral, inlineClickHouseParams } from '../src/drivers/clickhouse.js'
import { inlineTrinoParams } from '../src/drivers/trino.js'
import { inlineParams, inlineValues, sqlValue, getDialect, lex } from '../src/index.js'

// Wave 10: the one literal writer, and placeholders found by the tokenizer (never by searching the text).
describe('values as SQL literals', () => {
  it('strings per dialect, read back by the tokenizer as the same value', () => {
    const nasty = ["a'b", 'a\\', "\\'", 'x\\\\y', '-- c', '/* c */', '?', '$1', ':1', '@p1', '{__p1}', 'ěš😀', 'a\nb\r\nc']
    for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb', 'clickhouse', 'bigquery', 'trino']) {
      for (const v of nasty) {
        const sql = `SELECT ${sqlValue(v, driver)}`
        const lexed = lex(sql, driver)
        expect(lexed.ok, `${driver}: ${sql}`).toBe(true)
        const strings = lexed.ok ? lexed.tokens.filter((t) => t.kind === 'string') : []
        expect(strings.map((t) => t.value), `${driver}: ${sql}`).toEqual([v])
      }
    }
  })

  it("MySQL follows the session's sql_mode; NUL and T-SQL's backslash-newline are joined in", () => {
    expect(sqlValue('a\\', 'mysql')).toBe("'a\\\\'")
    expect(sqlValue('a\\', 'mysql', { noBackslashEscapes: true })).toBe("'a\\'")
    expect(sqlValue('a\u0000b', 'mysql')).toBe("'a\\0b'")
    expect(sqlValue('a\u0000b', 'mysql', { noBackslashEscapes: true })).toBe("CONCAT('a', CHAR(0 USING utf8mb4), 'b')")
    expect(sqlValue('a\\\nb', 'mssql')).toBe("CONCAT(CAST(N'' AS nvarchar(max)), N'a\\', NCHAR(10), N'b')")
    expect(sqlValue('a\u0000', 'sqlite')).toBe("CAST(X'6100' AS TEXT)")
    expect(() => sqlValue('a\u0000', 'postgres')).toThrow(/NUL/)
  })

  it('numbers, booleans, binary, JSON, arrays', () => {
    expect(sqlValue(1.7976931348623157e308, 'oracle')).toBe('1.7976931348623157e+308d')
    expect(sqlValue(Number.NaN, 'postgres')).toBe("'NaN'")
    expect(() => sqlValue(Number.POSITIVE_INFINITY, 'mysql')).toThrow(/no literal/)
    expect(sqlValue(true, 'mssql')).toBe('1')
    expect(sqlValue({ $binary: '5c27', length: 2 }, 'postgres')).toBe("'\\x5c27'::bytea")
    expect(sqlValue({ $binary: '5c27', length: 2 }, 'duckdb')).toBe("'\\x5C\\x27'::BLOB")
    expect(() => sqlValue({ $binary: '5c27', length: 5000 }, 'mysql')).toThrow(/only in part/)
    expect(sqlValue({ a: "it's" }, 'postgres')).toBe(`'{"a":"it''s"}'`)
    // (A backslash makes it an escape string, which PostgreSQL reads the same in its old and its standard mode.)
    expect(sqlValue(['a"b', null], 'postgres')).toBe(`E'{"a\\\\"b",NULL}'`)
    expect(sqlValue("a\\'; --", 'postgres')).toBe("E'a\\\\''; --'")
    expect(sqlValue("it's", 'postgres')).toBe("'it''s'")
    expect(clickhouseLiteral(['x', 1])).toBe("['x', 1]")
  })

  it('placeholders by position from the tokenizer: one inside a string or a comment stays text', () => {
    expect(inlineValues("SELECT '?' , ? -- ?\n, ?", ['a', "b'"], 'mysql')).toBe("SELECT '?' , 'a' -- ?\n, 'b'''")
    expect(inlineValues("SELECT '$1', $1, $2 /* $1 */", ['x', 2], 'postgres')).toBe("SELECT '$1', 'x', 2 /* $1 */")
    expect(inlineValues("SELECT '@p1', @p1 WHERE [@p1] = @p2", [1, 'é'], 'mssql')).toBe("SELECT '@p1', 1 WHERE [@p1] = N'é'")
    expect(inlineValues("SELECT ':1' FROM dual WHERE a = :1", ['v'], 'oracle')).toBe("SELECT ':1' FROM dual WHERE a = 'v'")
    expect(inlineClickHouseParams("SELECT '{__p1}', {__p1}", ["a\\'"])).toBe("SELECT '{__p1}', 'a\\\\\\''")
    expect(inlineTrinoParams("SELECT '{__p1}' WHERE x = {__p1}", ["it's"])).toBe("SELECT '{__p1}' WHERE x = 'it''s'")
    expect(inlineParams({ sql: 'UPDATE t SET a = ? WHERE id = ?', params: ['a\\', 1] }, getDialect('mysql'))).toBe("UPDATE t SET a = 'a\\\\' WHERE id = 1")
    expect(() => inlineValues('SELECT ?, ?', [1], 'mysql')).toThrow(/Missing value/)
  })
})
