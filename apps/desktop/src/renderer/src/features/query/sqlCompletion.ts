import type { Completion, CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import { getDialect, sqlFunctions, tablesInScope, type DriverId, type SchemaSnapshot, type SqlFunction } from '@dbmastermind/core/browser'

const NOT_CODE = new Set(['String', 'QuotedIdentifier', 'LineComment', 'BlockComment'])

function inCode(ctx: CompletionContext): boolean {
  const node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1)
  return !NOT_CODE.has(node.name)
}

/** After these words a table name follows, not a column. */
const TABLE_POSITION = /\b(from|join|into|update|table|truncate)\s+$/i

function info(fn: { signatures: string[]; doc?: string }, name: string): () => HTMLElement {
  return () => {
    const el = document.createElement('div')
    el.style.whiteSpace = 'pre-wrap'
    el.style.fontFamily = 'var(--font-mono)'
    el.style.fontSize = '12px'
    el.style.maxWidth = '520px'
    const lines = fn.signatures.slice(0, 6).map((s) => `${name}${s}`)
    if (fn.signatures.length > 6) lines.push(`… +${fn.signatures.length - 6}`)
    el.textContent = [fn.doc, ...lines].filter(Boolean).join('\n')
    return el
  }
}

/** Inserts `name()`; the cursor goes between the parentheses when the function takes arguments. */
function applyCall(name: string, takesArgs: boolean) {
  return (view: EditorView, _c: Completion, from: number, to: number) => {
    const next = view.state.sliceDoc(to, to + 1)
    if (next === '(') {
      view.dispatch({ changes: { from, to, insert: name }, selection: { anchor: from + name.length + 1 } })
      return
    }
    const text = `${name}()`
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + name.length + (takesArgs ? 1 : 2) } })
  }
}

const KIND_DETAIL: Record<SqlFunction['kind'], string | undefined> = { function: undefined, aggregate: 'aggregate', window: 'window' }

function functionOption(fn: SqlFunction, label = fn.name): Completion {
  const takesArgs = fn.signatures.length === 0 || fn.signatures.some((s) => !s.startsWith('()'))
  const result = fn.signatures.length === 1 ? /→\s*(.+)$/.exec(fn.signatures[0]!)?.[1] : undefined
  return {
    label,
    type: 'function',
    detail: KIND_DETAIL[fn.kind] ?? result,
    info: info(fn, label),
    apply: applyCall(label, takesArgs),
    // Below keywords (lang-sql gives them -1) and columns that match as well: SELECT/FROM stay first for "s"/"f".
    boost: -2,
  }
}

/**
 * Built-in functions of the engine (PostgreSQL's whole pg_catalog) and the database's own functions from the snapshot.
 * `schema.` narrows to that schema's routines.
 */
export function functionCompletionSource(getSchema: () => SchemaSnapshot | undefined, getDriver: () => DriverId): CompletionSource {
  return (ctx) => {
    if (!inCode(ctx)) return null
    const qualified = ctx.matchBefore(/[A-Za-z_][\w$]*\.[A-Za-z_][\w$]*$|[A-Za-z_][\w$]*\.$/)
    const schema = getSchema()
    if (qualified) {
      const owner = qualified.text.slice(0, qualified.text.indexOf('.')).toLowerCase()
      const routines = (schema?.routines ?? []).filter((r) => r.kind === 'function' && r.schema?.toLowerCase() === owner)
      if (!routines.length) return null
      const options = routines.map((r) => functionOption({ name: r.name, kind: 'function', signatures: [`(${r.arguments ?? ''})${r.returnType ? ` → ${r.returnType}` : ''}`] }))
      return { from: qualified.from + owner.length + 1, options, validFor: /^[\w$]*$/ }
    }
    const word = ctx.matchBefore(/[A-Za-z_][\w$]*/)
    if (!word && !ctx.explicit) return null
    if (word && ctx.state.sliceDoc(word.from - 1, word.from) === '.') return null
    const driver = getDriver()
    const own = new Map<string, SqlFunction>()
    for (const r of schema?.routines ?? []) {
      if (r.kind !== 'function') continue
      // Functions outside the default schema need their schema (unless it's on the search_path, which we can't know).
      const label = !r.schema || r.schema === schema?.defaultSchema ? r.name : `${r.schema}.${r.name}`
      const sig = `(${r.arguments ?? ''})${r.returnType ? ` → ${r.returnType}` : ''}`
      const e = own.get(label) ?? { name: label, kind: 'function' as const, signatures: [], doc: r.schema ? `${r.schema}.${r.name}` : undefined }
      e.signatures.push(sig)
      own.set(label, e)
    }
    const options = [...own.values(), ...sqlFunctions(driver).filter((f) => !own.has(f.name))].map((f) => functionOption(f))
    return { from: word?.from ?? ctx.pos, options, validFor: /^[\w$]*$/ }
  }
}

