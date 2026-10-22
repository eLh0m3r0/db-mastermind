import type { DatabaseService } from './engine.js'
import { cellToText } from './values.js'

export interface SessionActivity {
  id: string
  user?: string
  database?: string
  client?: string
  application?: string
  state?: string
  /** Running time of the current statement in ms. */
  durationMs?: number
  query?: string
  /** This is DB Mastermind's own connection. */
  own?: boolean
  /** Sessions holding locks this one waits for. */
  blockedBy?: string[]
}

const QUERIES: Record<string, string | undefined> = {
  postgres: `SELECT pid::text AS id, usename AS "user", datname AS database, client_addr::text AS client, application_name AS application,
       state, EXTRACT(EPOCH FROM (now() - query_start)) * 1000 AS duration_ms, query, pid = pg_backend_pid() AS own,
       array_to_string(pg_blocking_pids(pid), ',') AS blocked_by
  FROM pg_stat_activity WHERE backend_type = 'client backend' ORDER BY query_start NULLS LAST`,
  mysql: `SELECT ID AS id, USER AS user, DB AS \`database\`, HOST AS client, NULL AS application, COMMAND AS state, TIME * 1000 AS duration_ms,
       CAST(INFO AS CHAR) AS query, ID = CONNECTION_ID() AS own
  FROM information_schema.PROCESSLIST WHERE COMMAND <> 'Daemon' ORDER BY TIME DESC`,
  mssql: `SELECT CAST(s.session_id AS varchar(10)) AS id, s.login_name AS [user], DB_NAME(s.database_id) AS [database], s.host_name AS client,
       s.program_name AS application, COALESCE(r.status, s.status) AS state, r.total_elapsed_time AS duration_ms, t.text AS query,
       CASE WHEN s.session_id = @@SPID THEN 1 ELSE 0 END AS own, CAST(NULLIF(r.blocking_session_id, 0) AS varchar(10)) AS blocked_by
  FROM sys.dm_exec_sessions s
  LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
  OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
 WHERE s.is_user_process = 1
 ORDER BY r.total_elapsed_time DESC`,
  oracle: `SELECT s.sid || ',' || s.serial# AS "id", s.username AS "user", s.schemaname AS "database", s.machine AS "client", s.program AS "application",
       s.status AS "state", s.last_call_et * 1000 AS "duration_ms", q.sql_text AS "query",
       CASE WHEN s.sid = SYS_CONTEXT('USERENV', 'SID') THEN 1 ELSE 0 END AS "own",
       (SELECT b.sid || ',' || b.serial# FROM v$session b WHERE b.sid = s.blocking_session) AS "blocked_by"
  FROM v$session s LEFT JOIN v$sql q ON q.sql_id = s.sql_id AND q.child_number = 0
 WHERE s.type = 'USER' ORDER BY s.last_call_et DESC`,
}
const MYSQL_LIKE = new Set(['mysql', 'mariadb'])

/** Row lock waits (InnoDB); needs performance_schema / PROCESS privileges, so failures are ignored. */
const MYSQL_LOCK_WAITS: Record<string, string> = {
  mysql: `SELECT rt.PROCESSLIST_ID AS waiting, bt.PROCESSLIST_ID AS blocking
  FROM performance_schema.data_lock_waits w
  JOIN performance_schema.threads rt ON rt.THREAD_ID = w.REQUESTING_THREAD_ID
  JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID`,
  mariadb: `SELECT r.trx_mysql_thread_id AS waiting, b.trx_mysql_thread_id AS blocking
  FROM information_schema.INNODB_LOCK_WAITS w
  JOIN information_schema.INNODB_TRX r ON r.trx_id = w.requesting_trx_id
  JOIN information_schema.INNODB_TRX b ON b.trx_id = w.blocking_trx_id`,
}

/** Sessions on the server, longest-running first. Needs the usual monitoring privileges. */
export async function listActivity(db: DatabaseService, connectionId: string): Promise<SessionActivity[]> {
  const driver = db.config(connectionId).driver
  const sql = QUERIES[MYSQL_LIKE.has(driver) ? 'mysql' : driver]
  if (!sql) throw new Error('Server activity is not available for this database')
  const [outcome] = await db.runScript(connectionId, sql, { maxRows: 2000 })
  if (outcome?.error) throw new Error(outcome.error.message)
  const r = outcome!.results![0]!
  const idx = (name: string) => r.fields.findIndex((f) => f.name.toLowerCase() === name)
  const get = (row: (typeof r.rows)[number], name: string) => {
    const v = row[idx(name)] ?? null
    return v === null ? undefined : cellToText(v)
  }
  const sessions: SessionActivity[] = r.rows.map((row) => ({
    id: get(row, 'id') ?? '',
    user: get(row, 'user'),
    database: get(row, 'database'),
    client: get(row, 'client'),
    application: get(row, 'application'),
    state: get(row, 'state'),
    durationMs: get(row, 'duration_ms') === undefined ? undefined : Number(get(row, 'duration_ms')),
    query: get(row, 'query'),
    own: ['true', '1'].includes(String(get(row, 'own'))),
    blockedBy: get(row, 'blocked_by')?.split(',').filter(Boolean),
  }))
  const waits = MYSQL_LOCK_WAITS[driver]
  if (waits) {
    const [w] = await db.runScript(connectionId, waits, { maxRows: 2000 })
    for (const row of w?.results?.[0]?.rows ?? []) {
      const s = sessions.find((x) => x.id === cellToText(row[0] ?? null))
      if (s) s.blockedBy = [...new Set([...(s.blockedBy ?? []), cellToText(row[1] ?? null)])]
    }
  }
  return sessions
}

/** Cancels the running statement (`cancel`) or ends the whole session (`terminate`). */
export async function stopSession(db: DatabaseService, connectionId: string, id: string, mode: 'cancel' | 'terminate'): Promise<void> {
  const driver = db.config(connectionId).driver
  if (!/^[\d,]+$/.test(id)) throw new Error('Invalid session id')
  let sql: string
  if (driver === 'postgres') sql = `SELECT ${mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${id})`
  else if (MYSQL_LIKE.has(driver)) sql = `KILL ${mode === 'cancel' ? 'QUERY ' : ''}${id}`
  else if (driver === 'mssql') sql = `KILL ${id}`
  else if (driver === 'oracle') sql = mode === 'cancel' ? `ALTER SYSTEM CANCEL SQL '${id}'` : `ALTER SYSTEM KILL SESSION '${id}' IMMEDIATE`
  else throw new Error('Not supported for this database')
  const [o] = await db.runScript(connectionId, sql)
  if (o?.error) throw new Error(o.error.message)
}
