import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chartPalette, contrast, CONTRAST_MIN, CVD_MIN, deltaE, NORMAL_MIN, oklch } from '../src/renderer/src/lib/chart-palette'
import { LOOKS } from '../src/renderer/src/lib/looks'

/**
 * Every appearance's chart palette, measured: each series against that appearance's backgrounds (page and tiles),
 * neighbours apart for protanopia / deuteranopia and normal vision (the measures the previous fixed palette was
 * validated with), the accent first, red and yellow (error, warning) not early. The appearances are read from
 * styles.css, so a new look or accent is measured without touching this test.
 */
const css = readFileSync(new URL('../src/renderer/src/styles.css', import.meta.url), 'utf8')
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`)
  if (at < 0) return {}
  const body = css.slice(at, css.indexOf('}', at))
  return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]))
}
const light = block(':root')
const dark = block(':root.dark')

interface Appearance { name: string; accent: string; backgrounds: string[]; dark: boolean }
const appearances: Appearance[] = LOOKS.flatMap((look): Appearance[] => {
  if (look.dark === undefined) {
    return [false, true].map((isDark) => {
      const base = isDark ? dark : light
      const own = block(isDark ? `:root.dark.look-${look.id}` : `:root.look-${look.id}`)
      return { name: `${look.id} ${isDark ? 'dark' : 'light'}`, accent: own['--accent'] ?? base['--accent']!, backgrounds: [base['--bg']!, base['--bg-elevated']!], dark: isDark }
    })
  }
  const own = block(`:root.look-${look.id}`)
  const base = look.dark ? dark : light
  return [{ name: look.id, accent: own['--accent']!, backgrounds: [own['--bg'] ?? base['--bg']!, own['--bg-elevated'] ?? own['--bg'] ?? base['--bg-elevated']!], dark: look.dark }]
})

const measure = (a: Appearance) => {
  const p = chartPalette(a.accent, a.backgrounds, a.dark)
  const pairs = p.slice(1).map((c, i) => [p[i]!, c] as const)
  return {
    palette: p,
    contrast: Math.min(...p.flatMap((c) => a.backgrounds.map((bg) => contrast(c, bg)))),
    cvd: Math.min(...pairs.map(([x, y]) => Math.min(deltaE(x, y, 'protan'), deltaE(x, y, 'deutan')))),
    normal: Math.min(...pairs.map(([x, y]) => deltaE(x, y))),
  }
}

describe('chart palettes of every appearance', () => {
  it('reads all appearances from styles.css', () => {
    expect(appearances.length).toBe(18)
    for (const a of appearances) expect([a.accent, ...a.backgrounds].every((c) => /^#[0-9a-f]{6}$/.test(c)), a.name).toBe(true)
  })

  for (const a of appearances) {
    it(`${a.name}: accent first, 8 series, each 3:1 on its backgrounds, neighbours apart`, () => {
      const m = measure(a)
      expect(m.palette).toHaveLength(8)
      expect(Math.abs(oklch(m.palette[0]!).h - oklch(a.accent).h) < 8 || oklch(a.accent).c < 0.04).toBe(true)
      expect(m.contrast).toBeGreaterThanOrEqual(CONTRAST_MIN)
      expect(m.cvd).toBeGreaterThanOrEqual(CVD_MIN)
      expect(m.normal).toBeGreaterThanOrEqual(NORMAL_MIN)
      // Error red and warning yellow not among the first four (unless the accent itself is one).
      const warm = (hex: string) => { const { h, c } = oklch(hex); return c > 0.08 && (h < 35 || (h > 80 && h < 105)) }
      expect(m.palette.slice(1, 4).filter(warm)).toEqual([])
    })
  }

  it('prints the measured minima (the report table)', () => {
    const rows = appearances.map((a) => { const m = measure(a); return `${a.name.padEnd(16)} contrast ${m.contrast.toFixed(2)}  cvd ${m.cvd.toFixed(1)}  normal ${m.normal.toFixed(1)}  ${m.palette.join(' ')}` })
    console.log(rows.join('\n'))
    expect(rows.length).toBe(18)
  })
})
