import { describe, expect, it } from 'vitest'
import { copyRowsAs } from '../src/renderer/src/features/results/copy'

describe('Copy rows as SQL INSERT', () => {
  const fields = [{ name: 'id' }, { name: 'note' }]
  it('quotes and qualifies the table name per dialect', () => {
    expect(copyRowsAs('sql', fields, [[1, "it's"]], 'postgres', { schema: 'shop', name: 'Order Items' })).toBe(
      `INSERT INTO "shop"."Order Items" ("id", "note") VALUES (1, 'it''s');`,
    )
    expect(copyRowsAs('sql', fields, [[1, null]], 'mssql', { schema: 'dbo', name: 'orders' })).toBe('INSERT INTO [dbo].[orders] ([id], [note]) VALUES (1, NULL);')
    expect(copyRowsAs('sql', fields, [[1, 'x']], 'mysql', { name: 'orders' })).toBe("INSERT INTO `orders` (`id`, `note`) VALUES (1, 'x');")
  })
})
