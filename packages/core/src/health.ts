import type { DatabaseService } from './engine.js'
import type { CellValue, QueryResult } from './types.js'
import { cellToText } from './values.js'

/** One normalized statement with its totals since the server's statistics were reset. */
export interface TopQuery {
  query: string
  calls: number
  totalMs: number
  meanMs: number
  rows?: number
}

export type TopQueries = { available: true; queries: TopQuery[] } | { available: false; reason: string; enableSql?: string }

export interface TableSize {
  schema?: string
  name: string
  /** Bytes; undefined where the database doesn't say (DuckDB, SQLite). */
  totalBytes?: number
  dataBytes?: number
  indexBytes?: number
  rows?: number
}

export interface UnusedIndex {
  schema?: string
  table: string
  index: string
  bytes?: number
}

export interface StorageReport {
  tables: TableSize[]
  /** Indexes no query used since `statsSince` (unique and primary-key indexes are never listed); undefined: unknown here. */
  unusedIndexes?: UnusedIndex[]
  /** Since when the usage statistics count (server start or the last reset). */
  statsSince?: string
  unusedNote?: string
}

const LIMIT = 50

async function rows(db: DatabaseService, id: string, sql: string): Promise<Record<string, CellValue>[]> {
  const [o] = await db.runScript(id, sql, { maxRows: 500 })
  if (o?.error) throw Object.assign(new Error(o.error.message), { code: o.error.code })
  const r = o?.results?.[0] as QueryResult | undefined
  if (!r) return []
  return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name.toLowerCase(), row[i] ?? null])))
}

const num = (v: CellValue | undefined): number | undefined => (v === null || v === undefined || v === '' ? undefined : Number(typeof v === 'string' || typeof v === 'number' ? v : cellToText(v)))
const text = (v: CellValue | undefined): string => (v === null || v === undefined ? '' : cellToText(v))

const toTop = (r: Record<string, CellValue>): TopQuery => ({
  query: text(r.query).trim(),
  calls: num(r.calls) ?? 0,
  totalMs: num(r.total_ms) ?? 0,
  meanMs: num(r.mean_ms) ?? 0,
  rows: num(r.rows),
})

const PG_TOP = (total: string, mean: string) => `SELECT query, calls, ${total} AS total_ms, ${mean} AS mean_ms, rows
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) AND query NOT LIKE '%pg_stat_statements%'
 ORDER BY ${total} DESC LIMIT ${LIMIT}`

const PRIVILEGE_HINT: Record<string, string> = {
  mssql: 'It needs the VIEW SERVER STATE permission.',
  oracle: 'It needs SELECT on v$sqlstats (e.g. the SELECT_CATALOG_ROLE).',
  mysql: 'It needs SELECT on performance_schema.',
  mariadb: 'It needs SELECT on performance_schema.',
  postgres: 'It needs the pg_read_all_stats role to see other users’ statements.',
}

/** The statements that took the most time in total (cumulative since the statistics were last reset). */
export async function topQueries(db: DatabaseService, id: string): Promise<TopQueries> {
  try {
    return await readTopQueries(db, id)
  } catch (err) {
    // Missing monitoring privileges are the usual reason: say what is needed instead of a raw error.
    const hint = PRIVILEGE_HINT[db.config(id).driver] ?? ''
    return { available: false, reason: `The server did not allow reading its statement statistics: ${(err as Error).message}. ${hint}`.trim() }
  }
}

