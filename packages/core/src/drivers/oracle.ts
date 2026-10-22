/// <reference path="../oracledb.d.ts" />
import oracledb, { type Connection, type Metadata, type Pool } from 'oracledb'
import { oracleDialect } from '../dialect.js'
import { classifyStatement } from '../sql-split.js'
import { ConnectionLostError, elapsed, QueryCancelledError, type DatabaseDriver, type IntrospectOptions, type StreamBatch, type StreamOptions } from '../driver.js'
import type { BuiltQuery } from '../filters.js'
import { openSshTunnel, type SshTunnel } from '../ssh.js'
import type { ConnectionConfig, QueryOptions, QueryResult, SchemaSnapshot, ServerInfo, TableInfo } from '../types.js'
import { normalizeValue } from '../values.js'

type RawRow = Record<string, unknown>

/** Oracle-maintained schemas hidden from the explorer. */
const SYSTEM_OWNERS = [
  'SYS', 'SYSTEM', 'XDB', 'MDSYS', 'CTXSYS', 'ORDSYS', 'ORDDATA', 'OLAPSYS', 'WMSYS', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'AUDSYS',
  'GSMADMIN_INTERNAL', 'LBACSYS', 'DVSYS', 'OJVMSYS', 'DBSFWUSER', 'REMOTE_SCHEDULER_AGENT', 'GGSYS', 'ANONYMOUS', 'GSMCATUSER',
  'SYSBACKUP', 'SYSDG', 'SYSKM', 'SYSRAC', 'XS$NULL', 'DIP', 'ORACLE_OCM', 'MDDATA', 'SI_INFORMTN_SCHEMA', 'PUBLIC', 'DGPDB_INT',
  'VECSYS', 'GSMUSER', 'GSMROOTUSER', 'PDBADMIN',
]

/**
 * Values come back as text where JS types would lose information: NUMBER (precision), dates (time zones)
 * and LOBs (streams). Formats are set per session so they're stable and sortable.
 */
const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Thin mode returns DATE/TIMESTAMP as JS Dates in local time; render them back as the wall-clock value. */
function formatOracleDate(d: unknown): unknown {
  if (!(d instanceof Date)) return d
  const ms = d.getMilliseconds()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`
}

const fetchTypeHandler = (meta: Metadata) => {
  const t = meta.dbType
  if (t === oracledb.DB_TYPE_DATE || t === oracledb.DB_TYPE_TIMESTAMP || t === oracledb.DB_TYPE_TIMESTAMP_TZ || t === oracledb.DB_TYPE_TIMESTAMP_LTZ) {
    return { converter: formatOracleDate }
  }
  if (t === oracledb.DB_TYPE_NUMBER || t === oracledb.DB_TYPE_CLOB || t === oracledb.DB_TYPE_NCLOB) {
    return { type: oracledb.STRING }
  }
  if (t === oracledb.DB_TYPE_BLOB) return { type: oracledb.BUFFER }
  return undefined
}

const SESSION_SETUP = [
  `ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'`,
  `ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6'`,
  `ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS.FF6 TZH:TZM'`,
  `ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'`,
]

export class OracleDriver implements DatabaseDriver {
  readonly dialect = oracleDialect
  private pool?: Pool
  private tunnel?: SshTunnel
  private sessions = new Map<string, Connection>()
  /** Sessions where the user started a transaction (SET TRANSACTION); others auto-commit like DBeaver/SQL Developer's default. */
  private manualTx = new Set<string>()

  constructor(readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    let host = this.config.host ?? 'localhost'
    let port = this.config.port ?? 1521
    if (this.config.ssh?.enabled) {
      this.tunnel = await openSshTunnel(this.config.ssh, host, port)
      host = this.tunnel.localHost
      port = this.tunnel.localPort
    }
    // database = service name (FREEPDB1, ORCLPDB1…); options.connectString overrides everything (TNS, Easy Connect Plus).
    const connectString = this.config.options?.connectString
      ? String(this.config.options.connectString)
      : `${this.config.ssl && this.config.ssl.mode !== 'disable' ? 'tcps://' : ''}${host}:${port}/${this.config.database || 'FREEPDB1'}`
    const readOnly = this.config.readOnly
    this.pool = await oracledb.createPool({
      user: this.config.user,
      password: this.config.password,
      connectString,
      poolMin: 0,
      poolMax: 6,
      poolTimeout: 60,
      connectTimeout: 15,
      sessionCallback: (conn, _tag, cb) => {
        void (async () => {
          for (const sql of SESSION_SETUP) await conn.execute(sql)
          if (readOnly) await conn.execute('SET TRANSACTION READ ONLY')
        })().then(() => cb(), cb)
      },
    })
    const conn = await this.pool.getConnection()
    await conn.close()
  }

