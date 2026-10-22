import { describe, expect, it } from 'vitest'
import { cs } from '../src/renderer/src/lib/i18n-cs'

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('Czech dictionary', () => {
  const entries = Object.entries(cs)

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
