import { useEffect, useRef, useState } from 'react'
import { Building2, CheckCircle2, ClipboardPaste, FolderOpen, XCircle } from 'lucide-react'
import { isFileDriver, type ConnectionConfig, type DriverId, type Environment, type SslMode } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input, Segmented, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api, bridge } from '@/lib/api'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { useWorkspace } from '@/store/workspace'
import { toast, useUi } from '@/store/ui'
import { DriverIcon, DRIVERS } from './drivers'
import { useSettings } from '@/store/settings'
import { AiPermissionControls, aiDefaultsOf } from '../ai/AiPermissions'
import { KnowledgeLocationBar, useKnowledgeLocation } from '../knowledge/KnowledgeLocation'
import { useT } from '@/lib/i18n'

export const CONNECTION_COLORS = ['#6d4aff', '#0b72d9', '#0f9f6e', '#d97706', '#dc2626', '#db2777', '#64748b']
/** Names for screen readers and tooltips, in CONNECTION_COLORS order. */
const COLOR_NAMES = ['Purple', 'Blue', 'Green', 'Amber', 'Red', 'Pink', 'Slate']

const DEFAULT_PORTS: Partial<Record<DriverId, number>> = { postgres: 5432, mysql: 3306, mariadb: 3306, mssql: 1433, oracle: 1521, clickhouse: 8123, trino: 8080 }

/** The SSH server's key as remembered on the first connection; forgetting it trusts the next one (a reinstalled server). */
function SshHostKey({ host, port }: { host: string; port?: number }) {
  const t = useT()
  const [key, setKey] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void api.sshHostKey(host, port).then((k) => live && setKey(k))
    return () => {
      live = false
    }
  }, [host, port])
  return (
    <Field label={t('SSH host key')}>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-subtle px-2 py-1 font-mono text-[11.5px]" title={key ?? undefined}>
          {key ?? t('Remembered on the first connection')}
        </code>
        {key && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void api.forgetSshHostKey(host, port).then(() => {
                setKey(null)
                toast({ kind: 'info', message: t('The next connection will trust the key the server presents.') })
              })
            }
          >
            {t('Forget')}
          </Button>
        )}
      </div>
      <span className="text-[11.5px] text-fg-faint">{t('A different key later means someone may be intercepting the connection, so the app refuses it.')}</span>
    </Field>
  )
}

function blank(driver: DriverId = 'postgres'): ConnectionConfig {
  return { id: '', name: '', driver, host: 'localhost', port: DEFAULT_PORTS[driver], user: '', password: '', database: '' }
}

type Section = 'general' | 'ssl' | 'ssh' | 'advanced'

