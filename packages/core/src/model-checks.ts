import type { DriverId, ForeignKeyInfo, IndexInfo, TableInfo } from './types.js'

/**
 * Checks a model for the things reviewers always look for: tables without a key, foreign keys that cannot work
 * (types that differ, a target that is not unique), indexes that repeat each other, relationships nobody declared,
 * and names that break the model's own prevailing style. Deterministic and instant, so it can run on every
 * keystroke; the judgement calls (is this normalized? should this be an enum?) are left to the AI review.
 */

export type ModelIssueKind =
  | 'no_primary_key'
  | 'no_columns'
  | 'fk_target_missing'
  | 'fk_target_not_unique'
  | 'fk_type_mismatch'
  | 'duplicate_index'
  | 'redundant_index'
  | 'fk_without_index'
  | 'missing_relationship'
  | 'naming'
  | 'name_too_long'

/**
 * The longest name each database keeps. PostgreSQL cuts a longer one to 63 bytes without a word (two long
 * constraint names can then become one); the others refuse it. SQLite and DuckDB have no limit that matters.
 */
export const NAME_LIMITS: Partial<Record<DriverId, number>> = { postgres: 63, mysql: 64, mariadb: 64, mssql: 128, oracle: 128, clickhouse: 255, bigquery: 300, trino: 255 }

export interface ModelIssue {
  kind: ModelIssueKind
  /** `warning`: the model is probably wrong. `info`: worth a look. */
  severity: 'warning' | 'info'
  schema?: string
  table: string
  column?: string
  /** The other object involved: index name, referenced table.column, the expected naming style. */
  detail?: string
  /** `fixModelIssue` can resolve it without a decision from the user. */
  fixable?: boolean
  /** For `missing_relationship`: the foreign key to add. */
  relationship?: ForeignKeyInfo
}

const lower = (s: string) => s.toLowerCase()

const IDENT = String.raw`(?:"(?:[^"]|"")*"|` + '`(?:[^`]|``)*`' + String.raw`|\[(?:[^\]]|\]\])*\]|[^\s."` + '`' + String.raw`[(]+)`
/**
 * What makes an index more than its columns, from the server's CREATE INDEX (`IndexInfo.definition`): the access
 * method, the key's expressions and order, INCLUDE and a WHERE. `tail` is that text after the table's name, the same
 * for the same index under another name; `plain` says it is a B-tree on bare columns with no condition.
 */
