import { isReadOnlyScript, type DriverId, type StatementOutcome } from '@dbmastermind/core/browser'

/**
 * What "Load all rows" runs again: only the statement whose result is shown, and only when it reads. Running the
 * whole last run again would apply its writes a second time. `offset`: where the last run started in the editor.
 */
export function loadAllTarget(statement: Pick<StatementOutcome, 'sql' | 'start'>, offset: number, driver: DriverId): { sql: string; offset: number } | null {
  if (!statement.sql.trim() || !isReadOnlyScript(statement.sql, driver)) return null
  return { sql: statement.sql, offset: offset + statement.start }
}

/** The run's results with the one statement's new outcome in its place (the other results stay). */
export function withReloaded(outcomes: StatementOutcome[] | null, statement: StatementOutcome, reloaded: StatementOutcome[]): StatementOutcome[] {
  const at = outcomes?.indexOf(statement) ?? -1
  const fresh = reloaded.length === 1 ? { ...reloaded[0]!, start: statement.start, end: statement.end } : undefined
  if (!outcomes || at < 0 || !fresh) return reloaded
  return outcomes.map((o, i) => (i === at ? fresh : o))
}