  async close(): Promise<void> {
    for (const c of this.sessions.values()) await c.close().catch(() => {})
    this.sessions.clear()
    await this.pool?.close(0)
    this.pool = undefined
    await this.tunnel?.close()
    this.tunnel = undefined
  }

  private get activePool(): Pool {
    if (!this.pool) throw new Error('Not connected')
    return this.pool
  }

  private async acquire(session?: string): Promise<{ conn: Connection; release: () => Promise<void> }> {
    if (!session) {
      const conn = await this.activePool.getConnection()
      return { conn, release: () => conn.close() }
    }
    let conn = this.sessions.get(session)
    if (!conn) {
      conn = await this.activePool.getConnection()
      this.sessions.set(session, conn)
    }
    return { conn, release: async () => {} }
  }

  async releaseSession(session: string): Promise<void> {
    const conn = this.sessions.get(session)
    this.sessions.delete(session)
    this.manualTx.delete(session)
    if (!conn) return
    await conn.rollback().catch(() => {})
    await conn.close().catch(() => {})
  }

  async execute(sql: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    try {
      return await this.executeOnce(sql, options)
    } catch (err) {
      if (!isConnectionLost(err) || options.signal?.aborted) throw err
      const session = options.session
      if (session) {
        // Without this the session would keep its dead connection and fail every statement until a reconnect.
        const conn = this.sessions.get(session)
        this.sessions.delete(session)
        void conn?.close().catch(() => {})
        const open = this.manualTx.delete(session)
        if (open) throw new ConnectionLostError()
      }
      // Run again on a fresh connection only when that can't apply a change twice.
      if (classifyStatement(sql) !== 'read') throw err
      return this.executeOnce(sql, options)
    }
  }

