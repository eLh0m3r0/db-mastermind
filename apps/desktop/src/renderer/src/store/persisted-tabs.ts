/**
 * The tabs as saved with the workspace: a large .sql file's tab keeps no text (it was re-sent on every change). Its
 * file time is cleared, so after a restart the tab sees the file as changed and reads it again.
 */
export function persistedTabs<T extends { kind: string }>(tabs: T[]): T[] {
  return tabs.map((tab) => {
    const query = tab as T & { large?: boolean; file?: { mtimeMs: number } }
    if (tab.kind !== 'query' || !query.large) return tab
    return { ...tab, sql: '', savedSql: '', ...(query.file ? { file: { ...query.file, mtimeMs: 0 } } : {}) }
  })
}
