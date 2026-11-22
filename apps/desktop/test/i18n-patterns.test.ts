import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { readVerdict } from '../../../packages/core/src/sql-readonly'

vi.mock('@/store/settings', () => ({ useSettings: { getState: () => ({ settings: { language: 'cs' } }) } }))
const { csFromPattern, t } = await import('../src/renderer/src/lib/i18n')

const coreSources = (dir: URL): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? coreSources(new URL(`${e.name}/`, dir)) : e.name.endsWith('.ts') ? [readFileSync(new URL(e.name, dir), 'utf8')] : [],
  )

describe('read-only refusals in Czech', () => {
  it('every refusal the core builds at run time has Czech (each ${…} filled in)', () => {
    const literals = coreSources(new URL('../../../packages/core/src/', import.meta.url)).flatMap((source) =>
      [...source.matchAll(/(['`])((?:Only reads are allowed here \(read-only\)|SQL Server could not plan this batch)[^'`]*)\1/g)].map((m) => m[2]!),
    )
    expect(literals.length).toBeGreaterThan(15)
    const untranslated = literals.map((l) => l.replace(/\$\{[^}]*\}/g, 'UPDATE')).filter((l) => !csFromPattern(l))
    expect(untranslated).toEqual([])
  })

  it('the refusals the guard gives for real statements read in Czech and keep the statement word', () => {
    for (const [sql, driver, word] of [
      ["update customers set city = 'X'", 'sqlite', 'UPDATE'],
      ['select * from t for share', 'postgres', ''],
      ['pragma journal_mode = wal', 'sqlite', ''],
      ['select 1; delete from t', 'mssql', 'DELETE'],
    ] as const) {
      const verdict = readVerdict(sql, driver)
      expect(verdict.ok).toBe(false)
      const czech = t(verdict.reason!)
      expect(czech).toMatch(/^Tady jsou povolená jen čtení \(připojení jen pro čtení\): /)
      expect(czech).not.toMatch(/ is not| are not|starting with/)
      if (word) expect(czech).toContain(word)
    }
  })

  it('texts with an entry of their own still use it, and other texts stay as they are', () => {
    expect(t('This connection is read-only. Only SELECT-like statements are allowed.')).toBe('Připojení je jen pro čtení. Povolené jsou jen příkazy typu SELECT.')
    expect(t('relation "nope" does not exist')).toBe('relation "nope" does not exist')
  })
})
