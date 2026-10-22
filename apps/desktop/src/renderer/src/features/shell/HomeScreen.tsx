import { ArrowRight, BookOpen, Coffee, Database, Download, FileSpreadsheet, Keyboard, Plus, Sparkles } from 'lucide-react'
import { isFileDriver } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Kbd } from '@/components/ui/Input'
import { api, modKey } from '@/lib/api'
import { queryFile } from '@/lib/files'
import { useConnections } from '@/store/connections'
import { useUi } from '@/store/ui'
import { DriverIcon } from '../connections/drivers'
import { connectAndSelect, openImportMenu, StatusDot } from '../sidebar/Sidebar'
import { useT } from '@/lib/i18n'

async function openDemo() {
  const id = await api.createSampleDatabase()
  await useConnections.getState().load()
  await connectAndSelect(id)
}

export function HomeScreen() {
  const list = useConnections((s) => s.list)
  const setUi = useUi((s) => s.set)
  const t = useT()
  const recent = [...list].sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? '')).slice(0, 8)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-[860px] flex-col gap-8 px-8 py-12">
        <div className="flex items-center gap-4">
          <Logo size={52} />
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight">DB Mastermind</h1>
            <p className="text-[13px] text-fg-muted">{t('Browse, query, diagram and understand your databases. Free & open source, no limits.')}</p>
          </div>
        </div>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-fg-muted">{recent.length ? t('Recent connections') : t('Get started')}</h2>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" icon={<Coffee size={13} />} onClick={() => void openDemo()}>
                {t('Try the demo database')}
              </Button>
              <Button size="sm" variant="ghost" icon={<FileSpreadsheet size={13} />} onClick={() => void queryFile()} title={t('CSV, Parquet, JSON or Excel: query it with SQL, no import needed')}>
                {t('Query a file')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Download size={13} />} onClick={(e) => void openImportMenu(e.currentTarget)} title={t('From Beekeeper, DBeaver, DataGrip, pgAdmin, SSMS, Workbench, HeidiSQL…')}>
                {t('Import connections')}
              </Button>
              <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setUi({ modal: { kind: 'connection' } })}>
                {t('New connection')}
              </Button>
            </div>
          </div>
          {recent.length ? (
            <div className="grid grid-cols-2 gap-2.5">
              {recent.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void connectAndSelect(c.id)}
                  className="group flex items-center gap-3 rounded-lg border border-line bg-elevated p-3 text-left transition-colors hover:border-accent/50 hover:bg-hover"
                  style={c.color ? { boxShadow: `inset 3px 0 0 ${c.color}` } : undefined}
                >
                  <DriverIcon driver={c.driver} size={28} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-[13px] font-medium">{c.name}</span>
                      {c.environment === 'production' && <span className="rounded bg-danger px-1 text-[9.5px] font-bold text-white">PROD</span>}
                    </div>
                    <div className="truncate text-[11.5px] text-fg-faint">{isFileDriver(c.driver) ? c.filePath || t('in-memory') : `${c.host ?? ''}${c.database ? `/${c.database}` : ''}`}</div>
                  </div>
                  <StatusDot id={c.id} />
                  <ArrowRight size={14} className="text-fg-faint opacity-0 transition-opacity group-hover:opacity-100" />
                </button>
              ))}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setUi({ modal: { kind: 'connection' } })}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-line-strong p-10 text-fg-muted hover:border-accent hover:text-fg"
            >
              <Database size={28} />
              <span className="text-[14px] font-medium">{t('Add your first connection')}</span>
              <span className="text-[12px] text-fg-faint">PostgreSQL · SQL Server · Oracle · MySQL · MariaDB · SQLite · DuckDB · ClickHouse · CockroachDB · BigQuery · Trino</span>
            </button>
          )}
        </section>

        <section className="grid grid-cols-3 gap-3">
          <Feature icon={<Keyboard size={16} />} title={t('Keyboard first')}>
            <div className="flex flex-col gap-1.5">
              <Shortcut keys={[modKey, 'K']} label={t('Command palette')} />
              <Shortcut keys={[modKey, 'P']} label={t('Open table')} />
              <Shortcut keys={[modKey, '↵']} label={t('Run statement')} />
              <Shortcut keys={[modKey, 'T']} label={t('New query')} />
            </div>
          </Feature>
          <Feature icon={<Sparkles size={16} />} title={t('AI that knows your schema')}>
            {t('Connect Claude, OpenAI, OpenRouter or a local model, or use your Claude Code / Codex subscription.')} <span className="whitespace-nowrap">
              {t('Press')} <Kbd>{modKey}</Kbd> <Kbd>J</Kbd>.
            </span>
          </Feature>
          <Feature icon={<BookOpen size={16} />} title={t('Open source')}>
            {t('MIT licensed, no feature limits.')}{' '}
            <button type="button" className="text-accent hover:underline" onClick={() => void api.openExternal('https://github.com/eLh0m3r0/db-mastermind/blob/main/ROADMAP.md')}>
              {t('See the roadmap')}
            </button>
          </Feature>
        </section>
      </div>
    </div>
  )
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-subtle p-3.5">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
        <span className="text-accent">{icon}</span>
        {title}
      </div>
      <div className="text-[12px] leading-relaxed text-fg-muted">{children}</div>
    </div>
  )
}

function Shortcut({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between">
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
          <stop offset="0" stopColor="#8b6dff" />
          <stop offset="1" stopColor="#4f2fe0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#dbm-g)" />
      <ellipse cx="32" cy="19" rx="15" ry="6" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="M17 19v26c0 3.3 6.7 6 15 6s15-2.7 15-6V19" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="M17 32c0 3.3 6.7 6 15 6s15-2.7 15-6" fill="none" stroke="#fff" strokeWidth="3.2" strokeOpacity=".55" />
      <circle cx="44.5" cy="44.5" r="8.5" fill="#fff" />
      <path d="M41 44.5l2.6 2.6 4.6-5" fill="none" stroke="#5b37f0" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
