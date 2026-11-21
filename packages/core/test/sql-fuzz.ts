import { strToU8, zipSync } from 'fflate'
import type { DriverId, TableInfo } from '../src/index.js'
import { rng } from './orm-fuzz.js'

/**
 * Models whose SQL pieces (types, defaults, checks, index parts, collations, referential actions) and names come
 * from hostile SQL: every way to end a string, a comment or a statement in one of the dialects (review N1). Each
 * tries to drop the table `canary` or create the table `z`; the generators must write exactly the intended
 * statements whatever path the model took (our own objects, DBML, a drawDB or Workbench file, Mermaid).
 */
export const CANARY = 'canary'

const ATTACKS = [
  "'a'); DROP TABLE canary; --",
  "1); DROP TABLE canary; CREATE TABLE z (q int",
  "'x\\'); DROP TABLE canary; --'",
  "\"a\\\" = \"b)); DROP TABLE canary; CREATE TABLE z (q int, CHECK (\"",
  '$$); DROP TABLE canary; $$',
  '$q$ ); DROP TABLE canary; $q$',
  "E'\\''); DROP TABLE canary; --",
  '[a]]); DROP TABLE canary; --',
  'x\nGO\nDROP TABLE canary\nGO\n',
  'x\n/\nDROP TABLE canary\n/\n',
  'a /* ',
  '*/ ); DROP TABLE canary; /*',
  'a # x\n); DROP TABLE canary; #',
  'a--1); DROP TABLE canary',
  '/*!50000 ); DROP TABLE canary; */',
  'x\ndelimiter //\nDROP TABLE canary//\n',
  'x\n\\! touch PWNED\n',
  'CASCADE; DROP TABLE canary',
  '(a)); DROP TABLE canary; CREATE TABLE z ((q)',
  "`a`); DROP TABLE canary; --",
  'int references canary on delete cascade',
  'BEGIN ATOMIC DROP TABLE canary; END',
]
const BITS = ["'", '"', '`', '\\', ';', '(', ')', '[', ']', '--', '/*', '*/', '#', '$$', '\n', '\r', ' ', 'GO', 'E', 'N', ',', '!']

/** Names for databases that will really run the script: ASCII, no NUL, no trailing space, short. */
const NAME_BITS = ["'", '"', '`', ';', '(', ')', '-', '#', '$', ' ', '[', ']', '*', '/', '.', '=']