/** Columns of the tables the statement under the cursor uses, without `table.` (lang-sql only completes qualified ones). */
export function columnCompletionSource(getSchema: () => SchemaSnapshot | undefined, getDriver: () => DriverId): CompletionSource {
  return (ctx): CompletionResult | null => {
    const schema = getSchema()
    if (!schema || !inCode(ctx)) return null
    const word = ctx.matchBefore(/[A-Za-z_][\w$]*/)
    if (!word && !ctx.explicit) return null
    const from = word?.from ?? ctx.pos
    if (ctx.state.sliceDoc(from - 1, from) === '.') return null
    const line = ctx.state.doc.lineAt(from)
    const before = ctx.state.sliceDoc(Math.max(line.from - 200, 0), from)
    if (TABLE_POSITION.test(before)) return null
    const driver = getDriver()
    const refs = tablesInScope(ctx.state.doc.toString(), ctx.pos, driver, schema)
    if (!refs.length) return null
    const d = getDialect(driver)
    const plain = /^[a-z_][a-z0-9_$]*$/
    const q = (s: string) => (plain.test(s) ? s : d.quoteIdent(s))
    const count = new Map<string, number>()
    for (const r of refs) for (const c of r.table.columns) count.set(c.name, (count.get(c.name) ?? 0) + 1)
    const options: Completion[] = []
    for (const r of refs) {
      const prefix = q(r.alias ?? r.table.name)
      for (const c of r.table.columns) {
        // A name more than one table has is inserted qualified, so the query isn't ambiguous.
        const ambiguous = (count.get(c.name) ?? 0) > 1
        options.push({
          label: c.name,
          type: 'property',
          detail: refs.length > 1 ? `${r.alias ?? r.table.name} · ${c.dataType}` : c.dataType,
          apply: ambiguous ? `${prefix}.${q(c.name)}` : q(c.name),
          boost: c.isPrimaryKey ? 4 : 3,
        })
      }
    }
    return { from, options, validFor: /^[\w$]*$/ }
  }
}

/** Keywords that are only ever written as calls; LEFT, REPLACE, POSITION … stay keywords (LEFT JOIN, REPLACE INTO). */
const CALL_ONLY = new Set(['coalesce', 'nullif', 'greatest', 'least', 'lower', 'upper', 'abs'])

/**
 * lang-sql's keyword source without the words the function list offers as calls (COUNT next to count()), in the case
 * the user writes: someone typing `left` gets `left` (LEFT JOIN) ahead of left(), since an exact-case match outranks
 * any boost.
 */
export function keywordsWithoutFunctions(source: CompletionSource, getDriver: () => DriverId): CompletionSource {
  return (ctx) => {
    const res = source(ctx)
    const names = new Set(sqlFunctions(getDriver()).filter((f) => f.kind !== 'function' || CALL_ONLY.has(f.name.toLowerCase())).map((f) => f.name.toLowerCase()))
    const typed = ctx.matchBefore(/[A-Za-z_]+/)?.text ?? ''
    const lowerCase = /^[a-z_]+$/.test(typed)
    const strip = (r: CompletionResult | null) =>
      r && {
        ...r,
        options: r.options
          .filter((o) => o.type === 'type' || !names.has(o.label.toLowerCase()))
          .map((o) => (lowerCase ? { ...o, label: o.label.toLowerCase() } : o)),
      }
    return res instanceof Promise ? res.then(strip) : strip(res)
  }
}
