import type { DriverId, TableInfo } from './types.js'

type Family = 'bool' | 'json' | 'text' | 'string' | 'timestamp' | 'timestamptz' | 'uuid' | 'double' | 'real' | 'binary' | 'tinyint' | 'datetime'

const TARGETS: Record<DriverId, Partial<Record<Family, string>>> = {
  postgres: { bool: 'boolean', json: 'jsonb', text: 'text', string: 'varchar(255)', timestamp: 'timestamp', timestamptz: 'timestamptz', uuid: 'uuid', double: 'double precision', real: 'real', binary: 'bytea', tinyint: 'smallint', datetime: 'timestamp' },
  mssql: { bool: 'bit', json: 'nvarchar(max)', text: 'nvarchar(max)', string: 'nvarchar(255)', timestamp: 'datetime2', timestamptz: 'datetimeoffset', uuid: 'uniqueidentifier', double: 'float', real: 'real', binary: 'varbinary(max)', datetime: 'datetime2' },
  mysql: { bool: 'tinyint(1)', json: 'json', text: 'text', string: 'varchar(255)', timestamp: 'datetime', timestamptz: 'timestamp', uuid: 'char(36)', double: 'double', real: 'float', binary: 'blob', datetime: 'datetime' },
  mariadb: { bool: 'tinyint(1)', json: 'json', text: 'text', string: 'varchar(255)', timestamp: 'datetime', timestamptz: 'timestamp', uuid: 'uuid', double: 'double', real: 'float', binary: 'blob', datetime: 'datetime' },
  sqlite: { bool: 'BOOLEAN', json: 'TEXT', text: 'TEXT', string: 'TEXT', timestamp: 'TEXT', timestamptz: 'TEXT', uuid: 'TEXT', double: 'REAL', real: 'REAL', binary: 'BLOB', tinyint: 'INTEGER', datetime: 'TEXT' },
  oracle: { bool: 'NUMBER(1)', json: 'CLOB', text: 'CLOB', string: 'VARCHAR2(255)', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMP WITH TIME ZONE', uuid: 'VARCHAR2(36)', double: 'BINARY_DOUBLE', real: 'BINARY_FLOAT', binary: 'BLOB', tinyint: 'NUMBER(3)', datetime: 'TIMESTAMP' },
  duckdb: { bool: 'BOOLEAN', json: 'JSON', text: 'VARCHAR', string: 'VARCHAR', timestamp: 'TIMESTAMP', timestamptz: 'TIMESTAMPTZ', uuid: 'UUID', double: 'DOUBLE', real: 'REAL', binary: 'BLOB', datetime: 'TIMESTAMP' },
  clickhouse: { bool: 'Bool', json: 'String', text: 'String', string: 'String', timestamp: 'DateTime64(3)', timestamptz: 'DateTime64(3)', uuid: 'UUID', double: 'Float64', real: 'Float32', binary: 'String', tinyint: 'Int8', datetime: 'DateTime' },
}

function family(type: string): Family | null {
  const t = type.trim().toLowerCase()
  if (/^(bool|boolean|bit)$/.test(t) || t === 'tinyint(1)' || t === 'number(1)') return 'bool'
  if (/^jsonb?$/.test(t)) return 'json'
  if (/^(text|clob|nclob|ntext|mediumtext|longtext|tinytext|citext)$/.test(t) || /^n?varchar\s*\(\s*max\s*\)$/.test(t)) return 'text'
  if (/^(varchar|nvarchar|character varying|string|varchar2|nvarchar2)$/.test(t)) return 'string'
  if (/^(timestamptz|timestamp with time zone|datetimeoffset)$/.test(t)) return 'timestamptz'
  if (/^(timestamp|timestamp without time zone|datetime2)$/.test(t)) return 'timestamp'
  if (/^(datetime|smalldatetime)$/.test(t)) return 'datetime'
  if (/^(uuid|uniqueidentifier)$/.test(t)) return 'uuid'
  if (/^(double|double precision|float8|binary_double)$/.test(t) || t === 'float') return 'double'
  if (/^(real|float4|binary_float)$/.test(t)) return 'real'
  if (/^(bytea|blob|longblob|mediumblob|image|raw)$/.test(t) || /^varbinary\s*\(\s*max\s*\)$/.test(t)) return 'binary'
  if (t === 'tinyint') return 'tinyint'
  return null
}

/** A column type written for another database, e.g. `boolean` → `bit` for SQL Server. Unknown types pass through. */
export function translateType(type: string, to: DriverId): string {
  const f = family(type)
  const mapped = f ? TARGETS[to][f] : undefined
  if (mapped) return mapped
  // Length-limited strings keep their length; SQL Server and Oracle prefer their national/2 variants.
  const m = /^(?:n?varchar2?|character varying|nvarchar2?)\s*\(\s*(\d+)\s*\)$/i.exec(type.trim())
  if (m) {
    const n = m[1]
    if (to === 'mssql') return `nvarchar(${n})`
    if (to === 'oracle') return `VARCHAR2(${n})`
    if (to === 'sqlite') return 'TEXT'
    if (to === 'clickhouse') return 'String'
    return `varchar(${n})`
  }
  if (to === 'oracle' && /^(integer|int|bigint|smallint)$/i.test(type.trim())) return /^bigint$/i.test(type.trim()) ? 'NUMBER(19)' : 'NUMBER(10)'
  return type
}

/** A default value written for another database (timestamps and booleans; other expressions pass through). */
export function translateDefault(value: string, to: DriverId): string {
  const v = value.trim()
  if (/^(now\(\)|current_timestamp(\(\))?|getdate\(\)|sysdatetime\(\)|systimestamp|localtimestamp)$/i.test(v)) {
    return to === 'mssql' ? 'SYSDATETIME()' : to === 'oracle' ? 'SYSTIMESTAMP' : to === 'postgres' ? 'now()' : 'CURRENT_TIMESTAMP'
  }
  const bool = /^(?:cast\s*\(\s*)?'?(t|f|true|false)'?(?:\s+as\s+boolean\s*\))?$/i.exec(v)
  if (bool) {
    const on = /^t/i.test(bool[1]!)
    return to === 'postgres' || to === 'duckdb' ? (on ? 'true' : 'false') : on ? '1' : '0'
  }
  return v
}

/** Bounded strings for key columns: MySQL can't index TEXT, SQL Server can't index nvarchar(max) (900-byte keys). */
const KEY_STRING: Partial<Record<DriverId, string>> = { mysql: 'varchar(255)', mariadb: 'varchar(255)', mssql: 'nvarchar(450)', oracle: 'VARCHAR2(1000)' }

/** Tables with column types and defaults written for `to`. */
export function translateTables(tables: TableInfo[], to: DriverId): TableInfo[] {
  return tables.map((t) => {
    const keyed = new Set([...t.primaryKey, ...t.indexes.flatMap((i) => i.columns), ...t.foreignKeys.flatMap((f) => f.columns)])
    return {
      ...t,
      columns: t.columns.map((c) => {
        const f = family(c.dataType)
        const dataType = keyed.has(c.name) && (f === 'text' || f === 'json' || f === 'string') && KEY_STRING[to] ? KEY_STRING[to]! : translateType(c.dataType, to)
        return { ...c, dataType, defaultValue: c.defaultValue ? translateDefault(c.defaultValue, to) : c.defaultValue }
      }),
    }
  })
}