async function readTopQueries(db: DatabaseService, id: string): Promise<TopQueries> {
  const driver = db.config(id).driver
  const product = db.serverInfo(id)?.product
  if (driver === 'postgres' && product !== 'CockroachDB') {
    const ext = await rows(db, id, `SELECT extversion FROM pg_extension WHERE extname = 'pg_stat_statements'`)
    if (!ext.length) {
      return {
        available: false,
        reason: 'PostgreSQL collects these numbers with the pg_stat_statements extension, which is not installed in this database. It needs shared_preload_libraries = \'pg_stat_statements\' in postgresql.conf (and a restart), then:',
        enableSql: 'CREATE EXTENSION pg_stat_statements;',
      }
    }
    try {
      return { available: true, queries: (await rows(db, id, PG_TOP('total_exec_time', 'mean_exec_time'))).map(toTop) }
    } catch (err) {
      const message = (err as Error).message
      // PostgreSQL 12 and older name the columns total_time / mean_time.
      if (/total_exec_time/.test(message)) return { available: true, queries: (await rows(db, id, PG_TOP('total_time', 'mean_time'))).map(toTop) }
      if (/shared_preload_libraries/.test(message)) return { available: false, reason: 'The pg_stat_statements extension is installed but not loaded: add it to shared_preload_libraries in postgresql.conf and restart the server.' }
      throw err
    }
  }
  if (driver === 'mysql' || driver === 'mariadb') {
    const [on] = await rows(db, id, 'SELECT @@performance_schema AS on_')
    if (!on || !Number(num(on.on_))) return { available: false, reason: 'The server collects these numbers in performance_schema, which is off. Set performance_schema = ON in the server’s configuration and restart it.' }
    // Timers are in picoseconds.
    const list = await rows(
      db,
      id,
      `SELECT DIGEST_TEXT AS query, COUNT_STAR AS calls, SUM_TIMER_WAIT / 1000000000 AS total_ms, AVG_TIMER_WAIT / 1000000000 AS mean_ms, SUM_ROWS_SENT AS \`rows\`
         FROM performance_schema.events_statements_summary_by_digest
        WHERE DIGEST_TEXT IS NOT NULL AND (SCHEMA_NAME IS NULL OR SCHEMA_NAME = DATABASE()) AND DIGEST_TEXT NOT LIKE '%performance_schema%' AND DIGEST_TEXT NOT LIKE '%information_schema%'
        ORDER BY SUM_TIMER_WAIT DESC LIMIT ${LIMIT}`,
    )
    return { available: true, queries: list.map(toTop) }
  }
  if (driver === 'mssql') {
    const list = await rows(
      db,
      id,
      `SELECT TOP ${LIMIT}
              SUBSTRING(t.text, (s.statement_start_offset / 2) + 1, ((CASE s.statement_end_offset WHEN -1 THEN DATALENGTH(t.text) ELSE s.statement_end_offset END - s.statement_start_offset) / 2) + 1) AS query,
              s.execution_count AS calls, s.total_elapsed_time / 1000.0 AS total_ms, s.total_elapsed_time / 1000.0 / NULLIF(s.execution_count, 0) AS mean_ms, s.total_rows AS [rows]
         FROM sys.dm_exec_query_stats s
        CROSS APPLY sys.dm_exec_sql_text(s.sql_handle) t
        -- The text's own dbid is NULL for ad-hoc (auto-parameterized) statements; the plan knows its database.
        CROSS APPLY (SELECT CONVERT(int, value) AS dbid FROM sys.dm_exec_plan_attributes(s.plan_handle) WHERE attribute = 'dbid') pa
        WHERE pa.dbid = DB_ID()
        ORDER BY s.total_elapsed_time DESC`,
    )
    return { available: true, queries: list.map(toTop).filter((q) => !/dm_exec_query_stats/.test(q.query)) }
  }
  if (driver === 'oracle') {
    const list = await rows(
      db,
      id,
      `SELECT sql_text AS "query", executions AS "calls", elapsed_time / 1000 AS "total_ms", elapsed_time / 1000 / NULLIF(executions, 0) AS "mean_ms", rows_processed AS "rows"
         FROM v$sqlstats ORDER BY elapsed_time DESC FETCH FIRST ${LIMIT} ROWS ONLY`,
    )
    return { available: true, queries: list.map(toTop) }
  }
  return { available: false, reason: 'This database does not keep statement statistics the app can read.' }
}

