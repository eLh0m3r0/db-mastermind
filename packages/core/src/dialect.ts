import type { DriverId, TableRef } from './types.js'

export interface Dialect {
  id: DriverId
  /** Human readable SQL flavour, also used to pick the editor grammar. */
  sqlFlavor: 'postgresql' | 'tsql' | 'mysql' | 'mariadb' | 'sqlite' | 'plsql'
  defaultSchema?: string
  quoteIdent(name: string): string
  /** 1-based positional placeholder. */
  placeholder(index: number): string
  /** Appends ORDER BY-dependent pagination. `orderBy` must already be part of `sql` when present. */
  paginate(sql: string, limit: number, offset: number, hasOrderBy: boolean): string
  /** Expression rendering `expr` as text so LIKE works on any type. */
  castToText(expr: string): string
  /** Case-insensitive LIKE operator. */
  ilike: string
  /** Case-insensitive LIKE as a full expression, for databases without such an operator. */
  likeExpr?(textExpr: string, param: string, negate: boolean): string
  trueLiteral: string
  falseLiteral: string
  /** Regex match, or null when unsupported. */
  regex(expr: string, param: string, negate: boolean): string | null
  /**
   * Strictly typed databases (BigQuery) don't compare a text parameter with a number or date column: wraps the
   * placeholder so it has the column's type. Filter values are text.
   */
  typedParam?(placeholder: string, dataType: string): string
  /** LIKE escape character; `escapeClause: false` when the database has no ESCAPE clause (the default is '!'). */
  likeEscape?: { char: string; escapeClause: boolean }
  /** Wraps a DML batch so it is atomic. */
  begin: string
  commit: string
  rollback: string
}

const doubleQuote = (name: string) => `"${name.replaceAll('"', '""')}"`

const limitOffset = (sql: string, limit: number, offset: number) =>
  `${sql} LIMIT ${Math.max(0, Math.floor(limit))}${offset > 0 ? ` OFFSET ${Math.floor(offset)}` : ''}`

export const postgresDialect: Dialect = {
  id: 'postgres',
  sqlFlavor: 'postgresql',
  defaultSchema: 'public',
  quoteIdent: doubleQuote,
  placeholder: (i) => `$${i}`,
  paginate: (sql, limit, offset) => limitOffset(sql, limit, offset),
  castToText: (expr) => `${expr}::text`,
  ilike: 'ILIKE',
  trueLiteral: 'TRUE',
  falseLiteral: 'FALSE',
  regex: (expr, param, negate) => `${expr}::text ${negate ? '!~*' : '~*'} ${param}`,
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
}

export const duckdbDialect: Dialect = {
  ...postgresDialect,
  id: 'duckdb',
  defaultSchema: 'main',
  castToText: (expr) => `CAST(${expr} AS VARCHAR)`,
  regex: (expr, param, negate) => `${negate ? 'NOT ' : ''}regexp_matches(CAST(${expr} AS VARCHAR), ${param}, 'i')`,
  begin: 'BEGIN TRANSACTION',
}

const backtick = (name: string) => `\`${name.replaceAll('`', '``')}\``

export const mysqlDialect: Dialect = {
  id: 'mysql',
  sqlFlavor: 'mysql',
  quoteIdent: backtick,
  placeholder: () => '?',
  paginate: (sql, limit, offset) => limitOffset(sql, limit, offset),
  castToText: (expr) => `CAST(${expr} AS CHAR)`,
  ilike: 'LIKE',
  trueLiteral: '1',
  falseLiteral: '0',
  regex: (expr, param, negate) => `${expr} ${negate ? 'NOT REGEXP' : 'REGEXP'} ${param}`,
  begin: 'START TRANSACTION',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
}

export const mariadbDialect: Dialect = { ...mysqlDialect, id: 'mariadb', sqlFlavor: 'mariadb' }

