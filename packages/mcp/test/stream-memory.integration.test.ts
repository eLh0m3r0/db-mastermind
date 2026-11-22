import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

/**
 * A read of any size streams through the guard: `dbm query` without --allow-writes (SQL nobody confirmed) and the
 * desktop app's "export every row" on a read-only connection keep their peak memory flat, a million rows or three.
 * Each run is a child process of its own, so its peak memory is its own. (Holding the rows grew it by ~400 MB.)
 */
const skip = new Set((process.env.DBM_SKIP ?? '').split(','))
const dir = mkdtempSync(join(tmpdir(), 'dbm-stream-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')

function run(mode: string, driver: string, rows: number): { rows: number; maxRssKb: number; bytes: number } {
  const out = join(dir, `${mode}-${driver}-${rows}.csv`)
  const text = execFileSync(process.execPath, [join(root, 'node_modules/jiti/lib/jiti-cli.mjs'), join(here, 'stream-memory-child.ts'), mode, driver, String(rows), out], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 20 })
  const result = JSON.parse(text.trim().split('\n').at(-1)!) as { rows: number; maxRssKb: number }
  const bytes = statSync(out).size
  rmSync(out)
  return { ...result, bytes }
}

for (const driver of ['postgres', 'mssql']) {
  describe.skipIf(skip.has(driver))(`streaming through the guard on ${driver}`, () => {
    for (const mode of ['dbm', 'export']) {
      it(`${mode === 'dbm' ? 'dbm query --format csv' : 'export every row (read-only connection)'}: 1 and 3 million rows, the same peak memory`, { timeout: 600_000 }, () => {
        const small = run(mode, driver, 1_000_000)
        const big = run(mode, driver, 3_000_000)
        expect(small.rows).toBe(1_000_000)
        expect(big.rows).toBe(3_000_000)
        expect(big.bytes).toBeGreaterThan(small.bytes * 2.5)
        console.log(`${driver} ${mode}: peak ${Math.round(small.maxRssKb / 1024)} MB for 1M rows, ${Math.round(big.maxRssKb / 1024)} MB for 3M`)
        expect(big.maxRssKb - small.maxRssKb).toBeLessThan(60 * 1024)
      })
    }
  })
}
