import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AGENT_DATABASE_MEMBERS, agentDatabase, buildSystemPrompt, DatabaseService, DB_TOOLS, KnowledgeBase, loadSqlTools, type AgentDatabase, type DbTool, type ToolContext } from '../src/index.js'

/**
 * Wave 10: the tools' only way to a database is the guarded view (agent-db.ts). Every tool, the team tools and the
 * system prompt run against a view that throws on anything not on it: a tool that reaches for runScript,
 * fetchTable, streamQuery or the driver fails here.
 */
const dir = mkdtempSync(join(tmpdir(), 'dbm-agentdb-'))
const svc = new DatabaseService()
const kbDir = join(dir, 'kb')
beforeAll(async () => {
  await svc.connect({ id: 'lite', name: 'lite', driver: 'sqlite', filePath: join(dir, 'a.db') })
  await svc.runScript('lite', 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE u (id INTEGER PRIMARY KEY, t_id INTEGER REFERENCES t(id)); INSERT INTO t VALUES (1, \'a\'); CREATE VIEW v AS SELECT * FROM t')
  mkdirSync(join(kbDir, 'tools'), { recursive: true })
  writeFileSync(join(kbDir, 'README.md'), '# Notes\n')
  writeFileSync(join(kbDir, 'tools', 'names.sql'), '-- tool: names_by_id\n-- description: Names\n-- param: id (number, required): id\nSELECT name FROM t WHERE id = :id\n')
})
afterAll(async () => {
  await svc.disconnectAll()
  rmSync(dir, { recursive: true, force: true })
})

/** The view behind a proxy that fails loudly on any member it doesn't have. */
function strict(view: AgentDatabase): AgentDatabase {
  return new Proxy(view, {
    get(target, key) {
      if (typeof key === 'string' && !(AGENT_DATABASE_MEMBERS as readonly string[]).includes(key) && key !== 'then') throw new Error(`${key} is not on the guarded view`)
      return Reflect.get(target, key)
    },
  })
}

const inputFor = (tool: DbTool): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
    if (key === 'schema') continue
    out[key] = key === 'sql' ? 'SELECT * FROM t' : key === 'path' ? 'README.md' : key === 'content' ? '# x\n' : key === 'limit' || key === 'max_rows' || key === 'id' ? 1 : key === 'to' ? 'u' : 't'
  }
  return out
}

describe('the guarded view is the only way to the database', () => {
  it('has exactly its members: no runScript, fetchTable, streamQuery or driver', () => {
    const view = agentDatabase(svc, { allowData: true })
    expect(Object.keys(view).sort()).toEqual([...AGENT_DATABASE_MEMBERS].sort())
    for (const name of ['runScript', 'fetchTable', 'streamQuery', 'driver', 'execute', 'connect']) expect(name in view, name).toBe(false)
  })

  for (const allowData of [true, false]) {
    it(`every tool, the team tools and the system prompt use nothing else (allowData: ${allowData})`, async () => {
      const ctx: ToolContext = { db: strict(agentDatabase(svc, { allowData })), connectionId: 'lite', allowData, knowledge: new KnowledgeBase(kbDir), allowKnowledgeWrites: true, confirmWrite: async () => true }
      const { tools: team } = await loadSqlTools(ctx.knowledge, DB_TOOLS.map((t) => t.name))
      expect(team.map((t) => t.name)).toEqual(['names_by_id'])
      for (const tool of [...DB_TOOLS, ...team]) {
        const text = await tool.run(ctx, inputFor(tool)).catch((err: Error) => `THROWN: ${err.message}`)
        expect(text, tool.name).not.toMatch(/is not on the guarded view/)
        // Schema only: no row value comes back.
        if (!allowData && ['run_query', 'sample_rows', 'names_by_id'].includes(tool.name)) expect(text, tool.name).toMatch(/only shares the schema/)
      }
      expect(await buildSystemPrompt(ctx)).toMatch(/Schema/)
    })
  }

  it('reads and samples refuse on a schema-only view by themselves', async () => {
    const view = agentDatabase(svc, { allowData: false })
    await expect(view.read('lite', 'SELECT * FROM t')).rejects.toThrow(/only shares the schema/)
    await expect(view.sample('lite', { name: 't' }, 1)).rejects.toThrow(/only shares the schema/)
    expect((await view.explain('lite', 'SELECT * FROM t')).raw).toMatch(/SCAN/)
  })

  it('a write needs the confirmation the view asks for itself', async () => {
    const view = agentDatabase(svc, { allowData: true })
    expect(await view.write('lite', "INSERT INTO t VALUES (9, 'x')", undefined, { maxRows: 1 })).toEqual({ refused: expect.stringMatching(/not allowed/) })
    expect(await view.write('lite', "INSERT INTO t VALUES (9, 'x')", async () => false, { maxRows: 1 })).toEqual({ refused: expect.stringMatching(/declined/) })
    const [count] = await svc.runScript('lite', 'SELECT count(*) FROM t')
    expect(Number(count!.results![0]!.rows[0]![0])).toBe(1)
  })
})
