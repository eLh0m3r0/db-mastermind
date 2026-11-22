import { describe, expect, it } from 'vitest'
import { DB_TOOLS, modelError, type AgentDatabase, type ToolContext } from '../src/index.js'

// Wave 10 (audit C): "Schema only" means no value from rows reaches the AI.
describe('schema only', () => {
  const schemaOnly = { allowData: false }
  it('errors that can quote a value are reduced to their class and position; others pass', () => {
    const reduced = [
      { message: 'duplicate key value violates unique constraint "u_email"', code: '23505' },
      { message: 'invalid input syntax for type integer: "alice@example.com"', code: '22P02', position: 8 },
      { message: "Duplicate entry 'alice@example.com' for key 'customers.email'", code: 'ER_DUP_ENTRY' },
      { message: "Truncated incorrect DOUBLE value: 'secret'", code: '1292' },
      { message: 'Violation of UNIQUE KEY constraint \'UQ\'. Cannot insert duplicate key in object \'dbo.t\'. The duplicate key value is (alice).', code: '2627' },
      { message: "Conversion failed when converting the varchar value 'secret' to data type int.", code: '245' },
      { message: 'Conversion Error: Could not convert string \'secret\' to INT32' },
      { message: 'Code: 6. DB::Exception: Cannot parse string \'secret\' as UInt32', code: 'CANNOT_PARSE_TEXT' },
      { message: 'ORA-01722: invalid number' },
    ]
    for (const e of reduced) {
      const text = modelError(schemaOnly, e)
      expect(text, e.message).toMatch(/is not shown: the user only shares the schema/)
      expect(text).not.toMatch(/alice|secret/)
    }
    expect(modelError(schemaOnly, { message: 'invalid input syntax for type integer: "x"', code: '22P02', position: 8 })).toMatch(/at position 8/)
    for (const e of [{ message: 'syntax error at or near "FORM"', code: '42601' }, { message: "Unknown column 'nam' in 'field list'", code: 'ER_BAD_FIELD_ERROR' }, { message: 'Only reads are allowed here (read-only): DELETE is not.' }]) {
      expect(modelError(schemaOnly, e)).toContain(e.message)
    }
    expect(modelError({ allowData: true }, reduced[2]!)).toContain('alice@example.com')
  })

  it("explain_query on MySQL leaves the plan's conditions out (const tables' values are written into them)", async () => {
    const plan = { root: { operation: 'const', object: 'customers', detail: "('alice@example.com' = 'alice@example.com')", rows: 1, children: [] }, raw: '', format: 'json' as const }
    const db = { allowData: false, config: () => ({ id: 'x', name: 'x', driver: 'mysql' }), explain: async () => plan } as unknown as AgentDatabase
    const ctx: ToolContext = { db, connectionId: 'x', allowData: false }
    const explain = DB_TOOLS.find((t) => t.name === 'explain_query')!
    const text = await explain.run(ctx, { sql: 'SELECT * FROM customers WHERE id = 1' })
    expect(text).toMatch(/const on customers \(rows 1\)/)
    expect(text).not.toMatch(/alice/)
  })
})
