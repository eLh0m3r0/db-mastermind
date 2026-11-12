import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, StreamLanguage } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { AlertTriangle, Archive, Database, Eye, Shapes, FileCode2, FileInput, FolderOpen, GitCompare, Save, Sparkles, TerminalSquare, Plus } from 'lucide-react'
import { checkModel, createScript, dezignDriver, dezignMigrationOptions, dezignViewSql, dezignWrapScript, dropScript, fixModelIssue, unquotedNames, getDialect, parseDbml, toDbml, updateModelFromDatabase, type ModelIssue, type SchemaSnapshot } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { DRIVERS } from '../connections/drivers'
import { Select } from '@/components/ui/Input'
import { Splitter } from '@/components/ui/Splitter'
import { api, keys } from '@/lib/api'
import { tp, useT } from '@/lib/i18n'
import { debounce, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { askAi, toast } from '@/store/ui'
import { useWorkspace, type DiagramTab, type ModelTab } from '@/store/workspace'
import { DiagramView } from '../diagram/DiagramView'
import { describeDezignChanges, modelTabFromFile, sqlObjectsScript } from './open-model'
import { DomainsModal, domainsOfText, withDomains, type ModelDomainDef } from './domains'
import { editableViews, ViewsModal } from './views'
import { IssuesChip, IssuesPanel } from './ModelIssues'
import { rememberModelDatabase } from '@/lib/files'
import { connectAndSelect } from '../sidebar/Sidebar'
import { editorTheme } from '../query/SqlEditor'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'

/** One-click AI tasks on the model: [menu label, request]. */
const MODEL_TASKS: [string, string][] = [
  ['Review the model', 'Review this database model: naming, missing keys and constraints, types, normalization problems and anything that will hurt later.'],
  ['Suggest indexes', 'Suggest indexes for this model based on its foreign keys and the queries such a schema typically serves. Add them to the model.'],
  ['Normalize', 'Normalize this model where it clearly helps (repeated groups, multi-valued columns, data that belongs in its own table), keeping it practical.'],
  ['Add audit columns', 'Add created_at / updated_at audit columns (and created_by / updated_by where it makes sense) to the tables that should have them.'],
]

/** Minimal DBML highlighting: keywords, settings in brackets, strings, notes and comments. */
const dbmlLanguage = StreamLanguage.define<{ inSettings: boolean }>({
  startState: () => ({ inSettings: false }),
  token(stream, state) {
    if (stream.eatSpace()) return null
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match(/^'''/)) {
      while (!stream.eol() && !stream.match("'''")) stream.next()
      return 'string'
    }
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/) || stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^`[^`]*`?/)) return 'string'
    if (stream.eat('[')) {
      state.inSettings = true
      return 'bracket'
    }
    if (stream.eat(']')) {
      state.inSettings = false
      return 'bracket'
    }
    if (stream.match(/^-?\d+(\.\d+)?/)) return 'number'
    if (stream.match(/^[<>-](?=\s)/)) return 'operator'
    const word = stream.match(/^[\w$]+/) as RegExpMatchArray | null
    if (word) {
      const w = word[0].toLowerCase()
      if (!state.inSettings && /^(table|ref|enum|note|indexes|project|tablegroup|as)$/.test(w)) return 'keyword'
      if (state.inSettings && /^(pk|increment|not|null|unique|default|note|ref|name|delete|update|cascade|restrict|set|primary|key)$/.test(w)) return 'keyword'
      return 'variableName'
    }
    stream.next()
    return null
  },
})

function DbmlEditor({ value, dark, onChange, onSave, jumpTo }: { value: string; dark: boolean; onChange: (text: string) => void; onSave: () => void; jumpTo: { line: number; n: number } | null }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const theme = useRef(new Compartment())
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          highlightActiveLine(),
          bracketMatching(),
          dbmlLanguage,
          keymap.of([{ key: 'Mod-s', run: () => (handlers.current.onSave(), true), preventDefault: true }, indentWithTab, ...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          // Find & replace (⌘F) like the SQL editor; long models are hard to navigate without it.
          highlightSelectionMatches(),
          theme.current.of(editorTheme(dark)),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) handlers.current.onChange(u.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = v
    return () => v.destroy()
    // The document is initial-only; later edits come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    view.current?.dispatch({ effects: theme.current.reconfigure(editorTheme(dark)) })
  }, [dark])

  // Replacing the text from outside (open file, generate from database).
  useEffect(() => {
    const v = view.current
    if (v && v.state.doc.toString() !== value) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } })
  }, [value])

  useEffect(() => {
    const v = view.current
    if (!v || !jumpTo) return
    const line = v.state.doc.line(Math.min(Math.max(1, jumpTo.line), v.state.doc.lines))
    v.dispatch({ selection: { anchor: line.from, head: line.to }, scrollIntoView: true })
    v.focus()
  }, [jumpTo])

  return <div ref={host} className="h-full min-h-0 overflow-hidden [&_.cm-editor]:h-full" />
}

/**
 * A database model as DBML text with a live diagram. Save it next to the knowledge base to version it,
 * fill it from the live database, and compare it with the database to get the migration.
 */
export function ModelView({ tab }: { tab: ModelTab }) {
  const t = useT()
  const dark = useSettings((s) => s.dark)
  const updateTab = useWorkspace((s) => s.update)
  const openTab = useWorkspace((s) => s.open)
  const newQuery = useWorkspace((s) => s.newQuery)
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const connections = useConnections((s) => s.list)
  const liveSchema = useConnections((s) => s.runtime[tab.connectionId]?.schema)
  const loadSchema = useConnections((s) => s.loadSchema)
  const [text, setText] = useState(tab.text)
  // The model can be replaced from outside (AI "Apply to model").
  useEffect(() => {
    setText((current) => (current === tab.text ? current : tab.text))
  }, [tab.text])
  const [width, setWidth] = useState(Math.round(window.innerWidth * 0.36))
  const [jumpTo, setJumpTo] = useState<{ line: number; n: number } | null>(null)

  const persist = useMemo(() => debounce((id: string, value: string) => updateTab(id, { text: value, dirty: true }), 400), [updateTab])

  const model = useMemo(() => parseDbml(text, { defaultSchema: liveSchema?.defaultSchema }), [text, liveSchema?.defaultSchema])
  const snapshot = useMemo<SchemaSnapshot>(
    () => ({ tables: model.tables, schemas: [...new Set(model.tables.map((x) => x.schema ?? ''))], defaultSchema: liveSchema?.defaultSchema, routines: [], capturedAt: '' }),
    [model, liveSchema?.defaultSchema],
  )

  const replaceText = (value: string, patch: Partial<ModelTab> = {}) => {
    setText(value)
    updateTab(tab.id, { text: value, ...patch })
  }

  /** A model opened from a DeZign project goes back into it: the changes are listed first, the old files are kept. */
  const saveToSource = async (source: NonNullable<ModelTab['source']>) => {
    const request = { path: source.path, text, hash: source.hash, positions: tab.positions, notes: tab.notes, colors: tab.colors, diagrams: tab.diagrams, display: tab.display, boxes: tab.boxes, removedDiagrams: tab.removedDiagrams, domains: domainsOfText(text), views: editableViews(tab.sqlObjects).map(({ id, code }) => ({ id, code })), layout: !!source.layout, defaultSchema: liveSchema?.defaultSchema }
    const name = source.path.split(/[\\/]/).pop() ?? ''
    try {
      const preview = await api.saveDezignModel({ ...request, dryRun: true })
      if (!preview.changes.length) {
        updateTab(tab.id, { dirty: false, text })
        return toast({ kind: 'info', message: t('Nothing to save: the model is the same as {file}', { file: name }) })
      }
      const ok = await confirmAction({
        title: t('Write these changes into {file}?', { file: name }),
        message: t('Only the listed objects are changed; everything else in the DeZign project stays as it is. The files as they are now are copied to a backup folder first.'),
        items: describeDezignChanges(preview.changes),
        confirmLabel: t('Write to the DeZign file'),
      })
      if (!ok) return
      const done = await api.saveDezignModel(request)
      // What was new has ids of its own in the file now (diagrams, notes): the tab takes the layout back from there,
      // and keeps the text as it was typed.
      const selected = diagram?.name
      const { text: _saved, title: _title, dirty: _dirty, ...fresh } = modelTabFromFile(await api.openModelFile(source.path).then((f) => f!), liveSchema?.defaultSchema, { quiet: true })
      updateTab(tab.id, { ...fresh, dirty: false, text, source: { ...source, hash: done.hash, layout: true } })
      if (diagram) setArea(fresh.diagrams?.find((d) => d.name === selected) ? `d:${fresh.diagrams.find((d) => d.name === selected)!.id}` : '')
      toast({ kind: 'success', message: t('Saved to {file}', { file: name }), detail: done.backup ? t('Backup of the previous files: {dir}', { dir: done.backup }) : undefined })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save the model'), detail: errorMessage(err) })
    }
  }

  const save = async (as = false) => {
    if (!as && !tab.path && tab.source) return saveToSource(tab.source)
    try {
      const path = await api.saveModelFile(text, as ? undefined : tab.path, connection?.knowledgeBasePath, { positions: tab.positions, defaultSchema: liveSchema?.defaultSchema, driver: connection?.driver, name: fileName })
      if (!path) return
      // Saved as a DeZign project: the tab now follows that file, as if it had been opened from it.
      if (/\.dez(proj)?$/i.test(path)) {
        const file = await api.openModelFile(path)
        if (!file) return
        const { text: opened, ...patch } = modelTabFromFile(file, liveSchema?.defaultSchema, { quiet: true })
        replaceText(opened, patch)
        if (connection) rememberModelDatabase(path, connection.id)
        return toast({ kind: 'success', message: t('Saved as a DeZign for Databases project'), detail: path })
      }
      // Saved as its own file, the model no longer follows the DeZign project it came from.
      updateTab(tab.id, { path, source: undefined, dirty: false, text, title: path.split(/[\\/]/).pop() ?? t('Model') })
      if (connection) rememberModelDatabase(path, connection.id)
      toast({ kind: 'success', message: t('Model saved'), detail: path })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save the model'), detail: errorMessage(err) })
    }
  }

  const open = async () => {
    try {
      const file = await api.openModelFile(undefined, connection?.knowledgeBasePath)
      if (!file) return
      const { text: opened, ...patch } = modelTabFromFile(file, liveSchema?.defaultSchema)
      replaceText(opened, patch)
    } catch (err) {
      toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
    }
  }

  const fromDatabase = async () => {
    const snap = liveSchema ?? (await loadSchema(tab.connectionId))
    if (!snap) return
    if (text.trim() && !(await confirmAction({ title: t('Replace the model with the tables of {name}?', { name: connection?.name ?? '' }), confirmLabel: t('Replace'), danger: true }))) return
    replaceText(toDbml(snap.tables, { defaultSchema: snap.defaultSchema }), { dirty: true })
  }

  /**
   * The database is right: what it has and the model lacks is added, what differs follows it, and what only the
   * model knows (comments, domains, checks, layout) stays.
   */
  const updateFromDatabase = async (removeMissing: boolean) => {
    if (!connection) return
    // Read again: what the database has now, not what was loaded when the model was first compared with it.
    const snap = (await connectAndSelect(connection.id)) ? await loadSchema(tab.connectionId, true) : undefined
    if (!snap) return
    // The schemas the model is about, when the database has them; all of it otherwise.
    const schemas = new Set(model.tables.map((x) => (x.schema ?? snap.defaultSchema ?? '').toLowerCase()))
    const scoped = snap.tables.filter((x) => schemas.has((x.schema ?? snap.defaultSchema ?? '').toLowerCase()))
    const { tables, summary: n } = updateModelFromDatabase(model.tables, scoped.length ? scoped : snap.tables, { removeMissing })
    if (!Object.values(n).some(Boolean)) return toast({ kind: 'success', message: t('The model already matches {name}', { name: connection.name }) })
    replaceText(toDbml(tables, { defaultSchema: snap.defaultSchema, enums: model.enums, groups: model.groups, extras: model.extras }), { dirty: true })
    toast({
      kind: 'success',
      message: t('Model updated from {name}', { name: connection.name }),
      detail: t('Tables: {a} added, {b} removed. Columns: {c} added, {d} removed, {e} changed. Relationships changed: {f}. Indexes changed: {g}.', { a: String(n.tablesAdded), b: String(n.tablesRemoved), c: String(n.columnsAdded), d: String(n.columnsRemoved), e: String(n.columnsChanged), f: String(n.relationshipsChanged), g: String(n.indexesChanged) }),
    })
  }
  const fromDatabaseMenu = (anchor: HTMLElement) => {
    if (!model.tables.length) return void fromDatabase()
    openMenu(anchor, [
      { label: t('Update the model (keeps its comments, domains and layout)'), onClick: () => void updateFromDatabase(false) },
      { label: t('Update, and remove tables the database does not have'), onClick: () => void updateFromDatabase(true) },
      'separator',
      { label: t('Replace the model with the database'), onClick: () => void fromDatabase() },
    ])
  }

  /** Versions: this model against another .dbml file (older copy, another branch…). */
  const compareWithFile = async () => {
    try {
      const file = await api.openModelFile(undefined, connection?.knowledgeBasePath, { scripts: true })
      if (!file) return
      const name = file.path.split(/[\\/]/).pop() ?? 'DBML'
      if (file.skipped) toast({ kind: 'warning', message: tp(file.skipped, { one: '{n} statement of the script could not be read', many: '{n} statements of the script could not be read' }), detail: t('Tables they create are missing from the comparison.') })
      openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, targetModel: file.text, targetLabel: name, targetDriver: dezignDriver(tab.sqlDatabase) ?? connection?.driver ?? 'postgres', title: t('Changes since {name}', { name }) }, { reuse: false })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
    }
  }

  /** A project's own archived versions are one click away; any other file is picked as before. */
  const compareMenu = async (anchor: HTMLElement) => {
    const source = tab.source
    const versions = source ? await api.listModelVersions(source.path).catch(() => []) : []
    if (!source || !versions.length) return compareWithFile()
    const name = (v: (typeof versions)[number]) => [v.number && `v${v.number}`, v.label, v.date].filter(Boolean).join(' · ')
    openMenu(anchor, [
      { label: t('Another file…'), onClick: () => void compareWithFile() },
      'separator',
      ...versions.slice(0, 30).map((v) => ({
        label: name(v),
        onClick: () =>
          void api.openModelVersion(source.path, v.id).then(
            (file) => openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, targetModel: file.text, targetLabel: name(v), targetVersion: { path: source.path, id: v.id }, targetDriver: dezignDriver(tab.sqlDatabase) ?? connection?.driver ?? 'postgres', sourceScripting: tab.scripting, title: t('Changes since {name}', { name: name(v) }) }, { reuse: false }),
            (err) => toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) }),
          ),
      })),
    ])
  }

  /**
   * Archives the DeZign project as saved (DeZign's File → Versions): the version DeZign lists, and the one a later
   * "Compare with version…" makes the ALTER script from. Unsaved edits are not in the file, so it is saved first.
   */
  const archiveVersion = async () => {
    const source = tab.source
    if (!source) return
    if (tab.dirty) return toast({ kind: 'info', message: t('Save the model first: a version holds the project as it is saved') })
    const now = new Date()
    const two = (n: number) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`
    const label = await askText({
      title: t('Archive a version of {file}', { file: source.path.split(/[\\/]/).pop() ?? '' }),
      message: t('The project as it is saved now is kept in it as a version, as DeZign keeps one: listed under File → Versions there, and under Compare with version… here.'),
      value: t('Version {date}', { date: stamp }),
      confirmLabel: t('Archive'),
    })
    if (!label) return
    try {
      const done = await api.archiveModelVersion(source.path, { label, hash: source.hash })
      toast({ kind: 'success', message: t('Archived as version {n}', { n: String(done.number) }), detail: done.label })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not archive the version'), detail: errorMessage(err) })
    }
  }

  // The project's domains: the model's domains note says which there are (see ./domains).
  const domains = useMemo(() => domainsOfText(text), [text])
  const [domainsOpen, setDomainsOpen] = useState(false)
  /** New domain types go to the columns that follow them; the note lists the domains as they are now. */
  const applyDomains = (next: ModelDomainDef[]) => {
    setDomainsOpen(false)
    if (model.errors.length) return toast({ kind: 'error', message: t('Fix the errors in the model first') })
    const typeOf = new Map(next.map((d) => [d.name.toLowerCase(), d.dataType]))
    const tables = model.tables.map((tb) => ({ ...tb, columns: tb.columns.map((c) => (c.domain && typeOf.has(c.domain.toLowerCase()) && typeOf.get(c.domain.toLowerCase()) !== c.dataType ? { ...c, dataType: typeOf.get(c.domain.toLowerCase())! } : c)) }))
    const rewritten = tables.some((tb, i) => tb.columns.some((c, k) => c !== model.tables[i]!.columns[k]))
    const body = rewritten ? toDbml(tables, { defaultSchema: snapshot.defaultSchema, enums: model.enums, groups: model.groups, extras: model.extras }) : text
    const changed = withDomains(body, next)
    if (changed !== text) replaceText(changed, { dirty: true })
  }

  // The project's views: their SQL as the project keeps it, written back on Save (see ./views).
  const views = useMemo(() => editableViews(tab.sqlObjects), [tab.sqlObjects])
  const [viewsOpen, setViewsOpen] = useState(false)
  const applyViews = (codes: Record<string, string>) => {
    setViewsOpen(false)
    if (!views.some((v) => codes[v.id] !== undefined && codes[v.id] !== v.code)) return
    const sqlObjects = tab.sqlObjects?.map((o) => (o.kind === 'view' && o.id && codes[o.id] !== undefined && codes[o.id] !== o.code ? { ...o, code: codes[o.id]!, sql: dezignViewSql(o, codes[o.id]!) } : o))
    updateTab(tab.id, { sqlObjects, dirty: true })
  }

  /** An empty model starts with one table open in the designer: nobody has to know DBML to begin. */
  const addFirstTable = () => {
    replaceText('Table table_1 {\n  id integer [pk, increment]\n  name varchar(100) [not null]\n}\n', { dirty: true, startDesign: `${liveSchema?.defaultSchema ?? ''}.table_1` } as Partial<ModelTab>)
    // Only this once: the next time the diagram is shown it opens as usual.
    setTimeout(() => updateTab(tab.id, { startDesign: undefined } as Partial<ModelTab>), 1500)
  }

  const importDdl = async () => {
    try {
      const r = await api.importDdlFile()
      if (!r) return
      if (text.trim() && !(await confirmAction({ title: t('Replace the model with the tables from {file}?', { file: r.path.split(/[\\/]/).pop() ?? '' }), confirmLabel: t('Replace'), danger: true }))) return
      replaceText(r.dbml, { dirty: true })
      if (r.skipped.length) toast({ kind: 'warning', message: tp(r.skipped.length, { one: '{n} statement could not be read', many: '{n} statements could not be read' }), detail: r.skipped.map((x) => `${x.error}\n  ${x.sql.split('\n')[0]}`).join('\n') })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not import the SQL file'), detail: errorMessage(err) })
    }
  }

  /** Where a script goes: the database's editor, or a file for a model on its own. */
  const deliver = (script: string, title: string, file: string) => {
    if (connection) newQuery(tab.connectionId, script, title)
    else void api.saveSqlFile(script, file).then((path) => path && toast({ kind: 'success', message: t('Script saved'), detail: path }), (err) => toast({ kind: 'error', message: t('Could not save the script'), detail: errorMessage(err) }))
  }
  /** The DROP script DeZign writes next to the CREATE one: for the model's own database (or the one it is compared with). */
  const dropFor = () => {
    const id = dezignDriver(tab.sqlDatabase) ?? connection?.driver ?? 'postgres'
    const d = DRIVERS.find((x) => x.id === id) ?? DRIVERS[0]!
    const named = tab.source?.kind === 'dezign' ? unquotedNames(model.tables, d.id) : model.tables
    const views = (tab.sqlObjects ?? []).filter((o) => o.kind === 'view' && dezignDriver(tab.sqlDatabase) === d.id).map((o) => `DROP VIEW ${o.schema ? `${o.schema}.` : ''}${o.name};`)
    const script = `-- ${t('Drops everything the model creates in {db}: run it only on a database you mean to empty.', { db: d.label })}\n${views.length ? `${views.join('\n')}\n\n` : ''}${dropScript(named, getDialect(d.id), dezignMigrationOptions(tab.scripting, d.id))}`
    deliver(script, `DROP · ${d.label}`, `${fileName.replace(/\.\w+$/, '') || 'model'}-drop-${d.id}.sql`)
  }
  const ddlMenu = (anchor: HTMLElement) =>
    openMenu(
      anchor,
      [...DRIVERS.map((d) => ({
        label: d.label,
        onClick: () => {
          // A DeZign project's names are created as DeZign's own scripts create them: without quotes.
          const named = tab.source?.kind === 'dezign' ? unquotedNames(model.tables, d.id) : model.tables
          const folded = named !== model.tables && named.some((x, i) => x.name !== model.tables[i]!.name || x.columns.some((c, k) => c.name !== model.tables[i]!.columns[k]!.name))
          const note = folded ? `-- ${t('Names are created as DeZign creates them, without quotes: {db} stores them in {case} case.', { db: d.label, case: d.id === 'oracle' ? t('upper') : t('lower') })}\n` : ''
          // The project's own begin and end scripts go around it, for the database they were written for.
          const own = dezignDriver(tab.sqlDatabase)
          const body = `${createScript(named, getDialect(d.id), { translateTypes: true, from: own ?? connection?.driver, ...dezignMigrationOptions(tab.scripting, d.id) })}${sqlObjectsScript(tab.sqlObjects, tab.sqlDatabase, d.id)}`
          const script = `-- ${t('Model as {db} DDL', { db: d.label })}\n${note}${own === d.id ? dezignWrapScript(body, tab.scripting, 'create') : body}`
          // With a database the script opens in its editor; a model on its own saves it as a file.
          deliver(script, `DDL · ${d.label}`, `${fileName.replace(/\.\w+$/, '') || 'model'}-${d.id}.sql`)
        },
      })),
      'separator',
      { label: t('DROP script…'), onClick: dropFor }],
    )

  // Checks that run by themselves on a model that parses.
  // The limits of the database the model is for: the project's own, or the one it is compared with.
  const issues = useMemo(() => (model.errors.length ? [] : checkModel(model.tables, { driver: dezignDriver(tab.sqlDatabase) ?? connection?.driver })), [model, tab.sqlDatabase, connection?.driver])
  const [showIssues, setShowIssues] = useState(false)
  const jumpToIssue = (issue: ModelIssue) => {
    const name = issue.table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const line = text.split('\n').findIndex((l) => new RegExp(`^\\s*Table\\s+(?:(?:"[^"]+"|[\\w$]+)\\.)?"?${name}"?(?:\\s|\\{|$)`, 'i').test(l))
    if (line !== -1) setJumpTo({ line: line + 1, n: Date.now() })
  }
  /** How many rows of the child have no parent row, when the linked database has both tables; null when it can't tell. */
  const orphans = async (issue: ModelIssue): Promise<number | null> => {
    const fk = issue.relationship
    const child = liveSchema?.tables.find((x) => x.name.toLowerCase() === issue.table.toLowerCase())
    const parent = fk && liveSchema?.tables.find((x) => x.name.toLowerCase() === fk.refTable.toLowerCase())
    if (!connection || !fk || !child || !parent) return null
    const q = getDialect(connection.driver).quoteIdent
    const ref = (x: { schema?: string; name: string }) => (x.schema ? `${q(x.schema)}.` : '') + q(x.name)
    const sql = `SELECT COUNT(*) FROM ${ref(child)} c WHERE c.${q(fk.columns[0]!)} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${ref(parent)} p WHERE p.${q(fk.refColumns[0]!)} = c.${q(fk.columns[0]!)})`
    try {
      const [outcome] = await api.runQuery({ connectionId: connection.id, sql, runId: crypto.randomUUID(), maxRows: 1 })
      const n = Number(outcome?.results?.[0]?.rows[0]?.[0])
      return outcome?.error || !Number.isFinite(n) ? null : n
    } catch {
      return null
    }
  }
  const fixIssues = async (list: ModelIssue[]) => {
    // One suggested relationship is checked against the real rows first, when the model's database has them.
    if (list.length === 1 && list[0]!.kind === 'missing_relationship') {
      const n = await orphans(list[0]!)
      if (n && !(await confirmAction({ title: t('{n} rows of {table}.{column} have no row in {target}', { n: String(n), table: list[0]!.table, column: list[0]!.column ?? '', target: list[0]!.detail ?? '' }), message: t('The database would refuse this foreign key until those rows are fixed. Add the relationship to the model anyway?'), confirmLabel: t('Add anyway') }))) return
      if (n === 0) toast({ kind: 'success', message: t('Checked against {name}: every row has its parent', { name: connection?.name ?? '' }) })
    }
    let tables = model.tables
    for (const issue of list) tables = fixModelIssue(tables, issue) ?? tables
    if (tables !== model.tables) replaceText(toDbml(tables, { defaultSchema: snapshot.defaultSchema, enums: model.enums, groups: model.groups, extras: model.extras }), { dirty: true })
  }

  /** Links the model to a database: picked when it is first needed, remembered for this file. */
  const linkDatabase = (connectionId: string) => {
    updateTab(tab.id, { connectionId })
    rememberModelDatabase(tab.path ?? tab.source?.path, connectionId)
  }
  const compareWithDatabase = async () => {
    if (!connection) return
    if (!liveSchema && !(await connectAndSelect(connection.id))) return
    openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, sourceUnquoted: tab.source?.kind === 'dezign', sourceScripting: tab.scripting, title: t('Model → {name}', { name: connection.name }) }, { reuse: false })
  }
  const fileName = (tab.path ?? tab.source?.path)?.split(/[\\/]/).pop() ?? ''

  const designWithAi = () =>
    askAi({
      prompt: t(
        'Help me design a database model in DBML (dbdiagram.io syntax). Ask what it should store if it is not clear, then reply with the complete model in one ```dbml block. Current model:\n\n{model}',
        { model: text.trim() || '(empty)' },
      ),
    })

  // TableGroups color their tables (one palette color per group, in file order).
  const groupColors = useMemo(() => {
    const out: Record<string, number> = {}
    Object.values(model.groups).forEach((names, gi) => {
      for (const t of model.tables) if (names.includes(t.name)) out[`${t.schema ?? ''}.${t.name}`] = (gi % 8) + 1
    })
    return out
  }, [model])
  // Subject areas: a model's TableGroups and the named diagrams of its source can each be shown on their own.
  const [area, setArea] = useState('')
  const areaNames = Object.keys(model.groups)
  const diagram = area.startsWith('d:') ? tab.diagrams?.find((d) => d.id === area.slice(2)) : undefined
  const group = area.startsWith('g:') ? model.groups[area.slice(2)] : undefined
  const keyOf = (x: { schema?: string; name: string }) => `${x.schema ?? ''}.${x.name}`
  const inArea = (x: { schema?: string; name: string }) => (diagram ? diagram.tables.includes(keyOf(x)) : group ? group.includes(x.name) : true)
  const shown = useMemo<SchemaSnapshot>(() => (diagram || group ? { ...snapshot, tables: snapshot.tables.filter(inArea) } : snapshot), [area, snapshot, model.groups, tab.diagrams])
  const diagramTab = { ...tab, kind: 'diagram', colors: { ...groupColors, ...(diagram ? diagram.colors : tab.colors) }, notes: diagram ? diagram.notes : tab.notes, boxes: diagram ? diagram.boxes : tab.boxes, positions: diagram ? diagram.positions : tab.positions, tables: diagram ? diagram.tables : undefined, display: diagram ? diagram.display : tab.display } as unknown as DiagramTab
  /** A new diagram of the project the model came from: empty at first, tables are added from the search above the canvas. */
  const newDiagram = async () => {
    const name = (await askText({ title: t('New diagram'), message: t('A diagram shows a part of the model: add tables with the search above the canvas, take them off from their menu. The tables stay in the model.'), placeholder: t('Name of the diagram'), confirmLabel: t('Create') }))?.trim()
    if (!name) return
    const id = `new:${crypto.randomUUID()}`
    updateTab(tab.id, { dirty: true, diagrams: [...(tab.diagrams ?? []), { id, name, tables: [], positions: {} }] })
    setArea(`d:${id}`)
  }
  /** A diagram of the project under another name, or out of it (the tables stay in the model). */
  const renameDiagram = async (id: string) => {
    const d = tab.diagrams?.find((x) => x.id === id)
    if (!d) return
    const name = await askText({ title: t('Rename diagram'), value: d.name, confirmLabel: t('Rename') })
    if (name && name !== d.name) patchDiagram(id, () => ({ name }))
  }
  const removeDiagram = async (id: string) => {
    const d = tab.diagrams?.find((x) => x.id === id)
    if (!d) return
    if (!(await confirmAction({ title: t('Remove the diagram {name}?', { name: d.name }), message: t('The tables stay in the model; only this diagram (its layout, notes and frames) goes. Save takes it out of the DeZign project too.'), confirmLabel: t('Remove'), danger: true }))) return
    setArea('')
    updateTab(tab.id, { dirty: true, diagrams: tab.diagrams?.filter((x) => x.id !== id), removedDiagrams: id.startsWith('new:') ? tab.removedDiagrams : [...(tab.removedDiagrams ?? []), id] })
  }
  const patchDiagram = (id: string, patch: (d: NonNullable<ModelTab['diagrams']>[number]) => Partial<NonNullable<ModelTab['diagrams']>[number]>) =>
    updateTab(tab.id, { dirty: tab.source ? true : tab.dirty, diagrams: tab.diagrams?.map((d) => (d.id === id ? { ...d, ...patch(d) } : d)) })

  // A renamed table keeps its place: when exactly one table disappears and one appears, layouts follow the new name.
  const tableKeys = useMemo(() => model.tables.map(keyOf), [model])
  const previousKeys = useRef(tableKeys)
  useEffect(() => {
    const before = previousKeys.current
    previousKeys.current = tableKeys
    const gone = before.filter((k) => !tableKeys.includes(k))
    const come = tableKeys.filter((k) => !before.includes(k))
    if (gone.length !== 1 || come.length !== 1 || model.errors.length) return
    const [from, to] = [gone[0]!, come[0]!]
    const moved = <T,>(map: Record<string, T> | undefined) => (map && from in map ? Object.fromEntries(Object.entries(map).map(([k, v]) => [k === from ? to : k, v])) : map)
    updateTab(tab.id, {
      positions: moved(tab.positions),
      diagrams: tab.diagrams?.map((d) => ({ ...d, tables: d.tables.map((k) => (k === from ? to : k)), positions: moved(d.positions) ?? {} })),
    })
  }, [tableKeys])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <FileCode2 size={15} className="ml-1 text-accent" />
        <span className="mr-2 max-w-[260px] truncate text-[12.5px] font-medium" title={tab.path ?? tab.source?.path}>
          {(tab.path ?? tab.source?.path)?.split(/[\\/]/).pop() ?? t('Unsaved model')}
          {tab.dirty && ' •'}
        </span>
        <Button size="sm" variant="ghost" icon={<FolderOpen size={13} />} onClick={() => void open()}>
          {t('Open…')}
        </Button>
        <Button size="sm" variant="ghost" icon={<Save size={13} />} onClick={() => void save()} title={keys('⌘S')}>
          {t('Save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void save(true)}>
          {t('Save as…')}
        </Button>
        <div className="mx-1 h-4 w-px bg-line" />
        <Button size="sm" variant="ghost" icon={<Database size={13} />} disabled={!connection} onClick={(e) => fromDatabaseMenu(e.currentTarget)} title={t('Bring changes made in the database into the model, or start the model from the database')}>
          {t('From database')}
        </Button>
        <Button size="sm" variant="ghost" icon={<FileInput size={13} />} onClick={() => void importDdl()} title={t('Read tables from a SQL script (pg_dump, mysqldump, SSMS…) or a Prisma schema')}>
          {t('Import SQL…')}
        </Button>
        <Button size="sm" variant="ghost" icon={<TerminalSquare size={13} />} disabled={!model.tables.length} onClick={(e) => ddlMenu(e.currentTarget)}>
          {t('SQL DDL')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<Sparkles size={13} />}
          onClick={(e) =>
            openMenu(e.currentTarget, [
              { label: t('Design or extend the model…'), onClick: designWithAi },
              'separator',
              ...MODEL_TASKS.map(([label, task]) => ({
                label: t(label),
                disabled: !text.trim(),
                onClick: () => askAi({ prompt: t('{task}\n\nReply with a short explanation and the complete updated model in one ```dbml block, so it can be applied. Current model:\n\n{model}', { task: t(task), model: text.trim() }), send: true }),
              })),
            ])
          }
        >
          {t('Design with AI')}
        </Button>
        <div className="flex-1" />
        {(areaNames.length > 0 || !!tab.diagrams?.length || !!tab.source) && (
          <Select
            inputSize="sm"
            className="w-44"
            value={area}
            onChange={(e) => (e.target.value === '+' ? void newDiagram() : e.target.value === '~rename' ? void renameDiagram(area.slice(2)) : e.target.value === '~remove' ? void removeDiagram(area.slice(2)) : setArea(e.target.value))}
            title={t('Subject areas: the model’s TableGroups and the diagrams of the project it came from')} data-testid="model-area">
            <option value="">{tab.source ? t('Whole model') : t('All areas')}</option>
            {areaNames.map((g) => (
              <option key={`g:${g}`} value={`g:${g}`}>
                {g}
              </option>
            ))}
            {tab.diagrams?.map((d) => (
              <option key={`d:${d.id}`} value={`d:${d.id}`}>
                {d.name || t('Diagram')} ({d.tables.length})
              </option>
            ))}
            {tab.source && <option value="+">{t('New diagram…')}</option>}
            {tab.source && area.startsWith('d:') && <option value="~rename">{t('Rename this diagram…')}</option>}
            {tab.source && area.startsWith('d:') && <option value="~remove">{t('Remove this diagram…')}</option>}
          </Select>
        )}
        <IssuesChip issues={issues} open={showIssues} onToggle={() => setShowIssues((v) => !v)} />
        <span className="text-[11.5px] text-fg-faint">{tp(model.tables.length, { one: '{n} table', many: '{n} tables' })}</span>
        <Select
          inputSize="sm"
          className="w-44"
          value={connection ? tab.connectionId : ''}
          onChange={(e) => linkDatabase(e.target.value)}
          title={t('The database this model is compared with. A model works without one; pick it when you need the ALTER script.')}
          data-testid="model-database"
        >
          <option value="">{t('No database')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          variant="primary"
          icon={<GitCompare size={13} />}
          disabled={!connection || model.errors.length > 0 || !model.tables.length}
          onClick={() => void compareWithDatabase()}
          title={connection ? t('Compare the model with the database and generate the migration') : t('Pick a database on the left first')}
        >
          {connection ? t('Compare with {name}', { name: connection.name }) : t('Compare with database')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<GitCompare size={13} />}
          disabled={model.errors.length > 0}
          title={tab.source ? t('What changed since a version archived in the project, or compared with another file: the changes and the ALTER script') : t('What changed compared with another model file or a SQL script (e.g. a dump of the database): the changes and the ALTER script')}
          onClick={(e) => void compareMenu(e.currentTarget)}
          data-testid="model-compare-versions"
        >
          {tab.source ? t('Compare with version…') : t('Compare with file…')}
        </Button>
        {tab.source && (
          <Button size="sm" variant="ghost" icon={<Shapes size={13} />} onClick={() => setDomainsOpen(true)} title={t('The named types the project\'s columns follow')} data-testid="model-domains">
            {t('Domains…')}
          </Button>
        )}
        <DomainsModal open={domainsOpen} domains={domains} onClose={() => setDomainsOpen(false)} onApply={applyDomains} />
        {views.length > 0 && (
          <Button size="sm" variant="ghost" icon={<Eye size={13} />} onClick={() => setViewsOpen(true)} title={t('The SQL of the project’s views')} data-testid="model-views">
            {t('Views…')}
          </Button>
        )}
        <ViewsModal open={viewsOpen} views={views} onClose={() => setViewsOpen(false)} onApply={applyViews} />
        {tab.source && (
          <Button size="sm" variant="ghost" icon={<Archive size={13} />} onClick={() => void archiveVersion()} title={t('Keep the project as it is saved now as a version, as DeZign does')} data-testid="model-archive-version">
            {t('Archive version…')}
          </Button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <div style={{ width }} className="flex min-w-[260px] shrink-0 flex-col">
          <div className="min-h-0 flex-1">
            <DbmlEditor
              value={text}
              dark={dark}
              jumpTo={jumpTo}
              onChange={(v) => {
                setText(v)
                persist(tab.id, v)
              }}
              onSave={() => void save()}
            />
          </div>
          {showIssues && issues.length > 0 && <IssuesPanel issues={issues} onJump={jumpToIssue} onFix={(list) => void fixIssues(list)} />}
          {model.errors.length > 0 && (
            <div className="max-h-32 shrink-0 overflow-auto border-t border-line bg-warning-soft px-3 py-1.5 text-[12px] text-warning">
              {model.errors.map((e, i) => (
                <button key={i} type="button" className="flex w-full items-center gap-1.5 text-left hover:underline" onClick={() => setJumpTo({ line: e.line, n: Date.now() })}>
                  <AlertTriangle size={12} className="shrink-0" />
                  {t('line {n}', { n: String(e.line) })}: {e.message}
                </button>
              ))}
            </div>
          )}
        </div>
        <Splitter direction="horizontal" size={width} onResize={setWidth} min={260} max={window.innerWidth - 400} />
        <div className="min-w-0 flex-1 border-l border-line">
          {model.tables.length ? (
            <DiagramView
              tab={diagramTab}
              key={area}
              model={diagram ? snapshot : shown}
              modelDriver={dezignDriver(tab.sqlDatabase)}
              domains={domains}
              dashNonIdentifying={tab.source?.kind === 'dezign'}
              onLayout={(patch) => (diagram ? patchDiagram(diagram.id, () => ({ ...patch, ...('positions' in patch ? { positions: patch.positions ?? {} } : {}) })) : updateTab(tab.id, { ...patch, dirty: tab.source ? true : tab.dirty }))}
              onApplyModel={(tables) => {
                // Editing one area keeps the model's other tables; tables added there join the area.
                const others = model.tables.filter((x) => !inArea(x))
                const groups = group ? { ...model.groups, [area.slice(2)]: [...new Set([...group, ...tables.map((x) => x.name)])] } : model.groups
                const diagrams = diagram ? tab.diagrams?.map((d) => (d.id === diagram.id ? { ...d, tables: [...new Set([...d.tables, ...tables.map(keyOf)])] } : d)) : tab.diagrams
                replaceText(toDbml([...others, ...tables], { defaultSchema: snapshot.defaultSchema, enums: model.enums, groups, extras: model.extras }), { dirty: true, diagrams })
              }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-[12.5px] text-fg-muted">
              <Button variant="primary" icon={<Plus size={14} />} onClick={addFirstTable} data-testid="model-first-table">
                {t('Add the first table')}
              </Button>
              <span className="max-w-md">{t('It opens in the designer: add columns, keys and more tables there, and draw relationships between them. Or write tables in DBML on the left, start from the database, or let AI design it.')}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
