/**
 * A small but realistic shop database for first-run exploration (SQLite). Deterministic pseudo-random data
 * so screenshots and tests are stable.
 */

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

const FIRST = ['Jana', 'Petr', 'Lucie', 'Tomáš', 'Eva', 'Martin', 'Kateřina', 'Jakub', 'Tereza', 'Ondřej', 'Anna', 'David', 'Klára', 'Filip', 'Veronika', 'Lukáš', 'Emma', 'Noah', 'Olivia', 'Liam']
const LAST = ['Novák', 'Svoboda', 'Dvořák', 'Černá', 'Procházka', 'Kučera', 'Veselá', 'Horák', 'Němec', 'Marek', 'Smith', 'Johnson', 'Müller', 'Rossi', 'Kowalski']
const CITIES = [
  ['Praha', 'CZ'],
  ['Brno', 'CZ'],
  ['Ostrava', 'CZ'],
  ['Plzeň', 'CZ'],
  ['Bratislava', 'SK'],
  ['Wien', 'AT'],
  ['Berlin', 'DE'],
  ['Kraków', 'PL'],
] as const
const CATEGORIES = [
  ['Coffee', 'Beans and ground coffee'],
  ['Tea', 'Loose leaf and bagged tea'],
  ['Equipment', 'Grinders, kettles and brewers'],
  ['Accessories', 'Cups, filters and scales'],
  ['Gifts', 'Gift sets and vouchers'],
] as const
const PRODUCTS: [string, number, number][] = [
  ['Ethiopia Yirgacheffe 250 g', 0, 289],
  ['Colombia Huila 250 g', 0, 259],
  ['Brazil Santos 1 kg', 0, 749],
  ['Espresso Blend 500 g', 0, 419],
  ['Decaf Peru 250 g', 0, 279],
  ['Sencha Premium 100 g', 1, 189],
  ['Earl Grey 100 g', 1, 149],
  ['Rooibos Vanilla 100 g', 1, 129],
  ['Matcha Ceremonial 30 g', 1, 399],
  ['Hand Grinder Comandante', 2, 6490],
  ['Gooseneck Kettle', 2, 1890],
  ['V60 Dripper', 2, 590],
  ['AeroPress', 2, 1190],
  ['French Press 1 l', 2, 790],
  ['Paper Filters (100)', 3, 149],
  ['Digital Scale', 3, 990],
  ['Ceramic Cup', 3, 249],
  ['Travel Mug', 3, 549],
  ['Coffee Lover Gift Set', 4, 1490],
  ['Gift Voucher 1000 CZK', 4, 1000],
]

const esc = (v: string) => `'${v.replaceAll("'", "''")}'`

