import { describe, expect, it } from 'vitest'
import { TooManyRowsError } from '@dbmastermind/core'
import { saveErrorText } from '../src/renderer/src/features/table/save-errors'
import { cs } from '../src/renderer/src/lib/i18n-cs'

const czech = (text: string, vars: Record<string, string> = {}) => (cs[text] ?? text).replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
const english = (text: string, vars: Record<string, string> = {}) => text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)

describe('a grid save that would change several rows', () => {
  it('shows core’s message, in Czech too, for the immediate save and the tab’s transaction', () => {
    for (const err of [new TooManyRowsError(3), new TooManyRowsError(7, 'Roll back the tab’s transaction: it can no longer be committed.')]) {
      const cz = saveErrorText(err.message, czech)
      expect(cz).toContain(err.rows === 3 ? '3 řádků' : '7 řádků')
      expect(cz).not.toMatch(/This change|Nothing was saved|Roll back/)
      expect(saveErrorText(err.message, english)).toContain(`${err.rows} rows`)
    }
    expect(saveErrorText(new TooManyRowsError(3).message, czech)).toMatch(/Nic se neuložilo\.$/)
    expect(saveErrorText(new TooManyRowsError(7, 'Roll back the tab’s transaction: it can no longer be committed.').message, czech)).toMatch(/už ji nelze potvrdit\.$/)
  })

  it('other messages go through as they are', () => {
    expect(saveErrorText('duplicate key value', czech)).toBe('duplicate key value')
  })
})

describe('Storage without VIEW DATABASE STATE', () => {
  it('core’s note has a Czech translation', () => {
    expect(cs['Table sizes need the VIEW DATABASE STATE permission: the row counts are estimates from the schema.']).toBeTruthy()
  })
})
