// The diagram's series palette (styles.css --series-1…8) as hues; DeZign's free colors go to the nearest one.
const PALETTE_HUES = [213, 17, 159, 41, 337, 120, 248, 0]
// The palette's light-theme colors, as tints: a table fill in DeZign has black text on it.
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
/** A light fill (`#rrggbb`) for a palette index (1–8), for writing a color back into a diagram of another tool. */
export function paletteFill(index: number): string | undefined {
  const hex = PALETTE[index - 1]
  if (!hex) return undefined
  return `#${[1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.3 + 255 * 0.7).toString(16).padStart(2, '0')).join('')}`
}

/** Palette index (1–8) for a `#rrggbb` fill, or undefined for white, grays and other colors without a hue. */
export function paletteIndex(hex: string): number | undefined {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (!Number.isFinite(max) || max - min < 0.12) return undefined
  const d = max - min
  const hue = (60 * (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) + 360) % 360
  const distance = (h: number) => Math.min(Math.abs(h - hue), 360 - Math.abs(h - hue))
  return PALETTE_HUES.indexOf([...PALETTE_HUES].sort((a, c) => distance(a) - distance(c))[0]!) + 1
}
