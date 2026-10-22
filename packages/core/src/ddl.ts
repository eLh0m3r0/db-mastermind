import { qualify, type Dialect } from './dialect.js'
import { translateTables } from './type-map.js'
import type { ColumnInfo, DriverId, ForeignKeyInfo, IndexInfo, TableInfo, TableRef } from './types.js'

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
}

export interface DesignIndex {
  id: string
  name?: string
  originalName?: string
  columns: string[]
  unique: boolean
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
    })),
    primaryKey: [...t.primaryKey],
    foreignKeys: t.foreignKeys
      .filter((f) => !f.virtual)
      .map((f) => ({ id: designId('f'), name: f.name, originalName: f.name, columns: [...f.columns], refSchema: f.refSchema, refTable: f.refTable, refColumns: [...f.refColumns], onDelete: f.onDelete, onUpdate: f.onUpdate })),
    indexes: t.indexes
      .filter((i) => !i.primary)
      .map((i) => ({ id: designId('i'), name: i.name, originalName: i.name, columns: [...i.columns], unique: i.unique })),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const normType = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim()

/** Changes needed to turn `original` (live table, or undefined for a new one) into `draft`. */
export function diffTable(original: TableInfo | undefined, draftIn: DesignTable): SchemaChange[] {
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
    const diff = {
      type: normType(col.dataType) !== normType(before.dataType),
      nullable: col.nullable !== before.nullable,
      default: (col.defaultValue ?? null) !== (before.defaultValue ?? null),
      comment: (col.comment ?? null) !== (before.comment ?? null),
    }
    if (diff.type || diff.nullable || diff.default || diff.comment) {
      alters.push({ kind: 'alter_column', table: current, column: col.name, before, after: col, changes: diff })
    }
  }
  changes.push(...renames, ...drops, ...adds, ...alters)

  if (!same(draftPk, original.primaryKey)) changes.push({ kind: 'set_primary_key', table: current, columns: draftIn.primaryKey, before: original.primaryKey })
  if ((draft.comment ?? null) !== (original.comment ?? null)) changes.push({ kind: 'set_table_comment', table: current, comment: draft.comment ?? null })

  draft.foreignKeys.forEach((fk, i) => {
    const before = fk.originalName ? original.foreignKeys.find((f) => f.name === fk.originalName) : undefined
    const unchanged = before && same(fk.columns, before.columns) && fk.refTable === before.refTable && same(fk.refColumns, before.refColumns) && (fk.onDelete ?? '') === (before.onDelete ?? '')
    if (!unchanged) changes.push({ kind: 'add_foreign_key', table: current, fk: draftIn.foreignKeys[i]! })
  })
  draft.indexes.forEach((ix, i) => {
    const before = ix.originalName ? original.indexes.find((x) => x.name === ix.originalName) : undefined
    if (!before || !same(ix.columns, before.columns) || ix.unique !== before.unique) changes.push({ kind: 'add_index', table: current, index: draftIn.indexes[i]! })
  })
  return changes
}

