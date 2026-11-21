import type { ColumnInfo, ForeignKeyInfo, TableInfo } from './types.js'
import { emptyImport, leaveOut, type ImportedModel } from './imported-model.js'
import { isPlainType } from './foreign-sql.js'

/**
 * Mermaid ER diagrams (`erDiagram`, also inside a Markdown ```mermaid fence): entities with their attributes
 * (`type name PK, FK, UK "comment"`) and relationships with their cardinality. A relationship names no columns, so
 * the foreign key takes the columns its label names (the app's own Mermaid export writes them there), else the
 * child's FK columns named after the parent's key, else new key columns, as drawing a relationship from table to
 * table makes them. Many-to-many relationships have no foreign key: they are left out and counted.
 */

/** One side of a relationship: how many rows of this entity one row of the other has. */
type Side = 'zero-or-one' | 'exactly-one' | 'zero-or-more' | 'one-or-more'

const LEFT: Record<string, Side> = { '|o': 'zero-or-one', '||': 'exactly-one', '}o': 'zero-or-more', '}|': 'one-or-more' }
const RIGHT: Record<string, Side> = { 'o|': 'zero-or-one', '||': 'exactly-one', 'o{': 'zero-or-more', '|{': 'one-or-more' }
const WORDS: [RegExp, Side][] = [
  [/^(one or zero|zero or one)$/, 'zero-or-one'],
  [/^(one or more|one or many|many\(1\)|1\+)$/, 'one-or-more'],
  [/^(zero or more|zero or many|many\(0\)|0\+)$/, 'zero-or-more'],
  [/^(only one|1|exactly one)$/, 'exactly-one'],
]
const many = (s: Side) => s === 'zero-or-more' || s === 'one-or-more'

/** Generic words diagrams use for types, as SQL; a type written for a database stays as it is. */
const GENERIC: Record<string, string> = { string: 'text', str: 'text', int: 'integer', long: 'bigint', double: 'double precision', float: 'real', number: 'numeric', bool: 'boolean', datetime: 'timestamp', guid: 'uuid', object: 'json' }
const MULTIWORD = ['double precision', 'character varying', 'timestamp with time zone', 'timestamp without time zone', 'time with time zone', 'time without time zone', 'bit varying', 'national character varying', 'national character']

/** A Mermaid type as SQL: `varchar(255)` as written, `varchar_255_` (Mermaid can't hold parentheses everywhere) as varchar(255). */
function sqlType(type: string): string {
  const t = type.trim()
  const mangled = /^([A-Za-z][A-Za-z0-9_]*?)_(\d+)(?:_(\d+))?_$/.exec(t)
  if (mangled) return `${sqlType(mangled[1]!)}(${mangled[2]}${mangled[3] ? `,${mangled[3]}` : ''})`
  const spaced = t.replace(/_/g, ' ').toLowerCase()
  if (MULTIWORD.includes(spaced)) return spaced
  if (/\[\]$/.test(t)) return `${sqlType(t.slice(0, -2))}[]`
  return GENERIC[t.toLowerCase()] ?? t
}

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/s, '$1')
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const singular = (s: string) => s.replace(/ies$/i, 'y').replace(/(s|x|z|ch|sh)es$/i, '$1').replace(/s$/i, '')

/** The erDiagram sources in a text: the text itself, or each ```mermaid fence of a Markdown file. */
function sources(text: string): string[] {
  // Line by line (a regex over the text backtracks through every unclosed fence).
  const fences: string[] = []
  let open: { fence: string; lines: string[] } | undefined
  for (const line of text.split('\n')) {
    if (open) {
      if (line.trim().startsWith(open.fence) && /^[`~]*\s*$/.test(line.trim())) {
        fences.push(open.lines.join('\n') + '\n')
        open = undefined
      } else open.lines.push(line)
    } else {
      const start = /^\s*(`{3,}|~{3,})\s*mermaid\b/.exec(line)
      if (start) open = { fence: start[1]!, lines: [] }
    }
  }
  const diagrams = fences.length ? fences : [text]
  return diagrams.filter((d) => /^\s*erDiagram\b/m.test(d.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/^\s*%%.*$/gm, '')))
}

