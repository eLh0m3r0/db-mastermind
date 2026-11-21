import { describe, expect, it } from 'vitest'
import { classifyType, codeFormatsFor, compareSchemas, exportCode, parseDbml, tablesFromPrisma, toDrizzle, toPrisma, toSqlAlchemy, toTypeScript } from '../src/index.js'

const MODEL = `Enum order_status {
  new
  paid
  "on hold"
}

Table customers {
  id integer [pk, increment]
  email text [not null, unique]
  name text [not null, note: 'The name on the invoice']
  vip boolean [not null, default: false]
  created_at timestamp [not null, default: \`now()\`]
}

Table employees {
  id integer [pk, increment]
  name text [not null]
  manager_id integer [ref: > employees.id]
}

Table orders {
  id bigint [pk, increment]
  customer_id integer [not null, ref: > customers.id]
  billing_customer_id integer [ref: > customers.id]
  status order_status [not null, default: 'new']
  total "numeric(12,2)" [not null]

  indexes {
    (customer_id, status) [name: 'ix_orders_customer']
  }
}

Table order_lines {
  order_id bigint [not null]
  line_no integer [not null]
  quantity integer [not null, default: 1]

  indexes {
    (order_id, line_no) [pk]
  }
}

Table shipments {
  id integer [pk, increment]
  order_id bigint [not null]
  line_no integer [not null]
}

Table "Order Details" {
  "Detail ID" integer [pk]
  "2fa" text
}

Table audit_log {
  message text
}

Ref: order_lines.order_id > orders.id [delete: cascade]
Ref: shipments.(order_id, line_no) > order_lines.(order_id, line_no)
`

const model = parseDbml(MODEL)

describe('type families', () => {
  it('reads a type in any database spelling', () => {
    expect(classifyType('varchar(255)')).toMatchObject({ family: 'varchar', length: 255 })
    expect(classifyType('character varying(20)')).toMatchObject({ family: 'varchar', length: 20 })
    expect(classifyType('nvarchar(max)')).toMatchObject({ family: 'text', max: true, national: true })
    expect(classifyType('int unsigned')).toMatchObject({ family: 'integer', unsigned: true })
    expect(classifyType('tinyint(1)').family).toBe('boolean')
    expect(classifyType('NUMBER(1)').family).toBe('boolean')
    expect(classifyType('NUMBER(9)').family).toBe('integer')
    expect(classifyType('NUMBER(10)').family).toBe('bigint')
    expect(classifyType('NUMBER(12,2)')).toMatchObject({ family: 'decimal', length: 12, scale: 2 })
    expect(classifyType('timestamp(3) with time zone')).toMatchObject({ family: 'timestamptz', length: 3 })
    expect(classifyType('integer[]')).toMatchObject({ family: 'integer', array: true })
    expect(classifyType('_int4')).toMatchObject({ family: 'integer', array: true })
    expect(classifyType("enum('a','it''s')")).toMatchObject({ family: 'enum', values: ['a', "it's"] })
    expect(classifyType('bigserial')).toMatchObject({ family: 'bigint', serial: true })
    expect(classifyType('geometry').family).toBe('other')
  })
})

