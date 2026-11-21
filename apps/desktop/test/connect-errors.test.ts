import { describe, expect, it } from 'vitest'
import { explainConnectError } from '../src/renderer/src/lib/connect-errors'

const t = (text: string, vars?: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k: string) => vars?.[k] ?? m)
const explain = (message: string) => explainConnectError(message, t)

// The drivers' own messages, as pg 8, mysql2 3 and mssql 11 produced them against closed ports, an unknown host and
// the test containers (wrong password, missing database, TLS asked of a server without it).
describe('why a connection failed', () => {
  it('nothing listening: pg and mysql2 (ECONNREFUSED), mssql (Could not connect)', () => {
    for (const message of ['connect ECONNREFUSED 127.0.0.1:1', 'Failed to connect to 127.0.0.1:1 - Could not connect (sequence)']) {
      const p = explain(message)
      expect(p.summary).toBe('Nothing is listening on 127.0.0.1:1. Is the database running, and are the host and port right?')
      expect(p.detail).toBe(message)
      expect(p.section).toBe('general')
    }
    expect(explain('connect ECONNREFUSED ::1:5432').summary).toContain('::1:5432')
  })

  it('unknown host: pg, mysql2 and mssql', () => {
    for (const message of ['getaddrinfo ENOTFOUND db.invalid-host-xyz.example', 'Failed to connect to db.invalid-host-xyz.example:1433 - getaddrinfo ENOTFOUND db.invalid-host-xyz.example']) {
      expect(explain(message).summary).toBe('The host name db.invalid-host-xyz.example can’t be found. Check its spelling, or connect to the VPN first.')
    }
  })

  it('wrong user name or password: pg, mysql2, mssql, Oracle', () => {
    for (const message of [
      'password authentication failed for user "postgres"',
      "Access denied for user 'root'@'172.17.0.1' (using password: YES)",
      "Login failed for user 'sa'.",
      'ORA-01017: invalid username/password; logon denied',
    ])
      expect(explain(message).summary).toBe('The server rejected the user name or password.')
  })

  it('no such database: pg and mysql2', () => {
    expect(explain('database "nope_db" does not exist').summary).toBe('There is no database nope_db on this server. Check the Database field.')
    expect(explain("Unknown database 'nope_db'").summary).toBe('There is no database nope_db on this server. Check the Database field.')
  })

  it('TLS and timeouts point at their tabs', () => {
    expect(explain('The server does not support SSL connections')).toMatchObject({ section: 'ssl' })
    expect(explain('self-signed certificate in certificate chain')).toMatchObject({ section: 'ssl' })
    expect(explain('connect ETIMEDOUT 10.255.255.1:5432')).toMatchObject({ section: 'ssh' })
    expect(explain('Connection terminated due to connection timeout')).toMatchObject({ section: 'ssh' })
    expect(explain('Failed to connect to 10.0.0.9:1433 in 15000ms')).toMatchObject({ section: 'ssh' })
  })

  it('says nothing more than the driver when it doesn’t know the case', () => {
    expect(explain('relation "x" does not exist')).toEqual({ detail: 'relation "x" does not exist' })
  })
})
