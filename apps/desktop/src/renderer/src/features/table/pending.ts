import type { QueryResult } from '@dbmastermind/core/browser'

/** Unsaved grid changes: edits and deletions by row number in the loaded page, inserted rows after them. */
export interface PendingRows<V> {
  edits: Map<number, V>
  inserted: unknown[]
  deleted: Set<number>
}

/**
 * Unsaved changes moved onto a page loaded again (Commit / Roll back reloads the rows): rows are found again by
 * their key, since a rollback can remove or reorder rows. `lost`: changes whose row is no longer there.
 */
export function carryPending<V, P extends PendingRows<V>>(pending: P, before: QueryResult, after: QueryResult, keyColumns: string[]): { pending: P; lost: number } {
  if (!pending.edits.size && !pending.deleted.size) return { pending, lost: 0 }
  const keyOf = (result: QueryResult) => {
    const at = keyColumns.map((k) => result.fields.findIndex((f) => f.name === k))
    return (row: number) => (at.some((i) => i < 0) ? undefined : JSON.stringify(at.map((i) => result.rows[row]?.[i] ?? null)))
  }
  const oldKey = keyOf(before)
  const newKey = keyOf(after)
  const rowOf = new Map<string, number>()
  for (let r = 0; r < after.rows.length; r++) {
    const k = newKey(r)
    if (k !== undefined) rowOf.set(k, r)
  }
  let lost = 0
  const moved = (row: number) => {
    const k = oldKey(row)
    const r = k === undefined ? undefined : rowOf.get(k)
    if (r === undefined) lost++
    return r
  }
  const edits = new Map<number, V>()
  for (const [row, values] of pending.edits) {
    const r = moved(row)
    if (r !== undefined) edits.set(r, values)
  }
  const deleted = new Set<number>()
  for (const row of pending.deleted) {
    const r = moved(row)
    if (r !== undefined) deleted.add(r)
  }
  return { pending: { ...pending, edits, deleted }, lost }
}
