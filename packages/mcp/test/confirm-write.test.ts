import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { DatabaseService, type ConnectionConfig } from '@dbmastermind/core'
import { afterAll, describe, expect, it } from 'vitest'
import { createMcpServer } from '../src/server'

/** The app's own assistant asks before a write (confirmWrite); external agents can't be asked. */

const file = join(mkdtempSync(join(tmpdir(), 'dbm-confirm-')), 'notes.db')
const db = new DatabaseService()
afterAll(() => db.disconnectAll())

const text = (r: unknown) => ((r as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')

async function clientFor(access: 'read' | 'write', confirmWrite?: (sql: string) => Promise<boolean>) {
  const config: ConnectionConfig = { id: `c-${access}`, name: 'notes', driver: 'sqlite', filePath: file, ai: { access, agents: true, agentWrites: false, knowledgeWrites: false } }
  if (!db.isOpen(config.id)) await db.connect(config)
  const server = createMcpServer({ db, connections: [config], confirmWrite })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await server.connect(a)
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(b)
  return { client, id: config.id }
}

describe('confirmWrite', () => {
  it('asks before a write and honours the answer; read access never asks', async () => {
    const asked: string[] = []
    let answer = false
    const { client, id } = await clientFor('write', async (sql) => {
      asked.push(sql)
      return answer
    })
    await db.runScript(id, "CREATE TABLE notes (id integer primary key, note text); INSERT INTO notes VALUES (2, 'beta')")
    const update = { name: 'run_query', arguments: { sql: "UPDATE notes SET note = 'gamma' WHERE id = 2" } }
    expect(text(await client.callTool(update))).toMatch(/declined/i)
    expect((await db.runScript(id, 'SELECT note FROM notes'))[0]!.results![0]!.rows).toEqual([['beta']])
    answer = true
    await client.callTool(update)
    expect((await db.runScript(id, 'SELECT note FROM notes'))[0]!.results![0]!.rows).toEqual([['gamma']])
    expect(asked).toHaveLength(2)

    const read = await clientFor('read', async () => {
      asked.push('read')
      return true
    })
    expect(text(await read.client.callTool({ name: 'run_query', arguments: { sql: "UPDATE notes SET note = 'x'" } }))).toMatch(/Refused/)
    expect(asked).toHaveLength(2)
  })
})
