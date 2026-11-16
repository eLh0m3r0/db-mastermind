import { describe, expect, it } from 'vitest'
import { getDialect, type DezignSqlObject, type TableInfo } from '@dbmastermind/core/browser'
import { layoutAfterRenames, localLayout, movedKeys, portableLayout, sqlObjectsAfterRenames } from '../src/renderer/src/features/model/rename-follow'
import { withoutKeysTo } from '../src/renderer/src/features/diagram/drop-follow'
import { viewName } from '../src/renderer/src/features/model/drop-names'

const move = { from: { schema: 'public', name: 'orders' }, to: { schema: 'public', name: 'purchase' } }

describe('a renamed table', () => {
  it('keeps its place, colour and diagrams in the same write', () => {
    const tab = {
      positions: { 'public.orders': { x: 10, y: 20 }, 'public.items': { x: 1, y: 2 } },
      colors: { 'public.orders': 3 },
      diagrams: [{ id: 'd', name: 'Sales', tables: ['public.orders', 'public.items'], positions: { 'public.orders': { x: 5, y: 5 } } }],
    }
    const out = layoutAfterRenames(tab, movedKeys([move]))
    expect(out.positions).toEqual({ 'public.purchase': { x: 10, y: 20 }, 'public.items': { x: 1, y: 2 } })
    expect(out.colors).toEqual({ 'public.purchase': 3 })
    expect(out.diagrams?.[0]).toMatchObject({ tables: ['public.purchase', 'public.items'], positions: { 'public.purchase': { x: 5, y: 5 } } })
  })

  it('takes its triggers along: the trigger names the new table and its SQL is made again', () => {
    const coded: DezignSqlObject = { kind: 'trigger', name: 'trg_audit', schema: 'public', table: 'orders', code: 'CREATE TRIGGER %triggername% BEFORE INSERT ON %table% FOR EACH ROW EXECUTE FUNCTION audit()', sql: 'CREATE TRIGGER trg_audit BEFORE INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION audit()' }
    const plain: DezignSqlObject = { kind: 'trigger', name: 'trg_x', table: 'orders', sql: 'CREATE TRIGGER trg_x AFTER UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION x()' }
    const other: DezignSqlObject = { kind: 'trigger', name: 'trg_y', table: 'orders_archive', sql: 'CREATE TRIGGER trg_y AFTER UPDATE ON orders_archive FOR EACH ROW EXECUTE FUNCTION y()' }
    const [a, b, c] = sqlObjectsAfterRenames([coded, plain, other], [move])!
    expect(a).toMatchObject({ table: 'purchase', sql: 'CREATE TRIGGER trg_audit BEFORE INSERT ON public.purchase FOR EACH ROW EXECUTE FUNCTION audit()' })
    expect(b).toMatchObject({ table: 'purchase', sql: 'CREATE TRIGGER trg_x AFTER UPDATE ON purchase FOR EACH ROW EXECUTE FUNCTION x()' })
    expect(c).toBe(other)
  })
})

describe('a .dbml model’s layout in its file', () => {
  it('keys tables without a schema by name only, and the next connection reads them back in its own schema', () => {
    const tab = { positions: { 'public.orders': { x: 1, y: 1 }, 'sales.orders': { x: 2, y: 2 } } }
    const saved = portableLayout(tab, new Set(['orders']), 'public')
    expect(saved.positions).toEqual({ '.orders': { x: 1, y: 1 }, 'sales.orders': { x: 2, y: 2 } })
    expect(localLayout(saved, 'dbo').positions).toEqual({ 'dbo.orders': { x: 1, y: 1 }, 'sales.orders': { x: 2, y: 2 } })
    // No database linked: the model's tables have no schema, and neither do the keys.
    expect(localLayout(saved, undefined).positions).toEqual(saved.positions)
  })
})

describe('a table dropped on the canvas', () => {
  it('takes the relationships that point at it along', () => {
    const t = (name: string, refs: string[] = []): TableInfo => ({ name, schema: 'public', type: 'table', columns: [], primaryKey: [], indexes: [], foreignKeys: refs.map((r) => ({ name: '', columns: ['x'], refTable: r, refColumns: ['id'] })) }) as unknown as TableInfo
    const [pay, other] = withoutKeysTo([t('payments', ['orders', 'customers']), t('notes')], [{ schema: 'public', name: 'orders' }])
    expect(pay!.foreignKeys.map((f) => f.refTable)).toEqual(['customers'])
    expect(other!.foreignKeys).toEqual([])
  })
})

describe('DROP VIEW in the model’s drop script', () => {
  it('quotes names the dialect needs quoted, keeps plain ones as CREATE wrote them', () => {
    expect(viewName({ schema: 'sales', name: 'v_orders' }, getDialect('postgres'))).toBe('sales.v_orders')
    expect(viewName({ name: 'Order Totals' }, getDialect('postgres'))).toBe('"Order Totals"')
    expect(viewName({ schema: 'my-app', name: 'v' }, getDialect('mysql'))).toBe('`my-app`.v')
  })
})
