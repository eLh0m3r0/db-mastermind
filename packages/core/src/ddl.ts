import { qualify, type Dialect } from './dialect.js'
import { translateTables } from './type-map.js'
import type { ColumnInfo, DriverId, ForeignKeyInfo, IndexInfo, TableInfo, TableRef, CheckInfo } from './types.js'

/**
 * Schema design: the designer edits a draft copy of tables; `diffTables` turns the difference into
 * schema changes and `generateMigration` renders them as SQL for one dialect, with warnings and a
 * best-effort rollback script.
 */

export interface DesignColumn {
  /** Stable id so renames aren't mistaken for drop + add. */
  id: string
  name: string
  /** Name in the database; undefined for new columns. */
  originalName?: string
  dataType: string
  nullable: boolean
  defaultValue?: string | null
  identity?: boolean
  comment?: string | null
  /** Kept through design edits for models whose columns follow named types (see ColumnInfo.domain). */
  domain?: string
  /** See ColumnInfo.collation. */
  collation?: string
  /** See ColumnInfo.remarks. */
  remarks?: string
}

export interface DesignForeignKey {
  id: string
  name?: string
  /** Constraint name in the database; undefined for new keys. */
  originalName?: string
  columns: string[]
  refSchema?: string
  refTable: string
  refColumns: string[]
  onDelete?: string
  onUpdate?: string
  /** See ForeignKeyInfo.cardinality. */
  cardinality?: ForeignKeyInfo['cardinality']
}

export interface DesignIndex {
  id: string
  name?: string
  originalName?: string
  columns: string[]
  unique: boolean
  /** A UNIQUE constraint of the table rather than a unique index: created as one where the database has them. */
  constraint?: boolean
}

export interface DesignTable {
  id: string
  schema?: string
  name: string
  originalName?: string
  dropped?: boolean
  comment?: string | null
  columns: DesignColumn[]
  primaryKey: string[]
  foreignKeys: DesignForeignKey[]
  indexes: DesignIndex[]
  /** Check constraints: created with a new table; on an existing table added and dropped by name (see `diffTable`). */
  checks?: CheckInfo[]
  /** See TableInfo.remarks. */
  remarks?: string
  /** Diagram position, kept with the draft. */
  position?: { x: number; y: number }
}

export type SchemaChange =
  | { kind: 'create_table'; table: DesignTable }
  | { kind: 'drop_table'; table: TableRef }
  | { kind: 'rename_table'; table: TableRef; newName: string }
  | { kind: 'add_column'; table: TableRef; column: DesignColumn }
  | { kind: 'drop_column'; table: TableRef; column: string; before: ColumnInfo }
  | { kind: 'rename_column'; table: TableRef; column: string; newName: string }
  | {
      kind: 'alter_column'
      table: TableRef
      column: string
      before: ColumnInfo
      after: DesignColumn
      changes: { type?: boolean; nullable?: boolean; default?: boolean; comment?: boolean }
    }
  | { kind: 'add_foreign_key'; table: TableRef; fk: DesignForeignKey }
  | { kind: 'drop_foreign_key'; table: TableRef; name: string; before: ForeignKeyInfo }
  | { kind: 'add_index'; table: TableRef; index: DesignIndex }
  | { kind: 'drop_index'; table: TableRef; name: string; before: IndexInfo }
  | { kind: 'set_primary_key'; table: TableRef; columns: string[]; before: string[] }
  | { kind: 'set_table_comment'; table: TableRef; comment: string | null }
  /** `columns` are the table's columns once the migration is through (a condition names them). */
  | { kind: 'add_check'; table: TableRef; check: CheckInfo; columns: string[] }
  | { kind: 'drop_check'; table: TableRef; name: string; before: CheckInfo }

export interface MigrationWarning {
  level: 'danger' | 'warning' | 'info'
  message: string
}

export interface Migration {
  statements: string[]
  rollback: string[]
  warnings: MigrationWarning[]
  /** Whether the whole script can run in one transaction on this database. */
  transactional: boolean
}

