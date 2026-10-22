import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deleteTeamQuery, isTeamQuery, readTeamFolder, removeTeamConnection, writeTeamConnection, writeTeamQuery } from '../src/main/team-folder'

function folder() {
  const dir = mkdtempSync(join(tmpdir(), 'dbm-team-'))
  writeFileSync(
    join(dir, 'connections.json'),
    JSON.stringify({ format: 'db-mastermind-connections', version: 1, connections: [{ name: 'Účetnictví DB', driver: 'postgres', host: 'acc', password: 'nope' }, { id: 'dwh', name: 'DWH', driver: 'postgres', knowledgeBasePath: 'notes/dwh' }] }),
  )
  mkdirSync(join(dir, 'knowledge', 'team-ucetnictvi-db'), { recursive: true })
  mkdirSync(join(dir, 'queries', 'Reports'), { recursive: true })
  writeFileSync(join(dir, 'queries', 'Reports', 'Top customers.sql'), '-- connection: DWH\n-- description: Best 10\nSELECT 1\n')
  writeFileSync(join(dir, 'queries', 'ping.sql'), 'SELECT 2')
  return dir
}

describe('readTeamFolder', () => {
  it('reads connections with stable ids, knowledge folders and queries', () => {
    const dir = folder()
    const { connections, queries, error } = readTeamFolder(dir)
    expect(error).toBeUndefined()
    expect(connections[0]).toMatchObject({ id: 'team-ucetnictvi-db', host: 'acc', knowledgeBasePath: join(dir, 'knowledge', 'team-ucetnictvi-db') })
    expect(connections[0]!.password).toBeUndefined()
    expect(connections[1]!.knowledgeBasePath).toBe(join(dir, 'notes', 'dwh'))
    const top = queries.find((q) => q.name === 'Top customers')!
    expect(top).toMatchObject({ id: 'team:Reports/Top customers.sql', folder: 'Team/Reports', connectionId: 'dwh', description: 'Best 10', sql: 'SELECT 1\n' })
    expect(queries.find((q) => q.name === 'ping')).toMatchObject({ folder: 'Team', sql: 'SELECT 2' })
  })
  it('reports a broken connections file but still lists queries', () => {
    const dir = folder()
    writeFileSync(join(dir, 'connections.json'), '{')
    const r = readTeamFolder(dir)
    expect(r.error).toMatch(/connections\.json/)
    expect(r.queries).toHaveLength(2)
  })
})

describe('writing to the team folder', () => {
  it('saves, renames and deletes queries as .sql files', () => {
    const dir = folder()
    const id = writeTeamQuery(dir, { name: 'Late orders', sql: 'SELECT * FROM orders', folder: 'Team/Ops' }, 'DWH')
    expect(id).toBe('team:Ops/Late orders.sql')
    expect(readFileSync(join(dir, 'queries', 'Ops', 'Late orders.sql'), 'utf8')).toBe('-- connection: DWH\nSELECT * FROM orders\n')
    const renamed = writeTeamQuery(dir, { id, name: 'Late orders v2', sql: 'SELECT 1', folder: 'Team/Ops' })
    expect(existsSync(join(dir, 'queries', 'Ops', 'Late orders.sql'))).toBe(false)
    deleteTeamQuery(dir, renamed)
    expect(existsSync(join(dir, 'queries', 'Ops', 'Late orders v2.sql'))).toBe(false)
    expect(isTeamQuery({ folder: 'Team/Ops' }) && isTeamQuery({ id: 'team:x.sql' }) && !isTeamQuery({ folder: 'Teamwork' })).toBe(true)
  })
  it('adds connections without secrets, keeping the file format, and removes them', () => {
    const dir = folder()
    writeTeamConnection(dir, { id: 'mine', name: 'Mine', driver: 'mysql', password: 'secret', knowledgeBasePath: join(dir, 'knowledge', 'mine') } as never)
    const raw = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8'))
    expect(raw.format).toBe('db-mastermind-connections')
    expect(raw.connections.at(-1)).toEqual({ id: 'mine', name: 'Mine', driver: 'mysql', knowledgeBasePath: 'knowledge/mine' })
    removeTeamConnection(dir, 'team-ucetnictvi-db')
    expect(readTeamFolder(dir).connections.map((c) => c.id)).toEqual(['dwh', 'mine'])
  })
})
