import { parseDbml, sampleDatabaseSql, tablesFromDdl, type CodeDatabase, type TableInfo } from '../src/index.js'

/**
 * Models the code generators (orm-export.ts) are checked with: the demo database, every type family in each
 * database's own spelling, and the relations that are hard to get right (composite, repeated, self-reference,
 * one-to-one, a table without a key, names that need quoting, enums).
 */
export interface OrmCase {
  name: string
  database: CodeDatabase
  tables: TableInfo[]
  enums: Record<string, string[]>
  defaultSchema?: string
}

/** Every type family, as each database spells it. */
const TYPES: Partial<Record<CodeDatabase, string[]>> = {
  postgres: ['smallint', 'integer', 'bigint', 'numeric(12,2)', 'numeric', 'money', 'real', '"double precision"', 'boolean', 'char(3)', 'varchar(100)', 'varchar', 'text', 'citext', 'uuid', 'date', 'time', 'timetz', 'timestamp', 'timestamp(3)', 'timestamptz', 'interval', 'json', 'jsonb', 'bytea', 'bit(8)', 'varbit', 'xml', 'inet', 'cidr', 'integer[]', 'text[]', 'point', 'tsvector'],
  cockroachdb: ['smallint', 'integer', 'bigint', 'numeric(12,2)', 'real', '"double precision"', 'boolean', 'char(3)', 'varchar(100)', 'text', 'uuid', 'date', 'time', 'timetz', 'timestamp', 'timestamptz', 'interval', 'jsonb', 'bytea', 'bit(8)', 'inet', 'integer[]', 'text[]'],
  mysql: ['tinyint', 'tinyint(1)', '"smallint unsigned"', 'mediumint', 'int', '"int unsigned"', 'bigint', '"bigint unsigned"', 'decimal(10,2)', 'float', 'double', 'bit(1)', 'bit(8)', 'char(2)', 'varchar(50)', 'tinytext', 'text', 'mediumtext', 'longtext', 'date', 'time', 'datetime', 'datetime(3)', 'timestamp', 'year', 'json', 'binary(16)', 'varbinary(64)', 'blob', 'longblob', '"enum(\'small\',\'large\')"', '"set(\'x\',\'y\')"', 'geometry'],
  mariadb: ['tinyint', 'int', 'bigint', 'decimal(10,2)', 'double', 'varchar(50)', 'text', 'longtext', 'datetime', 'timestamp', 'json', 'uuid', 'blob', '"enum(\'on\',\'off\')"'],
  mssql: ['tinyint', 'smallint', 'int', 'bigint', 'decimal(18,4)', 'money', 'smallmoney', 'real', 'float', 'bit', 'char(5)', 'nchar(5)', 'varchar(50)', 'nvarchar(100)', 'nvarchar(max)', 'varchar(max)', 'text', 'ntext', 'uniqueidentifier', 'date', 'time', 'datetime', 'datetime2', 'smalldatetime', 'datetimeoffset', 'binary(8)', 'varbinary(100)', 'varbinary(max)', 'image', 'xml', 'geography'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATETIME', 'DATE', 'VARCHAR(20)', 'JSON', 'DECIMAL(10,2)'],
  oracle: ['NUMBER(10)', 'NUMBER(19)', 'NUMBER(12,2)', 'NUMBER(1)', 'BINARY_DOUBLE', 'VARCHAR2(100)', 'NVARCHAR2(50)', 'CHAR(2)', 'CLOB', 'DATE', 'TIMESTAMP', '"TIMESTAMP WITH TIME ZONE"', 'RAW(16)', 'BLOB', 'XMLTYPE'],
  duckdb: ['INTEGER', 'BIGINT', 'HUGEINT', 'DOUBLE', 'DECIMAL(18,3)', 'BOOLEAN', 'VARCHAR', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'UUID', 'JSON', 'BLOB', 'INTERVAL', 'INTEGER[]'],
  clickhouse: ['UInt8', 'Int32', 'Int64', 'UInt64', 'Float64', 'Decimal(18,4)', 'Bool', 'String', 'FixedString(3)', 'Date', 'DateTime', 'DateTime64(3)', 'UUID'],
  bigquery: ['INT64', 'NUMERIC', 'FLOAT64', 'BOOL', 'STRING', 'BYTES', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON'],
  trino: ['integer', 'bigint', 'decimal(10,2)', 'double', 'boolean', 'varchar', 'varchar(20)', 'date', 'timestamp(3)', '"timestamp(3) with time zone"', 'uuid', 'json', 'varbinary'],
}

/** Defaults in each database's own words. */
const DEFAULTS: Partial<Record<CodeDatabase, { now: string; flag: string }>> = {
  postgres: { now: '`now()`', flag: 'true' },
  cockroachdb: { now: '`now()`', flag: 'true' },
  mysql: { now: '`CURRENT_TIMESTAMP`', flag: '1' },
  mariadb: { now: '`CURRENT_TIMESTAMP`', flag: '1' },
  mssql: { now: '`getdate()`', flag: '1' },
  sqlite: { now: '`CURRENT_TIMESTAMP`', flag: '1' },
}

const KEY: Record<string, string> = { postgres: 'integer', cockroachdb: 'integer', mysql: 'int', mariadb: 'int', mssql: 'int', sqlite: 'INTEGER', oracle: 'NUMBER(10)', duckdb: 'INTEGER', clickhouse: 'Int32', bigquery: 'INT64', trino: 'integer' }
const TEXT: Record<string, string> = { postgres: 'text', cockroachdb: 'text', mysql: 'varchar(100)', mariadb: 'varchar(100)', mssql: 'nvarchar(100)', sqlite: 'TEXT', oracle: 'VARCHAR2(100)', duckdb: 'VARCHAR', clickhouse: 'String', bigquery: 'STRING', trino: 'varchar' }
const TIME: Record<string, string> = { postgres: 'timestamp', cockroachdb: 'timestamp', mysql: 'datetime', mariadb: 'datetime', mssql: 'datetime2', sqlite: 'DATETIME', oracle: 'TIMESTAMP', duckdb: 'TIMESTAMP', clickhouse: 'DateTime', bigquery: 'DATETIME', trino: 'timestamp(3)' }
const FLAG: Record<string, string> = { postgres: 'boolean', cockroachdb: 'boolean', mysql: 'tinyint(1)', mariadb: 'tinyint(1)', mssql: 'bit', sqlite: 'BOOLEAN', oracle: 'NUMBER(1)', duckdb: 'BOOLEAN', clickhouse: 'Bool', bigquery: 'BOOL', trino: 'boolean' }

function typesModel(database: CodeDatabase): string {
  const types = TYPES[database] ?? []
  return `Table every_type {\n  id ${KEY[database]} [pk, increment]\n${types.map((t, i) => `  c${i + 1}_${t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase()} ${t}${i % 3 === 0 ? ' [not null]' : ''}`).join('\n')}\n}\n`
}

/** Relations that are hard to get right, and names that need quoting. */
function relationsModel(database: CodeDatabase): string {
  const k = KEY[database]!
  const txt = TEXT[database]!
  const d = DEFAULTS[database]
  const enumCol = ['postgres', 'cockroachdb', 'mysql', 'mariadb'].includes(database) ? '  status order_status [not null, default: \'new\']\n' : ''
  return `${enumCol ? 'Enum order_status {\n  new\n  paid\n  "on hold"\n}\n\n' : ''}Table customers {
  id ${k} [pk, increment]
  email ${txt} [not null, unique]
  name ${txt} [not null, note: 'The name on the invoice']
  vip ${FLAG[database]} [not null${d ? `, default: ${d.flag}` : ''}]
  created_at ${TIME[database]}${d ? ` [not null, default: ${d.now}]` : ''}
  Note: 'People who buy'
}

Table employees {
  id ${k} [pk, increment]
  name ${txt} [not null]
  manager_id ${k} [ref: > employees.id]
  mentor_id ${k} [ref: > employees.id]
}

Table orders {
  id ${k} [pk, increment]
  customer_id ${k} [not null, ref: > customers.id]
  billing_customer_id ${k} [ref: > customers.id]
  employee_id ${k}
${enumCol}  note ${txt} [default: 'none']

  indexes {
    (customer_id, id) [name: 'ix_orders_customer']
    employee_id [name: 'ix_orders_employee']
  }
}

Table order_lines {
  order_id ${k} [not null]
  line_no ${k} [not null]
  quantity ${k} [not null, default: 1]

  indexes {
    (order_id, line_no) [pk]
  }
}

Table shipments {
  id ${k} [pk, increment]
  order_id ${k} [not null]
  line_no ${k} [not null]
}

Table profiles {
  customer_id ${k} [pk]
  bio ${txt}
}

Table audit_log {
  happened_at ${TIME[database]}
  message ${txt}
}

Table "Order Details" {
  "Detail ID" ${k} [pk, increment]
  "Unit Price" ${k} [not null]
  "2fa" ${txt}
  class ${txt}
  "order" ${txt}
  default ${txt}
  "Ünïcode" ${txt}
}

Ref: orders.employee_id > employees.id [delete: set null]
Ref: order_lines.order_id > orders.id [delete: cascade]
Ref: shipments.(order_id, line_no) > order_lines.(order_id, line_no)
Ref: profiles.customer_id - customers.id [delete: cascade]
Ref: "Order Details"."Unit Price" > orders.id
`
}

/** A model whose tables live in two schemas, two of them under the same name. */
function schemasModel(database: CodeDatabase): string {
  const k = KEY[database]!
  return `Table app.accounts {\n  id ${k} [pk]\n  name ${TEXT[database]} [not null]\n}\n\nTable sales.accounts {\n  id ${k} [pk]\n  owner_id ${k} [not null, ref: > app.accounts.id]\n}\n`
}

export const ORM_DATABASES: CodeDatabase[] = ['postgres', 'cockroachdb', 'mysql', 'mariadb', 'mssql', 'sqlite', 'oracle', 'duckdb', 'clickhouse', 'bigquery', 'trino']

export async function ormCases(): Promise<OrmCase[]> {
  const demo = (await tablesFromDdl(sampleDatabaseSql().filter((s) => /^CREATE (TABLE|INDEX)/i.test(s)).join(';\n'))).tables.map((t) => ({ ...t, schema: undefined, foreignKeys: t.foreignKeys.map((f) => ({ ...f, refSchema: undefined })) }))
  const out: OrmCase[] = []
  for (const database of ORM_DATABASES) {
    out.push({ name: 'demo', database, tables: demo, enums: {} })
    for (const [name, text] of [
      ['types', typesModel(database)],
      ['relations', relationsModel(database)],
      ['schemas', schemasModel(database)],
    ] as const) {
      const model = parseDbml(text)
      if (model.errors.length) throw new Error(`${database} ${name}: ${JSON.stringify(model.errors)}`)
      out.push({ name, database, tables: model.tables, enums: model.enums })
    }
  }
  return out
}
