import { createServer, type AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { isUnreachableError, type ConnectionConfig } from '@dbmastermind/core'
import { assertReachable, firstHop, singleFlight } from '../src/main/connect-guard'

const base: ConnectionConfig = { id: 'c', name: 'c', driver: 'postgres', host: '127.0.0.1' }

describe('the quiet retry checks the server before a password command runs', () => {
  it('knows the first hop: the server, its default port, or the SSH server', () => {
    expect(firstHop(base)).toEqual({ host: '127.0.0.1', port: 5432 })
    expect(firstHop({ ...base, port: 6000 })).toEqual({ host: '127.0.0.1', port: 6000 })
    expect(firstHop({ ...base, ssh: { enabled: true, host: 'bastion', user: 'u', authMethod: 'agent' } })).toEqual({ host: 'bastion', port: 22 })
    expect(firstHop({ ...base, ssh: { enabled: true, host: 'bastion', user: 'u', authMethod: 'agent', jump: { host: 'jump', port: 2222 } } })).toEqual({ host: 'jump', port: 2222 })
    expect(firstHop({ ...base, driver: 'sqlite', host: undefined, filePath: '/x.db' })).toBeUndefined()
  })

  it('a closed port is an unreachable error (the loop keeps waiting); an open one passes', async () => {
    const server = createServer((s) => s.destroy())
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as AddressInfo).port
    await expect(assertReachable({ ...base, port })).resolves.toBeUndefined()
    await new Promise<void>((r) => server.close(() => r()))
    const err = await assertReachable({ ...base, port }).catch((e: unknown) => e)
    expect(isUnreachableError(err)).toBe(true)
  })
})

describe('parallel connects share one attempt', () => {
  it('runs once while running, again after it settled', async () => {
    const once = singleFlight<number>()
    let runs = 0
    const run = () => new Promise<number>((r) => setTimeout(() => r(++runs), 20))
    expect(await Promise.all([once('a', run), once('a', run), once('a', run)])).toEqual([1, 1, 1])
    expect(await once('a', run)).toBe(2)
    await expect(once('b', () => Promise.reject(new Error('no')))).rejects.toThrow('no')
    expect(await once('b', run)).toBe(3)
  })
})
