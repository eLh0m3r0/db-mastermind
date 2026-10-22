import { useCallback, useEffect, useRef, useState } from 'react'
import { markdown } from '@codemirror/lang-markdown'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { AlertTriangle, BookOpen, Eye, FilePlus2, FileText, FolderOpen, Pencil, RefreshCw, Save, Search, Sparkles, Trash2, Wrench } from 'lucide-react'
import type { KnowledgeFileInfo } from '@shared/api'
import { Button, IconButton } from '@/components/ui/Button'
import { openMenu } from '@/components/ui/ContextMenu'
import { EmptyState } from '@/components/ui/EmptyState'
import { Input } from '@/components/ui/Input'
import { api, modKey } from '@/lib/api'
import { cn, errorMessage, fuzzyScore } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useSettings } from '@/store/settings'
import { askAi, toast } from '@/store/ui'
import { useWorkspace, type KnowledgeTab } from '@/store/workspace'
import { Markdown } from '../ai/Markdown'
import { askAiToDocument } from './generate'
import { t, tp, useT } from '@/lib/i18n'
import { askText, confirmAction } from '@/components/ui/ConfirmDialog'

const TEMPLATE = (title: string) => `---
tables: []
relations: []
---
# ${title}

What this area of the database is about.

## Tables

## How they join

## Gotchas
`

function MarkdownEditor({ value, onChange, onSave, dark }: { value: string; onChange: (v: string) => void; onSave: () => void; dark: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  useEffect(() => {
    view.current = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          history(),
          markdown(),
          EditorView.lineWrapping,
          placeholder(t('Write notes in Markdown…')),
          keymap.of([{ key: 'Mod-s', run: () => (handlers.current.onSave(), true), preventDefault: true }, ...defaultKeymap, ...historyKeymap]),
          EditorView.updateListener.of((u) => u.docChanged && handlers.current.onChange(u.state.doc.toString())),
          EditorView.theme(
            {
              '&': { height: '100%', backgroundColor: 'var(--bg)', color: 'var(--text)' },
              '.cm-content': { fontFamily: 'var(--font-mono)', fontSize: '13px', padding: '16px 0', maxWidth: '860px', caretColor: 'var(--accent)' },
              '.cm-line': { padding: '0 24px' },
              '&.cm-focused': { outline: 'none' },
            },
            { dark },
          ),
        ],
      }),
    })
    return () => view.current?.destroy()
    // Recreated per file via `key`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={host} className="h-full overflow-auto" />
}

