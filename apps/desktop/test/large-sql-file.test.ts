import { describe, expect, it } from 'vitest'
import { persistedTabs } from '../src/renderer/src/store/persisted-tabs'
import { LARGE_SQL_FILE } from '../src/main/sql-files'

describe('a large .sql file', () => {
  it('asks above a few megabytes', () => {
    expect(LARGE_SQL_FILE).toBeGreaterThanOrEqual(1024 * 1024)
    expect(LARGE_SQL_FILE).toBeLessThanOrEqual(20 * 1024 * 1024)
  })

  it('its tab is saved with the workspace without its text, and reads the file again after a restart', () => {
    const big = { kind: 'query', id: 'a', sql: 'x'.repeat(1000), savedSql: 'x'.repeat(1000), path: '/d/dump.sql', large: true, file: { format: { encoding: 'utf-8', bom: false, eol: '\n' }, mtimeMs: 123 } }
    const small = { kind: 'query', id: 'b', sql: 'SELECT 1', savedSql: 'SELECT 1', path: '/d/a.sql', file: { format: { encoding: 'utf-8', bom: false, eol: '\n' }, mtimeMs: 5 } }
    const other = { kind: 'knowledge', id: 'c', file: 'notes.md' }
    const [a, b, c] = persistedTabs([big, small, other])
    expect(a).toMatchObject({ sql: '', savedSql: '', path: '/d/dump.sql', file: { mtimeMs: 0 } })
    expect(b).toBe(small)
    expect(c).toBe(other)
  })
})
