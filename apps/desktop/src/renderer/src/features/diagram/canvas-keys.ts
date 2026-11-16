/**
 * Where focus is when a key belongs to a text field, a list, a dialog or the table panel rather than to the canvas.
 * (A button of the diagram's own toolbar or canvas counts as the diagram: ⌘Z after Align undoes it. Buttons
 * anywhere else are outside the diagram and never count.)
 */
const ELSEWHERE = 'input, textarea, select, a[href], .cm-editor, [contenteditable="true"], [role="dialog"], [role="menu"], [role="listbox"], [role="tree"], [role="grid"], [data-testid="table-panel"]'

interface CanvasElement {
  isConnected: boolean
  offsetParent: unknown
  contains(node: never): boolean
}

/**
 * Whether a key or clipboard event acts on this diagram: it is shown, its pane is the focused one (a split shows
 * two), no dialog is open, and focus is on the diagram (canvas or toolbar, not the table panel) or nowhere. Every
 * tab stays mounted, and the window listeners hear keys pressed anywhere: Delete in a list must never drop the
 * tables selected here.
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
