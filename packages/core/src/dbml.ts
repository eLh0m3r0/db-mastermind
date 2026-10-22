import type { ColumnInfo, ForeignKeyInfo, TableInfo } from './types.js'
import { designId, toDesignTable, type DesignTable } from './ddl.js'

/**
 * DBML (dbdiagram.io's schema language) to and from the table model, so a model can live as a text file
 * in the knowledge base, be diffed against a live database and turned into a migration.
 * Supported: Table (schema-qualified, aliases, Note), columns with [pk, increment, not null, null, unique,
 * default, note, ref], indexes blocks, Ref lines (>, <, -) with delete/update actions, Enum (as types).
 * Project, TableGroup and Note blocks are accepted and ignored.
 */

export interface DbmlError {
  line: number
  message: string
}

export interface DbmlModel {
  tables: TableInfo[]
  enums: Record<string, string[]>
  /** TableGroup name → table names, in file order. */
  groups: Record<string, string[]>
  errors: DbmlError[]
}

const ident = (s: string) => s.replace(/^"(.*)"$/, '$1').replace(/^`(.*)`$/, '$1')
const quoteName = (s: string) => (/^[A-Za-z_][\w]*$/.test(s) ? s : `"${s.replaceAll('"', '\\"')}"`)
const noteText = (s: string) => `'${s.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

/** Splits `a, b, 'c, d', e` at top-level commas. */
function splitTop(s: string, sep = ','): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (quote) {
      if (ch === '\\') {
        cur += ch + (s[i + 1] ?? '')
        i++
        continue
      }
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === sep && depth === 0) {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function unquoteString(v: string): string {
  const m = /^'''([\s\S]*)'''$/.exec(v) ?? /^'([\s\S]*)'$/.exec(v) ?? /^"([\s\S]*)"$/.exec(v)
  return m ? m[1]!.replace(/\\(['"\\])/g, '$1') : v
}

/** Removes // and /* *\/ comments outside of strings. */
function stripComments(text: string): string {
  let out = ''
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      out += ch
      if (ch === '\\') {
        out += text[++i] ?? ''
      } else if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const skipped = text.slice(i, end === -1 ? text.length : end + 2)
      out += skipped.replace(/[^\n]/g, '')
      i = end === -1 ? text.length : end + 1
    } else out += ch
  }
  return out
}

function parseRefTarget(s: string, defaultSchema?: string): { schema?: string; table: string; columns: string[] } | null {
  // schema.table.col | table.col | table.(a, b)
  const m = /^(.+)\.(\(([^)]*)\)|"[^"]+"|[\w$]+)$/.exec(s.trim())
  if (!m) return null
  const columns = m[3] !== undefined ? m[3].split(',').map((c) => ident(c.trim())) : [ident(m[2]!)]
  const parts = m[1]!.split('.').map(ident)
  return parts.length > 1 ? { schema: parts[0], table: parts[1]!, columns } : { schema: defaultSchema, table: parts[0]!, columns }
}

const ACTION = /(delete|update)\s*:\s*(cascade|restrict|set null|set default|no action)/gi

export function parseDbml(text: string, options: { defaultSchema?: string; /** Database type for columns typed with a DBML Enum. */ enumType?: string } = {}): DbmlModel {
  const lines = stripComments(text).split('\n')
  const tables: TableInfo[] = []
  const enums: Record<string, string[]> = {}
  const groups: Record<string, string[]> = {}
  const errors: DbmlError[] = []
  const aliases = new Map<string, TableInfo>()
  const refs: { line: number; from: string; op: string; to: string; settings: string }[] = []
  let i = 0
  const blockEnd = (start: number) => {
    // Index of the line closing a block that opened on `start` (brace counting across lines).
    let depth = 0
    for (let j = start; j < lines.length; j++) {
      for (const ch of lines[j]!) {
        if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) return j
        }
      }
    }
    return lines.length - 1
  }

  while (i < lines.length) {
    const line = lines[i]!.trim()
    const lineNo = i + 1
    if (!line) {
      i++
      continue
    }
    const table = /^Table\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)(?:\s+as\s+([\w$]+))?\s*(\[[^\]]*\])?\s*\{\s*$/i.exec(line)
    if (table) {
      const end = blockEnd(i)
      const nameParts = table[1]!.split('.').map(ident)
      const t: TableInfo = {
        schema: nameParts.length > 1 ? nameParts[0] : options.defaultSchema,
        name: nameParts.at(-1)!,
        type: 'table',
        comment: null,
        columns: [],
        primaryKey: [],
        foreignKeys: [],
        indexes: [],
      }
      if (table[2]) aliases.set(table[2], t)
      for (let j = i + 1; j < end; j++) {
        const row = lines[j]!.trim()
        if (!row) continue
        const note = /^Note\s*:\s*(.+)$/i.exec(row)
        if (note) {
          t.comment = unquoteString(note[1]!.trim())
          continue
        }
        if (/^Note\s*\{/i.test(row)) {
          const close = blockEnd(j)
          t.comment = unquoteString(lines.slice(j + 1, close).join('\n').trim())
          j = close
          continue
        }
        if (/^indexes\s*\{/i.test(row)) {
          const close = blockEnd(j)
          for (let k = j + 1; k < close; k++) {
            const ix = lines[k]!.trim()
            if (!ix) continue
            const m = /^(\([^)]*\)|"[^"]+"|`[^`]+`|[\w$]+)\s*(\[(.*)\])?$/.exec(ix)
            if (!m) {
              errors.push({ line: k + 1, message: `Can't read index: ${ix}` })
              continue
            }
            const columns = m[1]!.startsWith('(') ? m[1]!.slice(1, -1).split(',').map((c) => ident(c.trim())) : [ident(m[1]!)]
            const settings = (m[3] ?? '').toLowerCase()
            const name = /name\s*:\s*('[^']*'|"[^"]*")/i.exec(m[3] ?? '')?.[1]
            if (/\bpk\b/.test(settings)) {
              t.primaryKey = columns
              continue
            }
            t.indexes.push({ name: name ? unquoteString(name) : `ix_${t.name}_${columns.join('_')}`, columns, unique: /\bunique\b/.test(settings), primary: false })
          }
          j = close
          continue
        }
        const col = /^("[^"]+"|`[^`]+`|[\w$]+)\s+("[^"]+"|[\w$.]+(?:\([^)]*\))?(?:\[\])?)\s*(\[(.*)\])?\s*$/.exec(row)
        if (!col) {
          errors.push({ line: j + 1, message: `Can't read column: ${row}` })
          continue
        }
        const name = ident(col[1]!)
        const settings = splitTop(col[4] ?? '')
        const has = (s: string) => settings.some((x) => x.toLowerCase() === s)
        const value = (key: string) => {
          const s = settings.find((x) => new RegExp(`^${key}\\s*:`, 'i').test(x))
          return s ? s.slice(s.indexOf(':') + 1).trim() : undefined
        }
        const def = value('default')
        const column: ColumnInfo = {
          name,
          ordinal: t.columns.length + 1,
          dataType: ident(col[2]!),
          nullable: !(has('not null') || has('pk') || has('primary key')),
          defaultValue: def === undefined ? null : def.startsWith('`') ? def.slice(1, -1) : def,
          isPrimaryKey: has('pk') || has('primary key'),
          isIdentity: has('increment'),
          comment: value('note') !== undefined ? unquoteString(value('note')!) : null,
        }
        t.columns.push(column)
        if (column.isPrimaryKey) t.primaryKey.push(name)
        if (has('unique')) t.indexes.push({ name: `ux_${t.name}_${name}`, columns: [name], unique: true, primary: false, constraint: true })
        const ref = value('ref')
        if (ref) {
          const m = /^([<>-])\s*(.+)$/.exec(ref)
          if (m) refs.push({ line: j + 1, from: `${t.schema ? `${t.schema}.` : ''}${t.name}.${name}`, op: m[1]!, to: m[2]!, settings: '' })
        }
      }
      for (const c of t.columns) c.isPrimaryKey = t.primaryKey.includes(c.name)
      if (t.primaryKey.length) t.indexes.unshift({ name: `pk_${t.name}`, columns: t.primaryKey, unique: true, primary: true })
      tables.push(t)
      i = end + 1
      continue
    }
    const en = /^Enum\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)\s*\{/i.exec(line)
    if (en) {
      const end = blockEnd(i)
      const body = lines.slice(i, end + 1).join('\n')
      const content = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')).replace(/\[[^\]]*\]/g, ' ')
      enums[en[1]!.split('.').map(ident).at(-1)!] = (content.match(/"[^"]*"|[^\s]+/g) ?? []).map(ident)
      i = end + 1
      continue
    }
    const ref = /^Ref(?:\s+[\w$"]+)?\s*:\s*(.+?)\s*([<>-])\s*(.+?)\s*(\[(.*)\])?\s*$/i.exec(line)
    if (ref) {
      refs.push({ line: lineNo, from: ref[1]!, op: ref[2]!, to: ref[3]!, settings: ref[5] ?? '' })
      i++
      continue
    }
    const group = /^TableGroup\s+("[^"]+"|[\w$]+)[^{]*\{/i.exec(line)
    if (group) {
      const end = blockEnd(i)
      const body = lines.slice(i, end + 1).join('\n')
      const content = body.slice(body.indexOf('{') + 1, body.lastIndexOf('}')).replace(/\[[^\]]*\]/g, ' ').replace(/Note\s*:\s*'[^']*'/gi, ' ')
      groups[ident(group[1]!)] = (content.match(/"[^"]+"|[\w$.]+/g) ?? []).map((n) => ident(n.split('.').pop()!))
      i = end + 1
      continue
    }
    if (/^(Project|TableGroup|Note|Records)\b[^{]*\{/i.test(line)) {
      i = blockEnd(i) + 1
      continue
    }
    errors.push({ line: lineNo, message: `Unexpected: ${line}` })
    i++
  }

  if (options.enumType) {
    // Enums become plain columns; the allowed values go to the comment so they aren't lost.
    for (const t of tables) {
      for (const c of t.columns) {
        const values = enums[c.dataType]
        if (!values) continue
        c.dataType = options.enumType
        c.comment = [c.comment, `One of: ${values.join(', ')}`].filter(Boolean).join('. ')
      }
    }
  }

  const resolve = (ref: { schema?: string; table: string }) =>
    aliases.get(ref.table) ?? tables.find((t) => t.name === ref.table && (ref.schema === undefined || t.schema === ref.schema)) ?? tables.find((t) => t.name === ref.table)
  for (const r of refs) {
    let from = parseRefTarget(r.from, options.defaultSchema)
    let to = parseRefTarget(r.to, options.defaultSchema)
    if (!from || !to) {
      errors.push({ line: r.line, message: `Can't read reference: ${r.from} ${r.op} ${r.to}` })
      continue
    }
    // In DBML `a > b` means many a → one b; `a < b` is the reverse. The foreign key lives on the "many" side.
    if (r.op === '<') [from, to] = [to, from]
    const owner = resolve(from)
    const target = resolve(to)
    if (!owner || !target) {
      errors.push({ line: r.line, message: `Unknown table in reference: ${!owner ? from.table : to.table}` })
      continue
    }
    const fk: ForeignKeyInfo = {
      name: `fk_${owner.name}_${from.columns.join('_')}`,
      columns: from.columns,
      refSchema: target.schema,
      refTable: target.name,
      refColumns: to.columns,
    }
    for (const m of r.settings.matchAll(ACTION)) {
      if (m[1]!.toLowerCase() === 'delete') fk.onDelete = m[2]!.toUpperCase()
      else fk.onUpdate = m[2]!.toUpperCase()
    }
    owner.foreignKeys.push(fk)
  }
  // Aliases in groups mean their tables.
  for (const [g, names] of Object.entries(groups)) groups[g] = names.map((n) => aliases.get(n)?.name ?? n)
  return { tables, enums, groups, errors }
}

/** DBML for tables (round-trips through `parseDbml`), with the model's enums and table groups when given. */
export function toDbml(tables: TableInfo[], options: { defaultSchema?: string; enums?: Record<string, string[]>; groups?: Record<string, string[]> } = {}): string {
  const out: string[] = []
  for (const [name, values] of Object.entries(options.enums ?? {})) {
    out.push(`Enum ${quoteName(name)} {`, ...values.map((v) => `  ${quoteName(v)}`), '}', '')
  }
  const tableName = (t: { schema?: string; name: string }) => (t.schema && t.schema !== options.defaultSchema ? `${quoteName(t.schema)}.` : '') + quoteName(t.name)
  for (const t of tables.filter((x) => x.type === 'table')) {
    out.push(`Table ${tableName(t)} {`)
    const singlePk = t.primaryKey.length === 1
    // Single-column UNIQUE constraints read best on the column; named and multi-column indexes stay in `indexes`.
    const uniqueColumns = new Set(t.indexes.filter((ix) => ix.unique && ix.constraint && !ix.primary && ix.columns.length === 1).map((ix) => ix.columns[0]!))
    for (const c of t.columns) {
      const attrs: string[] = []
      if (singlePk && c.isPrimaryKey) attrs.push('pk')
      if (c.isIdentity) attrs.push('increment')
      if (!c.nullable && !(singlePk && c.isPrimaryKey)) attrs.push('not null')
      if (c.defaultValue !== null && c.defaultValue !== undefined && c.defaultValue !== '' && !c.isIdentity) {
        const d = c.defaultValue
        attrs.push(`default: ${/^-?\d+(\.\d+)?$/.test(d) || /^'.*'$/.test(d) || /^(true|false|null)$/i.test(d) ? d : `\`${d}\``}`)
      }
      if (uniqueColumns.has(c.name)) attrs.push('unique')
      if (c.comment) attrs.push(`note: ${noteText(c.comment)}`)
      const type = /^[\w$.]+(\(.*\))?(\[\])?$/.test(c.dataType) ? c.dataType : `"${c.dataType}"`
      out.push(`  ${quoteName(c.name)} ${type}${attrs.length ? ` [${attrs.join(', ')}]` : ''}`)
    }
    const indexes = t.indexes.filter((ix) => !ix.primary && !(ix.unique && ix.constraint && ix.columns.length === 1 && uniqueColumns.has(ix.columns[0]!)))
    if (t.primaryKey.length > 1 || indexes.length) {
      out.push('', '  indexes {')
      if (t.primaryKey.length > 1) out.push(`    (${t.primaryKey.map(quoteName).join(', ')}) [pk]`)
      for (const ix of indexes) {
        const cols = ix.columns.length === 1 ? quoteName(ix.columns[0]!) : `(${ix.columns.map(quoteName).join(', ')})`
        out.push(`    ${cols} [${[ix.unique ? 'unique' : '', `name: '${ix.name}'`].filter(Boolean).join(', ')}]`)
      }
      out.push('  }')
    }
    if (t.comment) out.push('', `  Note: ${noteText(t.comment)}`)
    out.push('}', '')
  }
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      if (fk.virtual) continue
      const cols = (c: string[]) => (c.length === 1 ? quoteName(c[0]!) : `(${c.map(quoteName).join(', ')})`)
      const actions = [fk.onDelete && fk.onDelete !== 'NO ACTION' ? `delete: ${fk.onDelete.toLowerCase()}` : '', fk.onUpdate && fk.onUpdate !== 'NO ACTION' ? `update: ${fk.onUpdate.toLowerCase()}` : ''].filter(Boolean)
      out.push(`Ref: ${tableName(t)}.${cols(fk.columns)} > ${tableName({ schema: fk.refSchema ?? t.schema, name: fk.refTable })}.${cols(fk.refColumns)}${actions.length ? ` [${actions.join(', ')}]` : ''}`)
    }
  }
  const names = new Set(tables.map((t) => t.name))
  for (const [group, members] of Object.entries(options.groups ?? {})) {
    const kept = members.filter((m) => names.has(m))
    if (!kept.length) continue
    out.push('', `TableGroup ${quoteName(group)} {`, ...kept.map((m) => `  ${tableName(tables.find((t) => t.name === m)!)}`), '}')
  }
  return `${out.join('\n').trim()}\n`
}


/**
 * Turns DBML with changed or new tables (e.g. an AI reply) into designer drafts against the live tables: matching
 * tables, columns, keys and indexes keep their database names, so the migration alters instead of recreating.
 * `// drop table name` lines mark tables to drop. Keys are "schema.table" for live tables, ids for new ones.
 */
export function designFromDbml(text: string, live: TableInfo[], options: { defaultSchema?: string } = {}): { drafts: Record<string, DesignTable>; errors: DbmlError[] } {
  // Tables the reply defines; the other live tables are put in front as context so references to them resolve.
  const defined = new Set([...text.matchAll(/^\s*Table\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)/gim)].map((m) => ident(m[1]!.split('.').pop()!).toLowerCase()))
  const context = toDbml(live.filter((l) => l.type === 'table' && !defined.has(l.name.toLowerCase())), options)
    .split('\n')
    .filter((l) => !/^Ref:/.test(l))
    .join('\n')
  const contextLines = context.split('\n').length
  const parsed = parseDbml(`${context}\n${text}`, options)
  const model = {
    ...parsed,
    tables: parsed.tables.filter((t) => defined.has(t.name.toLowerCase())),
    // Line numbers refer to the reply.
    errors: parsed.errors.map((e) => ({ ...e, line: e.line - contextLines })).filter((e) => e.line > 0),
  }
  const drafts: Record<string, DesignTable> = {}
  const keyOf = (t: { schema?: string; name: string }) => `${t.schema ?? ''}.${t.name}`
  const find = (name: string, schema?: string) => {
    const same = live.filter((l) => l.type === 'table' && l.name.toLowerCase() === name.toLowerCase())
    return same.find((l) => (l.schema ?? '') === (schema ?? options.defaultSchema ?? '')) ?? same.find((l) => !schema) ?? (same.length === 1 ? same[0] : undefined)
  }
  for (const t of model.tables) {
    const existing = find(t.name, t.schema)
    const base = existing ? toDesignTable(existing) : undefined
    const sameCols = (a: string[], b: string[]) => a.length === b.length && a.every((c, i) => c.toLowerCase() === b[i]!.toLowerCase())
    const draft: DesignTable = {
      id: base?.id ?? designId('t'),
      schema: existing?.schema ?? t.schema ?? options.defaultSchema,
      name: t.name,
      originalName: existing?.name,
      comment: t.comment ?? null,
      columns: t.columns.map((c) => {
        const old = base?.columns.find((x) => x.name.toLowerCase() === c.name.toLowerCase())
        return { id: old?.id ?? designId('c'), name: c.name, originalName: old?.originalName, dataType: c.dataType, nullable: c.nullable, defaultValue: c.defaultValue ?? null, identity: c.isIdentity, comment: c.comment ?? null }
      }),
      primaryKey: [...t.primaryKey],
      foreignKeys: t.foreignKeys.map((f) => {
        const old = base?.foreignKeys.find((x) => sameCols(x.columns, f.columns) && x.refTable.toLowerCase() === f.refTable.toLowerCase())
        return { id: old?.id ?? designId('f'), name: old?.name ?? f.name, originalName: old?.originalName, columns: [...f.columns], refSchema: f.refSchema ?? old?.refSchema, refTable: f.refTable, refColumns: [...f.refColumns], onDelete: f.onDelete ?? old?.onDelete, onUpdate: f.onUpdate ?? old?.onUpdate }
      }),
      indexes: t.indexes
        .filter((i) => !i.primary)
        .map((i) => {
          const old = base?.indexes.find((x) => sameCols(x.columns, i.columns) && x.unique === i.unique)
          return { id: old?.id ?? designId('i'), name: old?.name ?? i.name, originalName: old?.originalName, columns: [...i.columns], unique: i.unique }
        }),
    }
    drafts[existing ? keyOf(existing) : draft.id] = draft
  }
  for (const m of text.matchAll(/^\s*\/\/\s*drop\s+table\s+["`]?([\w$.]+?)["`]?\s*$/gim)) {
    const [schema, name] = m[1]!.includes('.') ? (m[1]!.split('.') as [string, string]) : [undefined, m[1]!]
    const existing = find(name, schema)
    if (existing) drafts[keyOf(existing)] = { ...toDesignTable(existing), dropped: true }
  }
  return { drafts, errors: model.errors }
}