/** Table sizes, largest first, and the indexes nothing used since the statistics started. */
export async function storageReport(db: DatabaseService, id: string): Promise<StorageReport> {
  const driver = db.config(id).driver
  const product = db.serverInfo(id)?.product
  const optional = async <T>(f: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await f()
    } catch {
      return undefined
    }
  }
  if (driver === 'postgres' && product !== 'CockroachDB') {
    const tables = await rows(
      db,
      id,
      `SELECT n.nspname AS sch, c.relname AS tbl, pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS data, pg_indexes_size(c.oid) AS idx, c.reltuples AS est
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
        ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 200`,
    )
    const unused = await optional(() =>
      rows(
        db,
        id,
        `SELECT s.schemaname AS sch, s.relname AS tbl, s.indexrelname AS idx, pg_relation_size(s.indexrelid) AS bytes
           FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
          WHERE s.idx_scan = 0 AND NOT i.indisunique AND NOT i.indisprimary
          ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 200`,
      ),
    )
    const [since] = (await optional(() => rows(db, id, `SELECT COALESCE((SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()), pg_postmaster_start_time())::text AS since`))) ?? []
    return {
      tables: tables.map((r) => ({ schema: text(r.sch), name: text(r.tbl), totalBytes: num(r.total), dataBytes: num(r.data), indexBytes: num(r.idx), rows: (num(r.est) ?? -1) >= 0 ? num(r.est) : undefined })),
      unusedIndexes: unused?.map((r) => ({ schema: text(r.sch), table: text(r.tbl), index: text(r.idx), bytes: num(r.bytes) })),
      statsSince: since ? text(since.since) : undefined,
    }
  }
  if (driver === 'mysql' || driver === 'mariadb') {
    const tables = await rows(
      db,
      id,
      `SELECT TABLE_SCHEMA AS sch, TABLE_NAME AS tbl, DATA_LENGTH + INDEX_LENGTH AS total, DATA_LENGTH AS data, INDEX_LENGTH AS idx, TABLE_ROWS AS est
         FROM information_schema.TABLES
        WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_SCHEMA NOT IN ('mysql', 'sys', 'performance_schema', 'information_schema')
        ORDER BY DATA_LENGTH + INDEX_LENGTH DESC LIMIT 200`,
    )
    const unused = await optional(() => rows(db, id, 'SELECT object_schema AS sch, object_name AS tbl, index_name AS idx FROM sys.schema_unused_indexes'))
    const [since] = (await optional(() => rows(db, id, `SELECT DATE_SUB(NOW(), INTERVAL VARIABLE_VALUE SECOND) AS since FROM performance_schema.global_status WHERE VARIABLE_NAME = 'Uptime'`))) ?? []
    return {
      tables: tables.map((r) => ({ schema: text(r.sch), name: text(r.tbl), totalBytes: num(r.total), dataBytes: num(r.data), indexBytes: num(r.idx), rows: num(r.est) })),
      unusedIndexes: unused?.map((r) => ({ schema: text(r.sch), table: text(r.tbl), index: text(r.idx) })),
      statsSince: since ? text(since.since) : undefined,
      ...(unused ? {} : { unusedNote: 'Unused indexes need the sys schema and performance_schema.' }),
    }
  }
  if (driver === 'mssql') {
    const tables = await rows(
      db,
      id,
      `SELECT TOP 200 s.name AS sch, t.name AS tbl, SUM(ps.reserved_page_count) * 8192 AS total,
              SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.reserved_page_count ELSE 0 END) * 8192 AS data,
              SUM(CASE WHEN ps.index_id > 1 THEN ps.reserved_page_count ELSE 0 END) * 8192 AS idx,
              SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS est
         FROM sys.dm_db_partition_stats ps JOIN sys.tables t ON t.object_id = ps.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
        WHERE t.is_ms_shipped = 0
        GROUP BY s.name, t.name ORDER BY SUM(ps.reserved_page_count) DESC`,
    )
    const unused = await optional(() =>
      rows(
        db,
        id,
        `SELECT s.name AS sch, t.name AS tbl, i.name AS idx, SUM(ps.reserved_page_count) * 8192 AS bytes
           FROM sys.indexes i
           JOIN sys.tables t ON t.object_id = i.object_id JOIN sys.schemas s ON s.schema_id = t.schema_id
           JOIN sys.dm_db_partition_stats ps ON ps.object_id = i.object_id AND ps.index_id = i.index_id
           LEFT JOIN sys.dm_db_index_usage_stats u ON u.object_id = i.object_id AND u.index_id = i.index_id AND u.database_id = DB_ID()
          WHERE i.index_id > 1 AND i.is_unique = 0 AND i.is_primary_key = 0 AND t.is_ms_shipped = 0
            AND COALESCE(u.user_seeks, 0) + COALESCE(u.user_scans, 0) + COALESCE(u.user_lookups, 0) = 0
          GROUP BY s.name, t.name, i.name ORDER BY SUM(ps.reserved_page_count) DESC`,
      ),
    )
    const [since] = (await optional(() => rows(db, id, 'SELECT CONVERT(varchar(19), sqlserver_start_time, 120) AS since FROM sys.dm_os_sys_info'))) ?? []
    return {
      tables: tables.map((r) => ({ schema: text(r.sch), name: text(r.tbl), totalBytes: num(r.total), dataBytes: num(r.data), indexBytes: num(r.idx), rows: num(r.est) })),
      unusedIndexes: unused?.map((r) => ({ schema: text(r.sch), table: text(r.tbl), index: text(r.idx), bytes: num(r.bytes) })),
      statsSince: since ? text(since.since) : undefined,
      ...(unused ? {} : { unusedNote: 'Unused indexes need the VIEW SERVER STATE permission.' }),
    }
  }
  if (driver === 'oracle') {
    const tables = await rows(
      db,
      id,
      `SELECT USER AS "sch", t.table_name AS "tbl", t.num_rows AS "est",
              (SELECT SUM(bytes) FROM user_segments s WHERE s.segment_name = t.table_name) AS "data",
              (SELECT SUM(s.bytes) FROM user_segments s JOIN user_indexes i ON i.index_name = s.segment_name WHERE i.table_name = t.table_name) AS "idx"
         FROM user_tables t ORDER BY 4 DESC NULLS LAST FETCH FIRST 200 ROWS ONLY`,
    )
    return {
      tables: tables.map((r) => ({ schema: text(r.sch), name: text(r.tbl), dataBytes: num(r.data), indexBytes: num(r.idx), totalBytes: (num(r.data) ?? 0) + (num(r.idx) ?? 0), rows: num(r.est) })),
      unusedNote: 'Oracle tracks index use only for monitored indexes (ALTER INDEX … MONITORING USAGE).',
    }
  }
  // DuckDB, SQLite and the rest: row counts from the schema, no sizes.
  const snapshot = await db.schema(id)
  return {
    tables: snapshot.tables
      .filter((t) => t.type === 'table')
      .map((t) => ({ schema: t.schema, name: t.name, rows: t.rowEstimate ?? undefined }))
      .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0)),
    unusedNote: 'This database does not track how indexes are used.',
  }
}
