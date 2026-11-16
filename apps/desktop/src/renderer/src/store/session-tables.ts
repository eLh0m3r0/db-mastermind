import { create } from 'zustand'

/**
 * Tables a query tab's own runs created (CREATE TEMP TABLE …), by tab: they live as long as the tab's session, and
 * the editor's warnings must not call them unknown (`inspectSql`'s `sessionTables`).
 */
export const useSessionTables = create<Record<string, { connectionId: string; tables: string[] }>>(() => ({}))

const EMPTY: string[] = []
export const sessionTablesOf = (state: Record<string, { tables: string[] }>, tabId: string): string[] => state[tabId]?.tables ?? EMPTY

/** After a run: the tables its statements that succeeded created. */
export function rememberSessionTables(tabId: string, connectionId: string, created: string[]): void {
  if (!created.length) return
  useSessionTables.setState((s) => {
    const before = s[tabId]?.connectionId === connectionId ? s[tabId]!.tables : []
    const tables = [...new Set([...before, ...created])]
    return tables.length === before.length ? s : { ...s, [tabId]: { connectionId, tables } }
  }, true)
}

/** The tab's session was released (tab closed). */
export function forgetSessionTables(tabId: string): void {
  if (!useSessionTables.getState()[tabId]) return
  useSessionTables.setState((s) => {
    const next = { ...s }
    delete next[tabId]
    return next
  }, true)
}

/** The connection went away or reconnected: its sessions, and their temporary tables, went with it. */
export function forgetSessionTablesOf(connectionId: string): void {
  useSessionTables.setState((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v.connectionId !== connectionId)), true)
}