export function diffTables(originals: TableInfo[], drafts: DesignTable[]): SchemaChange[] {
  const byName = (d: DesignTable) =>
    d.originalName ? originals.find((t) => t.name === d.originalName && (t.schema ?? '') === (d.schema ?? '')) : undefined
  const drops: SchemaChange[] = []
  const creates: SchemaChange[] = []
  const alters: SchemaChange[] = []
  for (const d of drafts) {
    for (const change of diffTable(byName(d), d)) {
      if (change.kind === 'create_table') creates.push(change)
      else if (change.kind === 'drop_table') drops.push(change)
      else alters.push(change)
    }
  }
  // FK additions run last so referenced tables/columns exist; drops of FKs first.
  const fkDrops = alters.filter((c) => c.kind === 'drop_foreign_key' || c.kind === 'drop_index')
  const fkAdds = alters.filter((c) => c.kind === 'add_foreign_key')
  const rest = alters.filter((c) => c.kind !== 'drop_foreign_key' && c.kind !== 'drop_index' && c.kind !== 'add_foreign_key')
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

function columnDefinition(c: DesignColumn, d: Dialect, opts: { inlinePk?: boolean; sequence?: string } = {}): string {
  const parts = [d.quoteIdent(c.name), c.dataType]
  if (c.identity) {
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

/** Renders a change set as SQL. `tables` is the live schema (needed by MySQL MODIFY and SQLite rebuilds). */
export function generateMigration(changes: SchemaChange[], dialect: Dialect, tables: TableInfo[] = []): Migration {
  // DuckDB can't alter a table once a new table references it: create new tables after the alters.
  if (dialect.id === 'duckdb') changes = [...changes.filter((c) => c.kind !== 'create_table'), ...changes.filter((c) => c.kind === 'create_table')]
  const d = dialect
  const statements: string[] = []
  const rollback: string[] = []
  const warnings: MigrationWarning[] = []
  const q = (ref: TableRef) => qualify(d, ref)
  const id = (n: string) => d.quoteIdent(n)
  const isMy = d.id === 'mysql' || d.id === 'mariadb'
  let mssqlVar = 0
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
        if (t.primaryKey.length && !inlinePk) lines.push(`  CONSTRAINT ${id(constraintName('pk', t.name, t.primaryKey))} PRIMARY KEY (${t.primaryKey.map(id).join(', ')})`)
        // SQLite and DuckDB can't add foreign keys later: declare them in the table.
        const inlineFks = d.id === 'sqlite' || d.id === 'duckdb'
        if (inlineFks) for (const fk of t.foreignKeys) lines.push(`  ${fkClause(fk, t.name, d)}`)
        let sql = `CREATE TABLE ${q(ref)} (\n${lines.join(',\n')}\n)`
        if (isMy && t.comment) sql += ` COMMENT=${literalComment(t.comment, d.id)}`
        statements.push(sql)
        if (!inlineFks) {
          for (const fk of t.foreignKeys) statements.push(`ALTER TABLE ${q(ref)} ADD ${fkClause(fk, t.name, d)}`)
        }
        for (const ix of t.indexes) {
          statements.push(createIndexSql(ix.name || constraintName(ix.unique ? 'ux' : 'ix', t.name, ix.columns), ref, ix.columns, ix.unique, d))
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
          if (c.type) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${after.dataType} USING ${col}::${after.dataType}`)
          if (c.nullable) statements.push(`ALTER TABLE ${t} ALTER COLUMN ${col} ${after.nullable ? 'DROP' : 'SET'} NOT NULL`)
          if (c.default) statements.push(after.defaultValue ? `ALTER TABLE ${t} ALTER COLUMN ${col} SET DEFAULT ${after.defaultValue}` : `ALTER TABLE ${t} ALTER COLUMN ${col} DROP DEFAULT`)
          if (c.type) rollback.unshift(`ALTER TABLE ${t} ALTER COLUMN ${col} TYPE ${before.dataType} USING ${col}::${before.dataType}`)
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
        const name = change.fk.name || constraintName('fk', change.table.name, change.fk.columns)
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
        const name = ix.name || constraintName(ix.unique ? 'ux' : 'ix', change.table.name, ix.columns)
        statements.push(createIndexSql(name, change.table, ix.columns, ix.unique, d))
        rollback.unshift(dropIndexSql(name, change.table, d))
        if (ix.unique) warnings.push({ level: 'info', message: `Unique index ${name} fails if duplicates already exist.` })
        break
      }
      case 'drop_index': {
        if (change.before.constraint && (d.id === 'postgres' || d.id === 'mssql' || d.id === 'oracle')) statements.push(`ALTER TABLE ${q(change.table)} DROP CONSTRAINT ${id(change.name)}`)
        else statements.push(dropIndexSql(change.name, change.table, d))
        rollback.unshift(createIndexSql(change.name, change.table, change.before.columns, change.before.unique, d))
        break
      }
      case 'set_primary_key': {
        const t = q(change.table)
        const name = constraintName('pk', change.table.name, change.columns)
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
              `DO $dbm$ DECLARE n text; BEGIN SELECT conname INTO n FROM pg_constraint WHERE conrelid = ${literalComment(t, 'postgres')}::regclass AND contype = 'p'; EXECUTE format('ALTER TABLE ${t.replaceAll("'", "''")} DROP CONSTRAINT %I', n); END $dbm$`,
            )
          else {
            const n = ++mssqlVar
            statements.push(
              `DECLARE @pk${n} NVARCHAR(256) = (SELECT name FROM sys.key_constraints WHERE type = 'PK' AND parent_object_id = OBJECT_ID(${literalComment(`${change.table.schema ? `${change.table.schema}.` : ''}${change.table.name}`, 'mssql')}));\nEXEC('ALTER TABLE ${t.replaceAll("'", "''")} DROP CONSTRAINT [' + @pk${n} + ']')`,
            )
          }
        }
        if (change.columns.length) statements.push(`ALTER TABLE ${t} ADD CONSTRAINT ${id(name)} PRIMARY KEY (${change.columns.map(id).join(', ')})`)
        warnings.push({ level: 'warning', message: `Changing the primary key of ${change.table.name} rebuilds its index and may break foreign keys that reference it.` })
        break
      }
      case 'set_table_comment':
        statements.push(...commentStatements(change.table, change.comment, [], d, true))
        break
    }
  }

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
  const wrapped = migration.transactional
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
    })),
    primaryKey: [...t.primaryKey],
    foreignKeys: t.foreignKeys.map((f) => ({
      name: f.name ?? f.id,
      columns: f.columns,
      refSchema: f.refSchema,
      refTable: f.refTable,
      refColumns: f.refColumns,
      onDelete: f.onDelete,
      onUpdate: f.onUpdate,
    })),
    indexes: t.indexes.map((i) => ({ name: i.name ?? i.id, columns: i.columns, unique: i.unique, primary: false })),
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
}