describe('code from a model', () => {
  it('offers Prisma and Drizzle only for the databases the tools support', () => {
    expect(codeFormatsFor('postgres')).toEqual(['prisma', 'drizzle', 'sqlalchemy', 'typescript'])
    expect(codeFormatsFor('mssql')).toEqual(['prisma', 'sqlalchemy', 'typescript'])
    expect(codeFormatsFor('oracle')).toEqual(['sqlalchemy', 'typescript'])
    expect(codeFormatsFor('duckdb')).toEqual(['sqlalchemy', 'typescript'])
    expect(() => exportCode('prisma', model.tables, { database: 'oracle' })).toThrow(/no provider/)
  })

  it('writes a Prisma schema that reads back as the same tables', () => {
    const prisma = toPrisma(model.tables, { enums: model.enums })
    expect(prisma).toContain('provider = "postgresql"')
    // Both sides of every relation; two relations between the same models are named.
    expect(prisma).toMatch(/customers_orders_customer_idTocustomers\s+customers\s+@relation\("orders_customer_idTocustomers", fields: \[customer_id\], references: \[id\]/)
    expect(prisma).toMatch(/orders_orders_billing_customer_idTocustomers\s+orders\[\]\s+@relation\("orders_billing_customer_idTocustomers"\)/)
    expect(prisma).toMatch(/employees\s+employees\?\s+@relation\("employeesToemployees"/)
    expect(prisma).toMatch(/other_employees\s+employees\[\]\s+@relation\("employeesToemployees"\)/)
    expect(prisma).toMatch(/order_lines\s+order_lines\s+@relation\(fields: \[order_id, line_no\], references: \[order_id, line_no\], onDelete: NoAction/)
    expect(prisma).toMatch(/@@id\(\[order_id, line_no\]\)/)
    expect(prisma).toMatch(/status\s+order_status\s+@default\(new\)/)
    expect(prisma).toMatch(/on_hold @map\("on hold"\)/)
    expect(prisma).toMatch(/Detail_ID\s+Int\s+@id @map\("Detail ID"\)/)
    expect(prisma).toMatch(/x_2fa\s+String\?\s+@map\("2fa"\)/)
    expect(prisma).toMatch(/@@map\("Order Details"\)/)
    expect(prisma).toMatch(/model audit_log \{[^}]*@@ignore/)
    expect(prisma).toMatch(/created_at\s+DateTime\s+@default\(now\(\)\) @db\.Timestamp\(6\)/)
    expect(prisma).toMatch(/total\s+Decimal\s+@db\.Decimal\(12, 2\)/)
    const back = tablesFromPrisma(prisma)
    expect(back.errors).toEqual([])
    expect(back.enums).toEqual({ order_status: ['new', 'paid', 'on_hold'] })
    // The same tables, keys and relations (Prisma's own spelling of a type is the database's: timestamp(6)).
    const changes = compareSchemas(back.tables.map((t) => ({ ...t, columns: t.columns.map((c) => ({ ...c, dataType: c.dataType.replace(/^timestamp\(6\)$/, 'timestamp') })) })), model.tables, { model: true })
    expect(changes).toEqual([])
  })

  it('names the provider of each database and leaves the URL to prisma.config.ts', () => {
    expect(toPrisma(model.tables, { database: 'mysql' })).toContain('provider = "mysql"')
    expect(toPrisma(model.tables, { database: 'mssql' })).toContain('provider = "sqlserver"')
    expect(toPrisma(model.tables, { database: 'sqlite' })).toContain('provider = "sqlite"')
    expect(toPrisma(model.tables, { database: 'cockroachdb' })).toContain('provider = "cockroachdb"')
    expect(toPrisma(model.tables)).not.toMatch(/^\s*url\s*=/m)
    // MySQL can't key TEXT: a bounded string, as the app's own scripts make it.
    expect(toPrisma(model.tables, { database: 'mysql' })).toMatch(/email\s+String\s+@unique.*@db\.VarChar\(255\)/)
    // MySQL's inline ENUM is an enum named after its table and column.
    const inline = toPrisma(parseDbml("Table t {\n  id int [pk]\n  size \"enum('s','m')\"\n}\n").tables, { database: 'mysql' })
    expect(inline).toMatch(/size\s+t_size\?/)
    expect(inline).toMatch(/enum t_size \{\s+s\s+m\s+\}/)
  })

  it('writes Drizzle tables with references, composite keys and enums', () => {
    const drizzle = toDrizzle(model.tables, { enums: model.enums })
    expect(drizzle).toContain("from 'drizzle-orm/pg-core'")
    expect(drizzle).toContain("export const orderStatus = pgEnum('order_status', ['new', 'paid', 'on hold']);")
    expect(drizzle).toContain("customerId: integer('customer_id').notNull().references((): AnyPgColumn => customers.id),")
    expect(drizzle).toContain("orderId: bigint('order_id', { mode: 'number' }).notNull().references((): AnyPgColumn => orders.id, { onDelete: 'cascade' }),")
    expect(drizzle).toContain('primaryKey({ columns: [table.orderId, table.lineNo] }),')
    expect(drizzle).toContain('foreignKey({ columns: [table.orderId, table.lineNo], foreignColumns: [orderLines.orderId, orderLines.lineNo]')
    expect(drizzle).toContain("createdAt: timestamp('created_at', { mode: 'string' }).notNull().defaultNow(),")
    expect(drizzle).toContain("detailId: integer('Detail ID').primaryKey(),")
    // A referenced table comes first.
    expect(drizzle.indexOf('export const customers')).toBeLessThan(drizzle.indexOf('export const orders'))
    expect(toDrizzle(model.tables, { database: 'mysql' })).toContain("from 'drizzle-orm/mysql-core'")
    expect(toDrizzle(model.tables, { database: 'sqlite' })).toContain(".primaryKey({ autoIncrement: true })")
    expect(() => toDrizzle(model.tables, { database: 'mssql' })).toThrow()
  })

  it('writes SQLAlchemy 2.0 models that Python 3.9 can read', () => {
    const py = toSqlAlchemy(model.tables, { enums: model.enums })
    expect(py).toContain('class Base(DeclarativeBase):')
    expect(py).toContain('__tablename__ = "orders"')
    expect(py).toContain('billing_customer_id: Mapped[Optional[int]] = mapped_column(Integer(), ForeignKey("customers.id", name="fk_orders_billing_customer_id"), nullable=True)')
    expect(py).toContain('ForeignKeyConstraint(["order_id", "line_no"], ["order_lines.order_id", "order_lines.line_no"]')
    expect(py).toContain('server_default=text("CURRENT_TIMESTAMP")')
    expect(py).toContain('Enum("new", "paid", "on hold", name="order_status")')
    expect(py).toContain('Detail_ID: Mapped[int] = mapped_column("Detail ID", Integer(), primary_key=True)')
    // No `X | None` (Python 3.10+), and a table without a key is a Table.
    expect(py).not.toMatch(/\| None/)
    expect(py).toContain('t_audit_log = Table(')
    expect(toSqlAlchemy(parseDbml('Table t {\n  id "int unsigned" [pk]\n}\n').tables, { database: 'mysql' })).toContain('Integer().with_variant(mysql.INTEGER(unsigned=True), "mysql")')
  })

  it('writes TypeScript row types as the drivers return them', () => {
    const ts = toTypeScript(model.tables, { enums: model.enums })
    expect(ts).toContain("export type OrderStatus = 'new' | 'paid' | 'on hold';")
    expect(ts).toMatch(/export interface Orders \{\n {2}id: string;\n {2}customer_id: number;\n {2}billing_customer_id: number \| null;\n {2}status: OrderStatus;\n {2}total: string;/)
    expect(ts).toContain("  'Detail ID': number;")
    expect(ts).toContain('  /** The name on the invoice */')
    expect(ts).toContain('created_at: Date;')
  })
})