function indexShape(ix: IndexInfo): { plain: boolean; filtered: boolean; tail?: string } {
  const defaultMethod = !ix.method || /^(btree|nonclustered|clustered)$/i.test(ix.method)
  const bareColumns = ix.columns.every((c) => !/[()\s<>]/.test(c))
  if (!ix.definition) return { plain: defaultMethod && bareColumns, filtered: false }
  const m = new RegExp(String.raw`\sON\s+(?:ONLY\s+)?(?:${IDENT}\s*\.\s*)?${IDENT}\s*`, 'i').exec(ix.definition)
  if (!m) return { plain: false, filtered: true }
  const tail = ix.definition.slice(m.index + m[0].length).replace(/\s+/g, ' ').trim().toLowerCase()
  const method = /^using\s+(\w+)/.exec(tail)?.[1]
  const filtered = /\bwhere\b/.test(tail)
  const keys = /\(([^]*?)\)/.exec(tail)?.[1] ?? ''
  const plain = (!method || method === 'btree') && defaultMethod && bareColumns && !filtered && !/\binclude\b/.test(tail) && !/\b(desc|collate|nulls)\b|\(/.test(keys)
  return { plain, filtered, tail }
}

/** A wider index that serves its leading columns as a plain one would: a B-tree without a condition. */
function coversLike(ix: IndexInfo): boolean {
  const shape = indexShape(ix)
  if (shape.filtered) return false
  if (ix.method && !/^(btree|nonclustered|clustered)$/i.test(ix.method)) return false
  return !shape.tail || /^(using btree )?\(/.test(shape.tail)
}

/** Two indexes on the same columns do the same work: only when nothing else about them differs, or can't be told. */
function sameIndex(a: IndexInfo, b: IndexInfo): boolean {
  const [x, y] = [indexShape(a), indexShape(b)]
  if (x.tail !== undefined && y.tail !== undefined) return x.tail.replace(/^using btree /, '') === y.tail.replace(/^using btree /, '')
  return x.plain && y.plain
}
const sameTable = (t: TableInfo, schema: string | undefined, name: string) => lower(t.name) === lower(name) && (!schema || !t.schema || lower(t.schema) === lower(schema))

/** Types that hold the same values under different names: a foreign key between them is fine. */
const TYPE_FAMILIES: string[][] = [
  ['int', 'integer', 'int4', 'serial', 'serial4', 'mediumint', 'number', 'int32'],
  ['bigint', 'int8', 'bigserial', 'serial8', 'int64'],
  ['smallint', 'int2', 'smallserial', 'serial2', 'tinyint', 'int16'],
  ['varchar', 'character varying', 'nvarchar', 'varchar2', 'nvarchar2', 'text', 'string', 'char', 'character', 'nchar', 'bpchar', 'citext'],
  ['numeric', 'decimal', 'money'],
  ['uuid', 'uniqueidentifier', 'guid'],
  ['timestamp', 'datetime', 'datetime2', 'timestamp without time zone'],
  ['timestamptz', 'timestamp with time zone', 'datetimeoffset'],
  ['bool', 'boolean', 'bit'],
]
export function typeFamily(dataType: string): string {
  const base = lower(dataType).replace(/\(.*$/, '').replace(/\s+/g, ' ').replace(/ unsigned$/, '').trim()
  return TYPE_FAMILIES.find((f) => f.includes(base))?.[0] ?? base
}

type Style = 'snake_case' | 'camelCase' | 'PascalCase' | 'UPPER_CASE'
/** The style a name shows, or undefined when it fits several (one lower-case word) or none. */
function styleOf(name: string): Style | undefined {
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake_case'
  if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(name)) return 'UPPER_CASE'
  if (/^[a-z][a-z0-9]*([A-Z][a-z0-9]*)+$/.test(name)) return 'camelCase'
  if (/^([A-Z][a-z0-9]+){2,}$/.test(name)) return 'PascalCase'
  return undefined
}
/** The style nearly all multi-word names follow, if there is one. */
function prevailing(names: string[]): Style | undefined {
  const counts = new Map<Style, number>()
  for (const n of names) {
    const s = styleOf(n)
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const [top] = [...counts.entries()].sort((a, b) => b[1] - a[1])
  return top && total >= 5 && top[1] / total >= 0.8 ? top[0] : undefined
}

const singular = (word: string) => (/ies$/.test(word) ? `${word.slice(0, -3)}y` : /(ses|xes|ches|shes)$/.test(word) ? word.slice(0, -2) : /s$/.test(word) && !/ss$/.test(word) ? word.slice(0, -1) : word)
const words = (name: string) => lower(name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')

/**
 * Relationships the names suggest and nobody declared: a column called like another table's key (`customer_id`
 * next to a table `customer` or `customers`, or exactly the name of its key column) with a matching type.
 */
export function suggestRelationships(tables: TableInfo[]): ModelIssue[] {
  const out: ModelIssue[] = []
  // Everything about a possible parent is worked out once: large models have thousands of columns to try.
  const candidates = tables
    .filter((t) => t.type === 'table' && t.primaryKey.length === 1)
    .flatMap((table) => {
      const key = table.columns.find((c) => lower(c.name) === lower(table.primaryKey[0]!))
      if (!key) return []
      const name = words(table.name)
      return [{ table, family: typeFamily(key.dataType), name, single: singular(name), keyName: words(key.name) }]
    })
  for (const table of tables.filter((t) => t.type === 'table')) {
    const referencing = new Set(table.foreignKeys.flatMap((fk) => fk.columns.map(lower)))
    for (const column of table.columns) {
      if (referencing.has(lower(column.name))) continue
      // The table's own single-column key is not a reference to somewhere else.
      if (table.primaryKey.length === 1 && lower(table.primaryKey[0]!) === lower(column.name)) continue
      const name = words(column.name)
      const stem = /^(.+)_(id|fk|key|code|no|nr)$/.exec(name)?.[1] ?? /^(?:id|fk)_(.+)$/.exec(name)?.[1]
      const generic = /^(id|code|name|key)$/.test(name)
      if (!stem && generic) continue
      const family = typeFamily(column.dataType)
      const stemSingle = stem ? singular(stem) : undefined
      const matches = candidates
        .filter((parent) => {
          if (parent.table === table || parent.family !== family) return false
          // `customer_id` → customer / customers; or the column carries the parent's own key name (`PartyID` both sides).
          if (stem && (stem === parent.name || stem === parent.single || stemSingle === parent.single || parent.name.endsWith(`_${stem}`))) return true
          return parent.keyName === name && !generic
        })
        .map((parent) => parent.table)
      // Two tables that fit equally well: no guess.
      if (matches.length !== 1) continue
      const parent = matches[0]!
      out.push({
        kind: 'missing_relationship',
        severity: 'info',
        schema: table.schema,
        table: table.name,
        column: column.name,
        detail: `${parent.name}.${parent.primaryKey[0]}`,
        fixable: true,
        relationship: { name: `fk_${table.name}_${column.name}`, columns: [column.name], refSchema: parent.schema, refTable: parent.name, refColumns: [parent.primaryKey[0]!] },
      })
    }
  }
  return out
}

export function checkModel(tables: TableInfo[], options: { /** The database the model is for: its limits apply. */ driver?: DriverId } = {}): ModelIssue[] {
  const issues: ModelIssue[] = []
  const limit = options.driver ? NAME_LIMITS[options.driver] : undefined
  // (In bytes: PostgreSQL and MySQL count UTF-8 bytes, a Czech letter is two.)
  const tooLong = (name: string | undefined) => !!limit && !!name && new TextEncoder().encode(name).length > limit
  const real = tables.filter((t) => t.type === 'table')
  const tableStyle = prevailing(real.map((t) => t.name))
  const columnStyle = prevailing(real.flatMap((t) => t.columns.map((c) => c.name)))

  for (const table of real) {
    const at = { schema: table.schema, table: table.name }
    if (!table.columns.length) {
      issues.push({ kind: 'no_columns', severity: 'warning', ...at })
      continue
    }
    if (!table.primaryKey.length) issues.push({ kind: 'no_primary_key', severity: 'warning', ...at })
    if (limit) {
      const long = (name: string | undefined, column?: string) => tooLong(name) && issues.push({ kind: 'name_too_long', severity: 'warning', ...at, ...(column ? { column } : {}), detail: `${name!.length} > ${limit}` })
      long(table.name)
      for (const c of table.columns) long(c.name, c.name)
      for (const ix of table.indexes) if (!ix.primary) long(ix.name, ix.name)
      for (const fk of table.foreignKeys) long(fk.name, fk.name)
      for (const check of table.checks ?? []) long(check.name, check.name)
    }

    const indexes = table.indexes.filter((ix) => !ix.primary)
    const columnsKey = (cols: string[]) => cols.map(lower).join(',')
    const pkKey = columnsKey(table.primaryKey)
    indexes.forEach((ix, i) => {
      const key = columnsKey(ix.columns)
      const twin = indexes.slice(0, i).find((other) => columnsKey(other.columns) === key && (other.unique || !ix.unique) && sameIndex(ix, other))
      if (twin || (key === pkKey && pkKey && indexShape(ix).plain)) {
        // An index on the key's own columns is what some databases build the key from: worth a look, not an error.
        issues.push({ kind: 'duplicate_index', severity: twin ? 'warning' : 'info', ...at, column: ix.columns.join(', '), detail: twin ? twin.name : 'primary key', fixable: true })
        return
      }
      // A plain index on (a) adds nothing next to one on (a, b).
      // (Only between B-trees without a condition: a partial index, another method or an expression is no cover.)
      const covering = indexShape(ix).plain ? indexes.find((other) => other !== ix && other.columns.length > ix.columns.length && columnsKey(other.columns.slice(0, ix.columns.length)) === key && coversLike(other)) : undefined
      if (covering && !ix.unique) issues.push({ kind: 'redundant_index', severity: 'info', ...at, column: ix.columns.join(', '), detail: covering.name, fixable: true })
    })

    for (const fk of table.foreignKeys.filter((f) => !f.virtual)) {
      const parent = tables.find((t) => sameTable(t, fk.refSchema, fk.refTable))
      const target = `${fk.refTable}.${fk.refColumns.join(', ')}`
      if (!parent || fk.refColumns.some((c) => !parent.columns.some((x) => lower(x.name) === lower(c)))) {
        issues.push({ kind: 'fk_target_missing', severity: 'warning', ...at, column: fk.columns.join(', '), detail: target })
        continue
      }
      const refKey = columnsKey(fk.refColumns)
      const unique = columnsKey(parent.primaryKey) === refKey || parent.indexes.some((ix) => ix.unique && columnsKey(ix.columns) === refKey)
      if (!unique) issues.push({ kind: 'fk_target_not_unique', severity: 'warning', ...at, column: fk.columns.join(', '), detail: target })
      fk.columns.forEach((name, i) => {
        const own = table.columns.find((c) => lower(c.name) === lower(name))
        const other = parent.columns.find((c) => lower(c.name) === lower(fk.refColumns[i] ?? ''))
        if (own && other && typeFamily(own.dataType) !== typeFamily(other.dataType)) {
          issues.push({ kind: 'fk_type_mismatch', severity: 'warning', ...at, column: name, detail: `${own.dataType} ≠ ${parent.name}.${other.name} ${other.dataType}` })
        }
      })
      const fkKey = columnsKey(fk.columns)
      const indexed = pkKey.startsWith(fkKey) || table.indexes.some((ix) => columnsKey(ix.columns.slice(0, fk.columns.length)) === fkKey)
      if (!indexed) issues.push({ kind: 'fk_without_index', severity: 'info', ...at, column: fk.columns.join(', '), detail: fk.refTable, fixable: true })
    }

    if (tableStyle && styleOf(table.name) && styleOf(table.name) !== tableStyle) issues.push({ kind: 'naming', severity: 'info', ...at, detail: tableStyle })
    if (columnStyle) {
      for (const c of table.columns) {
        if (styleOf(c.name) && styleOf(c.name) !== columnStyle) issues.push({ kind: 'naming', severity: 'info', ...at, column: c.name, detail: columnStyle })
      }
    }
  }
  return [...issues, ...suggestRelationships(tables)]
}

/** The model with a fixable issue resolved, or null when the issue needs a decision. */
export function fixModelIssue(tables: TableInfo[], issue: ModelIssue): TableInfo[] | null {
  if (!issue.fixable) return null
  const index = tables.findIndex((t) => sameTable(t, issue.schema, issue.table))
  const table = tables[index]
  if (!table) return null
  const columns = (issue.column ?? '').split(', ').map(lower)
  const same = (cols: string[]) => cols.map(lower).join(',') === columns.join(',')
  let next: TableInfo
  if (issue.kind === 'duplicate_index' || issue.kind === 'redundant_index') {
    // The later of two equal indexes goes; of a covered one, the covered one.
    // (Only one the check calls the same: a partial or other kind of index on those columns stays.)
    const repeats = (ix: (typeof table.indexes)[number], i: number) =>
      issue.kind === 'duplicate_index'
        ? (issue.detail === 'primary key' && indexShape(ix).plain) || table.indexes.slice(0, i).some((other) => !other.primary && same(other.columns) && sameIndex(ix, other))
        : !ix.unique && indexShape(ix).plain
    const last = table.indexes.map((ix, i) => (!ix.primary && same(ix.columns) && repeats(ix, i) ? i : -1)).filter((i) => i !== -1).pop()
    if (last === undefined) return null
    next = { ...table, indexes: table.indexes.filter((_, i) => i !== last) }
  } else if (issue.kind === 'fk_without_index') {
    const fk = table.foreignKeys.find((f) => same(f.columns))
    if (!fk) return null
    next = { ...table, indexes: [...table.indexes, { name: `ix_${table.name}_${fk.columns.join('_')}`, columns: [...fk.columns], unique: false, primary: false }] }
  } else if (issue.kind === 'missing_relationship' && issue.relationship) {
    next = { ...table, foreignKeys: [...table.foreignKeys, issue.relationship] }
  } else return null
  return tables.map((t, i) => (i === index ? next : t))
}