export const mssqlDialect: Dialect = {
  id: 'mssql',
  sqlFlavor: 'tsql',
  defaultSchema: 'dbo',
  quoteIdent: (name) => `[${name.replaceAll(']', ']]')}]`,
  placeholder: (i) => `@p${i}`,
  paginate: (sql, limit, offset, hasOrderBy) =>
    `${sql}${hasOrderBy ? '' : ' ORDER BY (SELECT NULL)'} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${Math.max(
      0,
      Math.floor(limit),
    )} ROWS ONLY`,
  castToText: (expr) => `CAST(${expr} AS NVARCHAR(MAX))`,
  ilike: 'LIKE',
  trueLiteral: '1',
  falseLiteral: '0',
  regex: () => null,
  begin: 'BEGIN TRANSACTION',
  commit: 'COMMIT TRANSACTION',
  rollback: 'ROLLBACK TRANSACTION',
}

export const sqliteDialect: Dialect = {
  id: 'sqlite',
  sqlFlavor: 'sqlite',
  defaultSchema: 'main',
  quoteIdent: doubleQuote,
  placeholder: () => '?',
  paginate: (sql, limit, offset) => limitOffset(sql, limit, offset),
  castToText: (expr) => `CAST(${expr} AS TEXT)`,
  ilike: 'LIKE',
  trueLiteral: '1',
  falseLiteral: '0',
  regex: () => null,
  begin: 'BEGIN',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
}

export const oracleDialect: Dialect = {
  id: 'oracle',
  sqlFlavor: 'plsql',
  quoteIdent: doubleQuote,
  placeholder: (i) => `:${i}`,
  paginate: (sql, limit, offset) =>
    `${sql} OFFSET ${Math.floor(offset)} ROWS FETCH NEXT ${Math.max(0, Math.floor(limit))} ROWS ONLY`,
  castToText: (expr) => `TO_CHAR(${expr})`,
  ilike: 'LIKE',
  likeExpr: (textExpr, param, negate) => `UPPER(${textExpr}) ${negate ? 'NOT ' : ''}LIKE UPPER(${param})`,
  trueLiteral: '1',
  falseLiteral: '0',
  regex: (expr, param, negate) => `${negate ? 'NOT ' : ''}REGEXP_LIKE(${expr}, ${param}, 'i')`,
  // Oracle starts transactions implicitly; DDL commits on its own.
  begin: 'SET TRANSACTION READ WRITE',
  commit: 'COMMIT',
  rollback: 'ROLLBACK',
}

/**
 * ClickHouse: positional parameters are inlined as literals by the driver (`{__p1}` tokens), because its typed
 * query parameters don't compare across types. No transactions: begin/commit are empty.
 */
export const clickhouseDialect: Dialect = {
  id: 'clickhouse',
  sqlFlavor: 'mysql',
  defaultSchema: 'default',
  quoteIdent: backtick,
  placeholder: (i) => `{__p${i}}`,
  paginate: (sql, limit, offset) => limitOffset(sql, limit, offset),
  castToText: (expr) => `toString(${expr})`,
  ilike: 'ILIKE',
  trueLiteral: 'true',
  falseLiteral: 'false',
  regex: (expr, param, negate) => `${negate ? 'NOT ' : ''}match(toString(${expr}), concat('(?i)', ${param}))`,
  begin: '',
  commit: '',
  rollback: '',
}

const BIGQUERY_CASTS: [RegExp, string][] = [
  [/^(INT64|INTEGER|INT|SMALLINT|BIGINT|TINYINT|BYTEINT)$/, 'INT64'],
  [/^(FLOAT64|FLOAT)$/, 'FLOAT64'],
  [/^(NUMERIC|DECIMAL)\b/, 'NUMERIC'],
  [/^(BIGNUMERIC|BIGDECIMAL)\b/, 'BIGNUMERIC'],
  [/^(BOOL|BOOLEAN)$/, 'BOOL'],
  [/^(DATE|DATETIME|TIMESTAMP|TIME)$/, ''],
]

