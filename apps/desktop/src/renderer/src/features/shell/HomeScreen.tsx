import { useState } from 'react'
import { ArrowRight, Coffee, Database, Download, FileSpreadsheet, Plus, Shapes, FileCode2, FilePlus2 } from 'lucide-react'
import { isFileDriver } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { runCommand } from '@/lib/commands'
import { Kbd } from '@/components/ui/Input'
import { api, modKey } from '@/lib/api'
import { forgetRecentModel, queryFile, openModel, recentModels } from '@/lib/files'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { DriverIcon } from '../connections/drivers'
import { connectAndSelect, openImportMenu, StatusDot } from '../sidebar/Sidebar'
import { useT } from '@/lib/i18n'
import { LookDecoration } from '@/components/LookDecoration'

async function openDemo() {
  const id = await api.createSampleDatabase()
  await useConnections.getState().load()
  await connectAndSelect(id)
}

export function HomeScreen() {
  const list = useConnections((s) => s.list)
  const setUi = useUi((s) => s.set)
  const t = useT()
  const recent = [...list].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')).slice(0, 5)
  const [models, setModels] = useState(recentModels)
  const modelFolder = (path: string) => path.split(/[\\/]/).slice(-3, -1).join('/')

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[1040px] flex-col gap-6 px-6 py-8">
        <div className="flex items-center gap-3.5">
          <Logo size={40} />
          <div className="flex-1">
            <h1 className="text-[20px] font-semibold tracking-tight">DB Mastermind</h1>
            <p className="text-[12.5px] text-fg-muted">{t('Work with your databases, or design a new one. Free & open source.')}</p>
          </div>
          <LookDecoration size={36} />
        </div>

        {/* The two ways in: a database, or a model (a document of its own, no database needed). */}
        <div className="grid gap-4 md:grid-cols-2">
          <Way
            icon={<Database size={18} />}
            title={t('Databases')}
            points={[t('Data, filters and the SQL editor'), t('A live diagram and the relationships of a schema'), t('AI that knows your schema')]}
            actions={
              <>
                <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setUi({ modal: { kind: 'connection' } })}>
                  {t('New connection')}
                </Button>
                <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={(e) => void openImportMenu(e.currentTarget)} title={t('From Beekeeper, DBeaver, DataGrip, pgAdmin, SSMS, Workbench, HeidiSQL…')}>
                  {t('Import connections')}
                </Button>
                <Button size="sm" variant="ghost" icon={<Coffee size={13} />} onClick={() => void openDemo()}>
                  {t('Try the demo database')}
                </Button>
                <Button size="sm" variant="ghost" icon={<FileSpreadsheet size={13} />} onClick={() => void queryFile()} title={t('CSV, Parquet, JSON or Excel: query it with SQL, no import needed')}>
                  {t('Query a file')}
                </Button>
              </>
            }
          >
            {recent.length ? (
              recent.map((c) => (
                <Item
                  key={c.id}
                  onClick={() => void connectAndSelect(c.id)}
                  icon={<DriverIcon driver={c.driver} size={22} />}
                  title={
                    <>
                      <span className="truncate">{c.name}</span>
                      {c.environment === 'production' && <span className="rounded bg-danger px-1 text-[9.5px] font-bold text-white">PROD</span>}
                    </>
                  }
                  detail={isFileDriver(c.driver) ? c.filePath || t('in-memory') : `${c.host ?? ''}${c.database ? `/${c.database}` : ''}`}
                  extra={<StatusDot id={c.id} />}
                  accent={c.color}
                />
              ))
            ) : (
              <Empty>{t('No connections yet. PostgreSQL, SQL Server, Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery, Trino.')}</Empty>
            )}
          </Way>

          <Way
            icon={<Shapes size={18} />}
            title={t('Models')}
            points={[t('Tables and relationships designed without a database'), t('Compared with a database, with the migration script'), t('SQL for any database; opens DeZign for Databases projects too')]}
            actions={
              <>
                <Button size="sm" variant="primary" icon={<FilePlus2 size={14} />} onClick={() => runCommand('new-model')} title={t('Design a database from scratch: draw the tables, then get the SQL for any database. No connection needed')}>
                  {t('New model')}
                </Button>
                <Button size="sm" variant="ghost" icon={<FileCode2 size={13} />} onClick={() => void openModel()} title={t('A database model: DBML, or a DeZign for Databases project (.dez, .dezproj). No connection needed')}>
                  {t('Open a model')}
                </Button>
              </>
            }
          >
            {models.length ? (
              models.slice(0, 5).map((m) => (
                <Item
                  key={m.path}
                  onClick={() => void openModel(m.path)}
                  icon={<FileCode2 size={18} className="text-fg-muted" />}
                  title={<span className="truncate">{m.name}</span>}
                  detail={modelFolder(m.path)}
                  hint={m.path}
                  extra={
                    <span
                      role="button"
                      tabIndex={-1}
                      title={t('Remove from the list')}
                      className="rounded px-1 text-fg-faint opacity-0 hover:bg-subtle hover:text-fg group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        forgetRecentModel(m.path)
                        setModels(recentModels())
                      }}
                    >
                      ×
                    </span>
                  }
                />
              ))
            ) : (
              <Empty>{t('Models you open show here.')}</Empty>
            )}
          </Way>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[11.5px] text-fg-muted">
          <Shortcut keys={[modKey, 'K']} label={t('Command palette')} />
          <Shortcut keys={[modKey, 'P']} label={t('Open table')} />
          <Shortcut keys={[modKey, 'J']} label={t('AI assistant')} />
          <span className="flex-1" />
          <span>
            {t('MIT licensed, no feature limits.')}{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md')}>
              {t('See the roadmap')}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

function Way({ icon, title, points, actions, children }: { icon: React.ReactNode; title: string; points: string[]; actions: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-line bg-elevated p-4">
      <div className="flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-soft text-accent">{icon}</span>
        <h2 className="text-[15px] font-semibold">{title}</h2>
      </div>
      <ul className="flex flex-col gap-1 text-[12px] text-fg-muted">
        {points.map((p) => (
          <li key={p} className="flex gap-1.5">
            <span className="text-accent">·</span>
            {p}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1.5">{actions}</div>
      <div className="flex flex-col gap-1">{children}</div>
    </section>
  )
}

function Item({ onClick, icon, title, detail, hint, extra, accent }: { onClick: () => void; icon: React.ReactNode; title: React.ReactNode; detail?: string; hint?: string; extra?: React.ReactNode; accent?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className="group flex items-center gap-2.5 rounded-lg border border-line px-2.5 py-2 text-left transition-colors hover:border-accent/50 hover:bg-hover"
      style={accent ? { boxShadow: `inset 3px 0 0 ${accent}` } : undefined}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[12.5px] font-medium">{title}</div>
        {detail && <div className="truncate text-[11px] text-fg-faint">{detail}</div>}
      </div>
      {extra}
      <ArrowRight size={13} className="shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-[11.5px] text-fg-faint">{children}</div>
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-1.5">
      <span>{label}</span>
      <span className="flex gap-0.5">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  )
}

export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden>
      <defs>
        <linearGradient id="dbm-g" x1="0" y1="0" x2="1" y2="1">
          {/* In the look's accent color. */}
          <stop offset="0" style={{ stopColor: 'color-mix(in srgb, var(--accent) 80%, white)' }} />
          <stop offset="1" style={{ stopColor: 'color-mix(in srgb, var(--accent) 85%, black)' }} />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#dbm-g)" />
      <ellipse cx="32" cy="19" rx="15" ry="6" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="M17 19v26c0 3.3 6.7 6 15 6s15-2.7 15-6V19" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="M17 32c0 3.3 6.7 6 15 6s15-2.7 15-6" fill="none" stroke="#fff" strokeWidth="3.2" strokeOpacity=".55" />
      <circle cx="44.5" cy="44.5" r="8.5" fill="#fff" />
      <path d="M41 44.5l2.6 2.6 4.6-5" fill="none" style={{ stroke: 'var(--accent)' }} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
