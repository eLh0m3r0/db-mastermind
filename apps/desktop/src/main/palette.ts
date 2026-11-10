// The diagram's series palette (styles.css --series-1…8) as hues; DeZign's free colors go to the nearest one.
const PALETTE_HUES = [213, 17, 159, 41, 337, 120, 248, 0]
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
