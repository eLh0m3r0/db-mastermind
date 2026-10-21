import { describe, expect, it } from 'vitest'
import { buildChangeStatements, inlineParams, mssqlDialect, mysqlDialect, postgresDialect } from '../src/index.js'

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
