import type { ForeignKeyInfo, TableInfo } from './types.js'

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

export function checkModel(tables: TableInfo[]): ModelIssue[] {
  const issues: ModelIssue[] = []
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

    const indexes = table.indexes.filter((ix) => !ix.primary)
    const columnsKey = (cols: string[]) => cols.map(lower).join(',')
    const pkKey = columnsKey(table.primaryKey)
    indexes.forEach((ix, i) => {
      const key = columnsKey(ix.columns)
      const twin = indexes.slice(0, i).find((other) => columnsKey(other.columns) === key && (other.unique || !ix.unique))
      if (twin || (key === pkKey && pkKey)) {
        // An index on the key's own columns is what some databases build the key from: worth a look, not an error.
        issues.push({ kind: 'duplicate_index', severity: twin ? 'warning' : 'info', ...at, column: ix.columns.join(', '), detail: twin ? twin.name : 'primary key', fixable: true })
        return
      }
      // A plain index on (a) adds nothing next to one on (a, b).
      const covering = indexes.find((other) => other !== ix && other.columns.length > ix.columns.length && columnsKey(other.columns.slice(0, ix.columns.length)) === key)
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
    const last = table.indexes.map((ix, i) => (!ix.primary && same(ix.columns) && (issue.kind === 'duplicate_index' || !ix.unique) ? i : -1)).filter((i) => i !== -1).pop()
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
