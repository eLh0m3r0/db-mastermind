import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { inlineClickHouseParams } from '../src/drivers/clickhouse.js'
import { DatabaseService, explainQuery } from '../src/index.js'

// ClickHouse over HTTP (docker-compose.test.yml / CI step, port 18123).
const db = new DatabaseService()
const id = 'ch'

beforeAll(async () => {
  await db.connect({ id, name: 'ch', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' })
  const out = await db.runScript(
    id,
    `DROP TABLE IF EXISTS dbm_events;
     CREATE TABLE dbm_events (id UInt64, kind LowCardinality(String), amount Decimal(12,2), note Nullable(String), at DateTime) ENGINE = MergeTree ORDER BY (kind, id) COMMENT 'events';
     INSERT INTO dbm_events SELECT number, ['view','click','buy'][number % 3 + 1], number * 1.25, if(number % 10 = 0, NULL, 'n'), toDateTime('2026-01-01 00:00:00') + number FROM numbers(2500);
     CREATE OR REPLACE VIEW dbm_buys AS SELECT * FROM dbm_events WHERE kind = 'buy';`,
  )
  expect(out.filter((o) => o.error)).toEqual([])
})

afterAll(async () => {
  await db.runScript(id, 'DROP VIEW IF EXISTS dbm_buys; DROP TABLE IF EXISTS dbm_events')
  await db.disconnectAll()
})

describe('ClickHouse', () => {
  it('reads the schema', async () => {
    expect(db.serverInfo(id)?.product).toBe('ClickHouse')
    const snap = await db.schema(id, true)
    expect(snap.defaultSchema).toBe('default')
    const events = snap.tables.find((t) => t.name === 'dbm_events')!
    expect(events.columns.map((c) => `${c.name}:${c.dataType}:${c.nullable}`)).toEqual([
      'id:UInt64:false',
      'kind:LowCardinality(String):false',
      'amount:Decimal(12, 2):false',
      'note:Nullable(String):true',
      'at:DateTime:false',
    ])
    expect(events.indexes).toEqual([{ name: 'ORDER BY', columns: ['kind', 'id'], unique: false, primary: false }])
    expect(events.primaryKey).toEqual([])
    expect(events.rowEstimate).toBe(2500)
    expect(snap.tables.find((t) => t.name === 'dbm_buys')!.type).toBe('view')
  })

  it('pages with filters, counts and keeps 64-bit numbers exact', async () => {
    const filter = { kind: 'group', id: 'g', combinator: 'and', children: [{ kind: 'condition', id: 'a', column: 'kind', operator: 'eq', value: 'buy' }, { kind: 'condition', id: 'b', column: 'id', operator: 'gt', value: '100' }] }
    const page = await db.fetchTable(id, { table: { schema: 'default', name: 'dbm_events' }, filter: filter as never, sort: [{ column: 'id', direction: 'desc' }], limit: 10 })
    expect(page.result.rows).toHaveLength(10)
    expect(page.result.rows[0]![0]).toBe('2498')
    expect(await db.countTable(id, { table: { schema: 'default', name: 'dbm_events' }, filter: filter as never })).toBe(800)
    const [r] = await db.runScript(id, "SELECT toUInt64('18446744073709551615') AS big, toDecimal64('12345678901234.56', 2) AS d")
    expect(r!.results![0]!.rows[0]).toEqual(['18446744073709551615', '12345678901234.56'])
  })

  it('limits, streams and stops early', async () => {
    const [r] = await db.runScript(id, 'SELECT * FROM dbm_events', { maxRows: 100 })
    expect(r!.results![0]).toMatchObject({ rowCount: 100, truncated: true })
    let streamed = 0
    for await (const batch of db.streamQuery(id, 'SELECT * FROM dbm_events', { batchSize: 1000 })) streamed += batch.rows.length
    expect(streamed).toBe(2500)
    for await (const batch of db.streamQuery(id, 'SELECT number FROM numbers(100000000)')) {
      expect(batch.rows.length).toBeGreaterThan(0)
      break
    }
  })

  it('explains and inlines parameters safely', async () => {
    const plan = await explainQuery(db, id, "SELECT count() FROM dbm_events WHERE kind = 'buy'")
    expect(plan.format).toBe('text')
    expect(plan.raw).toMatch(/ReadFromMergeTree/)
    expect(inlineClickHouseParams('SELECT {__p1}, {__p2}, {__p3}', ["it's \\ ok", 5, null])).toBe("SELECT 'it\\'s \\\\ ok', 5, NULL")
  })
})

// With progress headers the response is 200 before the query ends: an error after that arrives in the body, and
// must still be an error (review L11), in a result and in a stream (export).
describe('ClickHouse: a query that fails after it started sending', () => {
  const late = "SELECT number, throwIf(number = 1500, 'late failure') AS x FROM numbers(2000) WHERE sleepEachRow(0.001) = 0 SETTINGS max_block_size = 100, http_headers_progress_interval_ms = 100"
  it('is an error, not fewer rows', async () => {
    const [outcome] = await db.runScript(id, late)
    expect(outcome?.error?.message).toMatch(/late failure|FUNCTION_THROW_IF_VALUE_IS_NON_ZERO/)
  })

  it('ends a stream with the error after the rows sent before it', async () => {
    let rows = 0
    const read = async () => {
      for await (const batch of db.streamQuery(id, late, { batchSize: 100 })) rows += batch.rows.length
    }
    await expect(read()).rejects.toThrow(/late failure|FUNCTION_THROW_IF_VALUE_IS_NON_ZERO|Cannot parse|Unexpected/)
    expect(rows).toBeLessThanOrEqual(1500)
  })
})

describe('ClickHouse client warnings (npm package testing)', () => {
  it('connects and queries without the client warning about progress headers on stderr', async () => {
    const said: string[] = []
    const write = process.stderr.write.bind(process.stderr)
    const warn = console.warn
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      said.push(String(chunk))
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof process.stderr.write
    console.warn = (...args: unknown[]) => void said.push(args.map(String).join(' '))
    try {
      const other = new DatabaseService()
      await other.connect({ id: 'ch2', name: 'ch2', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' })
      await other.runScript('ch2', 'SELECT 1')
      await other.disconnectAll()
    } finally {
      process.stderr.write = write
      console.warn = warn
    }
    expect(said.filter((s) => /send_progress_in_http_headers|\[WARN\]/.test(s))).toEqual([])
  })
})