export function sampleDatabaseSql(): string[] {
  const r = rng(42)
  const pick = <T>(arr: readonly T[]) => arr[Math.floor(r() * arr.length)]!
  const out: string[] = [
    `CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT
)`,
    `CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  price NUMERIC NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1
)`,
    `CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  city TEXT,
  country TEXT NOT NULL,
  newsletter BOOLEAN NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
)`,
    `CREATE TABLE employees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  manager_id INTEGER REFERENCES employees(id)
)`,
    `CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  employee_id INTEGER REFERENCES employees(id),
  status TEXT NOT NULL CHECK (status IN ('new', 'paid', 'shipped', 'cancelled')),
  ordered_at TEXT NOT NULL,
  shipped_at TEXT,
  note TEXT
)`,
    `CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC NOT NULL,
  PRIMARY KEY (order_id, product_id)
)`,
    `CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  paid_at TEXT NOT NULL
)`,
    'CREATE INDEX ix_orders_customer ON orders (customer_id)',
    'CREATE INDEX ix_orders_status_date ON orders (status, ordered_at)',
    'CREATE INDEX ix_products_category ON products (category_id)',
    `CREATE VIEW customer_revenue AS
SELECT c.id, c.first_name || ' ' || c.last_name AS customer, c.country,
       COUNT(DISTINCT o.id) AS orders, ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
  FROM customers c
  JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
  JOIN order_items i ON i.order_id = o.id
 GROUP BY c.id`,
  ]

  CATEGORIES.forEach(([name, description], i) => out.push(`INSERT INTO categories VALUES (${i + 1}, ${esc(name)}, ${esc(description)})`))
  PRODUCTS.forEach(([name, cat, price], i) =>
    out.push(`INSERT INTO products VALUES (${i + 1}, ${cat + 1}, ${esc(name)}, ${price}, ${Math.floor(r() * 120)}, ${i === 4 ? 0 : 1})`),
  )
  out.push(
    `INSERT INTO employees VALUES (1, 'Alena Krásná', 'Head of Sales', NULL), (2, 'Bohdan Malý', 'Sales', 1), (3, 'Cyril Velký', 'Sales', 1), (4, 'Dana Rychlá', 'Support', 1)`,
  )

  const customers: string[] = []
  for (let i = 1; i <= 240; i++) {
    const first = pick(FIRST)
    const last = pick(LAST)
    const [city, country] = pick(CITIES)
    const day = new Date(Date.UTC(2024, 0, 1) + Math.floor(r() * 700) * 86_400_000)
    const email = `${first}.${last}${i}@example.com`
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
    customers.push(`(${i}, ${esc(first)}, ${esc(last)}, ${esc(email)}, ${r() < 0.06 ? 'NULL' : esc(city)}, ${esc(country)}, ${r() < 0.4 ? 1 : 0}, ${esc(day.toISOString().slice(0, 10))})`)
  }
  out.push(`INSERT INTO customers VALUES ${customers.join(',\n')}`)

  const orders: string[] = []
  const items: string[] = []
  const payments: string[] = []
  let paymentId = 1
  for (let id = 1; id <= 1200; id++) {
    const customer = 1 + Math.floor(r() * 240)
    const date = new Date(Date.UTC(2024, 2, 1) + Math.floor(r() * 600) * 86_400_000)
    const roll = r()
    const status = roll < 0.08 ? 'cancelled' : roll < 0.2 ? 'new' : roll < 0.45 ? 'paid' : 'shipped'
    const shipped = status === 'shipped' ? esc(new Date(date.getTime() + (1 + Math.floor(r() * 5)) * 86_400_000).toISOString().slice(0, 10)) : 'NULL'
    orders.push(`(${id}, ${customer}, ${r() < 0.85 ? 1 + Math.floor(r() * 4) : 'NULL'}, ${esc(status)}, ${esc(date.toISOString().slice(0, 10))}, ${shipped}, ${r() < 0.05 ? esc('Gift wrap, please') : 'NULL'})`)
    const lines = 1 + Math.floor(r() * 4)
    const used = new Set<number>()
    let total = 0
    for (let l = 0; l < lines; l++) {
      const product = 1 + Math.floor(r() * PRODUCTS.length)
      if (used.has(product)) continue
      used.add(product)
      const qty = 1 + Math.floor(r() * 3)
      const price = PRODUCTS[product - 1]![2]
      total += qty * price
      items.push(`(${id}, ${product}, ${qty}, ${price})`)
    }
    if (status === 'paid' || status === 'shipped') {
      payments.push(`(${paymentId++}, ${id}, ${esc(pick(['card', 'card', 'bank transfer', 'cash on delivery']))}, ${total}, ${esc(date.toISOString().slice(0, 10))})`)
    }
  }
  out.push(`INSERT INTO orders VALUES ${orders.join(',\n')}`)
  out.push(`INSERT INTO order_items VALUES ${items.join(',\n')}`)
  out.push(`INSERT INTO payments VALUES ${payments.join(',\n')}`)
  return out
}

/** Knowledge base notes shipped with the sample database, showing the conventions. */
export const SAMPLE_KNOWLEDGE: Record<string, string> = {
  'README.md': `# Demo coffee shop

An online shop selling coffee, tea and brewing equipment in Central Europe.

- **Sales**: \`orders\`, \`order_items\`, \`payments\` (see [sales.md](sales.md))
- **Catalog**: \`products\`, \`categories\`
- **People**: \`customers\`, \`employees\` (employees handle orders; \`manager_id\` builds the org chart)

Prices are in CZK including VAT.
`,
  'sales.md': `---
tables: [orders, order_items, payments]
---
# Sales

- An **order** belongs to one customer and is handled by an employee (NULL = web self-service).
- \`status\`: \`new\` → \`paid\` → \`shipped\`; \`cancelled\` orders are excluded from revenue.
- **Revenue** = \`SUM(order_items.quantity * order_items.unit_price)\` of non-cancelled orders.
  \`unit_price\` is the price at the time of purchase, so it can differ from \`products.price\`.
- Every paid or shipped order has exactly one row in \`payments\`.

Example: monthly revenue

\`\`\`sql
SELECT substr(o.ordered_at, 1, 7) AS month, SUM(i.quantity * i.unit_price) AS revenue
  FROM orders o JOIN order_items i ON i.order_id = o.id
 WHERE o.status <> 'cancelled'
 GROUP BY month ORDER BY month;
\`\`\`
`,
}
