import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, forgetHostKey, trustedHostKey, useKnownHostsFile, type ConnectionConfig } from '../src/index.js'
import { skip } from './fixtures.js'

/**
 * PostgreSQL through a real SSH server (the `ssh` service in docker-compose.test.yml, container `dbm-ssh`, on the
 * same network as `postgres`). Restarting the SSH server must neither crash the process nor leave the tunnel dead.
 * DBM_SSH_KEY points to a private key whose public half the server accepts (CI generates one).
 */

const container = process.env.DBM_SSH_CONTAINER ?? 'dbm-ssh'
const keyFile = process.env.DBM_SSH_KEY
const base = { name: 'pg', driver: 'postgres' as const, host: 'postgres', port: 5432, user: 'postgres', password: 'mastermind', database: 'mastermind' }
const ssh = { enabled: true, host: '127.0.0.1', port: 2222, user: 'dbm' }

const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'dbm-hosts-')), 'known-hosts.json')
useKnownHostsFile(knownHostsFile)

const crashes: unknown[] = []
const onCrash = (err: unknown) => crashes.push(err)
process.on('uncaughtException', onCrash)
const svc = new DatabaseService()
afterAll(async () => {
  await svc.disconnectAll()
  process.off('uncaughtException', onCrash)
})

const value = async (id: string, session?: string) => {
  const [o] = await svc.runScript(id, 'SELECT 1 AS n', { session })
  return o!.error?.message ?? String(o!.results![0]!.rows[0]![0])
}

describe.skipIf(skip.has('ssh'))('ssh tunnel', () => {
  it('connects with a password and with a key, and rejects a wrong password clearly', async () => {
    await svc.connect({ ...base, id: 'ssh-pw', ssh: { ...ssh, authMethod: 'password', password: 'sshsecret' } } as ConnectionConfig)
    expect(await value('ssh-pw')).toBe('1')
    if (keyFile && existsSync(keyFile)) {
      await svc.connect({ ...base, id: 'ssh-key', ssh: { ...ssh, authMethod: 'privateKey', privateKey: readFileSync(keyFile, 'utf8') } } as ConnectionConfig)
      expect(await value('ssh-key')).toBe('1')
    }
    await expect(svc.connect({ ...base, id: 'ssh-bad', ssh: { ...ssh, authMethod: 'password', password: 'wrong' } } as ConnectionConfig)).rejects.toThrow(/authentication/i)
  })

  it("remembers the server's host key and refuses a different one", async () => {
    const trusted = trustedHostKey('127.0.0.1', 2222)
    expect(trusted).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    // It is one of the keys the server really has.
    const real = execSync(`docker exec ${container} sh -c 'for f in /config/ssh_host_keys/*.pub; do ssh-keygen -lf $f; done'`).toString()
    expect(real).toContain(trusted!)
    // A server in the middle presents another key.
    writeFileSync(knownHostsFile, JSON.stringify({ '[127.0.0.1]:2222': 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }))
    const mitm = { ...base, id: 'ssh-mitm', ssh: { ...ssh, authMethod: 'password', password: 'sshsecret' } } as ConnectionConfig
    await expect(svc.connect(mitm)).rejects.toThrow(/different host key/)
    forgetHostKey('127.0.0.1', 2222)
    await svc.connect(mitm)
    expect(await value('ssh-mitm')).toBe('1')
    expect(trustedHostKey('127.0.0.1', 2222)).toBe(trusted)
  })

  it('reconnects after the SSH server restarts, without crashing', async () => {
    expect(await value('ssh-pw', 'tab')).toBe('1')
    execSync(`docker restart ${container}`)
    for (let i = 0; i < 30; i++) {
      try {
        execSync(`docker exec ${container} sh -c "nc -z 127.0.0.1 2222"`, { stdio: 'ignore' })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
    await new Promise((r) => setTimeout(r, 2000))
    expect(await value('ssh-pw')).toBe('1')
    expect(await value('ssh-pw', 'tab')).toBe('1')
    expect(crashes).toEqual([])
  }, 90_000)
})
