import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands'
import { MSSQL, MySQL, MariaSQL, PLSQL, PostgreSQL, SQLite, sql, type SQLDialect, type SQLNamespace } from '@codemirror/lang-sql'
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  placeholder as placeholderExt,
  rectangularSelection,
  type DecorationSet,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { joinCompletionSource } from './joinCompletion'
import { allSnippets, snippetSource } from './snippets'
import { useSettings } from '@/store/settings'
import { statementAtOffset, type DriverId, type SchemaSnapshot } from '@dbmastermind/core/browser'
import { t as tr } from '@/lib/i18n'

const DIALECTS: Record<DriverId, SQLDialect> = {
  postgres: PostgreSQL,
  mssql: MSSQL,
  mysql: MySQL,
  mariadb: MariaSQL,
  sqlite: SQLite,
  oracle: PLSQL,
  duckdb: PostgreSQL,
  clickhouse: MySQL,
}

export interface SqlEditorHandle {
  getValue(): string
  setValue(text: string): void
  /** Selected text, or the statement under the cursor with its offset. */
  getRunTarget(): { sql: string; offset: number } | null
  focus(): void
  insert(text: string): void
  markError(from: number, to?: number): void
  view(): EditorView | null
}

interface Props {
  /** Initial document; later changes go through the handle (setValue / insert). */
  value: string
  driver: DriverId
  schema?: SchemaSnapshot
  dark: boolean
  fontSize?: number
  onChange: (value: string) => void
  onRun: () => void
  onRunAll: () => void
  onFormat?: () => void
  onSave?: () => void
  onAskAi?: () => void
  ref?: Ref<SqlEditorHandle>
}

export const lightHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#7c3aed', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: '#0f7b3f' },
  { tag: [t.number, t.bool, t.null], color: '#b45309' },
  { tag: t.comment, color: '#8b93a1', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: '#0369a1' },
  { tag: t.operator, color: '#475569' },
  { tag: [t.special(t.name), t.quote], color: '#be123c' },
  { tag: t.punctuation, color: '#64748b' },
])

export const darkHighlight = HighlightStyle.define([
  { tag: t.keyword, color: '#c4a7ff', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: '#86d9a8' },
  { tag: [t.number, t.bool, t.null], color: '#f5b86b' },
  { tag: t.comment, color: '#6f7684', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: '#7cc4fa' },
  { tag: t.operator, color: '#a1a8b5' },
  { tag: [t.special(t.name), t.quote], color: '#fda4af' },
  { tag: t.punctuation, color: '#8b93a1' },
])

export function editorTheme(dark: boolean): Extension {
  return [
    EditorView.theme(
      {
        '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
        '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
        '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
        '.cm-gutters': { backgroundColor: 'var(--bg)', color: 'var(--text-faint)', border: 'none', paddingRight: '4px' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text)' },
        '.cm-activeLine': { backgroundColor: dark ? 'rgba(255,255,255,0.025)' : 'rgba(15,23,42,0.025)' },
        '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
          backgroundColor: dark ? 'rgba(139,109,255,0.3) !important' : 'rgba(109,74,255,0.18) !important',
        },
        '.cm-current-statement': { backgroundColor: dark ? 'rgba(139,109,255,0.07)' : 'rgba(109,74,255,0.05)' },
        '.cm-error-mark': { textDecoration: 'underline wavy var(--danger)', backgroundColor: 'var(--danger-soft)' },
        '.cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none' },
        '.cm-selectionMatch': { backgroundColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.07)' },
        '.cm-tooltip': { backgroundColor: 'var(--bg-elevated)', border: '1px solid var(--border)', boxShadow: 'var(--shadow)', borderRadius: '8px' },
        '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px !important', fontFamily: 'var(--font-mono)', fontSize: '12px' },
        '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: 'var(--accent-fg)' },
        '.cm-completionDetail': { opacity: 0.6, fontStyle: 'normal', marginLeft: '8px' },
        '.cm-panels': { backgroundColor: 'var(--bg-subtle)', color: 'var(--text)', borderColor: 'var(--border)' },
        '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
        '.cm-placeholder': { color: 'var(--text-faint)' },
      },
      { dark },
    ),
    syntaxHighlighting(dark ? darkHighlight : lightHighlight),
  ]
}

/** Builds the completion namespace: schema.table.column plus unqualified tables from the default schema. */
function buildNamespace(schema: SchemaSnapshot | undefined): SQLNamespace {
  if (!schema) return {}
  const root: Record<string, SQLNamespace> = {}
  const bySchema: Record<string, Record<string, SQLNamespace>> = {}
  for (const table of schema.tables) {
    const columns: Completion[] = table.columns.map((c) => ({
      label: c.name,
      type: 'property',
      detail: c.dataType,
      boost: c.isPrimaryKey ? 2 : 0,
    }))
    const tableNs: SQLNamespace = { self: { label: table.name, type: table.type === 'table' ? 'class' : 'interface', detail: table.type === 'table' ? undefined : table.type.replace('_', ' ') }, children: columns }
    const schemaName = table.schema ?? ''
    if (schemaName) (bySchema[schemaName] ??= {})[table.name] = tableNs
    if (!table.schema || table.schema === schema.defaultSchema) root[table.name] = tableNs
  }
  for (const [name, tables] of Object.entries(bySchema)) {
    if (!(name in root)) root[name] = { self: { label: name, type: 'namespace' }, children: tables }
  }
  return root
}

const setErrorRange = StateEffect.define<{ from: number; to: number } | null>()

