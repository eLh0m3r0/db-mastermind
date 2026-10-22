import { useEffect, useMemo, useRef, useState } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, StreamLanguage } from '@codemirror/language'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { AlertTriangle, Database, FileCode2, FileInput, FolderOpen, GitCompare, Save, Sparkles, TerminalSquare } from 'lucide-react'
import { createScript, getDialect, parseDbml, toDbml, type SchemaSnapshot } from '@dbmastermind/core/browser'
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
import { editorTheme } from '../query/SqlEditor'

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
          keymap.of([{ key: 'Mod-s', run: () => (handlers.current.onSave(), true), preventDefault: true }, indentWithTab, ...defaultKeymap, ...historyKeymap]),
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

  const save = async (as = false) => {
    try {
      const path = await api.saveModelFile(text, as ? undefined : tab.path, connection?.knowledgeBasePath)
      if (!path) return
      updateTab(tab.id, { path, dirty: false, text, title: path.split(/[\\/]/).pop() ?? t('Model') })
      toast({ kind: 'success', message: t('Model saved'), detail: path })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save the model'), detail: errorMessage(err) })
    }
  }

  const open = async () => {
    try {
      const file = await api.openModelFile(undefined, connection?.knowledgeBasePath)
      if (file) replaceText(file.text, { path: file.path, dirty: false, title: file.path.split(/[\\/]/).pop() ?? t('Model') })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not open the model'), detail: errorMessage(err) })
    }
  }

  const fromDatabase = async () => {
    const snap = liveSchema ?? (await loadSchema(tab.connectionId))
    if (!snap) return
    if (text.trim() && !window.confirm(t('Replace the model with the tables of {name}?', { name: connection?.name ?? '' }))) return
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
      if (text.trim() && !window.confirm(t('Replace the model with the tables from {file}?', { file: r.path.split(/[\\/]/).pop() ?? '' }))) return
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
        onClick: () => newQuery(tab.connectionId, `-- ${t('Model as {db} DDL', { db: d.label })}\n${createScript(model.tables, getDialect(d.id), { translateTypes: true })}`, `DDL · ${d.label}`),
      })),
    )

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
  // Subject areas: a model's TableGroups can each be shown on their own.
  const [area, setArea] = useState('')
  const areaNames = Object.keys(model.groups)
  const inArea = (name: string) => !area || (model.groups[area] ?? []).includes(name)
  const shown = useMemo<SchemaSnapshot>(() => (area && model.groups[area] ? { ...snapshot, tables: snapshot.tables.filter((x) => model.groups[area]!.includes(x.name)) } : snapshot), [area, snapshot, model.groups])
  const diagramTab = { ...tab, kind: 'diagram', colors: groupColors } as unknown as DiagramTab

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-2 py-1.5">
        <FileCode2 size={15} className="ml-1 text-accent" />
        <span className="mr-2 max-w-[260px] truncate text-[12.5px] font-medium" title={tab.path}>
          {tab.path ? tab.path.split(/[\\/]/).pop() : t('Unsaved model')}
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
        <Button size="sm" variant="ghost" icon={<Database size={13} />} onClick={() => void fromDatabase()}>
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
        {areaNames.length > 0 && (
          <Select inputSize="sm" className="w-40" value={area} onChange={(e) => setArea(e.target.value)} title={t('Subject areas come from the model’s TableGroups')}>
            <option value="">{t('All areas')}</option>
            {areaNames.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </Select>
        )}
        <span className="text-[11.5px] text-fg-faint">{tp(model.tables.length, { one: '{n} table', many: '{n} tables' })}</span>
        <Button
          size="sm"
          variant="primary"
          icon={<GitCompare size={13} />}
          disabled={model.errors.length > 0 || !model.tables.length}
          onClick={() => openTab({ kind: 'compare', connectionId: tab.connectionId, sourceModel: text, title: t('Model → {name}', { name: connection?.name ?? '' }) }, { reuse: false })}
          title={t('Compare the model with the database and generate the migration')}
        >
          {t('Compare with {name}', { name: connection?.name ?? t('database') })}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon={<GitCompare size={13} />}
          disabled={model.errors.length > 0}
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
              onApplyModel={(tables) => {
                // Editing one area keeps the model's other tables; tables added there join the area.
                const others = model.tables.filter((x) => !inArea(x.name))
                const groups = area ? { ...model.groups, [area]: [...new Set([...(model.groups[area] ?? []), ...tables.map((x) => x.name)])] } : model.groups
                replaceText(toDbml([...others, ...tables], { defaultSchema: snapshot.defaultSchema, enums: model.enums, groups }), { dirty: true })
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
