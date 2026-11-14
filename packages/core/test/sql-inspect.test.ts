import { describe, expect, it } from 'vitest'
import { closestName, inspectSql, mentionsTable, objectAt, readSql, type SchemaSnapshot, type TableInfo } from '../src/index.js'

const col = (name: string) => ({ name, dataType: 'text', ordinal: 0, nullable: true, isPrimaryKey: false, isIdentity: false })
const table = (schema: string, name: string, columns: string[], type: TableInfo['type'] = 'table'): TableInfo => ({ schema, name, type, columns: columns.map(col), primaryKey: [], foreignKeys: [], indexes: [] })
const snapshot: SchemaSnapshot = {
  defaultSchema: 'public',
  schemas: ['public', 'shop'],
  tables: [table('shop', 'customers', ['id', 'name', 'email']), table('shop', 'orders', ['id', 'customer_id', 'total', 'status']), table('public', 'Settings', ['key', 'value']), table('shop', 'vip', [], 'view')],
  routines: [{ schema: 'shop', name: 'add_one', kind: 'function' }],
  capturedAt: '',
}
const warn = (sql: string, driver: 'postgres' | 'mssql' | 'mysql' = 'postgres') => inspectSql(sql, driver, snapshot).map((w) => (w.kind === 'unknown-table' ? `table ${w.name}${w.suggestion ? ` → ${w.suggestion}` : ''}` : w.kind === 'unknown-column' ? `column ${w.table}.${w.column}${w.suggestion ? ` → ${w.suggestion}` : ''}` : `${w.verb} without WHERE on ${w.table}`))

describe('inspectSql: what is underlined', () => {
  it('a table that does not exist, with the likely one', () => {
    expect(warn('SELECT * FROM shop.custmers')).toEqual(['table shop.custmers → customers'])
    expect(warn('SELECT * FROM customer c JOIN shop.orders o ON o.customer_id = c.id')).toEqual(['table customer → customers'])
    expect(warn('SELECT * FROM nothing_like_it')).toEqual(['table nothing_like_it'])
  })

  it('alias.column that the table lacks', () => {
    expect(warn('SELECT o.totl, c.name FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id')).toEqual(['column orders.totl → total'])
    expect(warn('SELECT orders.nope FROM shop.orders')).toEqual(['column orders.nope'])
  })

  it('UPDATE or DELETE without WHERE', () => {
    expect(warn('UPDATE shop.orders SET status = 1')).toEqual(['UPDATE without WHERE on orders'])
    expect(warn('DELETE FROM shop.orders')).toEqual(['DELETE without WHERE on orders'])
    expect(warn('DELETE FROM shop.orders WHERE id IN (SELECT id FROM shop.orders)')).toEqual([])
    // A WHERE only inside a subquery doesn't limit the UPDATE.
    expect(warn('UPDATE shop.orders SET total = (SELECT max(total) FROM shop.orders WHERE id = 1)')).toEqual(['UPDATE without WHERE on orders'])
  })

  it('finds the right place in a script of several statements', () => {
    const sql = 'SELECT 1;\nSELECT * FROM shop.oders;'
    const [w] = inspectSql(sql, 'postgres', snapshot)
    expect(sql.slice(w!.from, w!.to)).toBe('shop.oders')
  })
})

