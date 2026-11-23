/**
 * Chart series colours that belong to the appearance (accent and look): the first series is the accent, the others
 * an ordered categorical palette derived for that appearance's background, so a chart in the terminal look is not the
 * default blue. The checks are the ones the previous fixed palette was validated with (OKLab ΔE ×100, Machado et al.
 * colour-vision simulation): neighbouring series at least 8 apart for protanopia and deuteranopia and 15 for normal
 * vision, and every series at least 3:1 against the chart's background (stricter than before: three of the fixed
 * light colours were below). Red and yellow, which read as error and warning, come last. Pure: no DOM (applied in
 * store/settings.ts, measured in chart-palette.test.ts).
 */

type Rgb = [number, number, number]

const hexToRgb = (hex: string): Rgb => {
  const h = hex.replace('#', '')
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Rgb
}
const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const lin2s = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const toLin = (hex: string): Rgb => hexToRgb(hex).map(s2lin) as Rgb

export function contrast(a: string, b: string): number {
  const lum = (h: string) => {
    const [r, g, bl] = toLin(h)
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

function oklabFromLin([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}

function linFromOklab([L, a, b]: Rgb): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}

export function oklch(hex: string): { l: number; c: number; h: number } {
  const [L, a, b] = oklabFromLin(toLin(hex))
  return { l: L, c: Math.hypot(a, b), h: ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360 }
}

/** A colour in OKLCH as `#rrggbb`, chroma lowered until it fits sRGB. */
export function fromOklch(l: number, c: number, h: number): string {
  for (let chroma = c; chroma >= 0; chroma -= 0.005) {
    const rad = (h * Math.PI) / 180
    const rgb = linFromOklab([l, chroma * Math.cos(rad), chroma * Math.sin(rad)])
    if (rgb.every((v) => v >= -0.0005 && v <= 1.0005)) return `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, lin2s(v))) * 255).toString(16).padStart(2, '0')).join('')}`
  }
  return '#808080'
}

const MACHADO: Record<'protan' | 'deutan', [Rgb, Rgb, Rgb]> = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
}

/** OKLab distance ×100, as seen with normal vision or simulated protanopia / deuteranopia. */
export function deltaE(a: string, b: string, kind?: 'protan' | 'deutan'): number {
  const see = (hex: string): Rgb => {
    const rgb = toLin(hex)
    if (!kind) return rgb
    const m = MACHADO[kind]
    return m.map((row) => Math.max(0, Math.min(1, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) as Rgb
  }
  const [x, y] = [oklabFromLin(see(a)), oklabFromLin(see(b))]
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

export const CONTRAST_MIN = 3
export const CVD_MIN = 8
export const NORMAL_MIN = 15

/** Hues in the order series take them (the previous palette's hues, red and yellow moved to the end), then spares. */
const HUES = [255, 45, 165, 340, 140, 295, 200, 90, 25, 320, 70]
const SERIES = 8

/** How far apart two hues are, in degrees. */
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))

/** Moves a colour's lightness (same hue and chroma) until it has 3:1 against every background. */
function readable(l: number, c: number, h: number, backgrounds: string[], dark: boolean): string | undefined {
  for (let step = 0; step <= 40; step++) {
    const hex = fromOklch(dark ? l + step * 0.01 : l - step * 0.01, c, h)
    if (backgrounds.every((bg) => contrast(hex, bg) >= CONTRAST_MIN)) return hex
  }
  return undefined
}

const apart = (a: string, b: string) => Math.min(deltaE(a, b, 'protan'), deltaE(a, b, 'deutan')) >= CVD_MIN && deltaE(a, b) >= NORMAL_MIN

/**
 * Eight series colours for an appearance: `accent` first (its lightness moved only if it lacks 3:1), then hues in
 * priority order, skipping those next to the accent's hue, each made readable on `backgrounds` and kept clearly apart
 * from the series before it (lightness steps tried in turn; a hue that can't be is left for later).
 */
export function chartPalette(accent: string, backgrounds: string[], dark: boolean): string[] {
  const a = oklch(accent)
  const first = backgrounds.every((bg) => contrast(accent, bg) >= CONTRAST_MIN) ? accent : (readable(a.l, a.c, a.h, backgrounds, dark) ?? accent)
  const out = [first]
  const pending = HUES.filter((h) => a.c < 0.04 || hueGap(h, a.h) >= 30)
  const baseL = dark ? 0.7 : 0.58
  while (out.length < SERIES && pending.length) {
    let placed = false
    for (const [i, h] of pending.entries()) {
      for (const dl of [0, 0.08, -0.08, 0.14, -0.14]) {
        const hex = readable(baseL + dl, 0.16, h, backgrounds, dark)
        if (hex && apart(hex, out.at(-1)!) && !out.includes(hex)) {
          out.push(hex)
          pending.splice(i, 1)
          placed = true
          break
        }
      }
      if (placed) break
    }
    if (!placed) break
  }
  return out
}

/** Sets `--chart-1…8` on the document from its current accent and backgrounds (after a look or theme change). */
export function applyChartPalette(root: HTMLElement, dark: boolean): void {
  const css = getComputedStyle(root)
  const color = (name: string) => normalizeHex(css.getPropertyValue(name).trim())
  const accent = color('--accent')
  const backgrounds = ['--bg', '--bg-elevated'].map(color).filter((c): c is string => !!c)
  if (!accent || !backgrounds.length) return
  chartPalette(accent, backgrounds, dark).forEach((hex, i) => root.style.setProperty(`--chart-${i + 1}`, hex))
}

/** `#rgb` / `#rrggbb` as `#rrggbb`; anything else (rgba(), names) undefined. */
export function normalizeHex(value: string): string | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (!m) return undefined
  const h = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!
  return `#${h.toLowerCase()}`
}