function rangeField(effect: typeof setErrorRange, className: string, clearOnChange: boolean) {
  return StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes)
      if (clearOnChange && tr.docChanged) deco = Decoration.none
      for (const e of tr.effects) {
        if (e.is(effect)) {
          if (!e.value || e.value.from >= e.value.to) deco = Decoration.none
          else {
            const builder = new RangeSetBuilder<Decoration>()
            builder.add(e.value.from, e.value.to, Decoration.mark({ class: className }))
            deco = builder.finish()
          }
        }
      }
      return deco
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

/** Highlights the statement that ⌘↵ would run, derived from the document and cursor on every change. */
function statementHighlight(getDriver: () => DriverId) {
  const compute = (state: EditorState): DecorationSet => {
    const doc = state.doc.toString()
    const stmt = statementAtOffset(doc, state.selection.main.head, getDriver())
    if (!stmt) return Decoration.none
    const end = stmt.start + stmt.text.length
    // Only worth highlighting when the script has more than one statement.
    if (stmt.start === doc.length - doc.trimStart().length && end >= doc.trimEnd().length) return Decoration.none
    const builder = new RangeSetBuilder<Decoration>()
    builder.add(stmt.start, end, Decoration.mark({ class: 'cm-current-statement' }))
    return builder.finish()
  }
  return StateField.define<DecorationSet>({
    create: compute,
    update: (deco, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  })
}

const errorField = rangeField(setErrorRange, 'cm-error-mark', true)

export function SqlEditor({ value, driver, schema, dark, onChange, onRun, onRunAll, onFormat, onSave, onAskAi, ref }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const handlers = useRef({ onChange, onRun, onRunAll, onFormat, onSave, onAskAi })
  handlers.current = { onChange, onRun, onRunAll, onFormat, onSave, onAskAi }
  const driverRef = useRef(driver)
  driverRef.current = driver
  const schemaRef = useRef(schema)
  schemaRef.current = schema
  const userSnippets = useSettings((s) => s.settings?.snippets)
  const snippetsRef = useRef(allSnippets(driver, userSnippets))
  snippetsRef.current = allSnippets(driver, userSnippets)
  const langCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())

  useEffect(() => {
    const joinSource = joinCompletionSource(() => schemaRef.current, () => driverRef.current)
    const snippetsSource = snippetSource(() => snippetsRef.current)
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, maxRenderedOptions: 80 }),
          rectangularSelection(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          placeholderExt(tr('Write SQL…   ⌘↵ runs the statement under the cursor, ⇧⌘↵ runs everything')),
          statementHighlight(() => driverRef.current),
          // Extra completion source next to the SQL language's own (tables, columns, keywords).
          // Sources need a stable identity: autocompletion matches results to sources by reference.
          EditorState.languageData.of(() => [{ autocomplete: joinSource }, { autocomplete: snippetsSource }]),
          errorField,
          keymap.of([
            { key: 'Mod-Enter', run: () => (handlers.current.onRun(), true), preventDefault: true },
            { key: 'Shift-Mod-Enter', run: () => (handlers.current.onRunAll(), true), preventDefault: true },
            { key: 'Shift-Mod-f', run: () => (handlers.current.onFormat?.(), true), preventDefault: true },
            { key: 'Mod-s', run: () => (handlers.current.onSave?.(), true), preventDefault: true },
            { key: 'Mod-i', run: () => (handlers.current.onAskAi?.(), true), preventDefault: true },
            { key: 'Mod-/', run: toggleComment },
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          langCompartment.current.of(sql({ dialect: DIALECTS[driver], upperCaseKeywords: true })),
          themeCompartment.current.of(editorTheme(dark)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
          }),
          EditorView.lineWrapping,
        ],
      }),
    })
    viewRef.current = view
    return () => view.destroy()
    // The editor is created once; props are pushed in through compartments below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: langCompartment.current.reconfigure(
        sql({
          dialect: DIALECTS[driver],
          upperCaseKeywords: true,
          schema: buildNamespace(schema),
          defaultSchema: schema?.defaultSchema,
        }),
      ),
    })
  }, [driver, schema])

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(editorTheme(dark)) })
  }, [dark])

  useImperativeHandle(ref, () => ({
    getValue: () => viewRef.current?.state.doc.toString() ?? '',
    setValue: (text) => {
      const view = viewRef.current
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    getRunTarget: () => {
      const view = viewRef.current
      if (!view) return null
      const { state } = view
      const sel = state.selection.main
      if (!sel.empty) return { sql: state.sliceDoc(sel.from, sel.to), offset: sel.from }
      const stmt = statementAtOffset(state.doc.toString(), sel.head, driverRef.current)
      return stmt ? { sql: stmt.text, offset: stmt.start } : null
    },
    focus: () => viewRef.current?.focus(),
    insert: (text) => {
      const view = viewRef.current
      if (!view) return
      view.dispatch(view.state.replaceSelection(text))
      view.focus()
    },
    markError: (from, to) => {
      const view = viewRef.current
      if (!view) return
      const len = view.state.doc.length
      const start = Math.max(0, Math.min(from, len))
      let end = to ?? start
      if (end <= start) {
        // Mark the word at the error position.
        const line = view.state.doc.lineAt(start)
        const rest = line.text.slice(start - line.from)
        end = start + Math.max(1, (/^\S+/.exec(rest)?.[0].length ?? 1))
      }
      view.dispatch({
        effects: setErrorRange.of({ from: start, to: Math.min(end, len) }),
        selection: EditorSelection.cursor(start),
        scrollIntoView: true,
      })
    },
    view: () => viewRef.current,
  }))

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
