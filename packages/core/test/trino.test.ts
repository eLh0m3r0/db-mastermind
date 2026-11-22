import { describe, expect, it } from 'vitest'
import { inlineTrinoParams, parseTrinoJson, trinoLiteral, trinoValue } from '../src/drivers/trino.js'
import { parseConnectionString } from '../src/connection-url.js'
import { trinoDialect } from '../src/dialect.js'
import { buildSelect } from '../src/filters.js'

const t = { schema: 'shop', name: 'orders' }
const where = (...children: object[]) => ({ kind: 'group', id: 'g', combinator: 'and', children: children.map((c, i) => ({ kind: 'condition', id: `c${i}`, ...c })) }) as never

describe('Trino SQL', () => {
  it('casts filter values to the column type and pages with OFFSET before LIMIT', () => {
    const q = buildSelect({ table: t, filter: where({ column: 'id', operator: 'eq', value: '5' }, { column: 'name', operator: 'eq', value: "O'Hara" }), columnTypes: { id: 'bigint', name: 'varchar(25)' }, limit: 5, offset: 10 }, trinoDialect)
    expect(q.sql).toBe('SELECT * FROM "shop"."orders" WHERE ("id" = CAST({__p1} AS bigint) AND "name" = {__p2}) OFFSET 10 LIMIT 5')
    expect(inlineTrinoParams(q.sql, q.params)).toBe(`SELECT * FROM "shop"."orders" WHERE ("id" = CAST('5' AS bigint) AND "name" = 'O''Hara') OFFSET 10 LIMIT 5`)
    const like = buildSelect({ table: t, filter: where({ column: 'name', operator: 'contains', value: 'a%' }), limit: 5 }, trinoDialect)
    expect(like.sql).toBe(`SELECT * FROM "shop"."orders" WHERE lower(CAST("name" AS varchar)) LIKE lower({__p1}) ESCAPE '!' LIMIT 5`)
    expect(trinoDialect.typedParam!('{__p1}', 'timestamp(3) with time zone')).toBe('CAST({__p1} AS timestamp(3) with time zone)')
    expect(trinoDialect.typedParam!('{__p1}', 'decimal(10,2)')).toBe('CAST({__p1} AS decimal(10,2))')
    expect(trinoDialect.typedParam!('{__p1}', 'array(varchar)')).toBe('{__p1}')
  })

  it('writes literals and reads protocol values exactly', () => {
    expect([null, 1.5, 7n, true, ['a', 2]].map(trinoLiteral)).toEqual(['NULL', '1.5', '7', 'true', "ARRAY['a', 2]"])
    expect(() => inlineTrinoParams('SELECT {__p2}', ['x'])).toThrow(/parameter 2/)
    expect(parseTrinoJson('{"data":[[9007199254740993,1.5,42]]}').data).toEqual([['9007199254740993', 1.5, 42]])
    expect(trinoValue('varbinary', Buffer.from('hi').toString('base64'))).toMatchObject({ $binary: '6869' })
    expect(trinoValue('json', '{"a":[1]}')).toEqual({ a: [1] })
    expect(trinoValue('map(varchar, integer)', { a: 1 })).toEqual({ a: 1 })
  })

  it('parses Trino URLs with catalog and schema', () => {
    expect(parseConnectionString('jdbc:trino://trino.corp:8443/hive/sales?SSL=true&user=alice')).toEqual({ driver: 'trino', host: 'trino.corp', port: 8443, database: 'hive', options: { schema: 'sales' }, user: 'alice', password: undefined, ssl: { mode: 'require' } })
    expect(parseConnectionString('presto://h/iceberg')).toMatchObject({ driver: 'trino', port: 8080, database: 'iceberg' })
  })
})

describe('Trino: the password goes only to the connection\'s server (wave 10)', () => {
  it('a nextUri on another host or port is not followed, and says so', async () => {
    const { createServer } = await import('node:http')
    const { TrinoDriver } = await import('../src/drivers/trino.js')
    const seen: { url: string; auth?: string }[] = []
    let foreignHits = 0
    const foreign = createServer((req, res) => {
      foreignHits++
      res.end('{}')
    })
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', r))
    const foreignPort = (foreign.address() as { port: number }).port
    let answer = (path: string) => ({ nextUri: `http://127.0.0.1:${foreignPort}/v1/statement/x/1` }) as object
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? '', auth: req.headers.authorization })
      if (req.url === '/v1/info') return res.end(JSON.stringify({ nodeVersion: { version: '483' }, starting: false }))
      res.end(JSON.stringify(answer(req.url ?? '')))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const driver = new TrinoDriver({ id: 't', name: 't', driver: 'trino', host: '127.0.0.1', port, user: 'u', password: 'secret', ssl: undefined } as never)
    try {
      // (connect runs SELECT 1, which gets the foreign nextUri.)
      await expect(driver.connect()).rejects.toThrow(new RegExp(`127\\.0\\.0\\.1:${foreignPort}.*not followed, the password is not sent there`))
      // Another scheme on the same host, and a relative URL of the same server, which is fine.
      answer = (path) => (path === '/v1/statement' ? { nextUri: `https://127.0.0.1:${port}/v1/statement/x/1` } : {})
      await expect(driver.execute('SELECT 1')).rejects.toThrow(/https:\/\/127\.0\.0\.1/)
      answer = (path) => (path === '/v1/statement' ? { nextUri: '/v1/statement/x/2' } : { columns: [{ name: 'a', type: 'integer' }], data: [[1]] })
      expect((await driver.execute('SELECT 1'))[0]!.rows).toEqual([[1]])
      expect(foreignHits).toBe(0)
    } finally {
      server.close()
      foreign.close()
    }
  })
})