export function KnowledgeView({ tab, active }: { tab: KnowledgeTab; active: boolean }) {
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  const loadConnections = useConnections((s) => s.load)
  const loadSchema = useConnections((s) => s.loadSchema)
  const updateTab = useWorkspace((s) => s.update)
  const dark = useSettings((s) => s.dark)
  const [files, setFiles] = useState<KnowledgeFileInfo[]>([])
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([])
  const [search, setSearch] = useState('')
  const [content, setContent] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [preview, setPreview] = useState(true)
  const t = useT()
  const folder = connection?.knowledgeBasePath
  const current = tab.file

  const refresh = useCallback(async () => {
    if (!folder) return
    try {
      setFiles(await api.kbList(tab.connectionId))
      // Staleness needs the live schema; a failed check just shows no warnings.
      void api.kbIssues(tab.connectionId).then(setIssues, () => setIssues([]))
    } catch (err) {
      toast({ kind: 'error', message: t('Could not read the knowledge base'), detail: errorMessage(err) })
    }
  }, [folder, tab.connectionId])

  useEffect(() => {
    if (active) void refresh()
  }, [active, refresh])

  useEffect(() => {
    if (!current || !folder) {
      setContent(null)
      setSaved(null)
      return
    }
    api.kbRead(tab.connectionId, current).then(
      (text) => {
        setContent(text)
        setSaved(text)
      },
      () => {
        setContent(null)
        updateTab(tab.id, { file: undefined })
      },
    )
  }, [current, folder, tab.connectionId, tab.id, updateTab])

  const dirty = content !== null && content !== saved

  const save = async () => {
    if (!current || content === null) return
    try {
      await api.kbWrite(tab.connectionId, current, content)
      setSaved(content)
      void refresh()
      void loadSchema(tab.connectionId, true)
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save'), detail: errorMessage(err) })
    }
  }

  const open = async (path: string) => {
    if (dirty && !(await confirmAction({ title: t('Discard unsaved changes?'), confirmLabel: t('Discard'), danger: true }))) return
    updateTab(tab.id, { file: path })
  }

  const create = async () => {
    const name = await askText({ title: t('New file'), message: t('File name (e.g. sales/orders.md)'), value: 'notes.md', confirmLabel: t('Create') })
    if (!name) return
    const title = name.replace(/\.md$/i, '').split('/').pop()!.replace(/[-_]/g, ' ')
    const path = await api.kbWrite(tab.connectionId, name, TEMPLATE(title.charAt(0).toUpperCase() + title.slice(1)))
    await refresh()
    updateTab(tab.id, { file: path })
    setPreview(false)
  }

  const remove = async () => {
    if (!current || !(await confirmAction({ title: t('Delete {name}?', { name: current }), confirmLabel: t('Delete'), danger: true }))) return
    await api.kbDelete(tab.connectionId, current)
    updateTab(tab.id, { file: undefined })
    void refresh()
  }

  if (!connection) return null

  if (!folder) {
    return (
      <EmptyState
        icon={<BookOpen size={30} />}
        title={t('Knowledge base')}
        actions={
          <>
            <Button
              variant="primary"
              onClick={async () => {
                await api.kbEnsureFolder(tab.connectionId)
                await loadConnections()
              }}
            >
              {t('Create knowledge base')}
            </Button>
            <Button
              icon={<FolderOpen size={14} />}
              onClick={async () => {
                const dir = await api.pickDirectory(t('Choose a folder with Markdown notes'))
                if (!dir) return
                await useConnections.getState().save({ ...connection, knowledgeBasePath: dir })
              }}
            >
              {t('Use existing folder…')}
            </Button>
          </>
        }
      >
        {t('Keep Markdown notes about')} <b>{connection.name}</b>
        {t(': what tables mean, codes and statuses, relationships the database doesn’t declare, gotchas. The AI assistant and MCP agents read them, and the AI can write the first version for you. Point it at a Git repository or shared folder to share notes with your team.')}
      </EmptyState>
    )
  }

  const visible = files.filter((f) => !search.trim() || fuzzyScore(`${f.path} ${f.title}`, search) >= 0)

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[260px] shrink-0 flex-col border-r border-line bg-subtle">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line pr-1.5 pl-3">
          <BookOpen size={14} className="text-accent" />
          <span className="text-[12.5px] font-semibold">{t('Knowledge base')}</span>
          <div className="flex-1" />
          <IconButton label={t('New file')} onClick={() => void create()}>
            <FilePlus2 size={14} />
          </IconButton>
          <IconButton
            label={t('AI tools (tools/*.sql)')}
            onClick={async (e) => {
              const anchor = e.currentTarget
              const { tools, errors } = await api.listTeamTools(tab.connectionId)
              openMenu(anchor, [
                ...tools.map((x) => ({ label: `${x.name}(${x.params.join(', ')})`, icon: <Wrench size={13} />, onClick: () => void api.showItemInFolder(`${folder}/tools`) })),
                ...errors.map((err) => ({ label: err, danger: true, disabled: true })),
                ...(tools.length || errors.length ? ['separator' as const] : []),
                {
                  label: t('New AI tool…'),
                  icon: <FilePlus2 size={13} />,
                  onClick: () =>
                    void api.createTeamTool(tab.connectionId).then(
                      (path) => {
                        void api.showItemInFolder(path)
                        toast({ kind: 'success', message: t('Tool template created'), detail: t('Edit {path}: the AI assistant and MCP agents get it as a tool.', { path }) })
                      },
                      (err: unknown) => toast({ kind: 'error', message: t('Could not create the tool'), detail: errorMessage(err) }),
                    ),
                },
              ])
            }}
          >
            <Wrench size={13} />
          </IconButton>
          <IconButton label={t('Refresh')} onClick={() => void refresh()}>
            <RefreshCw size={13} />
          </IconButton>
          <IconButton label={t('Show folder')} onClick={() => void api.showItemInFolder(folder)}>
            <FolderOpen size={13} />
          </IconButton>
        </div>
        <div className="p-2">
          <Input inputSize="sm" placeholder={t('Find note…')} value={search} onChange={(e) => setSearch(e.target.value)} leading={<Search size={12} />} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
          {visible.map((f) => (
            <button
              key={f.path}
              type="button"
              onClick={() => open(f.path)}
              className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left', current === f.path ? 'bg-active' : 'hover:bg-hover')}
              title={f.path}
            >
              <span className="flex items-center gap-1.5 text-[12.5px]">
                <FileText size={12} className="shrink-0 text-fg-faint" />
                <span className="truncate">{f.title}</span>
                {issues.some((i) => i.path === f.path) && (
                  <span title={issues.filter((i) => i.path === f.path).map((i) => i.message).join('\n')} className="ml-auto shrink-0 text-warning">
                    <AlertTriangle size={12} />
                  </span>
                )}
              </span>
              <span className="truncate pl-[18px] text-[10.5px] text-fg-faint">
                {f.path}
                {f.tables.length ? ` · ${tp(f.tables.length, { one: '{n} table', many: '{n} tables' })}` : ''}
              </span>
            </button>
          ))}
          {files.length === 0 && <div className="p-3 text-[12px] text-fg-faint">{t('No notes yet.')}</div>}
        </div>
        {issues.length > 0 && (
          <div className="border-t border-line bg-warning-soft px-3 py-2 text-[11.5px] text-warning">
            <div className="mb-1 font-medium">{tp(new Set(issues.map((i) => i.path)).size, { one: '{n} note is out of date', many: '{n} notes are out of date' })}</div>
            <button
              type="button"
              className="underline"
              onClick={() =>
                askAi({
                  prompt: t('Update the knowledge base: these notes mention things that no longer exist in the database. Check the current schema and fix the notes (front matter tables and relations, and the text).\n\n{issues}', {
                    issues: issues.map((i) => `- ${i.path}: ${i.message}`).join('\n'),
                  }),
                })
              }
            >
              {t('Ask AI to update them')}
            </button>
          </div>
        )}
        <div className="border-t border-line p-2">
          <Button className="w-full" icon={<Sparkles size={13} />} onClick={askAiToDocument}>
            {files.length ? t('Ask AI to extend notes') : t('Generate with AI')}
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {current && content !== null ? (
          <>
            <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <span className="truncate font-mono text-[12px] text-fg-muted">{current}</span>
              {dirty && <span className="h-1.5 w-1.5 rounded-full bg-warning" title={t('Unsaved changes')} />}
              <div className="flex-1" />
              <Button size="sm" variant="ghost" icon={preview ? <Pencil size={13} /> : <Eye size={13} />} onClick={() => setPreview((v) => !v)}>
                {preview ? t('Edit') : t('Preview')}
              </Button>
              <Button size="sm" variant={dirty ? 'primary' : 'ghost'} icon={<Save size={13} />} disabled={!dirty} onClick={() => void save()} title={`${t('Save')} (${modKey}S)`}>
                {t('Save')}
              </Button>
              <IconButton label={t('Delete file')} onClick={() => void remove()}>
                <Trash2 size={13} />
              </IconButton>
            </div>
            <div className="min-h-0 flex-1">
              {preview ? (
                <div className="h-full overflow-auto">
                  <div className="mx-auto max-w-[820px] px-8 py-6">
                    <Markdown text={content.replace(/^---[\s\S]*?\n---\n?/, '')} />
                  </div>
                </div>
              ) : (
                <MarkdownEditor key={current} value={content} onChange={setContent} onSave={() => void save()} dark={dark} />
              )}
            </div>
          </>
        ) : (
          <EmptyState icon={<FileText size={26} />} title={files.length ? t('Choose a note') : t('Start your knowledge base')}>
            {files.length
              ? t('Pick a file on the left, or create a new one.')
              : t('Create a note yourself, or let the AI study the schema and data and draft the documentation for you to review.')}
          </EmptyState>
        )}
      </div>
    </div>
  )
}