let idSeq = 0
export function designId(prefix = 'd'): string {
  idSeq += 1
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}`
}

export function toDesignTable(t: TableInfo): DesignTable {
  return {
    id: designId('t'),
    schema: t.schema,
    name: t.name,
    originalName: t.name,
    comment: t.comment ?? null,
    columns: t.columns.map((c) => ({
      id: designId('c'),
      name: c.name,
      originalName: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      defaultValue: c.defaultValue ?? null,
      identity: c.isIdentity,
      comment: c.comment ?? null,
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.collation ? { collation: c.collation } : {}),
      ...(c.remarks ? { remarks: c.remarks } : {}),
    })),
    primaryKey: [...t.primaryKey],
    foreignKeys: t.foreignKeys
      .filter((f) => !f.virtual)
      .map((f) => ({ id: designId('f'), name: f.name, originalName: f.name, columns: [...f.columns], refSchema: f.refSchema, refTable: f.refTable, refColumns: [...f.refColumns], onDelete: f.onDelete, onUpdate: f.onUpdate, ...(f.cardinality ? { cardinality: f.cardinality } : {}) })),
    indexes: t.indexes
      .filter((i) => !i.primary)
      .map((i) => ({ id: designId('i'), name: i.name, originalName: i.name, columns: [...i.columns], unique: i.unique, ...(i.constraint ? { constraint: true } : {}) })),
    ...(t.checks?.length ? { checks: t.checks.map((c) => ({ ...c })) } : {}),
    ...(t.remarks ? { remarks: t.remarks } : {}),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
/** Spellings of one type: a model says `varchar(90)`, PostgreSQL's catalog `character varying(90)`. */
const TYPE_ALIASES: [RegExp, string][] = [
  [/^character varying\b/, 'varchar'],
  [/^(character|bpchar)\b/, 'char'],
  [/^(int4|int|integer|serial4|serial)\b(\(\d+\))?/, 'integer'],
  [/^(int8|bigint|bigserial|serial8)\b(\(\d+\))?/, 'bigint'],
  [/^(int2|smallint|smallserial|serial2)\b(\(\d+\))?/, 'smallint'],
  // MySQL's boolean is a tinyint(1).
  [/^(bool|tinyint\(1\))$/, 'boolean'],
  [/^(decimal|dec)\b/, 'numeric'],
  [/^(float8|double)$/, 'double precision'],
  [/^float4$/, 'real'],
  [/^timestamp(\(\d+\))? without time zone$/, 'timestamp$1'],
  [/^timestamp(\(\d+\))? with time zone$/, 'timestamptz$1'],
  [/^time(\(\d+\))? without time zone$/, 'time$1'],
  [/^time(\(\d+\))? with time zone$/, 'timetz$1'],
]
const normType = (type: string) => {
  const t = type.toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1').trim()
  const named = TYPE_ALIASES.find(([pattern]) => pattern.test(t))
  return (named ? t.replace(named[0], named[1]) : t)
    .replace(/^numeric\((\d+)\)$/, 'numeric($1,0)')
    // SQL Server's default precision of its date and time types, written out or not.
    .replace(/^(datetime2|datetimeoffset|time)\(7\)$/, '$1')
    .replace(/^float\(53\)$/, 'float')
}
/** A bare `numeric` is the database's default precision: 10 digits in MySQL, 18 in SQL Server, any number in PostgreSQL. */
const typesDiffer = (model: string, database: string) => {
  const [a, b] = [normType(model), normType(database)]
  return a !== b && !(a === 'numeric' && /^numeric\((10|18|38),0\)$/.test(b))
}
/** A type name without quotes and schema: `public."TECH_ID"` and `tech_id` are one. */
const plainName = (name: string) => name.replaceAll('"', '').split('.').pop()!.trim().toLowerCase()
/** Whether two type names mean the same type (`int` and `integer`, `varchar(9)` and `character varying(9)`). */
export const sameType = (a: string, b: string) => !typesDiffer(a, b)
/** `serial` is PostgreSQL's shorthand for an integer with its own sequence: an identity column in all but name. */
export const isSerialType = (type: string) => /^(small|big)?serial[248]?$/i.test(type.trim())
/**
 * A default as the catalog reports it next to the same default as a model writes it: PostgreSQL adds casts
 * (`'x'::character varying`) and parentheses, and keywords come back in either case.
 */
const normDefault = (value: string | null | undefined) => {
  let v = (value ?? '').trim()
  for (let before = ''; before !== v; ) {
    before = v
    v = v.replace(/::"?[a-z_][\w ]*"?(\(\d+(,\s*\d+)?\))?(\[\])?$/i, '').trim()
    if (/^\((.*)\)$/s.test(v) && balanced(v.slice(1, -1))) v = v.slice(1, -1).trim()
  }
  if (/^(now\(\)|current_timestamp(\(\))?|localtimestamp|getdate\(\)|sysdatetime\(\))$/i.test(v)) return 'now()'
  if (/^(current_date|curdate\(\)|cast\(getdate\(\) as date\)|convert\(\s*["[]?date["\]]?\s*,\s*getdate\(\)\s*\)|trunc\(sysdate\))$/i.test(v)) return 'current_date'
  if (/^n'.*'$/is.test(v)) v = v.slice(1)
  // MySQL takes "…" for a string as well.
  if (/^"[^"']*"$/.test(v)) v = `'${v.slice(1, -1)}'`
  return v.includes("'") ? v : v.toLowerCase()
}
function balanced(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    if (ch === '(') depth += 1
    else if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

/** Changes needed to turn `original` (live table, or undefined for a new one) into `draft`. */
export interface DiffOptions {
  /**
   * Whether a check the model and the database both have under one name has another condition in the model.
   * Only the database can tell (see `DatabaseService.canonicalChecks`); without it a same-named check is the same.
   */
  checkChanged?: (table: TableRef, name: string) => boolean
}

/** What `DatabaseService.canonicalChecks` says of one condition. */
export type CanonicalCheck = { definition: string; /** The table's own check of that name, stored the same way. */ current?: string } | { missingColumn: true } | null

/**
 * The checks of a model whose condition differs from the same-named check of the database, found by asking
 * the database how it would store the model's condition (`canonical`). The result is `DiffOptions.checkChanged`.
 */
export async function findChangedChecks(
  model: TableInfo[],
  database: TableInfo[],
  canonical: (items: { table: TableRef; check: CheckInfo }[]) => Promise<CanonicalCheck[]>,
): Promise<NonNullable<DiffOptions['checkChanged']>> {
  const key = (table: string, name: string) => `${table}\u0000${name}`.toLowerCase()
  const asked: { table: TableRef; check: CheckInfo; live: string }[] = []
  for (const t of model) {
    const named = database.filter((x) => x.type === 'table' && x.name.toLowerCase() === t.name.toLowerCase())
    const live = named.find((x) => (x.schema ?? '').toLowerCase() === (t.schema ?? '').toLowerCase()) ?? named[0]
    for (const check of t.checks ?? []) {
      const twin = check.name && live?.checks?.find((c) => c.name?.toLowerCase() === check.name!.toLowerCase())
      if (live && twin) asked.push({ table: { schema: live.schema, name: live.name }, check, live: twin.expression })
    }
  }
  const answers = asked.length ? await canonical(asked.map(({ table, check }) => ({ table, check }))) : []
  const changed = new Set(asked.filter((a, i) => { const answer = answers[i]; return !!answer && ('missingColumn' in answer || answer.definition.trim() !== (answer.current ?? a.live).trim()) }).map((a) => key(a.table.name, a.check.name!)))
  return (table, name) => changed.has(key(table.name, name))
}

export function diffTable(original: TableInfo | undefined, draftIn: DesignTable, options: DiffOptions = {}): SchemaChange[] {
  let draft = draftIn
  if (!original) return draft.dropped ? [] : [{ kind: 'create_table', table: draft }]
  const ref: TableRef = { schema: original.schema, name: original.name }
  if (draft.dropped) return [{ kind: 'drop_table', table: ref }]

  const changes: SchemaChange[] = []
  // The database renames columns inside keys and indexes by itself: compare using original names.
  const toOriginal = new Map(draft.columns.filter((c) => c.originalName).map((c) => [c.name, c.originalName!]))
  const orig = (cols: string[]) => cols.map((c) => toOriginal.get(c) ?? c)
  draft = {
    ...draft,
    foreignKeys: draft.foreignKeys.map((f) => ({ ...f, columns: orig(f.columns) })),
    indexes: draft.indexes.map((i) => ({ ...i, columns: orig(i.columns) })),
  }
  const draftPk = orig(draft.primaryKey)
  // Constraints referencing renamed/dropped columns must go first.
  const draftFkNames = new Set(draft.foreignKeys.map((f) => f.originalName).filter(Boolean))
  for (const fk of original.foreignKeys.filter((f) => !f.virtual)) {
    const kept = draft.foreignKeys.find((f) => f.originalName === fk.name)
    const changed =
      kept && (!same(kept.columns, fk.columns) || kept.refTable !== fk.refTable || !same(kept.refColumns, fk.refColumns) || (kept.onDelete ?? '') !== (fk.onDelete ?? ''))
    if (!draftFkNames.has(fk.name) || changed) changes.push({ kind: 'drop_foreign_key', table: ref, name: fk.name, before: fk })
  }
  const draftIndexNames = new Set(draft.indexes.map((i) => i.originalName).filter(Boolean))
  for (const ix of original.indexes.filter((i) => !i.primary)) {
    const kept = draft.indexes.find((i) => i.originalName === ix.name)
    if (!draftIndexNames.has(ix.name) || (kept && (!same(kept.columns, ix.columns) || kept.unique !== ix.unique)))
      changes.push({ kind: 'drop_index', table: ref, name: ix.name, before: ix })
  }

  // A primary key that loses a column to a drop goes first: SQL Server refuses to drop a key's column, and
  // PostgreSQL takes the key away with it.
  const pkChanged = !same(draftPk, original.primaryKey)
  const pkLosesColumn = pkChanged && original.primaryKey.some((c) => !draft.columns.some((x) => x.originalName === c))
  if (pkLosesColumn) changes.push({ kind: 'set_primary_key', table: ref, columns: [], before: original.primaryKey })

  let current: TableRef = ref
  if (draft.name !== original.name) {
    changes.push({ kind: 'rename_table', table: ref, newName: draft.name })
    current = { schema: ref.schema, name: draft.name }
  }

  // Renames first so later statements (and captured view definitions) see the final names.
  const renames: SchemaChange[] = []
  const drops: SchemaChange[] = []
  const adds: SchemaChange[] = []
  const alters: SchemaChange[] = []
  const draftOriginals = new Set(draft.columns.map((c) => c.originalName).filter(Boolean))
  const domainTyped = new Set<string>()
  for (const col of original.columns) {
    if (!draftOriginals.has(col.name)) drops.push({ kind: 'drop_column', table: current, column: col.name, before: col })
  }
  for (const col of draft.columns) {
    if (!col.originalName) {
      adds.push({ kind: 'add_column', table: current, column: col })
      continue
    }
    const before = original.columns.find((c) => c.name === col.originalName)
    if (!before) continue
    if (col.name !== col.originalName) renames.push({ kind: 'rename_column', table: current, column: col.originalName, newName: col.name })
    // A column that follows a named type and is typed by it in the database (`tech_id`) has the model's type,
    // and its default comes from there.
    const byDomain = !!col.domain && plainName(before.dataType) === plainName(col.domain)
    if (byDomain) domainTyped.add(col.name.toLowerCase())
    const diff = {
      type: !byDomain && typesDiffer(col.dataType, before.dataType),
      // PostgreSQL makes a serial column NOT NULL whatever the model says.
      nullable: col.nullable !== before.nullable && !(isSerialType(col.dataType) && !before.nullable),
      default: normDefault(col.defaultValue) !== normDefault(before.defaultValue) && !(byDomain && !before.defaultValue),
      comment: (col.comment ?? null) !== (before.comment ?? null),
    }
    if (diff.type || diff.nullable || diff.default || diff.comment) {
      alters.push({ kind: 'alter_column', table: current, column: col.name, before, after: col, changes: diff })
    }
  }
  changes.push(...renames, ...drops, ...adds, ...alters)

  if (pkChanged && !(pkLosesColumn && !draftIn.primaryKey.length)) changes.push({ kind: 'set_primary_key', table: current, columns: draftIn.primaryKey, before: pkLosesColumn ? [] : original.primaryKey })
  if ((draft.comment ?? null) !== (original.comment ?? null)) changes.push({ kind: 'set_table_comment', table: current, comment: draft.comment ?? null })

  draft.foreignKeys.forEach((fk, i) => {
    const before = fk.originalName ? original.foreignKeys.find((f) => f.name === fk.originalName) : undefined
    // (No rule and NO ACTION are the same rule.)
    const rule = (action: string | undefined) => (!action || action.toUpperCase() === 'NO ACTION' ? '' : action.toUpperCase())
    const unchanged = before && same(fk.columns, before.columns) && fk.refTable === before.refTable && same(fk.refColumns, before.refColumns) && rule(fk.onDelete) === rule(before.onDelete) && rule(fk.onUpdate) === rule(before.onUpdate)
    if (!unchanged) changes.push({ kind: 'add_foreign_key', table: current, fk: draftIn.foreignKeys[i]! })
  })
  draft.indexes.forEach((ix, i) => {
    const before = ix.originalName ? original.indexes.find((x) => x.name === ix.originalName) : undefined
    if (!before || !same(ix.columns, before.columns) || ix.unique !== before.unique) changes.push({ kind: 'add_index', table: current, index: draftIn.indexes[i]! })
  })

  // Check constraints go by name. A database stores a condition rewritten its own way (`x IN ('A','B')` comes
  // back as `x = ANY (ARRAY[…])`), so two conditions can't be compared as text: a check of the same name is the
  // same check. A check the model does not name stands for any one check of the database the model does not
  // name either. Only where the database says which checks it has (`checks` set).
  if (original.checks) {
    // (A check a column has from its named type is that type's in the database, not the table's.)
    const wanted = (draftIn.checks ?? []).filter((c) => c.expression.trim() && !(c.column && domainTyped.has(c.column.toLowerCase())))
    const live = new Map(original.checks.map((c) => [(c.name ?? '').toLowerCase(), c]))
    const kept = new Set<string>()
    const columns = draftIn.columns.map((c) => c.name)
    for (const check of wanted.filter((c) => c.name)) {
      const name = check.name!.toLowerCase()
      if (!live.has(name)) changes.push({ kind: 'add_check', table: current, check, columns })
      else {
        kept.add(name)
        // The same name with another condition: the old one goes, the model's comes.
        if (options.checkChanged?.(ref, check.name!)) changes.push({ kind: 'drop_check', table: ref, name: live.get(name)!.name!, before: live.get(name)! }, { kind: 'add_check', table: current, check, columns })
      }
    }
    const unnamed = wanted.filter((c) => !c.name)
    const spare = original.checks.filter((c) => !kept.has((c.name ?? '').toLowerCase()))
    for (const check of unnamed.slice(spare.length)) changes.push({ kind: 'add_check', table: current, check, columns })
    for (const check of spare.slice(unnamed.length)) if (check.name) changes.push({ kind: 'drop_check', table: ref, name: check.name, before: check })
  }
  return changes
}

export function diffTables(originals: TableInfo[], drafts: DesignTable[], options: DiffOptions = {}): SchemaChange[] {
  const byName = (d: DesignTable) =>
    d.originalName ? originals.find((t) => t.name === d.originalName && (t.schema ?? '') === (d.schema ?? '')) : undefined
  const drops: SchemaChange[] = []
  const creates: SchemaChange[] = []
  const alters: SchemaChange[] = []
  for (const d of drafts) {
    for (const change of diffTable(byName(d), d, options)) {
      if (change.kind === 'create_table') creates.push(change)
      else if (change.kind === 'drop_table') drops.push(change)
      else alters.push(change)
    }
  }
  // A table goes before the tables it references; tables that reference each other lose those keys first.
  const key = (t: { schema?: string; name: string }) => `${t.schema ?? ''}\u0000${t.name}`
  const leaving = new Map(drops.flatMap((c) => (c.kind === 'drop_table' ? [[key(c.table), originals.find((t) => key(t) === key(c.table))] as const] : [])))
  const ordered: SchemaChange[] = []
  const loose: SchemaChange[] = []
  const cut = new Set<ForeignKeyInfo>()
  while (leaving.size) {
    const pointsAt = (name: string) => [...leaving].some(([other, t]) => other !== name && t?.foreignKeys.some((f) => !f.virtual && !cut.has(f) && key({ schema: f.refSchema ?? t.schema, name: f.refTable }) === name))
    let next = [...leaving.keys()].find((name) => !pointsAt(name))
    if (!next) {
      // A circle: one table's keys into the others are dropped by name, and the search goes on.
      next = leaving.keys().next().value!
      for (const [other, t] of leaving) {
        if (other === next || !t) continue
        for (const f of t.foreignKeys.filter((x) => !x.virtual && !cut.has(x) && key({ schema: x.refSchema ?? t.schema, name: x.refTable }) === next)) {
          cut.add(f)
          loose.push({ kind: 'drop_foreign_key', table: { schema: t.schema, name: t.name }, name: f.name, before: f })
        }
      }
    }
    ordered.push(drops.find((c) => key(c.table) === next)!)
    leaving.delete(next)
  }
  drops.splice(0, drops.length, ...loose, ...ordered)
  // FK additions run last so referenced tables/columns exist; drops of FKs first.
  // Checks leave before the columns they name change and come once those are as the model has them.
  const first = (c: SchemaChange) => c.kind === 'drop_foreign_key' || c.kind === 'drop_index' || c.kind === 'drop_check'
  const last = (c: SchemaChange) => c.kind === 'add_check' || c.kind === 'add_foreign_key'
  // Foreign keys go before indexes: a key may rest on a unique index of the table it references.
  const fkDrops = [...alters.filter((c) => c.kind === 'drop_foreign_key'), ...alters.filter((c) => c.kind === 'drop_check'), ...alters.filter((c) => c.kind === 'drop_index')]
  const fkAdds = [...alters.filter((c) => c.kind === 'add_check'), ...alters.filter((c) => c.kind === 'add_foreign_key')]
  const rest = alters.filter((c) => !first(c) && !last(c))
  return [...fkDrops, ...drops, ...creates, ...rest, ...fkAdds]
}

// ---------------------------------------------------------------------------
// SQL generation

function constraintName(prefix: string, table: string, columns: string[]): string {
  return `${prefix}_${table}_${columns.join('_')}`.replace(/[^\w]/g, '_').slice(0, 60)
}

function literalComment(text: string, driver: DriverId): string {
  const escaped = text.replaceAll("'", "''")
  return driver === 'mssql' ? `N'${escaped}'` : `'${escaped}'`
}

/**
 * A check's condition for this database. Identifiers are always quoted here, so a column the condition names
 * bare has to be quoted as well where that changes which column it is (PostgreSQL folds bare names to lower
 * case, Oracle to upper). In a check that belongs to one column, `value` stands for that column.
 */
export function checkCondition(check: CheckInfo, columns: { name: string }[], d: Dialect): string {
  const folded = d.id === 'postgres' ? (n: string) => n.toLowerCase() : d.id === 'oracle' ? (n: string) => n.toUpperCase() : null
  const placeholder = check.column && !columns.some((c) => c.name.toLowerCase() === 'value') ? check.column : null
  return check.expression.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*/g, (word, offset: number, whole: string) => {
    if (!/^[A-Za-z_]/.test(word) || /^\s*\(/.test(whole.slice(offset + word.length)) || whole[offset - 1] === '.') return word
    if (placeholder && word.toLowerCase() === 'value') return d.quoteIdent(placeholder)
    const named = columns.filter((c) => c.name.toLowerCase() === word.toLowerCase())
    return folded && named.length === 1 && folded(named[0]!.name) !== named[0]!.name ? d.quoteIdent(named[0]!.name) : word
  })
}

function columnDefinition(c: DesignColumn, d: Dialect, opts: { inlinePk?: boolean; sequence?: string } = {}): string {
  // (The collation is written as the model has it: DeZign writes what was typed, quotes included.)
  const parts = [d.quoteIdent(c.name), c.collation ? `${c.dataType} COLLATE ${c.collation}` : c.dataType]
  // `serial` already brings its sequence.
  if (c.identity && !(d.id === 'postgres' && isSerialType(c.dataType))) {
    if (d.id === 'postgres' || d.id === 'oracle') parts.push('GENERATED BY DEFAULT AS IDENTITY')
    else if (d.id === 'mssql') parts.push('IDENTITY(1,1)')
    else if (d.id === 'mysql' || d.id === 'mariadb') parts.push('AUTO_INCREMENT')
    // DuckDB has no identity columns: a sequence supplies the values.
    else if (d.id === 'duckdb' && opts.sequence) parts.push(`DEFAULT nextval('${opts.sequence.replaceAll("'", "''")}')`)
  }
  const hasDefault = c.defaultValue !== undefined && c.defaultValue !== null && c.defaultValue !== ''
  // Oracle requires DEFAULT before constraints.
  if (hasDefault && d.id === 'oracle') parts.push(`DEFAULT ${c.defaultValue}`)
  if (opts.inlinePk) parts.push('PRIMARY KEY')
  if (!c.nullable) parts.push('NOT NULL')
  if (hasDefault && d.id !== 'oracle') parts.push(`DEFAULT ${c.defaultValue}`)
  if (c.comment && (d.id === 'mysql' || d.id === 'mariadb')) parts.push(`COMMENT ${literalComment(c.comment, d.id)}`)
  return parts.join(' ')
}