const PLAIN_TYPES: Partial<Record<DriverId, string[]>> = {
  postgres: ['integer', 'bigint', 'text', 'varchar(20)', 'numeric(10,2)', 'boolean', 'timestamp'],
  mysql: ['int', 'bigint', 'varchar(20)', 'decimal(10,2)', 'datetime', 'text'],
  mariadb: ['int', 'bigint', 'varchar(20)', 'decimal(10,2)', 'datetime', 'text'],
  mssql: ['int', 'bigint', 'nvarchar(50)', 'decimal(18,4)', 'bit', 'datetime2'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC'],
  oracle: ['NUMBER(10)', 'VARCHAR2(20)', 'DATE'],
  duckdb: ['INTEGER', 'VARCHAR', 'DOUBLE', 'BOOLEAN'],
}

export interface SqlFuzzOptions {
  /** Names a real database takes (integration runs); otherwise names are as hostile as the pieces. */
  runnable?: boolean
}

export function sqlFuzzModel(seed: number, driver: DriverId, options: SqlFuzzOptions = {}): TableInfo[] {
  const r = rng(seed)
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)]!
  const piece = () => {
    if (r() < 0.6) return pick(ATTACKS)
    let s = ''
    for (let i = 0, n = 1 + Math.floor(r() * 6); i < n; i++) s += r() < 0.6 ? pick(BITS) : String.fromCharCode(97 + Math.floor(r() * 26))
    return s
  }
  const used = new Set<string>()
  const nameOf = (prefix: string) => {
    let s = prefix
    for (let i = 0, n = Math.floor(r() * 5); i < n; i++) s += options.runnable ? pick(NAME_BITS) : r() < 0.5 ? pick(BITS) : pick(ATTACKS).slice(0, 12)
    s = s.replace(/\s+$/, '')
    while (used.has(s.toLowerCase())) s += 'x'
    used.add(s.toLowerCase())
    return s
  }
  const types = PLAIN_TYPES[driver] ?? PLAIN_TYPES.postgres!
  const tables: TableInfo[] = []
  for (let i = 0, n = 1 + Math.floor(r() * 3); i < n; i++) {
    const name = nameOf(`t${i}`)
    const columns = Array.from({ length: 2 + Math.floor(r() * 3) }, (_, k) => {
      const dataType = k === 0 ? types[0]! : r() < 0.25 ? piece() : pick(types)
      return {
        name: k === 0 ? 'id' : nameOf(`c${k}`),
        ordinal: k + 1,
        dataType,
        nullable: k !== 0,
        defaultValue: k === 0 ? null : r() < 0.4 ? piece() : null,
        isPrimaryKey: k === 0,
        isIdentity: false,
        comment: r() < 0.4 ? piece() : null,
        ...(k > 0 && r() < 0.15 ? { collation: piece() } : {}),
      }
    })
    const other = columns[1]!.name
    tables.push({
      name,
      type: 'table',
      comment: r() < 0.4 ? piece() : null,
      columns,
      primaryKey: ['id'],
      foreignKeys: [],
      indexes: [
        { name: `${name}_pkey`, columns: ['id'], unique: true, primary: true },
        ...(r() < 0.6 ? [{ name: nameOf(`ix${i}`), columns: [r() < 0.5 ? other : piece()], unique: false, primary: false }] : []),
      ],
      ...(r() < 0.5 ? { checks: [{ name: nameOf(`ck${i}`), expression: r() < 0.7 ? piece() : '1 = 1' }] } : {}),
    })
  }
  for (const t of tables.slice(1)) {
    if (r() < 0.6) t.foreignKeys.push({ name: nameOf('fk'), columns: ['id'], refTable: tables[0]!.name, refColumns: ['id'], onDelete: r() < 0.5 ? piece() : 'CASCADE', onUpdate: r() < 0.3 ? piece() : undefined })
  }
  return tables
}

/** The same model as a drawDB export (fields, indices, relationships with their actions). */
export function asDrawDb(tables: TableInfo[], database: string): Uint8Array {
  const fieldId = (t: number, c: number) => t * 100 + c
  return strToU8(
    JSON.stringify({
      database,
      tables: tables.map((t, ti) => ({
        id: ti,
        name: t.name,
        x: 0,
        y: 0,
        comment: t.comment ?? '',
        fields: t.columns.map((c, ci) => ({ id: fieldId(ti, ci), name: c.name, type: c.dataType, default: c.defaultValue ?? '', check: t.checks?.[0] && ci === 1 ? t.checks[0].expression : '', primary: c.isPrimaryKey, notNull: !c.nullable, unique: false, increment: false, comment: c.comment ?? '' })),
        indices: t.indexes.filter((i) => !i.primary).map((i, k) => ({ id: k, name: i.name, unique: i.unique, fields: i.columns })),
      })),
      relationships: tables.flatMap((t, ti) =>
        t.foreignKeys.map((fk, k) => {
          const target = tables.findIndex((x) => x.name === fk.refTable)
          return { id: `${ti}-${k}`, name: fk.name, startTableId: ti, startFieldId: fieldId(ti, 0), endTableId: target, endFieldId: fieldId(target, 0), deleteConstraint: fk.onDelete ?? '', updateConstraint: fk.onUpdate ?? '', cardinality: 'many_to_one' }
        }),
      ),
    }),
  )
}

