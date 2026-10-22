import { describe, expect, it } from 'vitest'
import { parseSqlTool, sqlTool } from '../src/index.js'

describe('parseSqlTool', () => {
  it('reads the header and the SQL', () => {
    const spec = parseSqlTool(
      `-- tool: customer_balance\n-- description: Current balance\n-- of one customer\n-- param: customer_id (number, required): customers.id\n-- param: currency: ISO code\nSELECT 1 WHERE id = :customer_id;\n`,
      'tools/x.sql',
    )
    expect(spec).toEqual({
      name: 'customer_balance',
      description: 'Current balance of one customer',
      params: [
        { name: 'customer_id', type: 'number', required: true, description: 'customers.id' },
        { name: 'currency', type: 'string', required: false, description: 'ISO code' },
      ],
      sql: 'SELECT 1 WHERE id = :customer_id',
      file: 'tools/x.sql',
    })
    const tool = sqlTool(spec as never)
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: { customer_id: { type: 'number', description: 'customers.id' }, currency: { type: 'string', description: 'ISO code' } },
      required: ['customer_id'],
      additionalProperties: false,
    })
    expect(tool.readOnly).toBe(true)
  })

  it('takes the name from the file and reports problems', () => {
    expect(parseSqlTool('-- description: d\nSELECT 1', 'tools/top_customers.sql')).toMatchObject({ name: 'top_customers' })
    expect(parseSqlTool('SELECT 1', 'tools/a.sql')).toEqual({ error: 'tools/a.sql: add a "-- description:" line so the AI knows when to use it' })
    expect(parseSqlTool('-- tool: bad name\n-- description: d\nSELECT 1', 'tools/a.sql')).toMatchObject({ error: expect.stringContaining('tool name') })
  })
})