  private async executeOnce(sql: string, options: QueryOptions): Promise<QueryResult[]> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const { conn, release } = await this.acquire(options.session)
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      void conn.break().catch(() => {})
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const start = process.hrtime.bigint()
    try {
      if (options.session && /^\s*SET\s+TRANSACTION\b/i.test(sql)) this.manualTx.add(options.session)
      const r = await conn.execute<unknown[]>(sql, options.params ?? [], {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        maxRows: options.maxRows !== undefined ? options.maxRows + 1 : 0,
        autoCommit: !options.session || !this.manualTx.has(options.session),
        fetchTypeHandler,
      })
      if (options.session && /^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) this.manualTx.delete(options.session)
      const durationMs = elapsed(start)
      if (r.metaData) {
        const rows = r.rows ?? []
        const truncated = options.maxRows !== undefined && rows.length > options.maxRows
        const kept = truncated ? rows.slice(0, options.maxRows) : rows
        return [
          {
            fields: r.metaData.map((m) => ({ name: m.name, dataType: m.dbTypeName?.toLowerCase() })),
            rows: kept.map((row) => (row as unknown[]).map(normalizeValue)),
            rowCount: kept.length,
            command: 'SELECT',
            truncated,
            durationMs,
          },
        ]
      }
      return [{ fields: [], rows: [], rowCount: r.rowsAffected ?? 0, affectedRows: r.rowsAffected ?? 0, command: sql.trim().split(/\s+/, 1)[0]?.toUpperCase(), durationMs }]
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      await release().catch(() => {})
    }
  }

  async *stream(sql: string, options: StreamOptions = {}): AsyncGenerator<StreamBatch> {
    if (options.signal?.aborted) throw new QueryCancelledError()
    const conn = await this.activePool.getConnection()
    let cancelled = false
    const onAbort = () => {
      cancelled = true
      void conn.break().catch(() => {})
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const r = await conn.execute<unknown[]>(sql, options.params ?? [], { outFormat: oracledb.OUT_FORMAT_ARRAY, resultSet: true, fetchTypeHandler })
      const rs = r.resultSet
      if (!rs) return
      try {
        const fields = rs.metaData.map((m) => ({ name: m.name, dataType: m.dbTypeName?.toLowerCase() }))
        for (;;) {
          const rows = await rs.getRows(options.batchSize ?? 5000)
          if (!rows.length) return
          yield { fields, rows: rows.map((row) => row.map(normalizeValue)) }
        }
      } finally {
        await rs.close().catch(() => {})
      }
    } catch (err) {
      if (cancelled) throw new QueryCancelledError()
      throw err
    } finally {
      options.signal?.removeEventListener('abort', onAbort)
      await conn.close().catch(() => {})
    }
  }

  async transaction(statements: BuiltQuery[]): Promise<number[]> {
    const conn = await this.activePool.getConnection()
    try {
      const affected: number[] = []
      for (const s of statements) {
        const r = await conn.execute(s.sql, s.params, { autoCommit: false })
        affected.push(r.rowsAffected ?? 0)
      }
      await conn.commit()
      return affected
    } catch (err) {
      await conn.rollback().catch(() => {})
      throw err
    } finally {
      await conn.close().catch(() => {})
    }
  }

  private async rows(sql: string, binds: unknown[] = []): Promise<RawRow[]> {
    const conn = await this.activePool.getConnection()
    try {
      const r = await conn.execute<RawRow>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler })
      return r.rows ?? []
    } finally {
      await conn.close()
    }
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.rows(`SELECT banner_full AS "v" FROM v$version WHERE ROWNUM = 1`).catch(() => this.rows(`SELECT banner AS "v" FROM v$version WHERE ROWNUM = 1`))
    const text = String(r?.v ?? 'Oracle')
    return { product: 'Oracle', version: /\d+(\.\d+)+/.exec(text)?.[0] ?? text }
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.rows(`SELECT SYS_CONTEXT('USERENV', 'CON_NAME') AS "n" FROM dual`)
    return rows.map((r) => String(r.n))
  }

  async introspect(options: IntrospectOptions = {}): Promise<SchemaSnapshot> {
    const [meta] = await this.rows(`SELECT SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA') AS "schema", SYS_CONTEXT('USERENV', 'CON_NAME') AS "db" FROM dual`)
    const current = String(meta?.schema ?? this.config.user?.toUpperCase() ?? '')
    // Oracle databases have many schemas; by default show the user's own.
    const owners = options.schemas?.length ? options.schemas : [current]
    const inList = owners.map((_, i) => `:${i + 1}`).join(', ')

    const [allOwners, tables, columns, constraints, indexes] = await Promise.all([
      this.rows(
        `SELECT DISTINCT owner AS "o" FROM all_objects WHERE object_type IN ('TABLE','VIEW') AND owner NOT IN (${SYSTEM_OWNERS.map((o) => `'${o.replace("'", "''")}'`).join(',')}) ORDER BY 1`,
      ),
      this.rows(
        `SELECT o.owner AS "s", o.object_name AS "t", o.object_type AS "type", c.comments AS "comment", t.num_rows AS "est",
                CASE WHEN o.object_type = 'VIEW' THEN (SELECT v.text_vc FROM all_views v WHERE v.owner = o.owner AND v.view_name = o.object_name) END AS "definition"
           FROM all_objects o
           LEFT JOIN all_tab_comments c ON c.owner = o.owner AND c.table_name = o.object_name
           LEFT JOIN all_tables t ON t.owner = o.owner AND t.table_name = o.object_name
          WHERE o.owner IN (${inList}) AND o.object_type IN ('TABLE', 'VIEW') AND o.object_name NOT LIKE 'BIN$%'
          ORDER BY o.owner, o.object_name`,
        owners,
      ),
      this.rows(
        `SELECT c.owner AS "s", c.table_name AS "t", c.column_name AS "name", c.column_id AS "ord", c.data_type AS "type",
                c.data_length AS "len", c.char_length AS "clen", c.data_precision AS "prec", c.data_scale AS "scale", c.nullable AS "nullable",
                c.data_default AS "def", c.identity_column AS "ident", c.virtual_column AS "virt", cc.comments AS "comment"
           FROM all_tab_cols c
           LEFT JOIN all_col_comments cc ON cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name
          WHERE c.owner IN (${inList}) AND c.hidden_column = 'NO'
          ORDER BY c.owner, c.table_name, c.column_id`,
        owners,
      ),
      this.rows(
        `SELECT c.owner AS "s", c.table_name AS "t", c.constraint_name AS "name", c.constraint_type AS "type", cc.column_name AS "col", cc.position AS "pos",
                r.owner AS "ref_s", r.table_name AS "ref_t", rc.column_name AS "ref_col", c.delete_rule AS "on_delete"
           FROM all_constraints c
           JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
           LEFT JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name
           LEFT JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name AND rc.position = cc.position
          WHERE c.owner IN (${inList}) AND c.constraint_type IN ('P', 'R', 'U')
          ORDER BY c.owner, c.table_name, c.constraint_name, cc.position`,
        owners,
      ),
      this.rows(
        `SELECT i.table_owner AS "s", i.table_name AS "t", i.index_name AS "name", i.uniqueness AS "uniq", ic.column_name AS "col", i.index_type AS "method",
                (SELECT COUNT(*) FROM all_constraints k WHERE k.owner = i.owner AND k.index_name = i.index_name AND k.constraint_type IN ('P', 'U')) AS "is_con",
                (SELECT COUNT(*) FROM all_constraints k WHERE k.owner = i.owner AND k.index_name = i.index_name AND k.constraint_type = 'P') AS "is_pk"
           FROM all_indexes i
           JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
          WHERE i.table_owner IN (${inList})
          ORDER BY i.table_owner, i.table_name, i.index_name, ic.column_position`,
        owners,
      ),
    ])

    const key = (s: unknown, t: unknown) => `${String(s)}\u0000${String(t)}`
    const byKey = new Map<string, TableInfo>()
    for (const t of tables) {
      byKey.set(key(t.s, t.t), {
        schema: String(t.s),
        name: String(t.t),
        type: t.type === 'VIEW' ? 'view' : 'table',
        comment: t.comment ? String(t.comment) : null,
        rowEstimate: t.est === null || t.est === undefined ? null : Number(t.est),
        definition: t.definition ? String(t.definition) : null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      })
    }
    for (const c of constraints) {
      const t = byKey.get(key(c.s, c.t))
      if (!t) continue
      const name = String(c.name)
      if (c.type === 'P') {
        if (!t.primaryKey.includes(String(c.col))) t.primaryKey.push(String(c.col))
      } else if (c.type === 'R') {
        let fk = t.foreignKeys.find((f) => f.name === name)
        if (!fk) {
          fk = { name, columns: [], refSchema: String(c.ref_s), refTable: String(c.ref_t), refColumns: [], onDelete: String(c.on_delete ?? 'NO ACTION') }
          t.foreignKeys.push(fk)
        }
        fk.columns.push(String(c.col))
        fk.refColumns.push(String(c.ref_col))
      }
    }
    for (const c of columns) {
      const t = byKey.get(key(c.s, c.t))
      if (!t) continue
      const type = String(c.type)
      const prec = c.prec === null || c.prec === undefined ? null : Number(c.prec)
      const scale = c.scale === null || c.scale === undefined ? null : Number(c.scale)
      const dataType = /^(N?VARCHAR2|N?CHAR|RAW)$/.test(type)
        ? `${type}(${Number(c.clen) || Number(c.len)})`
        : type === 'NUMBER' && prec !== null
          ? `NUMBER(${prec}${scale ? `,${scale}` : ''})`
          : type
      const name = String(c.name)
      t.columns.push({
        name,
        ordinal: Number(c.ord),
        dataType,
        nullable: c.nullable === 'Y',
        defaultValue: c.def === null || c.def === undefined ? null : String(c.def).trim(),
        isPrimaryKey: t.primaryKey.includes(name),
        isIdentity: c.ident === 'YES',
        isGenerated: c.virt === 'YES',
        comment: c.comment ? String(c.comment) : null,
      })
    }
    for (const ix of indexes) {
      const t = byKey.get(key(ix.s, ix.t))
      if (!t) continue
      const name = String(ix.name)
      let entry = t.indexes.find((i) => i.name === name)
      if (!entry) {
        entry = { name, columns: [], unique: ix.uniq === 'UNIQUE', primary: Number(ix.is_pk) > 0, method: String(ix.method).toLowerCase(), constraint: Number(ix.is_con) > 0 }
        t.indexes.push(entry)
      }
      entry.columns.push(String(ix.col))
    }

    return {
      database: meta?.db ? String(meta.db) : undefined,
      defaultSchema: current,
      schemas: options.schemas?.length ? owners : [...new Set([current, ...allOwners.map((o) => String(o.o))])],
      tables: [...byKey.values()],
      routines: [],
      capturedAt: new Date().toISOString(),
    }
  }
}

/** The connection is gone (session killed, server restart, network). */
function isConnectionLost(err: unknown): boolean {
  return /NJS-500|NJS-521|ORA-00028|ORA-02396|ORA-03113|ORA-03114|ORA-03135|DPI-1010|DPI-1080/.test((err as { message?: string })?.message ?? '')
}
