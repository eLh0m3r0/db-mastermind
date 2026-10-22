// Auto layout: how many relationship lines cross (lower is better), on a ~25-table schema and the demo database.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const out = process.argv[2]
const tag = process.argv[3] ?? 'new'
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui58-'))
const file = join(dir, 'erp.db')
const db = new DatabaseSync(file)
db.exec(`
CREATE TABLE countries (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE regions (id INTEGER PRIMARY KEY, country_id INTEGER REFERENCES countries(id), name TEXT);
CREATE TABLE cities (id INTEGER PRIMARY KEY, region_id INTEGER REFERENCES regions(id), name TEXT);
CREATE TABLE addresses (id INTEGER PRIMARY KEY, city_id INTEGER REFERENCES cities(id), street TEXT);
CREATE TABLE customers (id INTEGER PRIMARY KEY, address_id INTEGER REFERENCES addresses(id), segment_id INTEGER REFERENCES segments(id), name TEXT);
CREATE TABLE segments (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE employees (id INTEGER PRIMARY KEY, manager_id INTEGER REFERENCES employees(id), department_id INTEGER REFERENCES departments(id), address_id INTEGER REFERENCES addresses(id));
CREATE TABLE departments (id INTEGER PRIMARY KEY, name TEXT, head_id INTEGER);
CREATE TABLE suppliers (id INTEGER PRIMARY KEY, address_id INTEGER REFERENCES addresses(id), name TEXT);
CREATE TABLE categories (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES categories(id), name TEXT);
CREATE TABLE products (id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id), supplier_id INTEGER REFERENCES suppliers(id), brand_id INTEGER REFERENCES brands(id), name TEXT);
CREATE TABLE brands (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE warehouses (id INTEGER PRIMARY KEY, address_id INTEGER REFERENCES addresses(id));
CREATE TABLE stock (warehouse_id INTEGER REFERENCES warehouses(id), product_id INTEGER REFERENCES products(id), qty INTEGER, PRIMARY KEY (warehouse_id, product_id));
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), employee_id INTEGER REFERENCES employees(id), shipping_address_id INTEGER REFERENCES addresses(id), currency_id INTEGER REFERENCES currencies(id));
CREATE TABLE currencies (id INTEGER PRIMARY KEY, code TEXT);
CREATE TABLE order_items (order_id INTEGER REFERENCES orders(id), product_id INTEGER REFERENCES products(id), qty INTEGER, PRIMARY KEY (order_id, product_id));
CREATE TABLE invoices (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), currency_id INTEGER REFERENCES currencies(id));
CREATE TABLE payments (id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id), method_id INTEGER REFERENCES payment_methods(id));
CREATE TABLE payment_methods (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE shipments (id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id), warehouse_id INTEGER REFERENCES warehouses(id), carrier_id INTEGER REFERENCES carriers(id));
CREATE TABLE carriers (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE returns (id INTEGER PRIMARY KEY, order_item_order_id INTEGER, shipment_id INTEGER REFERENCES shipments(id), reason_id INTEGER REFERENCES return_reasons(id));
CREATE TABLE return_reasons (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE price_lists (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), currency_id INTEGER REFERENCES currencies(id), segment_id INTEGER REFERENCES segments(id));
`)
db.close()
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en' } })
const win = await app.firstWindow()
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000))
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])
const crossings = () =>
  win.evaluate(() => {
    // Edge samples in the flow's own coordinate space (screen coordinates are fine: same transform for all).
    const segs = []
    for (const path of document.querySelectorAll('.react-flow__edge-path')) {
      const len = path.getTotalLength()
      const m = path.getScreenCTM()
      const pts = []
      for (let d = 0; d <= len; d += 4) {
        const p = path.getPointAtLength(d)
        pts.push({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f })
      }
      segs.push(pts)
    }
    const nodes = [...document.querySelectorAll('.react-flow__node')].map((n) => n.getBoundingClientRect())
    const o = (p, q, r) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x))
    const angle = (a, b, c, d) => {
      const u = { x: b.x - a.x, y: b.y - a.y }, v = { x: d.x - c.x, y: d.y - c.y }
      return Math.abs((u.x * v.x + u.y * v.y) / (Math.hypot(u.x, u.y) * Math.hypot(v.x, v.y) || 1))
    }
    let pairs = 0
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        let hit = false
        for (let a = 1; a < segs[i].length && !hit; a++)
          for (let b = 1; b < segs[j].length && !hit; b++) {
            const [p1, p2, q1, q2] = [segs[i][a - 1], segs[i][a], segs[j][b - 1], segs[j][b]]
            if (o(p1, p2, q1) * o(p1, p2, q2) < 0 && o(q1, q2, p1) * o(q1, q2, p2) < 0 && angle(p1, p2, q1, q2) < 0.5) hit = true
          }
        if (hit) pairs++
      }
    // Lines that pass under a table (not just touching their own tables' edges).
    let underTables = 0
    for (const pts of segs) {
      const inside = (p) => nodes.some((r) => p.x > r.left + 4 && p.x < r.right - 4 && p.y > r.top + 4 && p.y < r.bottom - 4)
      if (pts.some(inside)) underTables++
    }
    return { edges: segs.length, crossingPairs: pairs, linesUnderTables: underTables }
  })
try {
  await win.waitForTimeout(800)
  const c = await api('saveConnection', { id: '', name: 'ERP model', driver: 'sqlite', filePath: file })
  await win.reload()
  await win.waitForTimeout(1000)
  await win.getByRole('button', { name: /ERP model/ }).first().click()
  await win.waitForTimeout(1500)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('Open ER diagram')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(4000)
  console.log(tag, 'ERP:', JSON.stringify(await crossings()), 'routed', await win.locator('path.dbm-routed').count(), 'stepped', await win.locator('path.dbm-stepped').count())
  await win.screenshot({ path: `${out}/r22-layout-${tag}.png` })
  await win.getByRole('checkbox', { name: 'Keys only' }).check().catch(() => win.getByText('Keys only').click())
  await win.waitForTimeout(3000)
  console.log(tag, 'ERP keys only:', JSON.stringify(await crossings()))
} catch (err) {
  console.log('FLOW ERROR', err.message.split('\n')[0])
} finally {
  await app.close()
}
