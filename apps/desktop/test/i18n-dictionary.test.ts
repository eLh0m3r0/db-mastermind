import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cs } from '../src/renderer/src/lib/i18n-cs'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('Czech dictionary', () => {
  const entries = Object.entries(cs)

  it('keeps every entry inside the dictionary (not in the header comment)', () => {
    const source = readFileSync(new URL('../src/renderer/src/lib/i18n-cs.ts', import.meta.url), 'utf8')
    const header = source.slice(0, source.indexOf('export const cs'))
    expect(header).not.toMatch(/^\s+'.+': '.*',$/m)
  })

  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(100)
  })

  it.each(entries)('%s', (key, value) => {
    expect(value.trim()).not.toBe('')
    expect(placeholders(value)).toEqual(placeholders(key))
  })

  it('plural few-forms extend an existing many-form', () => {
    for (const key of Object.keys(cs).filter((k) => k.endsWith('|few'))) {
      expect(cs[key.slice(0, -'|few'.length)]).toBeDefined()
    }
  })
})
