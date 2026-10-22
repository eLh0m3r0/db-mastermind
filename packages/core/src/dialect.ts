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

export const dialects: Record<DriverId, Dialect> = {
  postgres: postgresDialect,
  mysql: mysqlDialect,
  mariadb: mariadbDialect,
  mssql: mssqlDialect,
  sqlite: sqliteDialect,
  oracle: oracleDialect,
}

export function getDialect(id: DriverId): Dialect {
  return dialects[id]
}

export function qualify(dialect: Dialect, ref: TableRef): string {
  return ref.schema ? `${dialect.quoteIdent(ref.schema)}.${dialect.quoteIdent(ref.name)}` : dialect.quoteIdent(ref.name)
}
