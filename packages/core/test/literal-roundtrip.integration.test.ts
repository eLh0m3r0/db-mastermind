import { afterAll, describe, expect, it } from 'vitest'
import { compareTableData, dataSyncScript, DatabaseService, getDialect, sqlValue, type CellValue, type ConnectionConfig, type DriverId } from '../src/index.js'
import { engines, setupEngine, skip } from './fixtures.js'
import { rng } from './orm-fuzz.js'

/**
 * Wave 10, values written into SQL text: a table of a few hundred nasty values (backslashes, quotes of every kind,
 * NUL, line breaks, Unicode, text that looks like comments or placeholders, binary, extreme numbers) becomes SQL
 * the way the app writes it (the SQL export and Copy as SQL INSERT: sqlValue per cell; the data-compare sync
 * script: dataSyncScript), that script runs into an empty copy, and the copy is identical. A canary is untouched.
 */
const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())
const ORACLE: ConnectionConfig = { id: 'ora-lit', name: 'ora', driver: 'oracle', host: '127.0.0.1', port: 15219, user: 'shop', password: 'mastermind', database: 'FREEPDB1' }
const CLICKHOUSE: ConnectionConfig = { id: 'ch-lit', name: 'ch', driver: 'clickhouse', host: '127.0.0.1', port: 18123, user: 'default', password: 'mastermind', database: 'default' }

const PIECES = ['\\', "\\'", "'", "''", '"', '`', '\u0000', '\n', '\r\n', '\t', '--', '-- ', '/*', '*/', '#', '?', '$1', ':name', ':1', '@p1', '{__p1}', '%', '_', '\\%', '\\_', 'ěščřžýáíé', '😀', '‮', '​', ' ', 'x', "' OR 1=1 --", '\\0', '\\n', "N'", "E'", '$$', '; DELETE FROM dbm_lit_canary; ', 'NULL', '0x41']
const NUMBERS = [0, 1.5, -2.25, 123456789.123, 1.7976931348623157e308, -1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, 1e-300, 42]

function values(nul: boolean): { s: string; n: number; b: string }[] {
  const r = rng(20261122)
  const out: { s: string; n: number; b: string }[] = PIECES.map((p, i) => ({ s: `a${p}`, n: NUMBERS[i % NUMBERS.length]!, b: '' }))
  for (let i = 0; i < 260; i++) {
    let s = ''
    const len = 1 + Math.floor(r() * 6)
    for (let j = 0; j < len; j++) s += PIECES[Math.floor(r() * PIECES.length)]
    out.push({ s, n: NUMBERS[Math.floor(r() * NUMBERS.length)]!, b: '' })
  }
  out.push({ s: `${'long \\ \u0000 '.repeat(600)}end\\`, n: 1, b: '' })
  out.push({ s: 'ends with a backslash\\', n: 2, b: '' })
  for (const [i, v] of out.entries()) v.b = Buffer.from(`${i}:${v.s}`.slice(0, 40), 'utf8').toString('hex') + (i % 3 ? '00ff27' : '5c27')
  // (PostgreSQL text can't hold NUL; Oracle reads '' as NULL.)
  return out.map((v) => ({ ...v, s: (nul ? v.s : v.s.replaceAll('\u0000', '')) || 'x' }))
}

const TYPES: Partial<Record<DriverId, { text: string; num: string; bin?: string; engine?: string }>> = {
  postgres: { text: 'text', num: 'double precision', bin: 'bytea' },
  mysql: { text: 'longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', num: 'double', bin: 'longblob' },
  mariadb: { text: 'longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', num: 'double', bin: 'longblob' },
  mssql: { text: 'nvarchar(max)', num: 'float', bin: 'varbinary(max)' },
  oracle: { text: 'NCLOB', num: 'BINARY_DOUBLE', bin: 'BLOB' },
  sqlite: { text: 'text', num: 'real', bin: 'blob' },
  duckdb: { text: 'varchar', num: 'double', bin: 'blob' },
  clickhouse: { text: 'String', num: 'Float64', engine: ' ENGINE = MergeTree ORDER BY id' },
}

