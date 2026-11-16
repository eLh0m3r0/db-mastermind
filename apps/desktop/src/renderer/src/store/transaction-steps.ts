import { classifyStatement, type StatementOutcome } from '@dbmastermind/core/browser'

/** A statement that ran inside the open transaction: what Commit makes permanent and Roll back undoes. */
export interface TransactionStep {
  sql: string
  /** Rows the statement changed, when the database says. */
  rows?: number
  /** A schema change (the explorer reloads after Commit / Roll back). */
  ddl?: boolean
  failed?: boolean
}

export function stepsOf(outcomes: StatementOutcome[]): TransactionStep[] {
  return outcomes
    .filter((o) => o.sql.trim() && !['read', 'transaction'].includes(classifyStatement(o.sql)) && !/^\s*(SET|USE|SHOW|PRINT)\b/i.test(o.sql))
    .map((o) => {
      const rows = o.results?.reduce<number | undefined>((n, r) => (r.affectedRows === undefined ? n : (n ?? 0) + r.affectedRows), undefined)
      const ddl = classifyStatement(o.sql) === 'ddl'
      // DDL reports 0 rows: "schema" says more.
      return { sql: o.sql.trim(), rows: ddl ? undefined : rows, ddl: ddl || undefined, failed: !!o.error || undefined }
    })
}

const BEGIN = /^\s*(BEGIN|START\s+TRANSACTION|SET\s+TRANSACTION)\b/i
/** COMMIT / ROLLBACK / END / ABORT that end the transaction; not ROLLBACK TO a savepoint. */
const END = /^\s*(COMMIT|END|ABORT|ROLLBACK(?!\s+(TRAN(SACTION)?\s+|WORK\s+)?TO\b))\b/i

/**
 * The steps of the transaction open after a run, and since when it is open. A COMMIT or ROLLBACK in the run ended
 * what was open before it (those steps are permanent or undone); what follows it opened a new one. Statements that
 * ran before a BEGIN when nothing was open committed on their own.
 */
export function stepsAfterRun(
  current: { steps: TransactionStep[]; since: number } | undefined,
  ran: StatementOutcome[],
  now = Date.now(),
): { steps: TransactionStep[]; since: number } {
  const ended = ran.map((o) => !o.error && END.test(o.sql)).lastIndexOf(true)
  if (ended >= 0) return { steps: stepsOf(ran.slice(ended + 1)), since: now }
  if (!current) {
    const lastBegin = ran.map((o) => BEGIN.test(o.sql)).lastIndexOf(true)
    return { steps: stepsOf(lastBegin >= 0 ? ran.slice(lastBegin + 1) : ran), since: now }
  }
  return { steps: [...current.steps, ...stepsOf(ran)], since: current.since }
}
