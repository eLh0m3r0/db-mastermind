import { ArrowLeft, ArrowRight, KeyRound, Link2, Table2 } from 'lucide-react'
import { displayName, findTable, incomingReferences } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge } from '@/components/ui/Input'
import { useConnections } from '@/store/connections'
import { useWorkspace, type StructureTab } from '@/store/workspace'

export function StructureView({ tab }: { tab: StructureTab }) {
  const schema = useConnections((s) => s.runtime[tab.connectionId]?.schema)
  const openTab = useWorkspace((s) => s.open)
  const table = schema ? findTable(schema, tab.table) : undefined
  if (!schema) return <EmptyState title="Loading schema…" />
  if (!table) return <EmptyState title={`Table ${tab.table.name} was not found`} />
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
          <Badge>{table.type.replace('_', ' ')}</Badge>
          {table.rowEstimate != null && table.rowEstimate >= 0 && <Badge>≈ {table.rowEstimate.toLocaleString()} rows</Badge>}
          <Button size="sm" onClick={() => openTab({ kind: 'table', connectionId: tab.connectionId, table: tab.table, title: table.name })}>
            Open data
          </Button>
        </div>

        <section>
          <h2 className="mb-2 text-[13px] font-semibold">Columns</h2>
          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full border-collapse">
              <thead className="bg-subtle">
                <tr>
                  <th className={th}>#</th>
                  <th className={th}>Name</th>
                  <th className={th}>Type</th>
                  <th className={th}>Nullable</th>
                  <th className={th}>Default</th>
                  <th className={th}>Key</th>
                  <th className={th}>Comment</th>
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
                      <td className={td}>{c.nullable ? 'yes' : <span className="text-fg-faint">NOT NULL</span>}</td>
                      <td className={`${td} max-w-[220px] truncate font-mono text-[12px] text-fg-muted`}>{c.defaultValue ?? ''}</td>
                      <td className={td}>
                        <div className="flex items-center gap-1">
                          {c.isPrimaryKey && (
                            <Badge tone="warning">
                              <KeyRound size={10} className="mr-1" /> PK
                            </Badge>
                          )}
                          {c.isIdentity && <Badge>identity</Badge>}
                          {c.isGenerated && <Badge>generated</Badge>}
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
            <h2 className="mb-2 text-[13px] font-semibold">Indexes</h2>
            <div className="flex flex-col gap-1.5">
              {table.indexes.map((ix) => (
                <div key={ix.name} className="rounded-md border border-line px-3 py-2">
                  <div className="flex items-center gap-2 text-[12.5px] font-medium">
                    {ix.name}
                    {ix.primary && <Badge tone="warning">primary</Badge>}
                    {ix.unique && !ix.primary && <Badge tone="accent">unique</Badge>}
                    {ix.method && <span className="text-[11px] text-fg-faint">{ix.method}</span>}
                  </div>
                  <div className="font-mono text-[12px] text-fg-muted">{ix.columns.join(', ')}</div>
                </div>
              ))}
              {table.indexes.length === 0 && <div className="text-[12px] text-fg-faint">No indexes</div>}
            </div>
          </section>
          <section>
            <h2 className="mb-2 text-[13px] font-semibold">Relationships</h2>
            <div className="flex flex-col gap-1.5">
              {table.foreignKeys.map((fk) => (
                <button
                  type="button"
                  key={fk.name}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-hover"
                  onClick={() => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: fk.refSchema, name: fk.refTable }, title: `${fk.refTable} · structure` })}
                >
                  <ArrowRight size={13} className="text-accent" />
                  <span className="text-[12.5px]">
                    <span className="font-mono">{fk.columns.join(', ')}</span> → <b>{fk.refTable}</b>
                    <span className="font-mono">({fk.refColumns.join(', ')})</span>
                  </span>
                  {fk.onDelete && fk.onDelete !== 'NO ACTION' && <span className="ml-auto text-[11px] text-fg-faint">on delete {fk.onDelete.toLowerCase()}</span>}
                </button>
              ))}
              {incoming.map((ref) => (
                <button
                  type="button"
                  key={`${ref.table.name}.${ref.foreignKey.name}`}
                  className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-left hover:bg-hover"
                  onClick={() => openTab({ kind: 'structure', connectionId: tab.connectionId, table: { schema: ref.table.schema, name: ref.table.name }, title: `${ref.table.name} · structure` })}
                >
                  <ArrowLeft size={13} className="text-info" />
                  <span className="text-[12.5px]">
                    <b>{ref.table.name}</b>
                    <span className="font-mono">({ref.foreignKey.columns.join(', ')})</span> references this table
                  </span>
                </button>
              ))}
              {table.foreignKeys.length + incoming.length === 0 && <div className="text-[12px] text-fg-faint">No relationships</div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
