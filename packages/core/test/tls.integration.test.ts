import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService, type ConnectionConfig } from '../src/index.js'
import { skip } from './fixtures.js'

/**
 * TLS modes against servers with certificates from a test CA (DBM_TLS_DIR: ca.crt, other.crt; the server certificate
 * names pg-tls, my-tls and localhost). Containers `pg-tls` (:54330) and `my-tls` (:33071) run on the same network as
 * the `ssh` service, so verify-full is also checked through a tunnel. The plain test PostgreSQL (:54329) has no TLS.
 */

const dir = process.env.DBM_TLS_DIR
const ready = !!dir && existsSync(join(dir, 'ca.crt')) && !skip.has('tls')
const ca = ready ? readFileSync(join(dir!, 'ca.crt'), 'utf8') : ''
const other = ready ? readFileSync(join(dir!, 'other.crt'), 'utf8') : ''
const ssh = { enabled: true, host: '127.0.0.1', port: 2222, user: 'dbm', authMethod: 'password' as const, password: 'sshsecret' }

const pg = { driver: 'postgres' as const, host: 'localhost', port: 54330, user: 'postgres', password: 'mastermind', database: 'postgres' }
const pgPlain = { driver: 'postgres' as const, host: 'localhost', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind' }
const my = { driver: 'mysql' as const, host: 'localhost', port: 33071, user: 'root', password: 'mastermind' }
const encrypted: Record<string, string> = {
  postgres: "SELECT CASE WHEN ssl THEN 'tls' ELSE 'plain' END FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
  mysql: "SELECT IF(VARIABLE_VALUE <> '', 'tls', 'plain') FROM performance_schema.session_status WHERE VARIABLE_NAME = 'Ssl_cipher'",
}

let svc = new DatabaseService()
afterEach(async () => {
  await svc.disconnectAll()
  svc = new DatabaseService()
})

let n = 0
/** 'tls' / 'plain' for the connection's transport, or the connect error message. */
async function transport(config: Omit<ConnectionConfig, 'id' | 'name'>): Promise<string> {
  const id = `tls-${n++}`
  try {
    await svc.connect({ id, name: id, ...config } as ConnectionConfig)
  } catch (err) {
    return `error: ${(err as Error).message}`
  }
  const [o] = await svc.runScript(id, encrypted[config.driver]!)
  return o!.error ? `error: ${o!.error.message}` : String(o!.results![0]!.rows[0]![0])
}

describe.skipIf(!ready)('TLS', () => {
  it('PostgreSQL: prefer falls back to plain, require and verification refuse what they should', async () => {
    expect(await transport({ ...pg, ssl: { mode: 'prefer' } })).toBe('tls')
    expect(await transport({ ...pgPlain, ssl: { mode: 'prefer' } })).toBe('plain')
    expect(await transport({ ...pgPlain, ssl: { mode: 'require' } })).toMatch(/does not support SSL/)
    expect(await transport({ ...pg, ssl: { mode: 'verify-ca', ca } })).toBe('tls')
    expect(await transport({ ...pg, ssl: { mode: 'verify-ca', ca: other } })).toMatch(/^error: .*certificate/)
    expect(await transport({ ...pg, ssl: { mode: 'verify-full', ca } })).toBe('tls')
    expect(await transport({ ...pg, host: '127.0.0.1', ssl: { mode: 'verify-full', ca } })).toMatch(/does not match/)
  })

  it('PostgreSQL: verify-full checks the real host name through an SSH tunnel', async () => {
    expect(await transport({ ...pg, host: 'pg-tls', port: 5432, ssh, ssl: { mode: 'verify-full', ca } })).toBe('tls')
  })

  it('MySQL: verify-full checks the host name, also for IP addresses and through an SSH tunnel', async () => {
    expect(await transport({ ...my, ssl: { mode: 'disable' } })).toBe('plain')
    expect(await transport({ ...my, ssl: { mode: 'require' } })).toBe('tls')
    expect(await transport({ ...my, ssl: { mode: 'verify-ca', ca } })).toBe('tls')
    expect(await transport({ ...my, ssl: { mode: 'verify-ca', ca: other } })).toMatch(/^error: .*certificate/)
    expect(await transport({ ...my, ssl: { mode: 'verify-full', ca } })).toBe('tls')
    expect(await transport({ ...my, host: '127.0.0.1', ssl: { mode: 'verify-full', ca } })).toMatch(/does not match/)
    expect(await transport({ ...my, host: 'my-tls', port: 3306, ssh, ssl: { mode: 'verify-full', ca } })).toBe('tls')
  })
})
