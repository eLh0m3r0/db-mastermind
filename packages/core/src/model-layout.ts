/**
 * The layout of a model's diagrams (positions, colors, notes, frames, named diagrams) kept in its own DBML file, as
 * a comment at the end: DBML tools skip comments, so the file stays plain DBML for them.
 */
export type ModelLayout = Record<string, unknown>

const MARK = '// dbmastermind-layout: '
const NOTE = '// Diagram layout kept by DB Mastermind (positions, colors, notes, diagrams):'

/** The model text without its layout comment, and the layout it held. */
export function splitModelLayout(text: string): { text: string; layout?: ModelLayout } {
  const at = text.lastIndexOf(`\n${MARK}`)
  const start = text.startsWith(MARK) ? 0 : at === -1 ? -1 : at + 1
  if (start === -1) return { text }
  const end = text.indexOf('\n', start)
  const line = text.slice(start + MARK.length, end === -1 ? undefined : end)
  let layout: ModelLayout | undefined
  try {
    const parsed: unknown = JSON.parse(line)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) layout = parsed as ModelLayout
  } catch {
    return { text }
  }
  // (The note line before it goes too.)
  let before = text.slice(0, start)
  if (before.endsWith(`${NOTE}\n`)) before = before.slice(0, -NOTE.length - 1)
  return { text: before.replace(/\n+$/, '\n') + (end === -1 ? '' : text.slice(end + 1)), layout }
}

/** The model text with its layout as the last lines (none when there is nothing to keep). */
export function withModelLayout(text: string, layout: ModelLayout | undefined): string {
  const plain = splitModelLayout(text).text.replace(/\s+$/, '')
  const kept = Object.fromEntries(
    Object.entries(layout ?? {}).filter(
      ([, v]) =>
        v !== undefined &&
        v !== null &&
        !(Array.isArray(v) && !v.length) &&
        !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v as object).length),
    ),
  )
  if (!Object.keys(kept).length) return `${plain}\n`
  return `${plain}\n\n${NOTE}\n${MARK}${JSON.stringify(kept)}\n`
}
