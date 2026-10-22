import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const pkg = join(__dirname, '..')
const kb = mkdtempSync(join(tmpdir(), 'dbm-kb-'))
const PG_URL = 'postgres://postgres:mastermind@127.0.0.1:54329/mastermind'

function text(result: unknown): string {
  return ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text).join('\n')
}

describe('dbmastermind-mcp (stdio)', () => {
  let client: Client

  beforeAll(async () => {
    execFileSync('node', ['build.mjs'], { cwd: pkg, stdio: 'ignore' })
    writeFileSync(
      join(kb, 'orders.md'),
      `---\ntables: [orders]\nrelations:\n  - orders.status -> order_status.code\n---\n# Orders\nAn order is placed by a customer. Status "paid" means the invoice was settled.\n`,
    )
    mkdirSync(join(kb, 'tools'))
    writeFileSync(
      join(kb, 'tools', 'orders_of_customer.sql'),
      `-- tool: orders_of_customer\n-- description: Number of orders of one customer\n-- param: customer_id (number, required): customers.id\nSELECT count(*) AS orders FROM shop.orders WHERE customer_id = :customer_id\n`,
    )
    writeFileSync(join(kb, 'tools', 'wipe.sql'), `-- tool: wipe\n-- description: Not allowed\nDELETE FROM shop.orders\n`)
    client = new Client({ name: 'test', version: '1.0.0' })
    await client.connect(
      new StdioClientTransport({
        command: 'node',
        args: [join(pkg, 'dist/cli.js'), '--url', PG_URL, '--name', 'shop', '--knowledge', kb],
      }),
    )
  })

  afterAll(async () => {
    await client?.close()
    rmSync(kb, { recursive: true, force: true })
  })

  it('lists tools with read-only annotations', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_connections', 'list_tables', 'describe_table', 'run_query', 'search_knowledge']))
    expect(names).not.toContain('write_knowledge')
    expect(tools.find((t) => t.name === 'run_query')?.annotations?.readOnlyHint).toBe(true)
  })

  it('describes tables and includes knowledge base notes', async () => {
    const result = await client.callTool({ name: 'describe_table', arguments: { table: 'shop.orders' } })
    const out = text(result)
    expect(out).toContain('customer_id')
    expect(out).toContain('FK → customers.id')
    expect(out).toContain('invoice was settled')
  })

  it('runs read-only queries and refuses writes', async () => {
    const read = text(await client.callTool({ name: 'run_query', arguments: { sql: 'SELECT count(*) AS n FROM shop.orders' } }))
    expect(read).toMatch(/^n\n\d+/)
    const write = text(await client.callTool({ name: 'run_query', arguments: { sql: 'DELETE FROM shop.orders' } }))
    expect(write).toMatch(/Refused/)
  })

  it('searches the schema and knowledge base', async () => {
    expect(text(await client.callTool({ name: 'search_schema', arguments: { query: 'email' } }))).toContain('customers.email')
    expect(text(await client.callTool({ name: 'search_knowledge', arguments: { query: 'paid invoice' } }))).toContain('orders.md')
  })

  it('reports errors as tool errors instead of crashing', async () => {
    const result = await client.callTool({ name: 'describe_table', arguments: { table: 'nope' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not found/)
  })

  it('exposes team tools from the knowledge base and binds their parameters', async () => {
    const { tools } = await client.listTools()
    const tool = tools.find((t) => t.name === 'orders_of_customer')
    expect(tool?.inputSchema.required).toEqual(['customer_id'])
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    const out = text(await client.callTool({ name: 'orders_of_customer', arguments: { customer_id: 1 } }))
    expect(out).toMatch(/^orders\n\d+/)
    // Values are bound, so this is just a value that matches nothing.
    const injected = text(await client.callTool({ name: 'orders_of_customer', arguments: { customer_id: '1 OR 1=1' } }))
    expect(injected).toMatch(/ERROR|^orders\n0/)
    expect(text(await client.callTool({ name: 'wipe', arguments: {} }))).toMatch(/Refused: tool files may only read data/)
  })
})