function fkClause(fk: DesignForeignKey, table: string, d: Dialect): string {
  const name = fk.name || constraintName('fk', table, fk.columns)
  // SQLite references can't be schema-qualified (the referenced table lives in the same database).
  const ref = d.id === 'sqlite' ? d.quoteIdent(fk.refTable) : qualify(d, { schema: fk.refSchema, name: fk.refTable })
  let sql = `CONSTRAINT ${d.quoteIdent(name)} FOREIGN KEY (${fk.columns.map((c) => d.quoteIdent(c)).join(', ')}) REFERENCES ${ref} (${fk.refColumns.map((c) => d.quoteIdent(c)).join(', ')})`
  // DuckDB foreign keys have no referential actions.
  if (d.id === 'duckdb') return sql
  if (fk.onDelete && fk.onDelete.toUpperCase() !== 'NO ACTION') sql += ` ON DELETE ${fk.onDelete.toUpperCase()}`
  if (fk.onUpdate && fk.onUpdate.toUpperCase() !== 'NO ACTION' && d.id !== 'oracle') sql += ` ON UPDATE ${fk.onUpdate.toUpperCase()}`
  return sql
}

/** Drops a column's default constraint, whose name SQL Server generates. `n` keeps variables unique per batch. */
function mssqlDropDefault(table: TableRef, column: string, n: number, d: Dialect): string {
  const tableName = `${table.schema ? `${table.schema}.` : ''}${table.name}`
  return `DECLARE @df${n} NVARCHAR(256) = (SELECT dc.name FROM sys.default_constraints dc JOIN sys.columns c ON c.default_object_id = dc.object_id WHERE dc.parent_object_id = OBJECT_ID(${literalComment(tableName, 'mssql')}) AND c.name = ${literalComment(column, 'mssql')});\nIF @df${n} IS NOT NULL EXEC('ALTER TABLE ${qualify(d, table).replaceAll("'", "''")} DROP CONSTRAINT [' + @df${n} + ']')`
}

const NARROWING = /^(varchar|nvarchar|char|nchar|character varying|varbinary)\((\d+)\)/i

function isNarrowing(before: string, after: string): boolean {
  const a = NARROWING.exec(before)
  const b = NARROWING.exec(after)
  if (a && b) return Number(b[2]) < Number(a[2])
  // Unbounded text into a bounded type.
  if (!a && b && /text|clob|max\)/i.test(before)) return true
  const rank = (t: string) => {
    const x = t.toLowerCase()
    if (/bigint|int8/.test(x)) return 4
    if (/^(int|integer|int4)/.test(x)) return 3
    if (/smallint|int2/.test(x)) return 2
    if (/tinyint/.test(x)) return 1
    return 0
  }
  const ra = rank(before)
  const rb = rank(after)
  if (ra && rb) return rb < ra
  // Text to anything else, or anything to a non-text type, can fail or truncate.
  return /char|text|clob/i.test(before) && !/char|text|clob/i.test(after)
}

/** A named type of a model (a DeZign domain): in PostgreSQL a `CREATE DOMAIN`, which the columns that follow it are typed by. */
export interface ModelDomain {
  name: string
  dataType: string
  defaultValue?: string | null
  /** The domain's check; `value` stands for the column. */
  check?: string | null
  notNull?: boolean
}

export interface MigrationOptions {
  /**
   * The name of a table's primary key constraint, where the model has a say (a DeZign project's `PK_%table%`).
   * An empty name is a key without a name of its own (the database gives it one).
   */
  primaryKeyName?: (table: TableRef) => string | undefined
  /** The model's named types, for a database that has them (PostgreSQL): columns that follow one are typed by it. */
  domains?: ModelDomain[]
  /**
   * Whether a unique index of the model is a UNIQUE constraint, where the model knows better than the index's own
   * `constraint` flag (a DeZign project: everything unique that is not one of its unique indexes).
   */
  uniqueConstraint?: (table: TableRef, name: string | undefined) => boolean | undefined
}

