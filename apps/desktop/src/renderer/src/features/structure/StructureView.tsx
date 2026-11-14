import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, Eye, KeyRound, Link2, Table2, TerminalSquare } from 'lucide-react'
import { displayName, findTable, incomingReferences, mentionsTable } from '@dbmastermind/core/browser'
import type { KnowledgeFileInfo, SavedQuery } from '@shared/api'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Input'
import { useConnections } from '@/store/connections'
import { useWorkspace, type StructureTab } from '@/store/workspace'
import { useT } from '@/lib/i18n'

export function StructureView({ tab }: { tab: StructureTab }) {
  const schema = useConnections((s) => s.runtime[tab.connectionId]?.schema)
  const openTab = useWorkspace((s) => s.open)
  const t = useT()
  const table = schema ? findTable(schema, tab.table) : undefined
  const connection = useConnections((s) => s.list.find((c) => c.id === tab.connectionId))
  // Where else the table is used: views, saved queries and knowledge base notes (loaded once per tab).
  const [saved, setSaved] = useState<SavedQuery[]>([])
  const [notes, setNotes] = useState<KnowledgeFileInfo[]>([])
  useEffect(() => {
    void api.listSavedQueries().then(setSaved, () => setSaved([]))
    if (connection?.knowledgeBasePath) void api.kbList(tab.connectionId).then(setNotes, () => setNotes([]))
  }, [tab.connectionId, connection?.knowledgeBasePath])
  const usedBy = useMemo(() => {
    if (!schema || !table || !connection) return { views: [], queries: [], notes: [] }
    const driver = connection.driver
    const mentions = (sql: string) => {
      try {
        return mentionsTable(sql, driver, schema, table)
      } catch {
        return false
      }
    }
    const asQuery = (definition: string) => (/^\s*(SELECT|WITH|\()/i.test(definition) ? definition : definition.replace(/^[\s\S]*?\bAS\s+/i, ''))
    return {
      views: schema.tables.filter((v) => v.type !== 'table' && v !== table && v.definition && mentions(asQuery(v.definition))),
      queries: saved.filter((q) => (!q.connectionId || q.connectionId === tab.connectionId) && mentions(q.sql)),
      notes: notes.filter((n) => n.tables.some((x) => x.toLowerCase() === table.name.toLowerCase() || x.toLowerCase() === `${table.schema ?? ''}.${table.name}`.toLowerCase())),
    }
  }, [schema, table, connection, saved, notes, tab.connectionId])
  if (!schema) return <EmptyState title={t('Loading schema…')} />
  if (!table) return <EmptyState title={t('Table {name} was not found', { name: tab.table.name })} />
  const incoming = incomingReferences(schema, table)

  const th = 'h-8 border-b border-line px-3 text-left text-[11.5px] font-semibold text-fg-muted'
  const td = 'h-8 border-b border-line px-3 text-[12.5px]'

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6">
        <div className="flex items-center gap-3">
          <Table2 size={20} className="text-accent" />
          <div>
            <h1 className="text-[17px] font-semibold">{displayName(schema, table)}</h1>
            {table.comment && <p className="text-[12.5px] text-fg-muted">{table.comment}</p>}
          </div>
          <div className="flex-1" />
          <Badge>{t(table.type.replace('_', ' '))}</Badge>
          {table.rowEstimate != null && table.rowEstimate >= 0 && <Badge>{t('≈ {n} rows', { n: table.rowEstimate.toLocaleString() })}</Badge>}
          <Button
            size="sm"
            onClick={() =>
              openTab(
                {
                  kind: 'diagram',
                  connectionId: tab.connectionId,
                  title: t('Design: {name}', { name: table.name }),
                  focus: table.name,
                  startDesign: `${table.schema ?? ''}.${table.name}`,
                },
                { reuse: false },
              )
            }
          >
            {t('Edit structure')}
          </Button>
          <Button size="sm" onClick={() => openTab({ kind: 'table', connectionId: tab.connectionId, table: tab.table, title: table.name })}>
            {t('Open data')}
          </Button>
        </div>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold">{t('Columns')}</h2>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full border-collapse">
              <thead className="bg-subtle">
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>{t('Name')}</th>
                  <th className={th}>{t('Type')}</th>
                  <th className={th}>{t('Nullable')}</th>
                  <th className={th}>{t('Default')}</th>
                  <th className={th}>{t('Key')}</th>
                  <th className={th}>{t('Comment')}</th>
                </tr>
              </thead>
              <tbody className="select-text">
                {table.columns.map((c) => {
                  const fk = table.foreignKeys.find((f) => f.columns.includes(c.name))
                  return (
                    <tr key={c.name} className="hover:bg-hover">
                      <td className={`${td} w-10 text-fg-faint`}>{c.ordinal}</td>
                      <td className={`${td} font-medium`}>{c.name}</td>
                      <td className={`${td} font-mono text-[12px] text-fg-muted`}>{c.dataType}</td>
                      <td className={td}>{c.nullable ? t('yes') : <span className="text-fg-faint">NOT NULL</span>}</td>
                      <td className={`${td} max-w-[220px] truncate font-mono text-[12px] text-fg-muted`}>{c.defaultValue ?? ''}</td>
                      <td className={td}>
                        <div className="flex items-center gap-1">
                          {c.isPrimaryKey && (
                            <Badge tone="warning">
                              <KeyRound size={10} className="mr-1" /> PK
                            </Badge>
                          )}
                          {c.isIdentity && <Badge>{t('identity')}</Badge>}
                          {c.isGenerated && <Badge>{t('generated')}</Badge>}
                          {fk && (
                            <Badge tone="accent">
                              <Link2 size={10} className="mr-1" /> {fk.refTable}.{fk.refColumns[fk.columns.indexOf(c.name)]}
                            </Badge>
                          )}
                        </div>
                      </td>
                      <td className={`${td} text-fg-muted`}>{c.comment}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="grid grid-cols-2 gap-6">
          <section>
            <h2 className="mb-2 text-[13px] font-semibold">{t('Indexes')}</h2>
            <div className="flex flex-col gap-1.5">
              {table.indexes.map((ix) => (
                <div key={ix.name} className="rounded-md border border-line px-3 py-2">
                  <div className="flex items-center gap-2 text-[12.5px] font-medium">
                    {ix.name}
                    {ix.primary && <Badge tone="warning">{t('primary')}</Badge>}
                    {ix.unique && !ix.primary && <Badge tone="accent">{t('unique')}</Badge>}
                    {ix.method && <span className="text-[11px] text-fg-faint">{ix.method}</span>}
                  </div>
                  <div className="font-mono text-[12px] text-fg-muted">{ix.columns.join(', ')}</div>
                </div>
              ))}
              {table.indexes.length === 0 && <div className="text-[12px] text-fg-faint">{t('No indexes')}</div>}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-[13px] font-semibold">{t('Relationships')}</h2>
            <div className="flex flex-col gap-1.5">
              {table.foreignKeys.map((fk) => (
                <button
                  type="button"
                  key={fk.name}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-hover"
                  onClick={() => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: fk.refSchema, name: fk.refTable }, title: t('{name} · structure', { name: fk.refTable }) })}
                >
                  <ArrowRight size={13} className="text-accent" />
                  <span className="text-[12.5px]">
                    <span className="font-mono">{fk.columns.join(', ')}</span> → <b>{fk.refTable}</b>
                    <span className="font-mono">({fk.refColumns.join(', ')})</span>
                  </span>
                  {fk.onDelete && fk.onDelete !== 'NO ACTION' && <span className="ml-auto text-[11px] text-fg-faint">{t('on delete')} {fk.onDelete.toLowerCase()}</span>}
                </button>
              ))}
              {incoming.map((ref) => (
                <button
                  type="button"
                  key={`${ref.table.name}.${ref.foreignKey.name}`}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-hover"
                  onClick={() => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: ref.table.schema, name: ref.table.name }, title: t('{name} · structure', { name: ref.table.name }) })}
                >
                  <ArrowLeft size={13} className="text-info" />
                  <span className="text-[12.5px]">
                    <b>{ref.table.name}</b>
                    <span className="font-mono">({ref.foreignKey.columns.join(', ')})</span> {t('references this table')}
                  </span>
                </button>
              ))}
              {table.foreignKeys.length + incoming.length === 0 && <div className="text-[12px] text-fg-faint">{t('No relationships')}</div>}
            </div>
          </section>
          <section className="col-span-full" data-testid="used-by">
            <h2 className="mb-2 text-[13px] font-semibold">{t('Used by')}</h2>
            <div className="flex flex-col gap-1.5">
              {usedBy.views.map((v) => (
                <button
                  type="button"
                  key={`v:${v.schema}.${v.name}`}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-[12.5px] hover:bg-hover"
                  onClick={() => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: v.schema, name: v.name }, title: t('{name} · structure', { name: v.name }) })}
                >
                  <Eye size={13} className="text-info" />
                  <b>{v.name}</b> <span className="text-fg-muted">{t('view')}</span>
                </button>
              ))}
              {usedBy.queries.map((q) => (
                <button type="button" key={`q:${q.id}`} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-[12.5px] hover:bg-hover" onClick={() => openTab({ kind: 'query', connectionId: tab.connectionId, title: q.name, sql: q.sql, savedQueryId: q.id, savedSql: q.sql }, { reuse: false })}>
                  <TerminalSquare size={13} className="text-accent" />
                  <b>{q.name}</b> <span className="text-fg-muted">{t('saved query')}</span>
                </button>
              ))}
              {usedBy.notes.map((n) => (
                <button
                  type="button"
                  key={`n:${n.path}`}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left text-[12.5px] hover:bg-hover"
                  onClick={() => openTab({ kind: 'knowledge', connectionId: tab.connectionId, title: t('Knowledge base'), file: n.path })}
                >
                  <BookOpen size={13} className="text-success" />
                  <b>{n.title || n.path}</b> <span className="text-fg-muted">{t('knowledge base note')}</span>
                </button>
              ))}
              {usedBy.views.length + usedBy.queries.length + usedBy.notes.length === 0 && <div className="text-[12px] text-fg-faint">{t('No views, saved queries or notes use this table')}</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