/**
 * Changes that make `target` match `source` (schema compare, e.g. dev → prod). Tables and columns are matched by
 * name (case-insensitively); anything only in the target is dropped unless `keepExtra` is set.
 */
export function compareSchemas(source: TableInfo[], target: TableInfo[], options: { keepExtra?: boolean } = {}): SchemaChange[] {
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  const drafts: DesignTable[] = []
  const targetSchema = target[0]?.schema
  for (const s of source.filter((t) => t.type === 'table')) {
    const t = target.find((x) => x.type === 'table' && same(x.name, s.name))
    const draft = toDesignTable(s)
    if (!t) {
      // New table: created in the target's schema, referencing the target's tables, with its own identity.
      draft.schema = targetSchema ?? draft.schema
      draft.originalName = undefined
      for (const c of draft.columns) {
        c.originalName = undefined
        if (c.identity) c.defaultValue = null
      }
      for (const f of draft.foreignKeys) {
        f.originalName = undefined
        f.name = undefined
        f.refSchema = target.find((x) => same(x.name, f.refTable))?.schema ?? targetSchema ?? f.refSchema
      }
      for (const i of draft.indexes) {
        i.originalName = undefined
        i.name = undefined
      }
      drafts.push(draft)
      continue
    }
    draft.schema = t.schema
    draft.originalName = t.name
    draft.name = t.name
    for (const c of draft.columns) {
      const match = t.columns.find((x) => same(x.name, c.name))
      c.originalName = match?.name
      if (match) c.name = match.name
      // Identity defaults name the database's own sequence (nextval('shop.x_seq')): keep the target's.
      if (match && match.isIdentity && c.identity) c.defaultValue = match.defaultValue ?? null
    }
    // Constraint names differ between databases (fk_orders_customer vs orders_customer_id_fkey): match by structure.
    const cols = (list: string[]) => list.map((c) => c.toLowerCase()).join(',')
    for (const f of draft.foreignKeys) {
      const match = t.foreignKeys.find((x) => !x.virtual && cols(x.columns) === cols(f.columns) && same(x.refTable, f.refTable) && cols(x.refColumns) === cols(f.refColumns))
      if (match) Object.assign(f, { name: match.name, originalName: match.name, columns: match.columns, refColumns: match.refColumns, onDelete: match.onDelete })
      // References point into the target's schema, not the source's.
      f.refSchema = target.find((x) => same(x.name, f.refTable))?.schema ?? t.schema
    }
    for (const i of draft.indexes) {
      const match = t.indexes.find((x) => !x.primary && cols(x.columns) === cols(i.columns) && x.unique === i.unique)
      if (match) Object.assign(i, { name: match.name, originalName: match.name, columns: match.columns })
    }
    // Keep target indexes that support its foreign keys (MySQL creates them and refuses to drop them).
    for (const ix of t.indexes.filter((x) => !x.primary)) {
      const supportsFk = t.foreignKeys.some((f) => cols(f.columns) === cols(ix.columns.slice(0, f.columns.length)))
      if (supportsFk && !draft.indexes.some((i) => i.originalName === ix.name)) {
        draft.indexes.push({ id: designId('i'), name: ix.name, originalName: ix.name, columns: ix.columns, unique: ix.unique })
      }
    }
    drafts.push(draft)
  }
  if (!options.keepExtra) {
    for (const t of target.filter((x) => x.type === 'table' && !source.some((s) => s.type === 'table' && same(s.name, x.name)))) {
      drafts.push({ ...toDesignTable(t), dropped: true })
    }
  }
  return diffTables(target, drafts)
}

/** CREATE script for a whole model (forward engineering), in any dialect. */
export function createScript(tables: TableInfo[], dialect: Dialect, options: { translateTypes?: boolean } = {}): string {
  const source = options.translateTypes ? translateTables(tables, dialect.id) : tables
  const changes = compareSchemas(
    source.filter((t) => t.type === 'table'),
    [],
    { keepExtra: true },
  )
  return migrationScript(generateMigration(changes, dialect, []), dialect)
}