/** Renders a change set as SQL. `tables` is the live schema (needed by MySQL MODIFY and SQLite rebuilds). */
export function generateMigration(changes: SchemaChange[], dialect: Dialect, tables: TableInfo[] = [], options: MigrationOptions = {}): Migration {
  // DuckDB can't alter a table once a new table references it: create new tables after the alters.
  if (dialect.id === 'duckdb') changes = [...changes.filter((c) => c.kind !== 'create_table'), ...changes.filter((c) => c.kind === 'create_table')]
  const d = dialect
  const statements: string[] = []
  const rollback: string[] = []
  const warnings: MigrationWarning[] = []
  // PostgreSQL has the model's named types: a column that follows one is typed by it and takes its default and
  // check from it, as in the scripts DeZign writes. (Elsewhere the column carries the type itself.)
  // Written bare, as DeZign writes it: a domain somebody called INTEGER or REAL then means the database's own
  // type of that name, in our script as in DeZign's.
  const domainName = (name: string) => (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name) ? name.toLowerCase() : d.quoteIdent(name))
  const usedDomains = new Map<string, ModelDomain>()
  const viaDomain = new Set<string>()
  if (options.domains?.length && d.id === 'postgres') {
    const byName = new Map(options.domains.map((x) => [x.name.toLowerCase(), x]))
    const typed = (table: string) => <T extends DesignColumn>(c: T): T => {
      const domain = c.domain ? byName.get(c.domain.toLowerCase()) : undefined
      if (!domain || !sameType(domain.dataType, c.dataType)) return c
      usedDomains.set(domain.name.toLowerCase(), domain)
      if (domain.check) viaDomain.add(`${table}\u0000${c.name}`.toLowerCase())
      return { ...c, dataType: domainName(domain.name), defaultValue: normDefault(c.defaultValue) === normDefault(domain.defaultValue) ? null : c.defaultValue }
    }
    changes = changes.map((c) =>
      c.kind === 'create_table'
        ? { ...c, table: { ...c.table, columns: c.table.columns.map(typed(c.table.name)) } }
        : c.kind === 'add_column'
          ? { ...c, column: typed(c.table.name)(c.column) }
          : c.kind === 'alter_column' && c.changes.type
            ? { ...c, after: typed(c.table.name)(c.after) }
            : c,
    )
  }
  const q = (ref: TableRef) => qualify(d, ref)
  const id = (n: string) => d.quoteIdent(n)
  const isMy = d.id === 'mysql' || d.id === 'mariadb'
  let mssqlVar = 0
  // Names made up here must not repeat: index names are per schema, MySQL's foreign key names per database, and
  // two relationships over the same columns (or long names cut at 60 characters) would get the same one.
  const taken = new Set(tables.flatMap((t) => [...t.indexes.map((i) => i.name), ...t.foreignKeys.map((f) => f.name ?? '')]).map((n) => n.toLowerCase()))
  // (A name this migration drops is free again: an index that changes is dropped and added under its name.)
  for (const c of changes) if (c.kind === 'drop_index' || c.kind === 'drop_foreign_key') taken.delete(c.name.toLowerCase())
  const numbered = (base: string): string => {
    let name = base
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, 60 - String(n).length - 1)}_${n}`
    taken.add(name.toLowerCase())
    return name
  }
  const fresh = (prefix: string, table: string, columns: string[]): string => {
    return numbered(constraintName(prefix, table, columns))
  }
  // A UNIQUE constraint is made as one, not as the unique index that would enforce the same.
  const constraints = d.id === 'postgres' || d.id === 'mssql' || d.id === 'oracle' || isMy
  const isConstraint = (table: TableRef, ix: DesignIndex) => constraints && ix.unique && (options.uniqueConstraint?.(table, ix.name) ?? !!ix.constraint)
  /** `CONSTRAINT "name" ` for a primary key, or nothing where the model leaves the key unnamed. */
  const keyClause = (table: TableRef, columns: string[]) => {
    const own = options.primaryKeyName?.(table)
    return own === '' ? '' : `CONSTRAINT ${id(own ? numbered(own) : fresh('pk', table.name, columns))} `
  }
  // Names the model gives come first and are kept; the same name given twice (two indexes called IDX_1 in two
  // tables) is numbered like a made-up one.
  const given = new Map<object, string>()
  for (const c of changes) {
    const named = c.kind === 'create_table' ? [...c.table.foreignKeys, ...c.table.indexes] : c.kind === 'add_foreign_key' ? [c.fk] : c.kind === 'add_index' ? [c.index] : []
    for (const x of named) if (x.name) given.set(x, numbered(x.name))
  }
  // A model's tables may live in schemas the database does not have yet.
  // (Each database has one schema from the start; `dbo` in a PostgreSQL model is a schema like any other.)
  const builtIn = d.id === 'postgres' ? 'public' : d.id === 'mssql' ? 'dbo' : d.id === 'duckdb' ? 'main' : ''
  const present = new Set(tables.map((t) => t.schema?.toLowerCase()))
  for (const schema of new Set(changes.flatMap((c) => (c.kind === 'create_table' && c.table.schema ? [c.table.schema] : [])))) {
    if (present.has(schema.toLowerCase()) || schema.toLowerCase() === builtIn) continue
    if (d.id === 'mssql') statements.push(`IF SCHEMA_ID(${literalComment(schema, 'mssql')}) IS NULL EXEC(${literalComment(`CREATE SCHEMA ${id(schema)}`, 'mssql')})`)
    else if (d.id === 'postgres' || isMy || d.id === 'duckdb') statements.push(`CREATE SCHEMA IF NOT EXISTS ${id(schema)}`)
  }
  for (const domain of usedDomains.values()) {
    const name = unquotedName(domain.name, 'postgres')
    const create = `CREATE DOMAIN ${domainName(domain.name)} AS ${domain.dataType}${domain.defaultValue ? ` DEFAULT ${domain.defaultValue}` : ''}${domain.notNull ? ' NOT NULL' : ''}${domain.check ? ` CHECK (${domain.check})` : ''}`
    // A database that already has tables may have the domain too.
    statements.push(tables.length ? `DO $dbm$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = ${literalComment(name, 'postgres')}) THEN ${create}; END IF; END $dbm$` : create)
  }
  // A new table may reference one created further down, or a column an existing table only gets in this
  // migration: the foreign keys of new tables wait until everything else is in place.
  const laterForeignKeys: { sql: string; undo: string | null }[] = []
  const created = new Set(changes.flatMap((c) => (c.kind === 'create_table' ? [c.table.name] : [])))
  /** Tables whose change is blocked by (PostgreSQL) or breaks (SQLite rebuild) dependent views. */
  const viewSensitive = new Set<string>()
  /** Where dependent views must be dropped: right before the first statement that needs it. */
  let viewDropAt = -1
  const markViewSensitive = (table: string) => {
    if (viewDropAt === -1) viewDropAt = statements.length
    viewSensitive.add(table)
  }
  const renamedColumns: { table: string; from: string; to: string }[] = []
  /** SQLite: columns as they are at this point of the script, for table rebuilds. */
  const sqliteColumns = new Map<string, DesignColumn[]>()
  const currentColumns = (table: TableRef): DesignColumn[] => {
    let cols = sqliteColumns.get(table.name)
    if (!cols) {
      const live = tables.find((t) => t.name === table.name)
      cols = live ? toDesignTable(live).columns : []
      sqliteColumns.set(table.name, cols)
    }
    return cols
  }
  const rebuild = (table: TableRef, map: (cols: DesignColumn[]) => DesignColumn[], addFk?: DesignForeignKey, dropFk?: string, pk?: string[]) => {
    const cols = map(currentColumns(table)).map((c) => ({ ...c, originalName: c.name }))
    sqliteColumns.set(table.name, cols)
    return sqliteRebuild(table, tables, () => cols, d, addFk, dropFk, pk)
  }

  for (const change of changes) {
    // DuckDB refuses to alter a table that views (or foreign keys) depend on: views are dropped and recreated around it.
    if (d.id === 'duckdb' && change.kind !== 'create_table' && change.kind !== 'drop_table' && change.kind !== 'add_index' && change.kind !== 'drop_index') {
      markViewSensitive(change.table.name)
    }
    switch (change.kind) {
      case 'create_table': {
        const t = change.table
        const ref = { schema: t.schema, name: t.name }
        const inlinePk = t.primaryKey.length === 1 && d.id === 'sqlite' && t.columns.find((c) => c.name === t.primaryKey[0])?.identity
        const sequences = new Map<string, string>()
        if (d.id === 'duckdb') {
          for (const c of t.columns.filter((x) => x.identity)) {
            const seq = q({ schema: t.schema, name: `${t.name}_${c.name}_seq` })
            sequences.set(c.name, seq)
            statements.push(`CREATE SEQUENCE ${seq}`)
            rollback.unshift(`DROP SEQUENCE ${seq}`)
          }
        }
        const lines = t.columns.map((c) => `  ${columnDefinition(c, d, { inlinePk: !!inlinePk && c.name === t.primaryKey[0], sequence: sequences.get(c.name) })}`)
        if (t.primaryKey.length && !inlinePk) lines.push(`  ${keyClause(ref, t.primaryKey)}PRIMARY KEY (${t.primaryKey.map(id).join(', ')})`)
        // SQLite and DuckDB can't add foreign keys later: declare them in the table.
        const inlineFks = d.id === 'sqlite' || d.id === 'duckdb'
        // The same relationship drawn twice is one constraint.
        const fkKey = (f: DesignForeignKey) => JSON.stringify([f.columns, f.refSchema ?? '', f.refTable, f.refColumns, f.onDelete ?? '', f.onUpdate ?? ''])
        const foreignKeys = t.foreignKeys.filter((f, i, all) => all.findIndex((x) => fkKey(x) === fkKey(f)) === i).map((f) => ({ ...f, name: given.get(f) ?? fresh('fk', t.name, f.columns) }))
        if (inlineFks) for (const fk of foreignKeys) lines.push(`  ${fkClause(fk, t.name, d)}`)
        // (PostgreSQL folds two identical UNIQUE constraints of one CREATE TABLE into one: the second of a model
        // that has two is added after the table, so the database has what the model has.)
        const uniques = t.indexes.filter((x) => isConstraint(ref, x))
        const repeated = uniques.filter((x, i) => uniques.findIndex((y) => same(y.columns, x.columns)) !== i || same(x.columns, t.primaryKey))
        for (const ix of uniques.filter((x) => !repeated.includes(x))) lines.push(`  CONSTRAINT ${id(given.get(ix) ?? fresh('ux', t.name, ix.columns))} UNIQUE (${ix.columns.map(id).join(', ')})`)
        // (A check the column has from its domain is the domain's here.)
        for (const check of (t.checks ?? []).filter((c) => !(c.column && viaDomain.has(`${t.name}\u0000${c.column}`.toLowerCase())))) lines.push(`  ${check.name ? `CONSTRAINT ${id(check.name)} ` : ''}CHECK (${checkCondition(check, t.columns, d)})`)
        let sql = `CREATE TABLE ${q(ref)} (\n${lines.join(',\n')}\n)`
        if (isMy && t.comment) sql += ` COMMENT=${literalComment(t.comment, d.id)}`
        statements.push(sql)
        if (!inlineFks) {
          for (const fk of foreignKeys) {
            // Tables that reference each other can't be dropped one by one: the rollback takes such keys off first.
            const undo = fk.refTable !== t.name && created.has(fk.refTable) ? `ALTER TABLE ${q(ref)} DROP ${isMy ? 'FOREIGN KEY' : 'CONSTRAINT'} ${id(fk.name)}` : null
            laterForeignKeys.push({ sql: `ALTER TABLE ${q(ref)} ADD ${fkClause(fk, t.name, d)}`, undo })
          }
        }
        for (const ix of repeated) statements.push(`ALTER TABLE ${q(ref)} ADD CONSTRAINT ${id(given.get(ix) ?? fresh('ux', t.name, ix.columns))} UNIQUE (${ix.columns.map(id).join(', ')})`)
        for (const ix of t.indexes.filter((x) => !isConstraint(ref, x))) {
          statements.push(createIndexSql(given.get(ix) ?? fresh(ix.unique ? 'ux' : 'ix', t.name, ix.columns), ref, ix.columns, ix.unique, d))
        }
        statements.push(...commentStatements(ref, t.comment ?? null, t.columns, d))
        rollback.unshift(`DROP TABLE ${q(ref)}`)
        if (!t.primaryKey.length) warnings.push({ level: 'info', message: `${t.name} has no primary key; rows can't be edited in the grid.` })
        break
      }
      case 'drop_table': {
        statements.push(`DROP TABLE ${q(change.table)}`)
        warnings.push({ level: 'danger', message: `Dropping ${change.table.name} deletes all of its data.` })
        rollback.unshift(`-- Cannot restore dropped table ${change.table.name}; restore it from a backup.`)
        break
      }
      case 'rename_table': {
        const to = { schema: change.table.schema, name: change.newName }
        if (d.id === 'mssql') statements.push(`EXEC sp_rename ${literalComment(`${change.table.schema ? `${change.table.schema}.` : ''}${change.table.name}`, 'mssql')}, ${literalComment(change.newName, 'mssql')}`)
        else if (isMy) statements.push(`RENAME TABLE ${q(change.table)} TO ${q(to)}`)
        else statements.push(`ALTER TABLE ${q(change.table)} RENAME TO ${id(change.newName)}`)
        rollback.unshift(d.id === 'mssql' ? `EXEC sp_rename N'${change.table.schema ? `${change.table.schema}.` : ''}${change.newName}', N'${change.table.name}'` : `ALTER TABLE ${q(to)} RENAME TO ${id(change.table.name)}`)
        warnings.push({ level: 'info', message: `Renaming ${change.table.name} breaks views, procedures and application code that use the old name.` })
        break
      }
      case 'add_column': {
        statements.push(
          d.id === 'oracle'
            ? `ALTER TABLE ${q(change.table)} ADD (${columnDefinition(change.column, d)})`
            : `ALTER TABLE ${q(change.table)} ADD ${d.id === 'mssql' ? '' : 'COLUMN '}${columnDefinition(change.column, d)}`,
        )
        if (d.id === 'sqlite') sqliteColumns.set(change.table.name, [...currentColumns(change.table), change.column])
        rollback.unshift(`ALTER TABLE ${q(change.table)} DROP COLUMN ${id(change.column.name)}`)
        if (!change.column.nullable && !change.column.defaultValue && !change.column.identity) {
          warnings.push({ level: 'warning', message: `${change.table.name}.${change.column.name} is NOT NULL without a default: this fails if the table has rows.` })
        }
        statements.push(...commentStatements(change.table, undefined, change.column.comment ? [change.column] : [], d))
        break
      }
      case 'drop_column': {
        if (d.id === 'mssql') {
          // A column with a default constraint can't be dropped until the constraint is.
          statements.push(mssqlDropDefault(change.table, change.column, ++mssqlVar, d))
        }
        statements.push(`ALTER TABLE ${q(change.table)} DROP COLUMN ${id(change.column)}`)
        if (d.id === 'sqlite') sqliteColumns.set(change.table.name, currentColumns(change.table).filter((c) => c.name !== change.column))
        warnings.push({ level: 'danger', message: `Dropping ${change.table.name}.${change.column} deletes its data.` })
        rollback.unshift(
          d.id === 'oracle'
            ? `ALTER TABLE ${q(change.table)} ADD (${id(change.column)} ${change.before.dataType}) -- data is not restored`
            : `ALTER TABLE ${q(change.table)} ADD ${d.id === 'mssql' ? '' : 'COLUMN '}${id(change.column)} ${change.before.dataType} -- data is not restored`,
        )
        break
      }
      case 'rename_column': {
        renamedColumns.push({ table: change.table.name, from: change.column, to: change.newName })
        if (d.id === 'sqlite') {
          const cols = currentColumns(change.table)
          sqliteColumns.set(change.table.name, cols.map((c) => (c.name === change.column ? { ...c, name: change.newName } : c)))
        }
        if (d.id === 'mssql') {
          statements.push(`EXEC sp_rename ${literalComment(`${change.table.schema ? `${change.table.schema}.` : ''}${change.table.name}.${change.column}`, 'mssql')}, ${literalComment(change.newName, 'mssql')}, 'COLUMN'`)
          rollback.unshift(`EXEC sp_rename N'${change.table.schema ? `${change.table.schema}.` : ''}${change.table.name}.${change.newName}', N'${change.column}', 'COLUMN'`)
        } else {
          statements.push(`ALTER TABLE ${q(change.table)} RENAME COLUMN ${id(change.column)} TO ${id(change.newName)}`)
          rollback.unshift(`ALTER TABLE ${q(change.table)} RENAME COLUMN ${id(change.newName)} TO ${id(change.column)}`)
        }
        break
      }
      case 'alter_column': {
        const { before, after, changes: c } = change
        const t = q(change.table)
        const col = id(after.name)
        if (c.type && isNarrowing(before.dataType, after.dataType)) {
          warnings.push({ level: 'warning', message: `${change.table.name}.${after.name}: ${before.dataType} → ${after.dataType} may fail or truncate existing values.` })
        }
        if (c.nullable && !after.nullable) {
          warnings.push({ level: 'warning', message: `${change.table.name}.${after.name} becomes NOT NULL: this fails if any row has NULL.` })
        }
        if (d.id === 'postgres') {
          if (c.type) markViewSensitive(change.table.name)
          // PostgreSQL won't change the type under a default it can't cast (`false` to bigint): the default steps
          // aside and comes back, as the model has it, after the change. A sequence's default converts by itself.
          const aside = !!c.type && !!before.defaultValue && !before.isIdentity && !/^nextval\(/i.test(before.defaultValue)
          if (aside) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`)
          if (c.type) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${after.dataType} USING ${col}::${after.dataType}`)
          if (c.nullable) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${after.nullable ? 'DROP' : 'SET'} NOT NULL`)
          if (after.defaultValue ? c.default || aside : c.default && !aside) statements.push(after.defaultValue ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${after.defaultValue}` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`)
          if (aside) rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${before.defaultValue}`)
          if (c.type) rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${before.dataType} USING ${col}::${before.dataType}`)
          if (aside) rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`)
          if (c.nullable) rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} ${before.nullable ? 'DROP' : 'SET'} NOT NULL`)
          if (c.default) rollback.unshift(before.defaultValue ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${before.defaultValue}` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`)
        } else if (d.id === 'mssql') {
          if (c.type || c.nullable) {
            statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${after.dataType} ${after.nullable ? 'NULL' : 'NOT NULL'}`)
            rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} ${before.dataType} ${before.nullable ? 'NULL' : 'NOT NULL'}`)
          }
          if (c.default) {
            statements.push(mssqlDropDefault(change.table, after.name, ++mssqlVar, d))
            if (after.defaultValue) statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${id(constraintName('df', change.table.name, [after.name]))} DEFAULT ${after.defaultValue} FOR ${col}`)
          }
        } else if (d.id === 'oracle') {
          // MODIFY repeats only what changed: restating NULL on a nullable column is an error (ORA-01451).
          const mod = (dataType: string | undefined, def: string | null | undefined, nullable: boolean | undefined, withDefault: boolean) =>
            `ALTER TABLE ${t} MODIFY (${col}${dataType ? ` ${dataType}` : ''}${withDefault ? ` DEFAULT ${def || 'NULL'}` : ''}${nullable === undefined ? '' : nullable ? ' NULL' : ' NOT NULL'})`
          if (c.type || c.nullable || c.default) {
            statements.push(mod(c.type ? after.dataType : undefined, after.defaultValue, c.nullable ? after.nullable : undefined, !!c.default))
            rollback.unshift(mod(c.type ? before.dataType : undefined, before.defaultValue, c.nullable ? before.nullable : undefined, !!c.default))
          }
        } else if (isMy) {
          if (c.type || c.nullable || c.default || c.comment) {
            statements.push(`ALTER TABLE ${t} MODIFY COLUMN ${columnDefinition(after, d)}`)
            rollback.unshift(
              `ALTER TABLE ${t} MODIFY COLUMN ${columnDefinition({ ...after, dataType: before.dataType, nullable: before.nullable, defaultValue: before.defaultValue ?? null, comment: before.comment ?? null }, d)}`,
            )
          }
        } else {
          markViewSensitive(change.table.name)
          statements.push(...rebuild(change.table, (cols) => cols.map((x) => (x.name === after.name ? { ...x, dataType: after.dataType, nullable: after.nullable, defaultValue: after.defaultValue ?? null } : x))))
          warnings.push({ level: 'info', message: `SQLite can't alter columns in place: ${change.table.name} is rebuilt (copy, drop, rename).` })
        }
        if (c.comment && !isMy) statements.push(...commentStatements(change.table, undefined, [after], d, true))
        break
      }
      case 'add_foreign_key': {
        if (d.id === 'sqlite') {
          markViewSensitive(change.table.name)
          statements.push(...rebuild(change.table, (cols) => cols, change.fk))
          warnings.push({ level: 'info', message: `SQLite can't add constraints in place: ${change.table.name} is rebuilt.` })
          break
        }
        const name = given.get(change.fk) ?? fresh('fk', change.table.name, change.fk.columns)
        statements.push(`ALTER TABLE ${q(change.table)} ADD ${fkClause({ ...change.fk, name }, change.table.name, d)}`)
        rollback.unshift(isMy ? `ALTER TABLE ${q(change.table)} DROP FOREIGN KEY ${id(name)}` : `ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${id(name)}`)
        warnings.push({ level: 'info', message: `The foreign key on ${change.table.name}(${change.fk.columns.join(', ')}) fails if existing rows reference missing ${change.fk.refTable} rows.` })
        break
      }
      case 'drop_foreign_key': {
        if (d.id === 'sqlite') {
          markViewSensitive(change.table.name)
          statements.push(...rebuild(change.table, (cols) => cols, undefined, change.name))
          break
        }
        statements.push(isMy ? `ALTER TABLE ${q(change.table)} DROP FOREIGN KEY ${id(change.name)}` : `ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${id(change.name)}`)
        const b = change.before
        rollback.unshift(`ALTER TABLE ${q(change.table)} ADD ${fkClause({ id: '', name: b.name, columns: b.columns, refSchema: b.refSchema, refTable: b.refTable, refColumns: b.refColumns, onDelete: b.onDelete }, change.table.name, d)}`)
        break
      }
      case 'add_index': {
        const ix = change.index
        const name = given.get(ix) ?? fresh(ix.unique ? 'ux' : 'ix', change.table.name, ix.columns)
        if (isConstraint(change.table, ix)) {
          statements.push(`ALTER TABLE ${q(change.table)} ADD CONSTRAINT ${id(name)} UNIQUE (${ix.columns.map(id).join(', ')})`)
          rollback.unshift(isMy ? dropIndexSql(name, change.table, d) : `ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${id(name)}`)
        } else {
          statements.push(createIndexSql(name, change.table, ix.columns, ix.unique, d))
          rollback.unshift(dropIndexSql(name, change.table, d))
        }
        if (ix.unique) warnings.push({ level: 'info', message: `Unique index ${name} fails if duplicates already exist.` })
        break
      }
      case 'drop_index': {
        if (change.before.constraint && (d.id === 'postgres' || d.id === 'mssql' || d.id === 'oracle')) statements.push(`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${id(change.name)}`)
        else statements.push(dropIndexSql(change.name, change.table, d))
        rollback.unshift(
          change.before.constraint && constraints
            ? `ALTER TABLE ${q(change.table)} ADD CONSTRAINT ${id(change.name)} UNIQUE (${change.before.columns.map(id).join(', ')})`
            : createIndexSql(change.name, change.table, change.before.columns, change.before.unique, d),
        )
        break
      }
      case 'set_primary_key': {
        const t = q(change.table)
        const named = change.columns.length ? keyClause(change.table, change.columns) : ''
        if (d.id === 'sqlite') {
          markViewSensitive(change.table.name)
          statements.push(...rebuild(change.table, (cols) => cols, undefined, undefined, change.columns))
          break
        }
        if (change.before.length) {
          if (isMy || d.id === 'oracle') statements.push(`ALTER TABLE ${t} DROP PRIMARY KEY`)
          else if (d.id === 'postgres')
            // The constraint name isn't in the snapshot; look it up at run time.
            statements.push(
              `DO $dbm$ DECLARE n text; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid = ${literalComment(t, 'postgres')}::regclass AND contype = 'p'; IF n IS NOT NULL THEN EXECUTE format('ALTER TABLE ${t.replaceAll("'", "''")} DROP CONSTRAINT %I', n); END IF; END $dbm$`,
            )
          else {
            const n = ++mssqlVar
            statements.push(
              `DECLARE @pk${n} NVARCHAR(256) = (SELECT name FROM sys.key_constraints WHERE type = 'PK' AND parent_object_id = OBJECT_ID(${literalComment(`${change.table.schema ? `${change.table.schema}.` : ''}${change.table.name}`, 'mssql')}));\nEXEC('ALTER TABLE ${t.replaceAll("'", "''")} DROP CONSTRAINT [' + @pk${n} + ']')`,
            )
          }
        }
        if (change.columns.length) statements.push(`ALTER TABLE ${t} ADD ${named}PRIMARY KEY (${change.columns.map(id).join(', ')})`)
        warnings.push({ level: 'warning', message: `Changing the primary key of ${change.table.name} rebuilds its index and may break foreign keys that reference it.` })
        break
      }
      case 'set_table_comment':
        statements.push(...commentStatements(change.table, change.comment, [], d, true))
        break
      case 'add_check':
      case 'drop_check': {
        const t = q(change.table)
        if (d.id === 'sqlite' || d.id === 'duckdb') {
          warnings.push({ level: 'warning', message: `${d.id === 'sqlite' ? 'SQLite' : 'DuckDB'} can't add or drop a check on an existing table: ${change.table.name} keeps the checks it has.` })
          break
        }
        const add = (check: CheckInfo, columns: string[]) => `ALTER TABLE ${t} ADD ${check.name ? `CONSTRAINT ${id(check.name)} ` : ''}CHECK (${checkCondition(check, columns.map((name) => ({ name })), d)})`
        const drop = (name: string) => `ALTER TABLE ${t} DROP ${d.id === 'mysql' ? 'CHECK' : 'CONSTRAINT'} ${id(name)}`
        if (change.kind === 'add_check') {
          statements.push(add(change.check, change.columns))
          if (change.check.name) rollback.unshift(drop(change.check.name))
          warnings.push({ level: 'info', message: `The check on ${change.table.name} fails if existing rows break it.` })
        } else {
          statements.push(drop(change.name))
          rollback.unshift(add(change.before, []))
        }
        break
      }
    }
  }
  statements.push(...laterForeignKeys.map((f) => f.sql))
  for (const f of laterForeignKeys) if (f.undo) rollback.unshift(f.undo)

  if (d.id === 'duckdb' && viewDropAt !== -1) {
    // DuckDB can't alter a table that has indexes: drop them first, recreate them (and new ones) at the end.
    const isCreateIndex = (sql: string) => /^CREATE (UNIQUE )?INDEX /.test(sql)
    const newIndexes = statements.filter(isCreateIndex)
    for (let i = statements.length - 1; i >= 0; i--) if (isCreateIndex(statements[i]!)) statements.splice(i, 1)
    const droppedByUser = new Set(changes.flatMap((c) => (c.kind === 'drop_index' ? [c.name] : [])))
    const droppedColumns = new Set(changes.flatMap((c) => (c.kind === 'drop_column' ? [`${c.table.name}.${c.column}`] : [])))
    const indexDrops: string[] = []
    for (const name of viewSensitive) {
      const t = tables.find((x) => x.name === name && x.type === 'table')
      for (const ix of t?.indexes ?? []) {
        if (ix.primary || ix.constraint || droppedByUser.has(ix.name)) continue
        indexDrops.push(dropIndexSql(ix.name, { schema: t!.schema, name }, d))
        if (ix.columns.some((c) => droppedColumns.has(`${name}.${c}`))) continue
        const columns = ix.columns.map((c) => renamedColumns.find((r) => r.table === name && r.from === c)?.to ?? c)
        newIndexes.push(createIndexSql(ix.name, { schema: t!.schema, name }, columns, ix.unique, d))
      }
    }
    statements.splice(viewDropAt, 0, ...indexDrops)
    statements.push(...newIndexes)
  }

  if (d.id === 'duckdb') {
    const referenced = [...viewSensitive].filter((name) => tables.some((t) => t.name !== name && t.foreignKeys.some((fk) => fk.refTable === name)))
    if (referenced.length) {
      warnings.push({ level: 'danger', message: `DuckDB can't alter ${referenced.join(', ')} while other tables reference it with foreign keys: drop those foreign keys (recreate the referencing tables) first.` })
    }
  }

  // A view that reads what is being dropped can't be put back as it was: the database refuses the drop, and
  // the script says so before anyone runs it.
  const mentions = (v: TableInfo, name: string) => new RegExp(`(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w$])`, 'i').test(v.definition ?? '')
  for (const c of changes) {
    if (c.kind !== 'drop_table' && c.kind !== 'drop_column') continue
    const readers = tables.filter((v) => v.type !== 'table' && mentions(v, c.table.name) && (c.kind === 'drop_table' || mentions(v, c.column)))
    if (readers.length) warnings.push({ level: 'danger', message: `${readers.map((v) => v.name).join(', ')} ${readers.length === 1 ? 'reads' : 'read'} ${c.table.name}${c.kind === 'drop_column' ? `.${c.column}` : ''}: change or drop the view first, or the database refuses this.` })
  }

  // Views that read the affected tables are dropped first and recreated from their saved definition.
  const dependents = tables.filter(
    (v) => v.type !== 'table' && v.definition && [...viewSensitive].some((name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(v.definition!)),
  )
  if (dependents.length) {
    const ref = (v: TableInfo) => qualify(d, { schema: v.schema, name: v.name })
    const kind = (v: TableInfo) => (v.type === 'materialized_view' ? 'MATERIALIZED VIEW' : 'VIEW')
    const drops: string[] = []
    let recreate: string[]
    if (d.id === 'postgres') {
      // Capture definitions at this point of the transaction, after earlier renames, so they stay valid.
      drops.push(`CREATE TEMP TABLE IF NOT EXISTS dbm_saved_views (n int, ddl text) ON COMMIT DROP`)
      dependents.forEach((v, i) =>
        drops.push(`INSERT INTO dbm_saved_views SELECT ${i}, ${literalComment(`CREATE ${kind(v)} ${ref(v)} AS `, 'postgres')} || pg_get_viewdef(${literalComment(ref(v), 'postgres')}::regclass, true)`),
      )
      recreate = [`DO $dbm$ DECLARE r record; BEGIN FOR r IN SELECT ddl FROM dbm_saved_views ORDER BY n LOOP EXECUTE r.ddl; END LOOP; END $dbm$`]
    } else {
      const renamed = (text: string) =>
        renamedColumns.reduce((t, r) => t.replace(new RegExp(`\\b${r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), r.to), text)
      recreate = dependents.map((v) =>
        d.id === 'sqlite' ? renamed(v.definition!.trim().replace(/;$/, '')) : `CREATE ${kind(v)} ${ref(v)} AS\n${renamed(v.definition!.trim().replace(/;$/, ''))}`,
      )
    }
    drops.push(...dependents.map((v) => `DROP ${kind(v)} ${ref(v)}`))
    statements.splice(viewDropAt, 0, ...drops)
    statements.push(...recreate)
    warnings.push({ level: 'info', message: `Dependent views are dropped and recreated: ${dependents.map((v) => v.name).join(', ')}. Their grants and comments must be re-applied.` })
  }

  const transactional = d.id === 'postgres' || d.id === 'mssql' || d.id === 'sqlite' || d.id === 'duckdb'
  if (d.id === 'duckdb' && changes.some((c) => ['add_foreign_key', 'drop_foreign_key', 'set_primary_key'].includes(c.kind))) {
    warnings.push({ level: 'warning', message: 'DuckDB cannot add or remove primary and foreign keys on an existing table; recreate the table instead.' })
  }
  if (!transactional && statements.length > 1) {
    warnings.push({ level: 'warning', message: `${d.id === 'oracle' ? 'Oracle' : 'MySQL/MariaDB'} commit${d.id === 'oracle' ? 's' : ''} each DDL statement immediately: if a statement fails, earlier ones stay applied.` })
  }
  return { statements, rollback, warnings, transactional }
}

function createIndexSql(name: string, table: TableRef, columns: string[], unique: boolean, d: Dialect): string {
  const cols = columns.map((c) => d.quoteIdent(c)).join(', ')
  // SQLite qualifies the index name, not the table.
  if (d.id === 'sqlite') {
    const indexName = table.schema ? `${d.quoteIdent(table.schema)}.${d.quoteIdent(name)}` : d.quoteIdent(name)
    return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${indexName} ON ${d.quoteIdent(table.name)} (${cols})`
  }
  return `CREATE ${unique ? 'UNIQUE ' : ''}INDEX ${d.quoteIdent(name)} ON ${qualify(d, table)} (${cols})`
}

function dropIndexSql(name: string, table: TableRef, d: Dialect): string {
  if (d.id === 'mssql' || d.id === 'mysql' || d.id === 'mariadb') return `DROP INDEX ${d.quoteIdent(name)} ON ${qualify(d, table)}`
  return `DROP INDEX ${table.schema && (d.id === 'postgres' || d.id === 'oracle' || d.id === 'duckdb') ? `${d.quoteIdent(table.schema)}.` : ''}${d.quoteIdent(name)}`
}

function commentStatements(table: TableRef, tableComment: string | null | undefined, columns: DesignColumn[], d: Dialect, allowNull = false): string[] {
  const out: string[] = []
  const t = qualify(d, table)
  if (d.id === 'postgres' || d.id === 'oracle' || d.id === 'duckdb') {
    // Oracle has no NULL comment: an empty string removes it.
    const empty = d.id === 'oracle' ? "''" : 'NULL'
    if (tableComment !== undefined && (tableComment || allowNull)) out.push(`COMMENT ON TABLE ${t} IS ${tableComment ? literalComment(tableComment, d.id) : empty}`)
    for (const c of columns) if (c.comment || allowNull) out.push(`COMMENT ON COLUMN ${t}.${d.quoteIdent(c.name)} IS ${c.comment ? literalComment(c.comment, d.id) : empty}`)
  } else if (d.id === 'mssql') {
    const schema = table.schema ?? 'dbo'
    const prop = (value: string, column?: string) =>
      `EXEC sys.sp_addextendedproperty @name = N'MS_Description', @value = ${literalComment(value, 'mssql')}, @level0type = N'SCHEMA', @level0name = ${literalComment(schema, 'mssql')}, @level1type = N'TABLE', @level1name = ${literalComment(table.name, 'mssql')}${column ? `, @level2type = N'COLUMN', @level2name = ${literalComment(column, 'mssql')}` : ''}`
    if (tableComment) out.push(prop(tableComment))
    for (const c of columns) if (c.comment) out.push(prop(c.comment, c.name))
  } else if ((d.id === 'mysql' || d.id === 'mariadb') && tableComment !== undefined && (tableComment || allowNull)) {
    out.push(`ALTER TABLE ${t} COMMENT = ${literalComment(tableComment ?? '', d.id)}`)
  }
  return out
}

/**
 * SQLite can't alter most things in place. The documented recipe: create the new table, copy rows,
 * drop the old one, rename. Foreign key checks are deferred by the caller's transaction.
 */
function sqliteRebuild(
  ref: TableRef,
  tables: TableInfo[],
  mapColumns: (cols: DesignColumn[]) => DesignColumn[],
  d: Dialect,
  addFk?: DesignForeignKey,
  dropFkName?: string,
  newPk?: string[],
): string[] {
  const live = tables.find((t) => t.name === ref.name && (t.schema ?? 'main') === (ref.schema ?? 'main'))
  if (!live) return [`-- ${ref.name} not found in the schema snapshot; refresh and try again`]
  const design = toDesignTable(live)
  const columns = mapColumns(design.columns)
  const fks = design.foreignKeys.filter((f) => f.name !== dropFkName && f.originalName !== dropFkName)
  if (addFk) fks.push(addFk)
  const temp = `${ref.name}__new`
  const pk = newPk ?? design.primaryKey
  const lines = columns.map((c) => `  ${columnDefinition({ ...c, identity: false }, d)}`)
  if (pk.length) lines.push(`  PRIMARY KEY (${pk.map((c) => d.quoteIdent(c)).join(', ')})`)
  for (const fk of fks) lines.push(`  ${fkClause(fk, ref.name, d)}`)
  const names = columns.map((c) => d.quoteIdent(c.name)).join(', ')
  const sourceNames = columns.map((c) => d.quoteIdent(c.originalName ?? c.name)).join(', ')
  return [
    `CREATE TABLE ${qualify(d, { schema: ref.schema, name: temp })} (\n${lines.join(',\n')}\n)`,
    `INSERT INTO ${qualify(d, { schema: ref.schema, name: temp })} (${names}) SELECT ${sourceNames} FROM ${qualify(d, ref)}`,
    `DROP TABLE ${qualify(d, ref)}`,
    `ALTER TABLE ${qualify(d, { schema: ref.schema, name: temp })} RENAME TO ${d.quoteIdent(ref.name)}`,
    // Auto-indexes (sqlite_autoindex_*) come back with the constraints.
    ...design.indexes.filter((ix) => !ix.name?.startsWith('sqlite_autoindex')).map((ix) => createIndexSql(ix.name ?? '', ref, ix.columns, ix.unique, d)),
  ]
}

/** Full script including transaction wrapping, ready for the SQL editor. */
export function migrationScript(migration: Migration, dialect: Dialect): string {
  if (!migration.statements.length) return ''
  const separator = dialect.id === 'mssql' ? ';\n' : ';\n'
  const header = migration.warnings.map((w) => `-- ${w.level.toUpperCase()}: ${w.message}`)
  const body = migration.statements.join(separator) + ';'
  // Without XACT_ABORT, SQL Server continues after an error and would commit a half-applied migration.
  const prefix = dialect.id === 'mssql' ? 'SET XACT_ABORT ON;\n' : ''
  const wrapped = migration.transactional && dialect.begin
    ? `${prefix}${dialect.begin};\n${body}\n${dialect.commit};`
    : body
  return [...header, ...(header.length ? [''] : []), wrapped].join('\n')
}

/** Renders a draft like a live table (for diagrams and the editor). */
export function designToTableInfo(t: DesignTable): TableInfo {
  return {
    schema: t.schema,
    name: t.name,
    type: 'table',
    comment: t.comment ?? null,
    columns: t.columns.map((c, i) => ({
      name: c.name,
      ordinal: i + 1,
      dataType: c.dataType,
      nullable: c.nullable,
      defaultValue: c.defaultValue ?? null,
      isPrimaryKey: t.primaryKey.includes(c.name),
      isIdentity: !!c.identity,
      comment: c.comment ?? null,
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.collation ? { collation: c.collation } : {}),
      ...(c.remarks ? { remarks: c.remarks } : {}),
    })),
    primaryKey: [...t.primaryKey],
    // (A key or an index nobody named gets the name a model gives an unnamed one, not the editor's own id.)
    foreignKeys: t.foreignKeys.map((f) => ({
      name: f.name || `fk_${t.name}_${f.columns.join('_')}`,
      columns: f.columns,
      refSchema: f.refSchema,
      refTable: f.refTable,
      refColumns: f.refColumns,
      onDelete: f.onDelete,
      onUpdate: f.onUpdate,
      ...(f.cardinality ? { cardinality: f.cardinality } : {}),
    })),
    indexes: t.indexes.map((i) => ({ name: i.name || `${i.unique ? 'ux' : 'ix'}_${t.name}_${i.columns.join('_')}`, columns: i.columns, unique: i.unique, primary: false, ...(i.constraint ? { constraint: true } : {}) })),
    // A check written on a column follows the column through a rename.
    ...(t.checks?.some((c) => c.expression.trim()) ? { checks: t.checks.filter((c) => c.expression.trim()).map((c) => ({ ...c, ...(c.column ? { column: t.columns.find((x) => x.originalName === c.column)?.name ?? c.column } : {}) })) } : {}),
    ...(t.remarks ? { remarks: t.remarks } : {}),
  }
}

export interface ImpactCheck {
  label: string
  /** Returns a single number: rows that would make the change fail (0 = safe). */
  sql: string
}

/** Read-only queries that predict whether a migration will fail on the existing data. */
export function impactChecks(changes: SchemaChange[], dialect: Dialect): ImpactCheck[] {
  const d = dialect
  const out: ImpactCheck[] = []
  const id = (n: string) => d.quoteIdent(n)
  for (const c of changes) {
    if (c.kind === 'alter_column' && c.changes.nullable && !c.after.nullable) {
      out.push({ label: `${c.table.name}.${c.after.name}: rows with NULL`, sql: `SELECT COUNT(*) FROM ${qualify(d, c.table)} WHERE ${id(c.before.name)} IS NULL` })
    }
    if (c.kind === 'add_column' && !c.column.nullable && !c.column.defaultValue && !c.column.identity) {
      out.push({ label: `${c.table.name}: existing rows (new NOT NULL column without default)`, sql: `SELECT COUNT(*) FROM ${qualify(d, c.table)}` })
    }
    if (c.kind === 'add_index' && c.index.unique) {
      const cols = c.index.columns.map(id).join(', ')
      out.push({
        label: `${c.table.name}(${c.index.columns.join(', ')}): duplicate values`,
        sql: `SELECT COUNT(*) FROM (SELECT ${cols} FROM ${qualify(d, c.table)} GROUP BY ${cols} HAVING COUNT(*) > 1) dup`,
      })
    }
    if (c.kind === 'add_foreign_key') {
      const t = qualify(d, c.table)
      const r = qualify(d, { schema: c.fk.refSchema, name: c.fk.refTable })
      const join = c.fk.columns.map((col, i) => `r.${id(c.fk.refColumns[i] ?? '')} = t.${id(col)}`).join(' AND ')
      const notNull = c.fk.columns.map((col) => `t.${id(col)} IS NOT NULL`).join(' AND ')
      out.push({
        label: `${c.table.name}(${c.fk.columns.join(', ')}) → ${c.fk.refTable}: rows without a match`,
        sql: `SELECT COUNT(*) FROM ${t} t WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${r} r WHERE ${join})`,
      })
    }
    if (c.kind === 'drop_table') out.push({ label: `${c.table.name}: rows that will be deleted`, sql: `SELECT COUNT(*) FROM ${qualify(d, c.table)}` })
    if (c.kind === 'drop_column') {
      out.push({ label: `${c.table.name}.${c.column}: non-NULL values that will be lost`, sql: `SELECT COUNT(*) FROM ${qualify(d, c.table)} WHERE ${id(c.column)} IS NOT NULL` })
    }
  }
  return out
}

export const COMMON_TYPES: Record<DriverId, string[]> = {
  postgres: ['bigint', 'integer', 'smallint', 'numeric(12,2)', 'boolean', 'text', 'varchar(255)', 'uuid', 'date', 'timestamp', 'timestamptz', 'jsonb', 'bytea', 'double precision'],
  mssql: ['bigint', 'int', 'smallint', 'decimal(12,2)', 'bit', 'nvarchar(255)', 'nvarchar(max)', 'varchar(255)', 'uniqueidentifier', 'date', 'datetime2', 'datetimeoffset', 'varbinary(max)', 'float'],
  mysql: ['bigint', 'int', 'smallint', 'decimal(12,2)', 'tinyint(1)', 'varchar(255)', 'text', 'char(36)', 'date', 'datetime', 'timestamp', 'json', 'blob', 'double'],
  mariadb: ['bigint', 'int', 'smallint', 'decimal(12,2)', 'tinyint(1)', 'varchar(255)', 'text', 'uuid', 'date', 'datetime', 'timestamp', 'json', 'blob', 'double'],
  sqlite: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN', 'DATE', 'DATETIME'],
  oracle: ['NUMBER(19)', 'NUMBER(10)', 'NUMBER(12,2)', 'VARCHAR2(255)', 'NVARCHAR2(255)', 'CHAR(1)', 'CLOB', 'DATE', 'TIMESTAMP', 'BLOB', 'BOOLEAN'],
  duckdb: ['BIGINT', 'INTEGER', 'SMALLINT', 'DECIMAL(12,2)', 'BOOLEAN', 'VARCHAR', 'UUID', 'DATE', 'TIMESTAMP', 'TIMESTAMPTZ', 'JSON', 'BLOB', 'DOUBLE'],
  clickhouse: ['Int64', 'Int32', 'UInt32', 'Decimal(12,2)', 'Bool', 'String', 'LowCardinality(String)', 'UUID', 'Date', 'DateTime', 'DateTime64(3)', 'Float64', 'Nullable(String)', 'Array(String)'],
  trino: ['bigint', 'integer', 'smallint', 'decimal(12,2)', 'boolean', 'varchar', 'varchar(255)', 'uuid', 'date', 'timestamp(3)', 'timestamp(3) with time zone', 'json', 'varbinary', 'double'],
  bigquery: ['INT64', 'NUMERIC', 'BIGNUMERIC', 'FLOAT64', 'BOOL', 'STRING', 'BYTES', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'JSON', 'ARRAY<STRING>', 'GEOGRAPHY'],
}

/** A table or a column the source seems to have renamed: `from` is its name in the target, `to` in the source. */
export interface RenameGuess {
  kind: 'table' | 'column'
  /** For a column: its table, as the target names it. */
  table: string
  from: string
  to: string
}

/**
 * What a comparison by name would drop and add although it is probably one thing under a new name: a table most
 * of whose columns are in a table the source no longer has, a column of the same type where exactly one left and
 * one came (or which sits in the same place). Guesses for the user to confirm: `compareSchemas` takes the ones
 * that are right as `renames` and writes RENAME instead of DROP and ADD, which keeps the data.
 */
export function guessRenames(source: TableInfo[], target: TableInfo[]): RenameGuess[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const tables = (list: TableInfo[]) => list.filter((t) => t.type === 'table')
  const guesses: RenameGuess[] = []
  const pairs: [TableInfo, TableInfo][] = []
  const lonely = tables(target).filter((t) => !tables(source).some((s) => same(s.name, t.name)))
  for (const s of tables(source)) {
    const twin = tables(target).find((t) => same(t.name, s.name))
    if (twin) {
      pairs.push([s, twin])
      continue
    }
    const shared = (t: TableInfo) => t.columns.filter((c) => s.columns.some((x) => same(x.name, c.name))).length / Math.max(t.columns.length, s.columns.length, 1)
    const best = lonely.filter((t) => shared(t) >= 0.6).sort((a, b) => shared(b) - shared(a))
    // (Two tables it could equally be: nobody's guess.)
    if (!best[0] || (best[1] && shared(best[1]) === shared(best[0])) || guesses.some((g) => g.kind === 'table' && same(g.from, best[0]!.name))) continue
    guesses.push({ kind: 'table', table: best[0].name, from: best[0].name, to: s.name })
    pairs.push([s, best[0]])
  }
  for (const [s, t] of pairs) {
    const came = s.columns.filter((c) => !t.columns.some((x) => same(x.name, c.name)))
    const left = t.columns.filter((c) => !s.columns.some((x) => same(x.name, c.name)))
    const used = new Set<ColumnInfo>()
    for (const c of came) {
      const alike = left.filter((x) => !used.has(x) && sameType(x.dataType, c.dataType))
      const others = came.filter((x) => x !== c && sameType(x.dataType, c.dataType))
      // One of a kind on each side; or, where as many came as left, the column that stands where the other stood.
      const inPlace = alike.length === others.length + 1 ? alike.find((x) => t.columns.indexOf(x) === s.columns.indexOf(c)) : undefined
      const match = alike.length === 1 && !others.length ? alike[0] : inPlace
      if (!match) continue
      used.add(match)
      guesses.push({ kind: 'column', table: t.name, from: match.name, to: c.name })
    }
  }
  return guesses
}

/**
 * Changes that make `target` match `source` (schema compare, e.g. dev → prod). Tables and columns are matched by
 * name (case-insensitively); anything only in the target is dropped unless `keepExtra` is set. Schemas may be
 * named differently on the two sides (`shop` → `public`); where both sides have a schema of the same name, a
 * table is matched with the one in its own schema first, and a new table stays in its schema. With `model` (the
 * source is a model, which names things on purpose) a new table always goes to the schema it names and keeps
 * the names of its relationships and indexes.
 */
export function compareSchemas(source: TableInfo[], target: TableInfo[], options: { keepExtra?: boolean; model?: boolean; renames?: RenameGuess[] } & DiffOptions = {}): SchemaChange[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const tableRenames = (options.renames ?? []).filter((r) => r.kind === 'table')
  const columnRenames = (options.renames ?? []).filter((r) => r.kind === 'column')
  const drafts: DesignTable[] = []
  const targetSchema = target[0]?.schema
  const targetSchemas = new Set(target.map((t) => (t.schema ?? '').toLowerCase()))
  /** The target's table of that name: the one in the same schema when several schemas have one. */
  const inTarget = (name: string, schema: string | undefined) => {
    const named = target.filter((x) => x.type === 'table' && same(x.name, name))
    return named.find((x) => same(x.schema ?? '', schema ?? '')) ?? named[0]
  }
  const taken = new Set<TableInfo>()
  for (const s of source.filter((t) => t.type === 'table')) {
    // A table the source renamed is the target's table under its old name.
    const renamed = inTarget(s.name, s.schema) ? undefined : tableRenames.find((r) => same(r.to, s.name))
    const found = inTarget(renamed?.from ?? s.name, s.schema)
    // A table of another schema that already stands for a source table is not this one's match.
    const t = found && !taken.has(found) ? found : undefined
    if (t) taken.add(t)
    const draft = toDesignTable(s)
    if (!t) {
      // New table: created in the target's schema, referencing the target's tables, with its own identity.
      const stays = (schema: string | undefined) => !!schema && (options.model || targetSchemas.has(schema.toLowerCase()))
      draft.schema = stays(draft.schema) ? draft.schema : (targetSchema ?? draft.schema)
      draft.originalName = undefined
      for (const c of draft.columns) {
        c.originalName = undefined
        if (c.identity) c.defaultValue = null
      }
      for (const f of draft.foreignKeys) {
        f.originalName = undefined
        if (!options.model) f.name = undefined
        f.refSchema = inTarget(f.refTable, f.refSchema)?.schema ?? (stays(f.refSchema) ? f.refSchema : (targetSchema ?? f.refSchema))
      }
      for (const i of draft.indexes) {
        i.originalName = undefined
        if (!options.model) i.name = undefined
      }
      drafts.push(draft)
      continue
    }
    draft.schema = t.schema
    draft.originalName = t.name
    draft.name = renamed ? s.name : t.name
    // Renamed columns: the target's name → the source's.
    const newName = new Map<string, string>()
    for (const r of columnRenames) {
      if (same(r.table, t.name) && !t.columns.some((x) => same(x.name, r.to)) && t.columns.some((x) => same(x.name, r.from)) && s.columns.some((x) => same(x.name, r.to))) newName.set(r.from.toLowerCase(), r.to)
    }
    const oldName = new Map([...newName].map(([from, to]) => [to.toLowerCase(), from]))
    for (const c of draft.columns) {
      const was = oldName.get(c.name.toLowerCase())
      const match = t.columns.find((x) => same(x.name, was ?? c.name))
      c.originalName = match?.name
      if (match && !was) c.name = match.name
      // Identity defaults name the database's own sequence (nextval('shop.x_seq')): keep the target's.
      if (match && match.isIdentity && (c.identity || isSerialType(c.dataType))) c.defaultValue = match.defaultValue ?? null
    }
    // Keys, indexes and references name columns and tables as the target spells them, like the columns themselves
    // (`ID` in a script is `id` in PostgreSQL): a difference in letter case alone is no change.
    const spelled = (columns: { name: string }[], list: string[]) => list.map((x) => columns.find((c) => same(c.name, x))?.name ?? x)
    draft.primaryKey = spelled(draft.columns, draft.primaryKey)
    for (const i of draft.indexes) i.columns = spelled(draft.columns, i.columns)
    for (const f of draft.foreignKeys) {
      f.columns = spelled(draft.columns, f.columns)
      const referenced = inTarget(f.refTable, f.refSchema)
      if (referenced) {
        f.refTable = referenced.name
        f.refColumns = spelled(referenced.columns, f.refColumns)
      }
    }
    // Constraint names differ between databases (fk_orders_customer vs orders_customer_id_fkey): match by structure.
    // (A key or an index on a renamed column is the same key: the database renames the column under it.)
    const cols = (list: string[]) => list.map((c) => (newName.get(c.toLowerCase()) ?? c).toLowerCase()).join(',')
    // Two of the same in the source (a unique constraint written twice) are two in the target as well; the same
    // relationship drawn twice is one foreign key.
    const matched = new Set<unknown>()
    const fkKey = (f: DesignForeignKey) => `${cols(f.columns)}>${f.refTable.toLowerCase()}(${cols(f.refColumns)})`
    draft.foreignKeys = draft.foreignKeys.filter((f, i, all) => all.findIndex((x) => fkKey(x) === fkKey(f)) === i)
    for (const f of draft.foreignKeys) {
      const match = t.foreignKeys.find((x) => !matched.has(x) && !x.virtual && cols(x.columns) === cols(f.columns) && same(x.refTable, f.refTable) && cols(x.refColumns) === cols(f.refColumns))
      matched.add(match)
      if (match) Object.assign(f, { name: match.name, originalName: match.name, columns: newName.size ? f.columns : match.columns, refColumns: match.refColumns, onDelete: match.onDelete })
      // References point into the target's schema, not the source's.
      f.refSchema = inTarget(f.refTable, f.refSchema)?.schema ?? t.schema
    }
    for (const i of draft.indexes) {
      const match = t.indexes.find((x) => !matched.has(x) && !x.primary && cols(x.columns) === cols(i.columns) && x.unique === i.unique)
      matched.add(match)
      if (match) Object.assign(i, { name: match.name, originalName: match.name, columns: newName.size ? i.columns : match.columns })
    }
    // Keep target indexes that support a foreign key that stays (MySQL creates them and refuses to drop them).
    for (const ix of t.indexes.filter((x) => !x.primary)) {
      const supportsFk = draft.foreignKeys.some((f) => cols(f.columns) === cols(ix.columns.slice(0, f.columns.length)))
      if (supportsFk && !draft.indexes.some((i) => i.originalName === ix.name)) {
        draft.indexes.push({ id: designId('i'), name: ix.name, originalName: ix.name, columns: ix.columns, unique: ix.unique })
      }
    }
    drafts.push(draft)
  }
  if (!options.keepExtra) {
    for (const t of target.filter((x) => x.type === 'table' && !taken.has(x))) {
      drafts.push({ ...toDesignTable(t), dropped: true })
    }
  }
  return diffTables(target, drafts, options)
}

/**
 * The migration as a Liquibase changelog in formatted SQL (one changeset with its rollback), for teams that
 * deploy with Liquibase. Liquibase opens and commits the transaction itself, so the statements go in bare.
 */
export function liquibaseChangelog(migration: Migration, options: { id: string; author?: string; comment?: string }): string {
  const author = (options.author || 'dbmastermind').replace(/[\s:]+/g, '_')
  const id = options.id.replace(/[\s:]+/g, '_')
  const lines = ['--liquibase formatted sql', '', `--changeset ${author}:${id}${migration.transactional ? '' : ' runInTransaction:false'}`]
  if (options.comment) lines.push(`--comment: ${options.comment.replace(/\s+/g, ' ')}`)
  for (const statement of migration.statements) lines.push(`${statement.replace(/;\s*$/, '')};`)
  // Every line of the rollback carries the marker: a statement may span several.
  for (const statement of migration.rollback) lines.push(...`${statement.replace(/;\s*$/, '')};`.split('\n').map((l) => `--rollback ${l}`))
  return `${lines.join('\n')}\n`
}

/**
 * A model's names as a script without quotes creates them. DeZign writes its PostgreSQL and Oracle scripts with
 * bare names, so the column a model calls `isAdmin` is `isadmin` in the database DeZign made (and in every
 * query written against it); quoted, it would be a different column. Names that can't be written bare
 * (`unit price`) stay as they are. Other databases keep the case of a name anyway.
 */
export function unquotedNames(tables: TableInfo[], driver: DriverId): TableInfo[] {
  if (driver !== 'postgres' && driver !== 'oracle') return tables
  const name = <T extends string | undefined>(n: T): T => unquotedName(n, driver)
  return tables.map((t) => ({
    ...t,
    schema: name(t.schema),
    name: name(t.name),
    columns: t.columns.map((c) => ({ ...c, name: name(c.name) })),
    primaryKey: t.primaryKey.map(name),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, name: name(f.name), columns: f.columns.map(name), refSchema: name(f.refSchema), refTable: name(f.refTable), refColumns: f.refColumns.map(name) })),
    indexes: t.indexes.map((i) => ({ ...i, name: name(i.name), columns: i.columns.map(name) })),
    ...(t.checks ? { checks: t.checks.map((c) => ({ ...c, ...(c.name ? { name: name(c.name) } : {}), ...(c.column ? { column: name(c.column) } : {}) })) } : {}),
  }))
}

