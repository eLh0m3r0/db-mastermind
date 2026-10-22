import { describe, expect, it } from 'vitest'
import { extractSql, writeSqlPrompt } from '../src/index.js'

describe('inline SQL writing', () => {
  it('extracts the first fenced block or the bare reply', () => {
    expect(extractSql('Here:\n```sql\nSELECT 1;\n```\nDone')).toBe('SELECT 1;')
    expect(extractSql('```\nSELECT 2\n```')).toBe('SELECT 2')
    expect(extractSql('  SELECT 3  ')).toBe('SELECT 3')
  })

  it('asks to rewrite the selection when there is one', () => {
    const p = writeSqlPrompt({ driver: 'postgres', dialectName: 'PostgreSQL', request: 'add a limit', schema: 'orders(id)', selection: 'SELECT * FROM orders' })
    expect(p.system).toContain('PostgreSQL')
    expect(p.prompt).toContain('Rewrite this selected SQL')
    expect(writeSqlPrompt({ driver: 'postgres', dialectName: 'PostgreSQL', request: 'count orders', schema: 'orders(id)' }).prompt).toContain('Write SQL for: count orders')
  })
})
