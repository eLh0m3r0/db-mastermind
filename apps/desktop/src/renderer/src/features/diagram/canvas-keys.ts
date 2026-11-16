/** Where focus is when a key belongs to a list, a dialog, a button or a text field rather than to the canvas. */
const ELSEWHERE = 'input, textarea, select, button, a[href], .cm-editor, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="tree"], [role="grid"]'

interface CanvasElement {
  isConnected: boolean
  offsetParent: unknown
  contains(node: never): boolean
}

/**
 * Whether a key or clipboard event acts on this diagram's canvas: the canvas is shown, its pane is the focused one
 * (a split shows two), no dialog is open, and focus is on the canvas or nowhere. Every tab stays mounted, and xyflow
 * and the window listeners hear keys pressed anywhere: Delete in a list must never drop the tables selected here.
 */
export function canvasOwnsKey(
  target: EventTarget | null,
  canvas: CanvasElement | null,
  options: { focused: boolean; dialogOpen: boolean; body: unknown },
): boolean {
  if (!options.focused || options.dialogOpen || !canvas?.isConnected || canvas.offsetParent === null) return false
  if (!target || target === options.body) return true
  const el = target as { closest?: (selector: string) => unknown }
  if (typeof el.closest === 'function' && el.closest(ELSEWHERE)) return false
  return canvas.contains(target as never)
}
