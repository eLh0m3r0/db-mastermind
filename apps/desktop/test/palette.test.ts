import { describe, expect, it } from 'vitest'
import { paletteIndex } from '../src/main/palette'

describe('free colors of an imported diagram on the series palette', () => {
  it('goes to the nearest hue', () => {
    // Blue, Orange, Teal, Yellow, Pink, Green, Purple, Red are 1…8.
    expect(paletteIndex('#ffff80')).toBe(4)
    expect(paletteIndex('#80ff80')).toBe(6)
    expect(paletteIndex('#ff8040')).toBe(2)
    expect(paletteIndex('#ff0000')).toBe(8)
    expect(paletteIndex('#99ccff')).toBe(1)
    expect(paletteIndex('#cc99ff')).toBe(7)
  })

  it('leaves white and grays uncolored', () => {
    expect(paletteIndex('#ffffff')).toBeUndefined()
    expect(paletteIndex('#c0c0c0')).toBeUndefined()
    expect(paletteIndex('#f5f5f5')).toBeUndefined()
    expect(paletteIndex('')).toBeUndefined()
  })
})
