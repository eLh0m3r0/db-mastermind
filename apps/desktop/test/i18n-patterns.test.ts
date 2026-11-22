import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { readVerdict } from '../../../packages/core/src/sql-readonly'

vi.mock('@/store/settings', () => ({ useSettings: { getState: () => ({ settings: { language: 'cs' } }) } }))
const { csFromPattern, csPart, t } = await import('../src/renderer/src/lib/i18n')
const { cs } = await import('../src/renderer/src/lib/i18n-cs')

const core = new URL('../../../packages/core/src/', import.meta.url)
const sources = (dir: URL): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(new URL(`${e.name}/`, dir)) : e.name.endsWith('.ts') ? [readFileSync(new URL(e.name, dir), 'utf8')] : [],
  )
/** String literals of the core, each `${…}` filled with a statement word. */
const literals = (source: string) =>
  [...source.replace(/\$\{[^{}]*\}/g, 'UPDATE').matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3]!).replace(/\\(.)/g, '$1'))
// Lowercase English words: a part still in English has some (statement words and names are upper case or code).
const english = (text: string) => /\b(an?|the|is|not|of|that|with|runs?|reads?|can't|here|only|are)\b/.test(text.replace(/ a /g, ' '))
const readOnlySource = readFileSync(new URL('sql-readonly.ts', core), 'utf8')

describe('read-only refusals in Czech', () => {
  it('every refusal message in the core has Czech', () => {
    const messages = sources(core)
      .flatMap(literals)
      .filter((l) => /^(This connection is read-only|Only reads are allowed here|There is no statement|A filter is|It could not be read|The filter could not|Only one|This connection runs|SQL Server (gave|could not)|This login may not)/.test(l))
    expect(messages.length).toBeGreaterThan(15)
    expect(messages.filter((m) => !cs[m] && !csFromPattern(m))).toEqual([])
  })

  it('every part a refusal names (what was refused, what to do instead) has Czech', () => {
    const parts = [...readOnlySource.replace(/\$\{[^{}]*\}/g, 'UPDATE').matchAll(/refuse\(profile, (?:'((?:[^'\\]|\\.)*)'|`([^`]*)`|"([^"]*)")(?:, (?:profile === 'user' \? )?'((?:[^'\\]|\\.)*)')?/g)].flatMap((m) =>
      [m[1] ?? m[2] ?? m[3], m[4]].filter((p): p is string => !!p).map((p) => p.replace(/\\(.)/g, '$1')),
    )
    expect(parts.length).toBeGreaterThan(20)
    expect(parts.filter((p) => english(p) && english(csPart(p)))).toEqual([])
  })

  it('every refused function says in Czech what it does', () => {
    const block = readOnlySource.slice(readOnlySource.indexOf('const REFUSED_CALLS'), readOnlySource.indexOf('\n]\n', readOnlySource.indexOf('const REFUSED_CALLS')))
    const what = [...block.matchAll(/\[\[[^\]]*\],\s*(['"])(.*?)\1,\s*(['"])(.*?)\3\]/g)].map((m) => m[4]!)
    expect(what.length).toBeGreaterThan(50)
    expect(what.filter((w) => !cs[w])).toEqual([])
  })

  it('the refusals the guard gives for real statements read in Czech and keep the statement word', () => {
    for (const profile of ['user', 'agent'] as const) {
      for (const [sql, driver, keep] of [
        ["update customers set city = 'X'", 'sqlite', 'UPDATE'],
        ['select * from t for share', 'postgres', 'FOR SHARE'],
        ['pragma journal_mode = wal', 'sqlite', 'PRAGMA'],
        ['select 1; delete from t', 'mssql', 'DELETE'],
        ["select pg_read_file('/etc/passwd')", 'postgres', 'pg_read_file()'],
        ['select /*! sleep(1) */ 1', 'mysql', '/*!'],
        ['set role admin', 'postgres', 'SET'],
        ["set names 'koi8r'", 'mysql', 'SET'],
        ['select * from U&"t\\0061"', 'postgres', 'U&"…"'],
        ['select * from orders@remote', 'oracle', '@'],
        ["select 1 into outfile '/tmp/x'", 'mysql', 'OUTFILE'],
        ['select /*x*/ 1', 'mysql', '/*x'],
      ] as const) {
        const verdict = readVerdict(sql, driver, { profile })
        expect(verdict.ok, `${profile}: ${sql}`).toBe(false)
        const czech = t(verdict.reason!)
        expect(czech, verdict.reason).toMatch(profile === 'user' ? /^Připojení je jen pro čtení: / : /^Tady jsou povolená jen čtení \(připojení jen pro čtení\): /)
        expect(english(czech), czech).toBe(false)
        expect(czech).toContain(keep)
      }
    }
  })

  it('texts with an entry of their own still use it, and other texts stay as they are', () => {
    expect(t('This connection is read-only. Only SELECT-like statements are allowed.')).toBe('Připojení je jen pro čtení. Povolené jsou jen příkazy typu SELECT.')
    expect(t('relation "nope" does not exist')).toBe('relation "nope" does not exist')
  })
})
