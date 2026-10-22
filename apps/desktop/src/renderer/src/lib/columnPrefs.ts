/** Per-table grid layout: column order, hidden columns and widths, remembered on this computer. */
export interface ColumnPrefs {
  order?: string[]
  hidden?: string[]
  widths?: Record<string, number>
}

const key = (id: string) => `columns:${id}`

export function loadColumnPrefs(id: string): ColumnPrefs {
  try {
    return JSON.parse(localStorage.getItem(key(id)) ?? '{}') as ColumnPrefs
  } catch {
    return {}
  }
}

export function saveColumnPrefs(id: string, prefs: ColumnPrefs): void {
  try {
    if (!prefs.order?.length && !prefs.hidden?.length && !Object.keys(prefs.widths ?? {}).length) localStorage.removeItem(key(id))
    else localStorage.setItem(key(id), JSON.stringify(prefs))
  } catch {
    // Storage unavailable: the layout just isn't remembered.
  }
}

/** Field indexes in display order, without hidden ones (unknown fields keep their place at the end). */
export function columnView(fields: { name: string }[], prefs: ColumnPrefs): number[] {
  const hidden = new Set(prefs.hidden ?? [])
  const rank = new Map((prefs.order ?? []).map((n, i) => [n, i]))
  return fields
    .map((f, i) => ({ i, name: f.name }))
    .filter((f) => !hidden.has(f.name))
    .sort((a, b) => (rank.get(a.name) ?? 1e6 + a.i) - (rank.get(b.name) ?? 1e6 + b.i))
    .map((f) => f.i)
}
