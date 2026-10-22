import { useEffect, useMemo, useState } from 'react'
import { KeyRound, ShieldCheck, User, Users } from 'lucide-react'
import type { Grant, Principal } from '@dbmastermind/core/browser'
import { EmptyState } from '@/components/ui/EmptyState'
import { Badge, Input } from '@/components/ui/Input'
import { Spinner } from '@/components/ui/Spinner'
import { api } from '@/lib/api'
import { useT } from '@/lib/i18n'
import { cn, errorMessage } from '@/lib/utils'
import { useWorkspace, type RolesTab } from '@/store/workspace'

/** Users and roles of the database, their memberships and object privileges (read-only). */
export function RolesView({ tab }: { tab: RolesTab }) {
  const t = useT()
  const updateTab = useWorkspace((s) => s.update)
  const [principals, setPrincipals] = useState<Principal[] | null>(null)
  const [grants, setGrants] = useState<Grant[] | null>(null)
  const [error, setError] = useState<string>()
  const [search, setSearch] = useState('')
  const [grantFilter, setGrantFilter] = useState('')

  useEffect(() => {
    api.listPrincipals(tab.connectionId).then(setPrincipals, (err: unknown) => setError(errorMessage(err)))
  }, [tab.connectionId])

  useEffect(() => {
    if (!tab.principal) return
    setGrants(null)
    api.listGrants(tab.connectionId, tab.principal).then(setGrants, (err: unknown) => setError(errorMessage(err)))
  }, [tab.connectionId, tab.principal])

  const visible = useMemo(() => (principals ?? []).filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase())), [principals, search])
  const selected = principals?.find((p) => p.name === tab.principal)
  const members = useMemo(() => (principals ?? []).filter((p) => tab.principal && p.memberOf.includes(tab.principal)), [principals, tab.principal])
  const shownGrants = (grants ?? []).filter((g) => !grantFilter || g.object.toLowerCase().includes(grantFilter.toLowerCase()))

  if (error) return <EmptyState icon={<ShieldCheck size={28} />} title={t('Could not read users and roles')}>{error}</EmptyState>
  if (!principals)
    return (
      <div className="flex h-full items-center justify-center text-fg-faint">
        <Spinner size={18} />
      </div>
    )

  const icon = (p: Principal) => (p.kind === 'role' ? <ShieldCheck size={13} /> : p.kind === 'group' ? <Users size={13} /> : <User size={13} />)

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-72 shrink-0 flex-col border-r border-line">
        <div className="border-b border-line p-2">
          <Input inputSize="sm" placeholder={t('Search users and roles…')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-1">
          {visible.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => updateTab(tab.id, { principal: p.name })}
              className={cn('flex h-7 w-full items-center gap-2 rounded px-2 text-left text-[12.5px]', p.name === tab.principal ? 'bg-active' : 'hover:bg-hover')}
            >
              <span className={p.kind === 'role' ? 'text-accent' : 'text-fg-muted'}>{icon(p)}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.name}</span>
              {p.superuser && <KeyRound size={12} className="shrink-0 text-warning" />}
            </button>
          ))}
        </div>
        <div className="border-t border-line px-3 py-1.5 text-[11px] text-fg-faint">
          {principals.filter((p) => p.kind !== 'role').length} {t('users')} · {principals.filter((p) => p.kind === 'role').length} {t('roles')}
        </div>
      </div>
      {!selected ? (
        <EmptyState icon={<ShieldCheck size={28} />} title={t('Users & roles')}>
          {t('Pick a user or role to see its memberships and what it may read or change.')}
        </EmptyState>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col overflow-auto p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-accent">{icon(selected)}</span>
            <h2 className="font-mono text-[15px] font-semibold">{selected.name}</h2>
            <Badge>{selected.kind === 'role' ? t('role') : selected.kind === 'group' ? t('group') : t('user')}</Badge>
            {selected.canLogin === false && <Badge>{t('cannot log in')}</Badge>}
            {selected.superuser && <Badge tone="warning">{t('superuser: may do anything')}</Badge>}
          </div>
          <div className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12.5px]">
            <span className="text-fg-muted">{t('Member of')}</span>
            <span className="flex flex-wrap gap-1">
              {selected.memberOf.length
                ? selected.memberOf.map((r) => (
                    <button key={r} type="button" className="rounded bg-accent-soft px-1.5 font-mono text-[11.5px] text-accent hover:underline" onClick={() => updateTab(tab.id, { principal: r })}>
                      {r}
                    </button>
                  ))
                : '—'}
            </span>
            {members.length > 0 && (
              <>
                <span className="text-fg-muted">{t('Members')}</span>
                <span className="flex flex-wrap gap-1">
                  {members.map((m) => (
                    <button key={m.name} type="button" className="rounded bg-muted px-1.5 font-mono text-[11.5px] hover:underline" onClick={() => updateTab(tab.id, { principal: m.name })}>
                      {m.name}
                    </button>
                  ))}
                </span>
              </>
            )}
          </div>
          <div className="mt-5 mb-2 flex items-center gap-2">
            <h3 className="text-[13px] font-semibold">{t('Privileges granted directly')}</h3>
            <div className="flex-1" />
            <Input inputSize="sm" className="w-56" placeholder={t('Filter objects…')} value={grantFilter} onChange={(e) => setGrantFilter(e.target.value)} />
          </div>
          {!grants ? (
            <Spinner size={14} className="text-fg-faint" />
          ) : shownGrants.length === 0 ? (
            <p className="text-[12.5px] text-fg-muted">{t('No direct privileges. Access may come from the roles above.')}</p>
          ) : (
            <table className="w-full border-collapse text-[12.5px]">
              <thead className="text-left text-[11px] text-fg-muted">
                <tr>
                  <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Object')}</th>
                  <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Type')}</th>
                  <th className="border-b border-line px-2 py-1.5 font-semibold">{t('Privileges')}</th>
                </tr>
              </thead>
              <tbody>
                {shownGrants.map((g) => (
                  <tr key={`${g.objectType}|${g.object}`} className="border-b border-line align-top">
                    <td className="px-2 py-1.5 font-mono text-[12px]">{g.object}</td>
                    <td className="px-2 py-1.5 text-fg-muted">{g.objectType}</td>
                    <td className="px-2 py-1.5">
                      <span className="flex flex-wrap gap-1">
                        {g.privileges.map((p) => (
                          <Badge key={p} tone={/DELETE|DROP|ALTER|ALL|CONTROL|TRUNCATE/i.test(p) ? 'warning' : 'neutral'}>
                            {p}
                          </Badge>
                        ))}
                        {g.grantable && <Badge tone="accent">{t('can grant')}</Badge>}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}