const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** The same model as a MySQL Workbench file: types as explicit parameters, defaults, index expressions, rules. */
export function asWorkbench(tables: TableInfo[]): Uint8Array {
  let parts = 0
  const v = (key: string, type: string, value: string | number) => `<value type="${type}" key="${key}">${typeof value === 'string' ? xml(value) : value}</value>`
  const body = tables
    .map((t, ti) => {
      const id = (c: number) => `c${ti}_${c}`
      const columns = t.columns
        .map((c, ci) => {
          // A type the fuzz made up goes in as the simple type's explicit parameters (`(…)` after `int`).
          const simple = /^\w+$/.test(c.dataType) ? c.dataType.toLowerCase() : 'int'
          const params = /^\w+$/.test(c.dataType) ? '' : c.dataType
          return `<value type="object" struct-name="db.mysql.Column" id="${id(ci)}">${v('name', 'string', c.name)}${v('isNotNull', 'int', c.nullable ? 0 : 1)}${v('defaultValueIsNull', 'int', c.defaultValue ? 0 : 1)}${v('defaultValue', 'string', c.defaultValue ?? '')}${v('datatypeExplicitParams', 'string', params)}${v('comment', 'string', c.comment ?? '')}${c.collation ? v('collationName', 'string', c.collation) : ''}<link type="object" struct-name="db.SimpleDatatype" key="simpleType">com.mysql.rdbms.mysql.datatype.${xml(simple)}</link></value>`
        })
        .join('')
      const part = (c: string) => {
        const ci = t.columns.findIndex((x) => x.name === c)
        return `<value type="object" struct-name="db.mysql.IndexColumn" id="ic${ti}_${parts++}">${v('columnLength', 'int', 0)}${v('descend', 'int', 0)}${ci >= 0 ? `<link type="object" struct-name="db.Column" key="referencedColumn">${id(ci)}</link>` : v('expression', 'string', c)}</value>`
      }
      const indexes = t.indexes.map((i, k) => `<value type="object" struct-name="db.mysql.Index" id="i${ti}_${k}"><value type="list" content-type="object" key="columns">${i.columns.map(part).join('')}</value>${v('indexType', 'string', i.primary ? 'PRIMARY' : 'INDEX')}${v('isPrimary', 'int', i.primary ? 1 : 0)}${v('unique', 'int', i.unique ? 1 : 0)}${v('name', 'string', i.name)}</value>`).join('')
      const fks = t.foreignKeys
        .map((fk, k) => {
          const target = tables.findIndex((x) => x.name === fk.refTable)
          return `<value type="object" struct-name="db.mysql.ForeignKey" id="fk${ti}_${k}"><link type="object" struct-name="db.mysql.Table" key="referencedTable">t${target}</link><value type="list" content-type="object" key="columns"><link type="object">${id(0)}</link></value><value type="list" content-type="object" key="referencedColumns"><link type="object">c${target}_0</link></value>${v('deleteRule', 'string', fk.onDelete ?? '')}${v('updateRule', 'string', fk.onUpdate ?? '')}${v('many', 'int', 1)}${v('name', 'string', fk.name)}</value>`
        })
        .join('')
      return `<value type="object" struct-name="db.mysql.Table" id="t${ti}">${v('name', 'string', t.name)}${v('comment', 'string', t.comment ?? '')}<value type="list" content-type="object" key="columns">${columns}</value><value type="list" content-type="object" key="indices">${indexes}</value><value type="list" content-type="object" key="foreignKeys">${fks}</value></value>`
    })
    .join('')
  const doc = `<?xml version="1.0"?><data grt_format="2.0" document_type="MySQL Workbench Model" version="1.4.4"><value type="object" struct-name="workbench.Document" id="doc"><value type="list" content-type="object" key="physicalModels"><value type="object" struct-name="workbench.physical.Model" id="pm"><value type="object" struct-name="db.mysql.Catalog" id="cat" key="catalog"><value type="list" content-type="object" key="schemata"><value type="object" struct-name="db.mysql.Schema" id="s1">${v('name', 'string', 'fuzz')}<value type="list" content-type="object" key="tables">${body}</value></value></value></value></value></value></value></data>`
  return zipSync({ 'document.mwb.xml': strToU8(doc) })
}

/** The same model as a Mermaid ER diagram (types are single tokens there, so the hostile ones are squeezed). */
export function asMermaid(tables: TableInfo[]): Uint8Array {
  const token = (s: string) => s.replace(/[^\w\-[\](),."]/g, '') || 'x'
  const lines = ['erDiagram']
  for (const t of tables) {
    lines.push(`  "${t.name.replaceAll('"', '')}" {`)
    for (const c of t.columns) lines.push(`    ${token(c.dataType)} ${token(c.name)}${c.isPrimaryKey ? ' PK' : ''}${c.comment ? ` "${c.comment.replace(/["\n\r]/g, '')}"` : ''}`)
    lines.push('  }')
  }
  return strToU8(lines.join('\n'))
}