export function ConnectionForm() {
  const modal = useUi((s) => s.modal)
  const setUi = useUi((s) => s.set)
  const open = modal?.kind === 'connection'
  const editingId = open ? modal.connectionId : undefined
  const existing = useConnections((s) => (editingId ? s.list.find((c) => c.id === editingId) : undefined))
  const settings = useSettings((s) => s.settings)
  const save = useConnections((s) => s.save)
  const connect = useConnections((s) => s.connect)
  const [config, setConfig] = useState<ConnectionConfig>(blank())
  const [section, setSection] = useState<Section>('general')
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string }>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [urlText, setUrlText] = useState('')
  const { location: kbLocation } = useKnowledgeLocation(existing?.id, existing?.knowledgeBasePath)
  /** Why "Save & connect" failed, shown once the form reopens on the saved connection. */
  const failedConnect = useRef<{ state: 'error'; message?: string }>(undefined)
  const t = useT()

  useEffect(() => {
    if (!open) return
    setConfig(existing ? structuredClone(existing) : { ...blank(), ...(modal.draft as Partial<ConnectionConfig>) })
    setSection('general')
    setTest(failedConnect.current ?? { state: 'idle' })
    failedConnect.current = undefined
    setUrlText('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingId])

  const close = () => setUi({ modal: undefined })
  const set = (patch: Partial<ConnectionConfig>) => {
    setConfig((c) => ({ ...c, ...patch }))
    setTest({ state: 'idle' })
  }
  const setOption = (key: string, value: string | boolean | undefined) =>
    set({ options: { ...config.options, [key]: value as string | boolean } })

  const changeDriver = (driver: DriverId) => {
    const portWasDefault = !config.port || config.port === DEFAULT_PORTS[config.driver]
    set({ driver, port: portWasDefault ? DEFAULT_PORTS[driver] : config.port })
  }

  const applyUrl = async (text: string) => {
    if (!text.trim()) return
    try {
      const parsed = await api.parseConnectionString(text)
      setConfig((c) => ({ ...c, ...parsed, name: c.name }))
      setUrlText('')
      toast({ kind: 'success', message: t('Connection details filled in from the URL') })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not parse connection string'), detail: errorMessage(err) })
    }
  }

  const runTest = async () => {
    setTest({ state: 'running' })
    try {
      const info = await api.testConnection(config)
      setTest({ state: 'ok', message: `${info.product} ${info.version}` })
    } catch (err) {
      setTest({ state: 'error', message: errorMessage(err) })
    }
  }

  const submit = async (andConnect: boolean) => {
    setBusy(true)
    try {
      const saved = await save(config)
      if (!andConnect) return close()
      setTest({ state: 'running' })
      const ok = await connect(saved.id)
      const runtime = useConnections.getState().runtime[saved.id]
      if (ok) {
        close()
        useUi.getState().set({ selectedConnectionId: saved.id })
        // Like opening it from the sidebar: its tab, or a query tab to start with.
        const ws = useWorkspace.getState()
        const existingTab = ws.tabs.find((tab) => tab.connectionId === saved.id)
        if (existingTab) ws.activate(existingTab.id)
        else ws.newQuery(saved.id)
      } else if (runtime?.status === 'error') {
        // Saved, but it doesn't connect: keep the form open on the saved connection, with the reason, to fix it.
        failedConnect.current = { state: 'error', message: runtime.error }
        if (editingId === saved.id) setTest(failedConnect.current)
        else setUi({ modal: { kind: 'connection', connectionId: saved.id } })
      } else setTest({ state: 'idle' })
    } catch (err) {
      toast({ kind: 'error', message: t('Could not save connection'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const isFile = isFileDriver(config.driver)
  const isDuck = config.driver === 'duckdb'
  const isBigQuery = config.driver === 'bigquery'
  const windowsAuth = config.driver === 'mssql' && config.options?.authentication === 'windows'
  const isWindows = bridge.platform === 'win32'
  const ssl = config.ssl ?? { mode: (config.driver === 'mssql' ? 'prefer' : 'disable') as SslMode }
  const ssh = config.ssh ?? { enabled: false, host: '', port: 22, user: '', authMethod: 'privateKey' as const }

  const pickFile = async (title: string, onPick: (path: string) => void, filters?: { name: string; extensions: string[] }[]) => {
    const path = await api.pickFile({ title, filters })
    if (path) onPick(path)
  }

  const pickPem = (title: string, onPick: (pem: string) => void) =>
    pickFile(title, async (path) => onPick(await api.readTextFile(path)), [{ name: t('Certificates & keys'), extensions: ['pem', 'crt', 'cer', 'key', 'ca'] }])

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? t('Edit {name}', { name: existing.name }) : t('New connection')}
      width={680}
      bodyClassName="p-0"
      footer={
        <>
          <Button onClick={() => void runTest()} loading={test.state === 'running'}>
            {t('Test connection')}
          </Button>
          {test.state === 'ok' && (
            <span className="flex min-w-0 items-center gap-1 truncate text-[12px] text-success">
              <CheckCircle2 size={14} className="shrink-0" /> {test.message}
            </span>
          )}
          {test.state === 'error' && (
            <span className="flex min-w-0 items-center gap-1 text-[12px] text-danger" title={test.message}>
              <XCircle size={14} className="shrink-0" /> <span className="line-clamp-2">{test.message}</span>
            </span>
          )}
          <div className="flex-1" />
          <Button onClick={() => void submit(false)} disabled={busy}>
            {t('Save')}
          </Button>
          <Button variant="primary" onClick={() => void submit(true)} loading={busy}>
            {t('Save & connect')}
          </Button>
        </>
      }
    >
      {existing?.managed && (
        <div className="flex items-center gap-2 border-b border-line bg-accent-soft px-4 py-2 text-[12px]">
          <Building2 size={13} className="shrink-0 text-accent" />
          {t('Managed by your organization: server settings come from the managed configuration and changes to them are reset. Fill in your own user name and password.')}
        </div>
      )}
      <div className="flex min-h-[440px]">
        {/* Driver picker */}
        <div className="flex w-[170px] shrink-0 flex-col gap-0.5 border-r border-line bg-subtle p-2">
          {DRIVERS.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => changeDriver(d.id)}
              className={cn(
                'flex h-9 items-center gap-2.5 rounded-md px-2 text-left text-[13px]',
                config.driver === d.id ? 'bg-elevated font-medium shadow-sm' : 'text-fg-muted hover:bg-hover hover:text-fg',
              )}
            >
              <DriverIcon driver={d.id} size={18} />
              {d.label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          {!isFile && (
            <div className="flex gap-1 border-b border-line px-4 pt-3">
              {((isBigQuery ? ['general', 'advanced'] : ['general', 'ssl', 'ssh', 'advanced']) as Section[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSection(s)}
                  className={cn(
                    '-mb-px border-b-2 px-2.5 pb-2 text-[12.5px] font-medium',
                    section === s ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                >
                  {{ general: t('General'), ssl: 'SSL / TLS', ssh: t('SSH tunnel'), advanced: t('Advanced') }[s]}
                  {s === 'ssh' && ssh.enabled && <span className="ml-1 text-accent">●</span>}
                  {s === 'ssl' && ssl.mode !== 'disable' && <span className="ml-1 text-accent">●</span>}
                </button>
              ))}
            </div>
          )}

          <form
            className="flex flex-col gap-3 overflow-auto p-4"
            onSubmit={(e) => {
              e.preventDefault()
              void submit(true)
            }}
          >
            {(section === 'general' || isFile) && (
              <>
                {!isFile && !isBigQuery && (
                  <div className="flex gap-2">
                    <Input
                      className="flex-1 font-mono text-[12px]"
                      placeholder={t('Paste a connection URL (postgres://…, JDBC, ADO.NET)')}
                      value={urlText}
                      onChange={(e) => setUrlText(e.target.value)}
                      onPaste={(e) => {
                        const text = e.clipboardData.getData('text')
                        if (/^\w[\w+.-]*:\/\/|^jdbc:|=.*;/i.test(text)) {
                          e.preventDefault()
                          void applyUrl(text)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void applyUrl(urlText)
                        }
                      }}
                      leading={<ClipboardPaste size={13} />}
                    />
                  </div>
                )}
                <Field label={t('Name')}>
                  <Input value={config.name} placeholder={isFile ? 'my-app.db' : t('Production CRM')} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                {isFile ? (
                  <Field label={t('Database file')}>
                    <div className="flex gap-2">
                      <Input
                        className="flex-1 font-mono text-[12px]"
                        value={config.filePath ?? ''}
                        onChange={(e) => set({ filePath: e.target.value })}
                        placeholder={isDuck ? t('Empty: in-memory database for querying files') : '/path/to/database.db'}
                      />
                      <Button
                        icon={<FolderOpen size={14} />}
                        onClick={() =>
                          void pickFile(isDuck ? t('Choose DuckDB database') : t('Choose SQLite database'), (p) => set({ filePath: p, name: config.name || p.split(/[\\/]/).pop() || '' }), [
                            isDuck ? { name: 'DuckDB', extensions: ['duckdb', 'ddb', 'db'] } : { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'] },
                            { name: t('All files'), extensions: ['*'] },
                          ])
                        }
                      >
                        {t('Browse')}
                      </Button>
                    </div>
                  </Field>
                ) : isBigQuery ? (
                  <>
                    <div className="flex gap-2">
                      <Field label={t('Project ID')} className="flex-1">
                        <Input value={config.database ?? ''} onChange={(e) => set({ database: e.target.value.trim() })} placeholder="my-project-123" />
                      </Field>
                      <Field label={t('Location (optional)')} className="w-36">
                        <Input value={String(config.options?.location ?? '')} onChange={(e) => setOption('location', e.target.value || undefined)} placeholder="EU" />
                      </Field>
                    </div>
                    <Field
                      label={t('Service account key (JSON)')}
                      hint={t('Stored encrypted on this computer. Leave empty to use your gcloud sign-in (gcloud auth application-default login).')}
                    >
                      <Textarea
                        rows={4}
                        className="font-mono text-[11.5px]"
                        value={config.password ?? ''}
                        onChange={(e) => set({ password: e.target.value })}
                        placeholder='{ "type": "service_account", "project_id": … }'
                        spellCheck={false}
                      />
                      <div className="mt-1.5">
                        <Button
                          size="sm"
                          icon={<FolderOpen size={14} />}
                          onClick={() =>
                            void pickFile(
                              t('Choose service account key'),
                              async (p) => {
                                const key = await api.readTextFile(p)
                                let project = ''
                                try {
                                  project = String((JSON.parse(key) as { project_id?: string }).project_id ?? '')
                                } catch {
                                  // Not JSON: connecting reports it.
                                }
                                set({ password: key, database: config.database || project || undefined })
                              },
                              [{ name: 'JSON', extensions: ['json'] }],
                            )
                          }
                        >
                          {t('Load key file…')}
                        </Button>
                      </div>
                    </Field>
                  </>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <Field label={t('Host')} className="flex-1">
                        <Input value={config.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
                      </Field>
                      <Field label={t('Port')} className="w-24">
                        <Input
                          value={config.port ?? ''}
                          inputMode="numeric"
                          onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined })}
                          placeholder={String(DEFAULT_PORTS[config.driver] ?? '')}
                        />
                      </Field>
                    </div>
                    {config.driver === 'mssql' && (
                      <Field label={t('Authentication')}>
                        <Segmented
                          value={windowsAuth ? 'windows' : 'sql'}
                          onChange={(v) => setOption('authentication', v === 'windows' ? 'windows' : undefined)}
                          options={[
                            { value: 'sql', label: t('SQL Server login') },
                            { value: 'windows', label: t('Windows authentication') },
                          ]}
                        />
                      </Field>
                    )}
                    {windowsAuth ? (
                      <div className={cn('rounded-md px-2.5 py-2 text-[12px]', isWindows ? 'bg-subtle text-fg-muted' : 'bg-warning-soft text-warning')}>
                        {isWindows
                          ? t('Signs in as your Windows account, no password needed. Requires the Microsoft ODBC Driver 17 or 18 for SQL Server (installed with SSMS).')
                          : t('Windows authentication works only when DB Mastermind runs on Windows.')}
                      </div>
                    ) : (
                      <div className="flex gap-2">
                        <Field label={t('User')} className="flex-1">
                          <Input value={config.user ?? ''} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                        </Field>
                        <Field label={t('Password')} className="flex-1">
                          <Input type="password" value={config.password ?? ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
                        </Field>
                      </div>
                    )}
                    <Field
                      label={config.driver === 'trino' ? t('Catalog') : t('Database')}
                      hint={config.driver === 'postgres' ? t('Defaults to "postgres"') : config.driver === 'trino' ? t('Its schemas appear in the explorer, e.g. hive or iceberg') : undefined}
                    >
                      <Input value={config.database ?? ''} onChange={(e) => set({ database: e.target.value })} placeholder={config.driver === 'trino' ? 'hive' : undefined} />
                    </Field>
                    {config.driver === 'mssql' && (
                      <div className="flex gap-2">
                        <Field label={t('Instance name (optional)')} className="flex-1">
                          <Input value={String(config.options?.instanceName ?? '')} onChange={(e) => setOption('instanceName', e.target.value || undefined)} placeholder="SQLEXPRESS" />
                        </Field>
                        {!windowsAuth && (
                          <Field label={t('Windows domain (NTLM, optional)')} className="flex-1">
                            <Input value={String(config.options?.domain ?? '')} onChange={(e) => setOption('domain', e.target.value || undefined)} placeholder="CORP" />
                          </Field>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div className="mt-1 flex items-end gap-4">
                  <Field label={t('Environment')}>
                    <Segmented<Environment | 'none'>
                      value={config.environment ?? 'none'}
                      onChange={(v) => set({ environment: v === 'none' ? undefined : v })}
                      options={[
                        { value: 'none', label: '—' },
                        { value: 'development', label: t('Dev') },
                        { value: 'test', label: t('Test') },
                        { value: 'staging', label: t('Staging') },
                        { value: 'production', label: t('Prod') },
                      ]}
                    />
                  </Field>
                  <Field label={t('Color')}>
                    <div className="flex h-7 items-center gap-1.5">
                      {CONNECTION_COLORS.map((color, i) => (
                        <button
                          key={color}
                          type="button"
                          title={t(COLOR_NAMES[i] ?? 'Color')}
                          aria-label={t(COLOR_NAMES[i] ?? 'Color')}
                          aria-pressed={config.color === color}
                          onClick={() => set({ color: config.color === color ? undefined : color })}
                          className={cn('h-4.5 w-4.5 rounded-full ring-offset-2 ring-offset-elevated', config.color === color && 'ring-2 ring-fg-muted')}
                          style={{ background: color, width: 18, height: 18 }}
                        />
                      ))}
                    </div>
                  </Field>
                </div>
                <div className="flex flex-col gap-2 pt-1">
                  <Checkbox
                    checked={!!config.readOnly}
                    onChange={(readOnly) => set({ readOnly })}
                    label={t('Read-only')}
                    hint={t('Only SELECT-like statements are allowed. Enforced by the database where supported.')}
                  />
                  {config.environment === 'production' && !config.readOnly && (
                    <div className="rounded-md bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">
                      {t('Production connections always ask before running DELETE / UPDATE without WHERE, DROP or TRUNCATE.')}
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'ssl' && !isFile && (
              <>
                <Field label={t('SSL mode')}>
                  <Select value={ssl.mode} onChange={(e) => set({ ssl: { ...ssl, mode: e.target.value as SslMode } })}>
                    <option value="disable">{t('Disable')}</option>
                    <option value="prefer">{t("Prefer (encrypt, don't verify)")}</option>
                    <option value="require">{t("Require (encrypt, don't verify)")}</option>
                    <option value="verify-ca">{t('Verify CA')}</option>
                    <option value="verify-full">{t('Verify full (CA + hostname)')}</option>
                  </Select>
                </Field>
                {(['ca', 'cert', 'key'] as const).map((key) => (
                  <Field key={key} label={{ ca: t('CA certificate'), cert: t('Client certificate'), key: t('Client key') }[key]}>
                    <div className="flex gap-2">
                      <Textarea
                        className="h-16 flex-1 font-mono text-[11px]"
                        placeholder="-----BEGIN …-----"
                        value={ssl[key] ?? ''}
                        onChange={(e) => set({ ssl: { ...ssl, [key]: e.target.value || undefined } })}
                      />
                      <Button icon={<FolderOpen size={14} />} onClick={() => void pickPem(t('Choose file'), (pem) => set({ ssl: { ...ssl, [key]: pem } }))}>
                        {t('Load')}
                      </Button>
                    </div>
                  </Field>
                ))}
                {config.driver === 'mssql' && (
                  <Checkbox
                    checked={config.options?.trustServerCertificate !== false && ssl.mode !== 'verify-ca' && ssl.mode !== 'verify-full'}
                    onChange={(v) => setOption('trustServerCertificate', v)}
                    label={t('Trust server certificate')}
                    hint={t('Needed for most on-premise SQL Servers with self-signed certificates.')}
                  />
                )}
              </>
            )}

            {section === 'ssh' && !isFile && (
              <>
                <Checkbox checked={ssh.enabled} onChange={(enabled) => set({ ssh: { ...ssh, enabled } })} label={t('Connect through an SSH tunnel')} />
                <fieldset disabled={!ssh.enabled} className={cn('flex flex-col gap-3', !ssh.enabled && 'opacity-50')}>
                  <div className="flex gap-2">
                    <Field label={t('SSH host')} className="flex-1">
                      <Input value={ssh.host} onChange={(e) => set({ ssh: { ...ssh, host: e.target.value } })} placeholder="bastion.example.com" />
                    </Field>
                    <Field label={t('Port')} className="w-24">
                      <Input value={ssh.port ?? 22} onChange={(e) => set({ ssh: { ...ssh, port: Number(e.target.value.replace(/\D/g, '')) || 22 } })} />
                    </Field>
                  </div>
                  <Field label={t('SSH user')}>
                    <Input value={ssh.user} onChange={(e) => set({ ssh: { ...ssh, user: e.target.value } })} />
                  </Field>
                  <Field label={t('Authentication')}>
                    <Segmented
                      value={ssh.authMethod}
                      onChange={(authMethod) => set({ ssh: { ...ssh, authMethod } })}
                      options={[
                        { value: 'privateKey', label: t('Private key') },
                        { value: 'password', label: t('Password') },
                        { value: 'agent', label: t('SSH agent') },
                      ]}
                    />
                  </Field>
                  {ssh.authMethod === 'password' && (
                    <Field label={t('SSH password')}>
                      <Input type="password" value={ssh.password ?? ''} onChange={(e) => set({ ssh: { ...ssh, password: e.target.value } })} />
                    </Field>
                  )}
                  {ssh.authMethod === 'privateKey' && (
                    <>
                      <Field label={t('Private key')}>
                        <div className="flex gap-2">
                          <Textarea
                            className="h-20 flex-1 font-mono text-[11px]"
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            value={ssh.privateKey ?? ''}
                            onChange={(e) => set({ ssh: { ...ssh, privateKey: e.target.value } })}
                          />
                          <Button icon={<FolderOpen size={14} />} onClick={() => void pickFile(t('Choose private key'), async (p) => set({ ssh: { ...ssh, privateKey: await api.readTextFile(p) } }))}>
                            {t('Load')}
                          </Button>
                        </div>
                      </Field>
                      <Field label={t('Passphrase (optional)')}>
                        <Input type="password" value={ssh.passphrase ?? ''} onChange={(e) => set({ ssh: { ...ssh, passphrase: e.target.value } })} />
                      </Field>
                    </>
                  )}
                  {ssh.host.trim() && <SshHostKey host={ssh.host.trim()} port={ssh.port} />}
                </fieldset>
              </>
            )}

            {section === 'advanced' && !isFile && (
              <>
                {isBigQuery && (
                  <Field label={t('API endpoint (optional)')} hint={t('Only for emulators or private endpoints, e.g. http://localhost:9050')}>
                    <Input value={config.host ?? ''} onChange={(e) => set({ host: e.target.value.trim() || undefined })} placeholder="https://bigquery.googleapis.com" />
                  </Field>
                )}
                {config.driver === 'mssql' && (
                  <Field label={t('Query timeout (seconds, 0 = none)')}>
                    <Input
                      value={Number(config.options?.requestTimeout ?? 0) / 1000}
                      onChange={(e) => setOption('requestTimeout', String(Number(e.target.value.replace(/\D/g, '') || 0) * 1000))}
                    />
                  </Field>
                )}
                {/* Outside the Field's <label>: a click on the label text must not open the Change… menu. */}
                {existing && kbLocation && (
                  <div className="flex flex-col gap-1">
                    <span className="text-[12px] font-medium text-fg-muted">{t('Knowledge base')}</span>
                    <KnowledgeLocationBar
                      compact
                      connection={existing}
                      location={kbLocation}
                      // The change is already saved; keep the form's copy in step so Save doesn't undo it.
                      onChanged={(l) => set({ knowledgeBasePath: l.path, knowledgeBaseLocal: l.personal || undefined } as Partial<ConnectionConfig>)}
                    />
                  </div>
                )}
                <Field label={t('Knowledge base folder')} hint={t('Markdown notes about this database, used by the AI assistant. Optional.')}>
                  <div className="flex gap-2">
                    <Input className="flex-1 font-mono text-[12px]" value={config.knowledgeBasePath ?? ''}
                      // A team connection pointed elsewhere by hand is this user's own (the team's path would win otherwise).
                      onChange={(e) => set({ knowledgeBasePath: e.target.value || undefined, ...(existing?.team ? { knowledgeBaseLocal: true } : {}) } as Partial<ConnectionConfig>)}
                    />
                    <Button icon={<FolderOpen size={14} />} onClick={() => void api.pickDirectory(t('Knowledge base folder')).then((p) => p && set({ knowledgeBasePath: p }))}>
                      {t('Browse')}
                    </Button>
                  </div>
                </Field>
                <Field label={t('AI permissions')} hint={config.ai ? undefined : t('Uses the default from Settings → AI permissions.')}>
                  <AiPermissionControls
                    value={config.ai ?? (config.aiEnabled === false ? { ...aiDefaultsOf(settings!), access: 'off' } : aiDefaultsOf(settings!))}
                    readOnlyConnection={config.readOnly}
                    lockedOff={!!existing?.aiLockedOff}
                    onChange={(ai) => set({ ai, aiEnabled: undefined })}
                  />
                </Field>
                <Field label={t('Group')}>
                  <Input value={config.group ?? ''} onChange={(e) => set({ group: e.target.value || undefined })} placeholder={t('e.g. Customer A')} />
                </Field>
              </>
            )}
            <button type="submit" hidden />
          </form>
        </div>
      </div>
    </Modal>
  )
}