/**
 * BigQuery (GoogleSQL): named parameters `@p1`, strictly typed, so filter values are cast to the column type.
 * LIKE has no ESCAPE clause (backslash escapes) and no ILIKE. No multi-statement transactions from the app.
 */
export const bigqueryDialect: Dialect = {
  id: 'bigquery',
  sqlFlavor: 'mysql',
  quoteIdent: (name) => `\`${name.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``,
  placeholder: (i) => `@p${i}`,
  paginate: (sql, limit, offset) => limitOffset(sql, limit, offset),
  castToText: (expr) => `CAST(${expr} AS STRING)`,
  ilike: 'LIKE',
  likeExpr: (text, param, negate) => `LOWER(${text}) ${negate ? 'NOT ' : ''}LIKE LOWER(${param})`,
  likeEscape: { char: '\\', escapeClause: false },
  trueLiteral: 'TRUE',
  falseLiteral: 'FALSE',
  regex: (expr, param, negate) => `${negate ? 'NOT ' : ''}REGEXP_CONTAINS(CAST(${expr} AS STRING), CONCAT('(?i)', ${param}))`,
  typedParam: (placeholder, dataType) => {
    const t = dataType.trim().toUpperCase()
    for (const [re, cast] of BIGQUERY_CASTS) {
      const m = re.exec(t)
      if (m) return `CAST(${placeholder} AS ${cast || m[0]})`
    }
    return placeholder
  },
  begin: '',
  commit: '',
  rollback: '',
}

/** Trino types whose columns don't compare with a text value (filter values are text). */
const TRINO_TYPED = /^(tinyint|smallint|integer|int|bigint|real|double|decimal(\(\s*\d+\s*,\s*\d+\s*\))?|boolean|date|uuid|(time|timestamp)(\(\d+\))?( with time zone)?)$/

/**
 * Trino: standard SQL with double-quoted identifiers. Parameters are inlined as literals by the driver (`{__pN}`
 * tokens) and cast to the compared column's type, because Trino doesn't compare varchar with numbers or dates.
 * No ILIKE: case-insensitive LIKE lowers both sides. OFFSET comes before LIMIT. No transactions from the app.
 */
export const trinoDialect: Dialect = {
  id: 'trino',
  sqlFlavor: 'postgresql',
  quoteIdent: doubleQuote,
  placeholder: (i) => `{__p${i}}`,
  paginate: (sql, limit, offset) => `${sql}${offset > 0 ? ` OFFSET ${Math.floor(offset)}` : ''} LIMIT ${Math.max(0, Math.floor(limit))}`,
  castToText: (expr) => `CAST(${expr} AS varchar)`,
  ilike: 'LIKE',
  likeExpr: (text, param, negate) => `lower(${text}) ${negate ? 'NOT ' : ''}LIKE lower(${param})`,
  trueLiteral: 'true',
  falseLiteral: 'false',
  regex: (expr, param, negate) => `${negate ? 'NOT ' : ''}regexp_like(CAST(${expr} AS varchar), concat('(?i)', ${param}))`,
  typedParam: (placeholder, dataType) => {
    const t = dataType.trim().toLowerCase()
    return TRINO_TYPED.test(t) ? `CAST(${placeholder} AS ${t})` : placeholder
  },
  begin: '',
  commit: '',
  rollback: '',
}

export const dialects: Record<DriverId, Dialect> = {
  postgres: postgresDialect,
  mysql: mysqlDialect,
  mariadb: mariadbDialect,
  mssql: mssqlDialect,
  sqlite: sqliteDialect,
  oracle: oracleDialect,
  duckdb: duckdbDialect,
  clickhouse: clickhouseDialect,
  bigquery: bigqueryDialect,
  trino: trinoDialect,
}

export function getDialect(id: DriverId): Dialect {
  return dialects[id]
}

export function qualify(dialect: Dialect, ref: TableRef): string {
  return ref.schema ? `${dialect.quoteIdent(ref.schema)}.${dialect.quoteIdent(ref.name)}` : dialect.quoteIdent(ref.name)
}
