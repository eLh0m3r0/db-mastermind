import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, StreamLanguage } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { AlertTriangle, Database, FileCode2, FileInput, FolderOpen, GitCompare, Save, Sparkles, TerminalSquare } from 'lucide-react'
import { checkModel, createScript, fixModelIssue, getDialect, parseDbml, toDbml, type ModelIssue, type SchemaSnapshot } from '@dbmastermind/core/browser'
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
import { describeDezignChanges, modelTabFromFile } from './open-model'
import { IssuesChip, IssuesPanel } from './ModelIssues'
import { rememberModelDatabase } from '@/lib/files'
import { connectAndSelect } from '../sidebar/Sidebar'
import { editorTheme } from '../query/SqlEditor'
import { confirmAction } from '@/components/ui/ConfirmDialog'

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
    const request = { path: source.path, text, hash: source.hash, positions: tab.positions, notes: tab.notes, diagrams: tab.diagrams, defaultSchema: liveSchema?.defaultSchema }
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
        warning: t('Saving to DeZign files is new and has not been checked in DeZign itself yet. Keep the backup until you have opened the result there.'),
        confirmLabel: t('Write to the DeZign file'),
      })
      if (!ok) return
      const done = await api.saveDezignModel(request)
      updateTab(tab.id, { dirty: false, text, source: { ...source, hash: done.hash } })
      toast({ kind: 'success', message: t('Saved to {file}', { file: name }), detail: done.backup ? t('Backup of the previous files: {dir}', { dir: done.backup }) : undefined })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save the model'), detail: errorMessage(err) })
    }
  }

  const save = async (as = false) => {
    if (!as && !tab.path && tab.source) return saveToSource(tab.source)
    try {
      const path = await api.saveModelFile(text, as ? undefined : tab.path, connection?.knowledgeBasePath)
      if (!path) return
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

  /** Versions: this model against another .dbml file (older copy, another branch…). */
  const compareWithFile = async () => {
    try {
      const file = await api.openModelFile(undefined, connection?.knowledgeBasePath)
      if (!file) return
      const name = file.path.split(/[\\/]/).pop() ?? 'DBML'
      openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, targetModel: file.text, targetLabel: name, title: t('Changes since {name}', { name }) }, { reuse: false })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
    }
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

  const ddlMenu = (anchor: HTMLElement) =>
    openMenu(
      anchor,
      DRIVERS.map((d) => ({
        label: d.label,
        onClick: () => {
          const script = `-- ${t('Model as {db} DDL', { db: d.label })}\n${createScript(model.tables, getDialect(d.id), { translateTypes: true })}`
          // With a database the script opens in its editor; a model on its own saves it as a file.
          if (connection) newQuery(tab.connectionId, script, `DDL · ${d.label}`)
          else void api.saveSqlFile(script, `${fileName.replace(/\.\w+$/, '') || 'model'}-${d.id}.sql`).then((path) => path && toast({ kind: 'success', message: t('Script saved'), detail: path }), (err) => toast({ kind: 'error', message: t('Could not save the script'), detail: errorMessage(err) }))
        },
      })),
    )

  // Checks that run by themselves on a model that parses.
  const issues = useMemo(() => (model.errors.length ? [] : checkModel(model.tables)), [model])
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
    openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, title: t('Model → {name}', { name: connection.name }) }, { reuse: false })
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
  const diagramTab = { ...tab, kind: 'diagram', colors: { ...groupColors, ...(diagram ? diagram.colors : tab.colors) }, notes: diagram ? diagram.notes : tab.notes, positions: diagram ? diagram.positions : tab.positions } as unknown as DiagramTab
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
        <Button size="sm" variant="ghost" icon={<Database size={13} />} disabled={!connection} onClick={() => void fromDatabase()}>
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
        {(areaNames.length > 0 || !!tab.diagrams?.length) && (
          <Select inputSize="sm" className="w-44" value={area} onChange={(e) => setArea(e.target.value)} title={t('Subject areas: the model’s TableGroups and the diagrams of the project it came from')} data-testid="model-area">
            <option value="">{tab.diagrams?.length ? t('Whole model') : t('All areas')}</option>
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
          disabled={!connection || model.errors.length > 0}
          title={t('What changed compared with another DBML file, e.g. an older version of this model')}
          onClick={() => void compareWithFile()}
        >
          {t('Compare with file…')}
        </Button>
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
              model={shown}
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
            <div className="flex h-full items-center justify-center p-8 text-center text-[12.5px] text-fg-muted">
              {t('Write tables in DBML on the left, start from the database, or let AI design it. The diagram follows as you type.')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
