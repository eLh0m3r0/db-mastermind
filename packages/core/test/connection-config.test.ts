import { describe, expect, it } from 'vitest'
import { needsReconnect, sameServer, supportsOtherDatabases, type ConnectionConfig } from '../src/index.js'

const pg: ConnectionConfig = { id: 'a', name: 'Server', driver: 'postgres', host: 'db.local', port: 5432, user: 'app', database: 'shop' }

describe('connection settings', () => {
  it('reconnects for what the connection was made with, not for its name, color or commit mode', () => {
    expect(needsReconnect(pg, { ...pg, name: 'Other', color: '#f00', manualCommit: true, ai: { access: 'read' } })).toBe(false)
    expect(needsReconnect(pg, { ...pg, database: 'crm' })).toBe(true)
    expect(needsReconnect(pg, { ...pg, readOnly: true })).toBe(true)
    expect(needsReconnect({ ...pg, password: '' }, { ...pg, password: undefined })).toBe(false)
  })
  it('tells another database of the same server and login', () => {
    expect(sameServer(pg, { ...pg, id: 'b', name: 'x', database: 'crm' })).toBe(true)
    expect(sameServer(pg, { ...pg, user: 'admin' })).toBe(false)
    expect(sameServer(pg, { ...pg, port: 5433 })).toBe(false)
    expect(sameServer(pg, { ...pg, ssh: { host: 'bastion', port: 22, user: 'me' } })).toBe(false)
  })
  it('offers other databases only where a server has several behind one login', () => {
    expect(['postgres', 'mysql', 'mariadb', 'mssql', 'clickhouse'].every((d) => supportsOtherDatabases(d as ConnectionConfig['driver']))).toBe(true)
    expect(['sqlite', 'duckdb', 'oracle', 'bigquery', 'trino'].some((d) => supportsOtherDatabases(d as ConnectionConfig['driver']))).toBe(false)
  })
})
