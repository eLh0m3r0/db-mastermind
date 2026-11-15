interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The saved window position, only if enough of the window's top (its title bar) lands on a display: after a monitor
 * is unplugged Windows would open the window on the missing screen, where nobody can reach it (macOS moves it back by
 * itself). Undefined lets the window open centred.
 */
export function reachablePosition(saved: Partial<Rect>, workAreas: Rect[]): { x: number; y: number } | undefined {
  if (typeof saved.x !== 'number' || typeof saved.y !== 'number') return undefined
  const width = saved.width ?? 800
  const titleBar = { x: saved.x, y: saved.y, width, height: 40 }
  const reachable = workAreas.some((a) => {
    const w = Math.min(titleBar.x + titleBar.width, a.x + a.width) - Math.max(titleBar.x, a.x)
    const h = Math.min(titleBar.y + titleBar.height, a.y + a.height) - Math.max(titleBar.y, a.y)
    return w >= 120 && h >= 20
  })
  return reachable ? { x: saved.x, y: saved.y } : undefined
}
