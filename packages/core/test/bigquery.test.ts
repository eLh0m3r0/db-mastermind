import { describe, expect, it } from 'vitest'
import { bigqueryParams, bigqueryTimestamp, bigqueryValue } from '../src/drivers/bigquery.js'
import { bigqueryDialect, postgresDialect } from '../src/dialect.js'
import { buildSelect } from '../src/filters.js'

const t = { schema: 'shop', name: 'orders' }
const where = (...children: object[]) => ({ kind: 'group', id: 'g', combinator: 'and', children: children.map((c, i) => ({ kind: 'condition', id: `c${i}`, ...c })) }) as never

describe('BigQuery SQL', () => {
  it('casts filter values to the column type', () => {
    const q = buildSelect({ table: t, filter: where({ column: 'id', operator: 'eq', value: '5' }, { column: 'customer', operator: 'eq', value: 'x' }), columnTypes: { id: 'INT64', customer: 'STRING' }, limit: 5 }, bigqueryDialect)
    expect(q.sql).toBe('SELECT * FROM `shop`.`orders` WHERE (`id` = CAST(@p1 AS INT64) AND `customer` = @p2) LIMIT 5')
    // LIKE has no ESCAPE clause: % and _ are escaped with a backslash (the emulator ignores it, BigQuery doesn't).
    const like = buildSelect({ table: t, filter: where({ column: 'customer', operator: 'contains', value: '50%_\\' }), limit: 5 }, bigqueryDialect)
    expect(like.sql).toBe('SELECT * FROM `shop`.`orders` WHERE LOWER(CAST(`customer` AS STRING)) LIKE LOWER(@p1) LIMIT 5')
    expect(like.params).toEqual(['%50\\%\\_\\\\%'])
    expect(bigqueryTimestamp('1767261600123456')).toBe('2026-01-01 10:00:00.123456 UTC')
    expect(bigqueryTimestamp('1.7672616E9')).toBe('2026-01-01 10:00:00 UTC')
  })

  it('types only where the dialect needs it', () => {
    const pg = buildSelect({ table: t, filter: where({ column: 'id', operator: 'eq', value: '5' }), columnTypes: { id: 'integer' }, limit: 5 }, postgresDialect)
    expect(pg.sql).toBe('SELECT * FROM "shop"."orders" WHERE "id" = $1 LIMIT 5')
    expect(bigqueryDialect.typedParam!('@p1', 'NUMERIC(10, 2)')).toBe('CAST(@p1 AS NUMERIC)')
    expect(bigqueryDialect.typedParam!('@p1', 'TIMESTAMP')).toBe('CAST(@p1 AS TIMESTAMP)')
    expect(bigqueryDialect.typedParam!('@p1', 'ARRAY<INT64>')).toBe('@p1')
    expect(bigqueryDialect.quoteIdent('a`b')).toBe('`a\\`b`')
  })

  it('converts REST values and parameters', () => {
    expect(bigqueryValue({ name: 'n', type: 'INTEGER' }, '9007199254740993')).toBe('9007199254740993')
    expect(bigqueryValue({ name: 'n', type: 'INTEGER' }, '42')).toBe(42)
    expect(bigqueryValue({ name: 'b', type: 'BYTES' }, Buffer.from('hi').toString('base64'))).toMatchObject({ $binary: '6869' })
    expect(bigqueryValue({ name: 'r', type: 'RECORD', mode: 'REPEATED', fields: [{ name: 'x', type: 'BOOLEAN' }] }, [{ v: { f: [{ v: 'true' }] } }])).toEqual([{ x: true }])
    expect(bigqueryParams(['a', null, 5n])).toEqual({ params: { p1: 'a', p2: null, p3: '5' }, types: { p2: 'STRING', p3: 'INT64' } })
  })
})