for (const driver of ['postgres', 'mysql', 'mariadb', 'mssql', 'oracle', 'sqlite', 'duckdb', 'clickhouse'] as DriverId[]) {
  describe.skipIf(skip.has(driver))(`values written as SQL on ${driver}`, () => {
    it('the export / Copy as INSERT script and the sync script recreate the table exactly; the canary is untouched', { timeout: 300_000 }, async () => {
      let id: string
      if (driver === 'oracle' || driver === 'clickhouse') {
        const c = driver === 'oracle' ? ORACLE : CLICKHOUSE
        await svc.connect(c)
        id = c.id
      } else id = (await setupEngine(svc, engines.find((e) => e.id === driver)!)).id
      const t = TYPES[driver]!
      const dialect = getDialect(driver)
      const modes = svc.serverInfo(id)?.sqlModes ?? {}
      const run = async (sql: string) => {
        const outcomes = await svc.runScript(id, sql, { readOnly: false })
        const failed = outcomes.find((o) => o.error)
        if (failed) throw new Error(`${failed.error!.message} in ${failed.sql.slice(0, 300)}`)
        return outcomes
      }
      const drop = (name: string) => (driver === 'oracle' ? `BEGIN EXECUTE IMMEDIATE 'DROP TABLE ${name}'; EXCEPTION WHEN OTHERS THEN NULL; END;` : `DROP TABLE IF EXISTS ${name}`)
      const cols = `id int${driver === 'clickhouse' ? '' : ' PRIMARY KEY'}, s ${t.text}, n ${t.num}${t.bin ? `, b ${t.bin}` : ''}`
      const TABLES = ['dbm_lit_src', 'dbm_lit_copy', 'dbm_lit_ssrc', 'dbm_lit_sync', 'dbm_lit_canary']
      for (const name of TABLES) await run(drop(name))
      for (const name of ['dbm_lit_src', 'dbm_lit_copy']) await run(`CREATE TABLE ${name} (${cols})${t.engine ?? ''}`)
      for (const name of ['dbm_lit_ssrc', 'dbm_lit_sync']) await run(`CREATE TABLE ${name} (id int${driver === 'clickhouse' ? '' : ' PRIMARY KEY'}, s ${t.text}, n ${t.num})${t.engine ?? ''}`)
      await run(`CREATE TABLE dbm_lit_canary (id int)${t.engine ?? ''}`)
      await run('INSERT INTO dbm_lit_canary VALUES (1)')
      // (PostgreSQL text can't hold a NUL; node:sqlite hands text over and back only up to one.)
      const rows = values(driver !== 'postgres' && driver !== 'sqlite')
      // The source, written with the driver's own parameters (ClickHouse inlines them through the same writer).
      const driverApi = svc.driver(id)
      const ph = (i: number) => dialect.placeholder(i)
      const unhex = (p: string) => ({ postgres: `decode(${p}, 'hex')`, mysql: `UNHEX(${p})`, mariadb: `UNHEX(${p})`, mssql: `CONVERT(varbinary(max), ${p}, 2)`, oracle: `HEXTORAW(${p})`, sqlite: `unhex(${p})`, duckdb: `from_hex(${p})` })[driver as string] ?? p
      // (Numbers go in as their text and are cast: drivers guess an integer type for 1.8e308.)
      // (SQLite's own text-to-real conversion is not exact: it takes the number as it is.)
      const asText = driver !== 'sqlite'
      const num = (p: string) => (!asText ? p : driver === 'oracle' ? `TO_BINARY_DOUBLE(${p})` : `CAST(${p} AS ${t.num})`)
      for (const [i, v] of rows.entries()) {
        await driverApi.execute(`INSERT INTO dbm_lit_src (id, s, n${t.bin ? ', b' : ''}) VALUES (${ph(1)}, ${driver === 'oracle' ? `TO_NCLOB(${ph(2)})` : ph(2)}, ${num(ph(3))}${t.bin ? `, ${unhex(ph(4))}` : ''})`, { params: [i + 1, v.s, asText ? String(v.n) : v.n, ...(t.bin ? [v.b] : [])] })
      }
      const read = async (table: string, withBinary = true) => {
        const [o] = await svc.runScript(id, `SELECT id, s, n${t.bin && withBinary ? ', b' : ''} FROM ${table} ORDER BY id`, { readOnly: false, maxRows: 100_000 })
        if (o?.error) throw new Error(o.error.message)
        return o!.results![0]!.rows.map((r) => r.map((c) => (typeof c === 'string' && /^-?\d+$/.test(c) ? Number(c) : c)))
      }
      const source = await read('dbm_lit_src')
      expect(source.length).toBe(rows.length)
      // The source holds exactly the values (the driver's own parameters were the reference).
      expect(source.map((r) => r[1])).toEqual(rows.map((v) => v.s))

      // 1. The SQL export and Copy as SQL INSERT: a literal per cell.
      const fields = ['id', 's', 'n', ...(t.bin ? ['b'] : [])]
      const script = source.map((r) => `INSERT INTO dbm_lit_copy (${fields.join(', ')}) VALUES (${r.map((v) => sqlValue(v as CellValue, driver, modes)).join(', ')});`).join('\n')
      await run(script)
      const copy = await read('dbm_lit_copy')
      // (SQLite reads a decimal literal like 1e-300 one unit in the last place off: its own parsing, not the text.)
      const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b) || (driver === 'sqlite' && typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= Math.abs(a) * 4e-16)
      const differs = copy.findIndex((r, i) => r.length !== source[i]!.length || r.some((v, j) => !same(v, source[i]![j])))
      expect(differs === -1 ? [] : [JSON.stringify(source[differs]), JSON.stringify(copy[differs]), sqlValue(source[differs]![1] as CellValue, driver, modes)]).toEqual([])

      // 2. The data-compare sync script into an empty table.
      // (Binary columns can't be synchronized with a script: the sync's tables have text and numbers.)
      await run('INSERT INTO dbm_lit_ssrc (id, s, n) SELECT id, s, n FROM dbm_lit_src')
      // (Oracle keeps unquoted names in upper case.)
      const ref = (name: string) => ({ name: driver === 'oracle' ? name.toUpperCase() : name })
      const result = await compareTableData(svc, { source: { connectionId: id, table: ref('dbm_lit_ssrc') }, target: { connectionId: id, table: ref('dbm_lit_sync') }, keyColumns: [driver === 'oracle' ? 'ID' : 'id'], maxDiffs: 100_000 })
      expect(result.counts.missing).toBe(rows.length)
      const sync = dataSyncScript(result, ref('dbm_lit_sync'), dialect, { modes })
      await run(sync)
      const synced = await read('dbm_lit_sync', false)
      const original = await read('dbm_lit_src', false)
      expect(synced.length).toBe(original.length)
      expect(synced.findIndex((r, i) => r.some((v, j) => !same(v, original[i]![j])))).toBe(-1)

      // Nothing else was touched.
      const [canary] = await svc.runScript(id, 'SELECT count(*) FROM dbm_lit_canary', { readOnly: false })
      expect(Number(canary!.results![0]!.rows[0]![0])).toBe(1)
      for (const name of TABLES) await run(drop(name))
      console.log(`${driver}: ${rows.length} values, export/INSERT ${script.length} chars, sync ${sync.split('\n').length} lines`)
    })
  })
}
