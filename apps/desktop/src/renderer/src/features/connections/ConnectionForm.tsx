import { useEffect, useState } from 'react'
import { CheckCircle2, ClipboardPaste, FolderOpen, XCircle } from 'lucide-react'
import type { ConnectionConfig, DriverId, Environment, SslMode } from '@dbmastermind/core/browser'
import { Button } from '@/components/ui/Button'
import { Checkbox, Field, Input, Segmented, Select, Textarea } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { api } from '@/lib/api'
import { cn, errorMessage } from '@/lib/utils'
import { useConnections } from '@/store/connections'
import { toast, useUi } from '@/store/ui'
import { DriverIcon, DRIVERS } from './drivers'

export const CONNECTION_COLORS = ['#6d4aff', '#0b72d9', '#0f9f6e', '#d97706', '#dc2626', '#db2777', '#64748b']

const DEFAULT_PORTS: Partial<Record<DriverId, number>> = { postgres: 5432, mysql: 3306, mariadb: 3306, mssql: 1433 }

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
  const save = useConnections((s) => s.save)
  const connect = useConnections((s) => s.connect)
  const [config, setConfig] = useState<ConnectionConfig>(blank())
  const [section, setSection] = useState<Section>('general')
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; message?: string }>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [urlText, setUrlText] = useState('')

  useEffect(() => {
    if (!open) return
    setConfig(existing ? structuredClone(existing) : { ...blank(), ...(modal.draft as Partial<ConnectionConfig>) })
    setSection('general')
    setTest({ state: 'idle' })
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
      toast({ kind: 'success', message: 'Connection details filled in from the URL' })
    } catch (err) {
      toast({ kind: 'error', message: 'Could not parse connection string', detail: errorMessage(err) })
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
      close()
      if (andConnect) {
        const ok = await connect(saved.id)
        if (ok) useUi.getState().set({ selectedConnectionId: saved.id })
        else toast({ kind: 'error', message: `Could not connect to ${saved.name}`, detail: useConnections.getState().runtime[saved.id]?.error })
      }
    } catch (err) {
      toast({ kind: 'error', message: 'Could not save connection', detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const isSqlite = config.driver === 'sqlite'
  const ssl = config.ssl ?? { mode: (config.driver === 'mssql' ? 'prefer' : 'disable') as SslMode }
  const ssh = config.ssh ?? { enabled: false, host: '', port: 22, user: '', authMethod: 'privateKey' as const }

  const pickFile = async (title: string, onPick: (path: string) => void, filters?: { name: string; extensions: string[] }[]) => {
    const path = await api.pickFile({ title, filters })
    if (path) onPick(path)
  }

  const pickPem = (title: string, onPick: (pem: string) => void) =>
    pickFile(title, async (path) => onPick(await api.readTextFile(path)), [{ name: 'Certificates & keys', extensions: ['pem', 'crt', 'cer', 'key', 'ca'] }])

  return (
    <Modal
      open={open}
      onClose={close}
      title={existing ? `Edit ${existing.name}` : 'New connection'}
      width={680}
      bodyClassName="p-0"
      footer={
        <>
          <Button onClick={() => void runTest()} loading={test.state === 'running'}>
            Test connection
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
            Save
          </Button>
          <Button variant="primary" onClick={() => void submit(true)} loading={busy}>
            Save & connect
          </Button>
        </>
      }
    >
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
          {!isSqlite && (
            <div className="flex gap-1 border-b border-line px-4 pt-3">
              {(['general', 'ssl', 'ssh', 'advanced'] as Section[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSection(s)}
                  className={cn(
                    '-mb-px border-b-2 px-2.5 pb-2 text-[12.5px] font-medium',
                    section === s ? 'border-accent text-fg' : 'border-transparent text-fg-muted hover:text-fg',
                  )}
                >
                  {{ general: 'General', ssl: 'SSL / TLS', ssh: 'SSH tunnel', advanced: 'Advanced' }[s]}
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
            {(section === 'general' || isSqlite) && (
              <>
                {!isSqlite && (
                  <div className="flex gap-2">
                    <Input
                      className="flex-1 font-mono text-[12px]"
                      placeholder="Paste a URL: postgres://user:pass@host:5432/db, JDBC or ADO.NET string"
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
                <Field label="Name">
                  <Input value={config.name} placeholder={isSqlite ? 'my-app.db' : 'Production CRM'} onChange={(e) => set({ name: e.target.value })} />
                </Field>
                {isSqlite ? (
                  <Field label="Database file">
                    <div className="flex gap-2">
                      <Input className="flex-1 font-mono text-[12px]" value={config.filePath ?? ''} onChange={(e) => set({ filePath: e.target.value })} placeholder="/path/to/database.db" />
                      <Button
                        icon={<FolderOpen size={14} />}
                        onClick={() =>
                          void pickFile('Choose SQLite database', (p) => set({ filePath: p, name: config.name || p.split(/[\\/]/).pop() || '' }), [
                            { name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3', 'db3', 's3db'] },
                            { name: 'All files', extensions: ['*'] },
                          ])
                        }
                      >
                        Browse
                      </Button>
                    </div>
                  </Field>
                ) : (
                  <>
                    <div className="flex gap-2">
                      <Field label="Host" className="flex-1">
                        <Input value={config.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="localhost" />
                      </Field>
                      <Field label="Port" className="w-24">
                        <Input
                          value={config.port ?? ''}
                          inputMode="numeric"
                          onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, '')) : undefined })}
                          placeholder={String(DEFAULT_PORTS[config.driver] ?? '')}
                        />
                      </Field>
                    </div>
                    <div className="flex gap-2">
                      <Field label="User" className="flex-1">
                        <Input value={config.user ?? ''} onChange={(e) => set({ user: e.target.value })} autoComplete="off" />
                      </Field>
                      <Field label="Password" className="flex-1">
                        <Input type="password" value={config.password ?? ''} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
                      </Field>
                    </div>
                    <Field label="Database" hint={config.driver === 'postgres' ? 'Defaults to "postgres"' : undefined}>
                      <Input value={config.database ?? ''} onChange={(e) => set({ database: e.target.value })} />
                    </Field>
                    {config.driver === 'mssql' && (
                      <div className="flex gap-2">
                        <Field label="Instance name (optional)" className="flex-1">
                          <Input value={String(config.options?.instanceName ?? '')} onChange={(e) => setOption('instanceName', e.target.value || undefined)} placeholder="SQLEXPRESS" />
                        </Field>
                        <Field label="Windows domain (NTLM, optional)" className="flex-1">
                          <Input value={String(config.options?.domain ?? '')} onChange={(e) => setOption('domain', e.target.value || undefined)} placeholder="CORP" />
                        </Field>
                      </div>
                    )}
                  </>
                )}
                <div className="mt-1 flex items-end gap-4">
                  <Field label="Environment">
                    <Segmented<Environment | 'none'>
                      value={config.environment ?? 'none'}
                      onChange={(v) => set({ environment: v === 'none' ? undefined : v })}
                      options={[
                        { value: 'none', label: '—' },
                        { value: 'development', label: 'Dev' },
                        { value: 'test', label: 'Test' },
                        { value: 'staging', label: 'Staging' },
                        { value: 'production', label: 'Prod' },
                      ]}
                    />
                  </Field>
                  <Field label="Color">
                    <div className="flex h-7 items-center gap-1.5">
                      {CONNECTION_COLORS.map((color) => (
                        <button
                          key={color}
                          type="button"
                          title={color}
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
                    label="Read-only"
                    hint="Only SELECT-like statements are allowed. Enforced by the database where supported."
                  />
                  {config.environment === 'production' && !config.readOnly && (
                    <div className="rounded-md bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">
                      Production connections always ask before running DELETE / UPDATE without WHERE, DROP or TRUNCATE.
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'ssl' && !isSqlite && (
              <>
                <Field label="SSL mode">
                  <Select value={ssl.mode} onChange={(e) => set({ ssl: { ...ssl, mode: e.target.value as SslMode } })}>
                    <option value="disable">Disable</option>
                    <option value="prefer">Prefer (encrypt, don't verify)</option>
                    <option value="require">Require (encrypt, don't verify)</option>
                    <option value="verify-ca">Verify CA</option>
                    <option value="verify-full">Verify full (CA + hostname)</option>
                  </Select>
                </Field>
                {(['ca', 'cert', 'key'] as const).map((key) => (
                  <Field key={key} label={{ ca: 'CA certificate', cert: 'Client certificate', key: 'Client key' }[key]}>
                    <div className="flex gap-2">
                      <Textarea
                        className="h-16 flex-1 font-mono text-[11px]"
                        placeholder="-----BEGIN …-----"
                        value={ssl[key] ?? ''}
                        onChange={(e) => set({ ssl: { ...ssl, [key]: e.target.value || undefined } })}
                      />
                      <Button icon={<FolderOpen size={14} />} onClick={() => void pickPem('Choose file', (pem) => set({ ssl: { ...ssl, [key]: pem } }))}>
                        Load
                      </Button>
                    </div>
                  </Field>
                ))}
                {config.driver === 'mssql' && (
                  <Checkbox
                    checked={config.options?.trustServerCertificate !== false && ssl.mode !== 'verify-ca' && ssl.mode !== 'verify-full'}
                    onChange={(v) => setOption('trustServerCertificate', v)}
                    label="Trust server certificate"
                    hint="Needed for most on-premise SQL Servers with self-signed certificates."
                  />
                )}
              </>
            )}

            {section === 'ssh' && !isSqlite && (
              <>
                <Checkbox checked={ssh.enabled} onChange={(enabled) => set({ ssh: { ...ssh, enabled } })} label="Connect through an SSH tunnel" />
                <fieldset disabled={!ssh.enabled} className={cn('flex flex-col gap-3', !ssh.enabled && 'opacity-50')}>
                  <div className="flex gap-2">
                    <Field label="SSH host" className="flex-1">
                      <Input value={ssh.host} onChange={(e) => set({ ssh: { ...ssh, host: e.target.value } })} placeholder="bastion.example.com" />
                    </Field>
                    <Field label="Port" className="w-24">
                      <Input value={ssh.port ?? 22} onChange={(e) => set({ ssh: { ...ssh, port: Number(e.target.value.replace(/\D/g, '')) || 22 } })} />
                    </Field>
                  </div>
                  <Field label="SSH user">
                    <Input value={ssh.user} onChange={(e) => set({ ssh: { ...ssh, user: e.target.value } })} />
                  </Field>
                  <Field label="Authentication">
                    <Segmented
                      value={ssh.authMethod}
                      onChange={(authMethod) => set({ ssh: { ...ssh, authMethod } })}
                      options={[
                        { value: 'privateKey', label: 'Private key' },
                        { value: 'password', label: 'Password' },
                        { value: 'agent', label: 'SSH agent' },
                      ]}
                    />
                  </Field>
                  {ssh.authMethod === 'password' && (
                    <Field label="SSH password">
                      <Input type="password" value={ssh.password ?? ''} onChange={(e) => set({ ssh: { ...ssh, password: e.target.value } })} />
                    </Field>
                  )}
                  {ssh.authMethod === 'privateKey' && (
                    <>
                      <Field label="Private key">
                        <div className="flex gap-2">
                          <Textarea
                            className="h-20 flex-1 font-mono text-[11px]"
                            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                            value={ssh.privateKey ?? ''}
                            onChange={(e) => set({ ssh: { ...ssh, privateKey: e.target.value } })}
                          />
                          <Button icon={<FolderOpen size={14} />} onClick={() => void pickFile('Choose private key', async (p) => set({ ssh: { ...ssh, privateKey: await api.readTextFile(p) } }))}>
                            Load
                          </Button>
                        </div>
                      </Field>
                      <Field label="Passphrase (optional)">
                        <Input type="password" value={ssh.passphrase ?? ''} onChange={(e) => set({ ssh: { ...ssh, passphrase: e.target.value } })} />
                      </Field>
                    </>
                  )}
                </fieldset>
              </>
            )}

            {section === 'advanced' && !isSqlite && (
              <>
                {config.driver === 'mssql' && (
                  <Field label="Query timeout (seconds, 0 = none)">
                    <Input
                      value={Number(config.options?.requestTimeout ?? 0) / 1000}
                      onChange={(e) => setOption('requestTimeout', String(Number(e.target.value.replace(/\D/g, '') || 0) * 1000))}
                    />
                  </Field>
                )}
                <Field label="Knowledge base folder" hint="Markdown notes about this database, used by the AI assistant. Optional.">
                  <div className="flex gap-2">
                    <Input className="flex-1 font-mono text-[12px]" value={config.knowledgeBasePath ?? ''} onChange={(e) => set({ knowledgeBasePath: e.target.value || undefined })} />
                    <Button icon={<FolderOpen size={14} />} onClick={() => void api.pickDirectory('Knowledge base folder').then((p) => p && set({ knowledgeBasePath: p }))}>
                      Browse
                    </Button>
                  </div>
                </Field>
                <Checkbox
                  checked={config.aiEnabled !== false}
                  onChange={(aiEnabled) => set({ aiEnabled })}
                  label="Allow AI features for this connection"
                  hint="When off, the assistant and MCP server can't see this connection."
                />
                <Field label="Group">
                  <Input value={config.group ?? ''} onChange={(e) => set({ group: e.target.value || undefined })} placeholder="e.g. Customer A" />
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