export function tablesFromMermaid(text: string): ImportedModel {
  const found = sources(text)
  if (!found.length) throw new Error('Not a Mermaid ER diagram: there is no erDiagram in it')
  const out = emptyImport('mermaid')
  const tables = new Map<string, TableInfo>()
  const marked = new Map<TableInfo, Set<string>>()
  const entity = (raw: string): TableInfo => {
    // `name`, `"Quoted name"`, `name["Shown as"]` (the alias is only what the diagram shows).
    const name = unquote(raw.replace(/\[[^\]]*\]$/, '').replace(/:::[\w-]+$/, ''))
    let t = tables.get(name)
    if (!t) {
      t = { name, type: 'table', comment: null, columns: [], primaryKey: [], foreignKeys: [], indexes: [] }
      tables.set(name, t)
      marked.set(t, new Set())
    }
    return t
  }
  const relationships: { left: TableInfo; right: TableInfo; l: Side; r: Side; label: string }[] = []
  const ENTITY = String.raw`("[^"]+"|[A-Za-z_][\w-]*(?:\[[^\]]*\])?)`
  const SYMBOL = new RegExp(`^${ENTITY}\\s*(\\|o|\\|\\||\\}o|\\}\\|)(--|\\.\\.)(o\\||\\|\\||o\\{|\\|\\{)\\s*${ENTITY}\\s*(?::\\s*(.*))?$`)
  // (Cardinality words are short: bounded, so a long line can't make the two lazy groups backtrack for ever.)
  const WORDED = new RegExp(`^${ENTITY}\\s+(.{1,64}?)\\s+(?:optionally\\s+)?to\\s+(.{1,64}?)\\s+${ENTITY}\\s*(?::\\s*(.*))?$`, 'i')
  for (const source of found) {
    const lines = source.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n')
    let i = lines.findIndex((l) => /^\s*erDiagram\b/.test(l))
    for (i++; i < lines.length; i++) {
      const line = lines[i]!.replace(/%%.*$/, '').trim()
      if (!line || /^(direction|title|accTitle|accDescr|style|classDef|class|linkStyle)\b/.test(line)) continue
      const symbol = SYMBOL.exec(line)
      if (symbol) {
        relationships.push({ left: entity(symbol[1]!), right: entity(symbol[5]!), l: LEFT[symbol[2]!]!, r: RIGHT[symbol[4]!]!, label: unquote(symbol[6] ?? '') })
        continue
      }
      const worded = WORDED.exec(line)
      const side = (w: string) => WORDS.find(([re]) => re.test(w.trim().toLowerCase()))?.[1]
      if (worded && side(worded[2]!) && side(worded[3]!)) {
        relationships.push({ left: entity(worded[1]!), right: entity(worded[4]!), l: side(worded[2]!)!, r: side(worded[3]!)!, label: unquote(worded[5] ?? '') })
        continue
      }
      const block = new RegExp(`^${ENTITY}\\s*(?::::[\\w-]+)?\\s*\\{(.*)$`).exec(line)
      if (block) {
        const t = entity(block[1]!)
        // Attributes up to the closing brace, which may share a line with the last one or with the opening one.
        const body: string[] = []
        let rest = block[2]!
        while (true) {
          const close = rest.indexOf('}')
          if (close !== -1) {
            body.push(rest.slice(0, close))
            break
          }
          body.push(rest)
          if (++i >= lines.length) break
          rest = lines[i]!.replace(/%%.*$/, '')
        }
        for (const a of body.flatMap((b) => b.split('\n')).map((b) => b.trim()).filter(Boolean)) {
          const m = /^([*A-Za-z_][\w\-[\]()",.]*?)\s+(\*?[A-Za-z_][\w\-[\]()]*)\s*((?:PK|FK|UK)(?:\s*,\s*(?:PK|FK|UK))*)?\s*(?:"([^"]*)")?\s*$/.exec(a)
          if (!m) continue
          const name = m[2]!.replace(/^\*/, '')
          const keys = (m[3] ?? '').split(',').map((k) => k.trim())
          const typed = sqlType(m[1]!.replace(/^\*/, ''))
          const column: ColumnInfo = { name, ordinal: t.columns.length + 1, dataType: isPlainType(typed) ? typed : 'text', nullable: !keys.includes('PK'), defaultValue: null, isPrimaryKey: keys.includes('PK') || m[2]!.startsWith('*'), isIdentity: false, comment: m[4]?.trim() || null }
          if (column.isPrimaryKey) column.nullable = false
          if (column.dataType !== typed) leaveOut(out, column, 'types', 'Mermaid', typed)
          if (t.columns.some((c) => c.name === name)) continue
          t.columns.push(column)
          if (column.isPrimaryKey) t.primaryKey.push(name)
          if (keys.includes('UK')) t.indexes.push({ name: `${t.name}_${name}_key`, columns: [name], unique: true, primary: false, constraint: true })
          if (keys.includes('FK')) marked.get(t)!.add(name)
        }
        continue
      }
      // A bare entity name declares an entity without attributes.
      const bare = new RegExp(`^${ENTITY}$`).exec(line)
      if (bare) entity(bare[1]!)
    }
  }

  for (const r of relationships) {
    if (many(r.l) && many(r.r)) {
      out.leftOut.manyToMany = (out.leftOut.manyToMany ?? 0) + 1
      continue
    }
    // The "many" side holds the foreign key; in a one-to-one, the side whose columns the label names, else the right.
    const labelled = r.label.split(',').map((s) => s.trim()).filter(Boolean)
    const names = (t: TableInfo) => labelled.length > 0 && labelled.every((c) => t.columns.some((x) => x.name === c))
    const childIsLeft = many(r.l) || (!many(r.r) && names(r.left) && !names(r.right))
    const [child, parent, childSide] = childIsLeft ? [r.left, r.right, r.l] : [r.right, r.left, r.r]
    const fk = foreignKeyFor(child, parent, labelled, marked.get(child)!)
    if (!fk) {
      out.leftOut.relationshipsWithoutKey = (out.leftOut.relationshipsWithoutKey ?? 0) + 1
      continue
    }
    if (child.foreignKeys.some((f) => f.refTable === fk.refTable && f.columns.join() === fk.columns.join())) continue
    if (childSide !== 'zero-or-more') fk.cardinality = childSide
    child.foreignKeys.push(fk)
  }
  for (const t of tables.values()) if (t.primaryKey.length) t.indexes.unshift({ name: `${t.name}_pkey`, columns: [...t.primaryKey], unique: true, primary: true })
  out.tables = [...tables.values()]
  return out
}

/** The foreign key a relationship stands for: the columns its label names, the child's FK columns, or new ones. */
function foreignKeyFor(child: TableInfo, parent: TableInfo, labelled: string[], fkColumns: Set<string>): ForeignKeyInfo | undefined {
  const key = parent.primaryKey
  if (!key.length) return undefined
  const fk = (columns: string[]): ForeignKeyInfo => ({ name: `${child.name}_${columns.join('_')}_fkey`, columns, refTable: parent.name, refColumns: [...key] })
  if (labelled.length === key.length && labelled.every((c) => child.columns.some((x) => x.name === c))) return fk(labelled)
  // The child's FK columns named after the parent's key: id, customer_id, customerId, customers_id.
  const matched = key.map((pk) => {
    const wanted = new Set([norm(pk), norm(parent.name + pk), norm(singular(parent.name) + pk)])
    return [...fkColumns].find((c) => wanted.has(norm(c)) && !(child === parent && c === pk))
  })
  if (matched.every(Boolean)) return fk(matched as string[])
  // New key columns, as drawing a relationship from table to table adds them (DiagramView onConnect).
  const columns = key.map((pk) => {
    const keyColumn = parent.columns.find((c) => c.name === pk)!
    const plain = pk.toLowerCase() === 'id' || child.columns.some((x) => x.name.toLowerCase() === pk.toLowerCase() && child.primaryKey.includes(x.name) && child !== parent) ? `${parent.name}_${pk}` : pk
    const name = child === parent ? `parent_${pk}` : plain
    if (!child.columns.some((x) => x.name.toLowerCase() === name.toLowerCase())) {
      const dataType = /^bigserial$/i.test(keyColumn.dataType) ? 'bigint' : /^(small)?serial$/i.test(keyColumn.dataType) ? 'integer' : keyColumn.dataType
      child.columns.push({ name, ordinal: child.columns.length + 1, dataType, nullable: true, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null })
    }
    return child.columns.find((x) => x.name.toLowerCase() === name.toLowerCase())!.name
  })
  return fk(columns)
}