/** One name as a script without quotes creates it (see `unquotedNames`). */
export function unquotedName<T extends string | undefined>(name: T, driver: DriverId): T {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return name
  return (driver === 'postgres' ? name.toLowerCase() : driver === 'oracle' ? name.toUpperCase() : name) as T
}

/**
 * DROP script for a whole model, as DeZign generates one next to the CREATE script: the tables in an order their
 * foreign keys allow (children first), and the domains the model made in PostgreSQL after them.
 */
export function dropScript(tables: TableInfo[], dialect: Dialect, options: Pick<MigrationOptions, 'domains'> = {}): string {
  const real = tables.filter((t) => t.type === 'table')
  const migration = generateMigration(compareSchemas([], real), dialect, real)
  const used = new Set(real.flatMap((t) => t.columns.map((c) => c.domain?.toLowerCase()).filter(Boolean)))
  const domains = dialect.id === 'postgres' ? (options.domains ?? []).filter((d) => used.has(d.name.toLowerCase())) : []
  const tail = domains.map((d) => `DROP DOMAIN ${/^[A-Za-z_][A-Za-z0-9_$]*$/.test(d.name) ? d.name.toLowerCase() : dialect.quoteIdent(d.name)};`)
  return migrationScript({ ...migration, statements: [...migration.statements, ...tail] }, dialect)
}

/** CREATE script for a whole model (forward engineering), in any dialect. */
export function createScript(tables: TableInfo[], dialect: Dialect, options: { translateTypes?: boolean; /** The database the model's types were written for: for that one they are left as written. */ from?: DriverId } & MigrationOptions = {}): string {
  const source = options.translateTypes ? translateTables(tables, dialect.id, options.from) : tables
  const changes = compareSchemas(
    source.filter((t) => t.type === 'table'),
    [],
    { keepExtra: true, model: true },
  )
  return migrationScript(generateMigration(changes, dialect, [], options), dialect)
}
