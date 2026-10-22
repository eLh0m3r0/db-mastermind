// Minimal typings for the parts of node-oracledb (thin mode) DB Mastermind uses.
declare module 'oracledb' {
  export const OUT_FORMAT_ARRAY: number
  export const OUT_FORMAT_OBJECT: number
  export const STRING: unknown
  export const BUFFER: unknown
  export const DB_TYPE_NUMBER: unknown
  export const DB_TYPE_DATE: unknown
  export const DB_TYPE_TIMESTAMP: unknown
  export const DB_TYPE_TIMESTAMP_TZ: unknown
  export const DB_TYPE_TIMESTAMP_LTZ: unknown
  export const DB_TYPE_CLOB: unknown
  export const DB_TYPE_NCLOB: unknown
  export const DB_TYPE_BLOB: unknown
  export const DB_TYPE_JSON: unknown

  export interface Metadata {
    name: string
    dbType?: unknown
    dbTypeName?: string
  }
  export interface ResultSet<T = unknown> {
    metaData: Metadata[]
    getRows(count: number): Promise<T[]>
    close(): Promise<void>
  }
  export interface Result<T = unknown> {
    rows?: T[]
    metaData?: Metadata[]
    rowsAffected?: number
    resultSet?: ResultSet<T>
  }
  export interface ExecuteOptions {
    outFormat?: number
    maxRows?: number
    autoCommit?: boolean
    resultSet?: boolean
    fetchTypeHandler?: (meta: Metadata) => { type?: unknown; converter?: (value: unknown) => unknown } | undefined
  }
  export interface Connection {
    execute<T = unknown>(sql: string, binds?: unknown[] | Record<string, unknown>, options?: ExecuteOptions): Promise<Result<T>>
    commit(): Promise<void>
    rollback(): Promise<void>
    break(): Promise<void>
    close(): Promise<void>
    oracleServerVersionString?: string
  }
  export interface PoolAttributes {
    user?: string
    password?: string
    connectString: string
    poolMin?: number
    poolMax?: number
    poolTimeout?: number
    connectTimeout?: number
    sessionCallback?: (connection: Connection, requestedTag: string, cb: (err?: Error) => void) => void
  }
  export interface Pool {
    getConnection(): Promise<Connection>
    close(drainTime?: number): Promise<void>
  }
  export function createPool(attrs: PoolAttributes): Promise<Pool>
  const oracledb: {
    createPool: typeof createPool
    OUT_FORMAT_ARRAY: number
    OUT_FORMAT_OBJECT: number
    STRING: unknown
    BUFFER: unknown
    DB_TYPE_NUMBER: unknown
    DB_TYPE_DATE: unknown
    DB_TYPE_TIMESTAMP: unknown
    DB_TYPE_TIMESTAMP_TZ: unknown
    DB_TYPE_TIMESTAMP_LTZ: unknown
    DB_TYPE_CLOB: unknown
    DB_TYPE_NCLOB: unknown
    DB_TYPE_BLOB: unknown
    DB_TYPE_JSON: unknown
  }
  export default oracledb
}
