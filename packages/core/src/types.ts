export type DriverId = 'postgres' | 'mssql' | 'mysql' | 'mariadb' | 'sqlite'

export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'

export interface SslConfig {
  mode: SslMode
  /** PEM contents (not paths) so configs stay portable. */
  ca?: string
  cert?: string
  key?: string
}

export interface SshConfig {
  enabled: boolean
  host: string
  port?: number
  user: string
  authMethod: 'password' | 'privateKey' | 'agent'
  password?: string
  privateKey?: string
  passphrase?: string
}

export type Environment = 'development' | 'test' | 'staging' | 'production'

export interface ConnectionConfig {
  id: string
  name: string
  driver: DriverId
  host?: string
  port?: number
  database?: string
  user?: string
  password?: string
  /** SQLite database file. */
  filePath?: string
  ssl?: SslConfig
  ssh?: SshConfig
  /** SQL Server: domain for NTLM auth, instance name, trustServerCertificate… */
  options?: Record<string, string | number | boolean>
  readOnly?: boolean
  environment?: Environment
  color?: string
  group?: string
  /** Folder with Markdown notes describing this database. */
  knowledgeBasePath?: string
  /** Whether AI features may see this connection. Defaults to true. */
  aiEnabled?: boolean
}

/** Values are normalized so they survive structured clone / JSON (IPC, MCP). */
export type CellValue = string | number | boolean | null | BinaryValue | CellValue[] | { [key: string]: CellValue }

export interface BinaryValue {
  $binary: string // hex, possibly truncated
  length: number
}

export interface ResultField {
  name: string
  /** Database-native type name when known. */
  dataType?: string
}

export interface QueryResult {
  fields: ResultField[]
  rows: CellValue[][]
  /** Rows returned, or rows affected for DML. */
  rowCount: number
  affectedRows?: number
  /** e.g. SELECT, INSERT, UPDATE. */
  command?: string
  /** True when the driver stopped reading after maxRows. */
  truncated?: boolean
  durationMs: number
}

export interface QueryOptions {
  params?: unknown[]
  /** Stop reading rows after this many (per result set). */
  maxRows?: number
  signal?: AbortSignal
  /** Run on a sticky connection (one per editor tab) so transactions and session settings persist. */
  session?: string
}

export type ObjectType = 'table' | 'view' | 'materialized_view' | 'foreign_table'

export interface TableRef {
  schema?: string
  name: string
}

export interface ColumnInfo {
  name: string
  ordinal: number
  dataType: string
  nullable: boolean
  defaultValue?: string | null
  isPrimaryKey: boolean
  isIdentity: boolean
  isGenerated?: boolean
  maxLength?: number | null
  comment?: string | null
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  refSchema?: string
  refTable: string
  refColumns: string[]
  onUpdate?: string
  onDelete?: string
  /** Defined in the knowledge base rather than in the database. */
  virtual?: boolean
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  method?: string
}

export interface TableInfo {
  schema?: string
  name: string
  type: ObjectType
  comment?: string | null
  rowEstimate?: number | null
  columns: ColumnInfo[]
  primaryKey: string[]
  foreignKeys: ForeignKeyInfo[]
  indexes: IndexInfo[]
}

export interface RoutineInfo {
  schema?: string
  name: string
  kind: 'function' | 'procedure'
  returnType?: string | null
  arguments?: string | null
}

export interface SchemaSnapshot {
  database?: string
  defaultSchema?: string
  schemas: string[]
  tables: TableInfo[]
  routines: RoutineInfo[]
  capturedAt: string
}

export interface ServerInfo {
  product: string
  version: string
}