describe('inspectSql: what is never underlined', () => {
  it.each([
    ['known tables and views, any case, quoted or not', 'SELECT * FROM SHOP.CUSTOMERS c JOIN "shop"."orders" o ON o.customer_id = c.id JOIN shop.vip v ON v.id = c.id'],
    ['an unqualified table of another schema', 'SELECT * FROM customers'],
    ['CTEs, also recursive and used before they are defined in the list', 'WITH RECURSIVE a AS (SELECT 1), b (x) AS (SELECT * FROM a) SELECT * FROM b JOIN a ON true'],
    ['table functions', 'SELECT * FROM generate_series(1, 3) g, unnest(array[1]) u'],
    ['subqueries in FROM', 'SELECT * FROM (SELECT 1) x'],
    ['system catalogs and schemas the snapshot does not know', 'SELECT * FROM pg_class; SELECT * FROM information_schema.tables; SELECT * FROM other_db.public.t; SELECT * FROM audit.log'],
    ['tables created earlier in the script', 'CREATE TABLE tmp_x (a int); INSERT INTO tmp_x (a) VALUES (1); SELECT * FROM tmp_x'],
    ['SELECT … INTO a new table', 'SELECT * INTO new_copy FROM shop.orders'],
    ['names inside strings and comments', "SELECT 'FROM nope' -- FROM nope2\n/* FROM nope3 */ FROM shop.orders"],
    ['columns of a view the driver could not describe, EXCLUDED, unknown qualifiers', 'SELECT v.whatever, x.y FROM shop.vip v'],
    ['qualified star and function calls', 'SELECT o.*, shop.add_one(o.id) FROM shop.orders o'],
    ['INSERT … ON CONFLICT with EXCLUDED', 'INSERT INTO shop.orders (id, status) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status'],
    ['FROM inside expressions, IS DISTINCT FROM, FOR UPDATE', "SELECT extract(year FROM o.status), trim(both ' ' FROM o.status), substring(o.status FROM 2) FROM shop.orders o WHERE o.total IS DISTINCT FROM 1 FOR UPDATE NOWAIT"],
    ['a subquery FROM inside parentheses still counts', 'SELECT * FROM shop.orders WHERE customer_id IN (SELECT id FROM shop.customers)'],
    ['dollar-quoted bodies', 'CREATE FUNCTION f() RETURNS int AS $$ SELECT * FROM nope $$ LANGUAGE sql'],
  ])('%s', (_label, sql) => {
    expect(warn(sql)).toEqual([])
  })

  it('MySQL ON DUPLICATE KEY UPDATE and a subquery table that does not exist', () => {
    expect(warn('INSERT INTO shop.orders (id, status) VALUES (1, 2) ON DUPLICATE KEY UPDATE status = VALUES(status)', 'mysql')).toEqual([])
    expect(warn('SELECT * FROM shop.orders WHERE customer_id IN (SELECT id FROM shop.custmers)')).toEqual(['table shop.custmers → customers'])
  })

  it('T-SQL: UPDATE alias … FROM, temp tables, table variables, sys views', () => {
    expect(warn('UPDATE o SET o.status = 1 FROM shop.orders o WHERE o.id = 1', 'mssql')).toEqual([])
    expect(warn('SELECT * FROM #work; SELECT * FROM @list; SELECT * FROM sys.objects; SELECT * FROM [shop].[orders]', 'mssql')).toEqual([])
  })

  it('the same alias for different tables in two subqueries is not guessed', () => {
    expect(warn('SELECT (SELECT t.total FROM shop.orders t), (SELECT t.email FROM shop.customers t)')).toEqual([])
  })

  it('nothing without a schema, and only no-WHERE on engines whose snapshot can not vouch for names', () => {
    expect(inspectSql('SELECT * FROM nope', 'postgres', undefined)).toEqual([])
    expect(inspectSql('SELECT * FROM nope; DELETE FROM nope', 'trino', snapshot).map((w) => w.kind)).toEqual(['no-where'])
    expect(inspectSql('SELECT * FROM nope', 'oracle', snapshot)).toEqual([])
  })
})

describe('readSql and objectAt', () => {
  it('reads tables with aliases and the verb past a WITH', () => {
    const [s] = readSql('WITH x AS (SELECT 1) UPDATE shop.orders o SET total = 1 WHERE id = 1', 'postgres')
    expect(s!.verb).toBe('UPDATE')
    expect(s!.tables.map((t) => `${t.parts.join('.')}:${t.alias ?? ''}`)).toEqual(['shop.orders:o'])
  })

  it('names the table, view or routine under the cursor', () => {
    const sql = 'SELECT c.email, shop.add_one(1) FROM shop.customers c'
    expect(objectAt(sql, sql.indexOf('customers') + 2, 'postgres', snapshot)).toMatchObject({ kind: 'table', table: { name: 'customers' } })
    expect(objectAt(sql, sql.indexOf('add_one') + 1, 'postgres', snapshot)).toMatchObject({ kind: 'routine', name: 'add_one' })
    expect(objectAt(sql, sql.indexOf('email'), 'postgres', snapshot)).toMatchObject({ kind: 'table', table: { name: 'customers' } })
    expect(objectAt(sql, 2, 'postgres', snapshot)).toBeUndefined()
  })

  it('closestName suggests only near misses', () => {
    expect(closestName('custmers', ['customers', 'orders'])).toBe('customers')
    expect(closestName('xyz', ['customers', 'orders'])).toBeUndefined()
    expect(closestName('orders', ['orders'])).toBeUndefined()
  })
})

describe('mentionsTable', () => {
  it('finds the table among FROM / JOIN / UPDATE / INTO names, not in strings or columns', () => {
    const customers = snapshot.tables[0]!
    expect(mentionsTable('SELECT * FROM shop.orders o JOIN shop.customers c ON c.id = o.customer_id', 'postgres', snapshot, customers)).toBe(true)
    expect(mentionsTable("SELECT 'customers' AS x, o.customers FROM shop.orders o", 'postgres', snapshot, customers)).toBe(false)
    expect(mentionsTable('UPDATE customers SET name = 1 WHERE id = 2', 'postgres', snapshot, customers)).toBe(true)
  })
})
