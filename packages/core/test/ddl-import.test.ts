import { describe, expect, it } from 'vitest'
import { compareSchemas, createScript, getDialect, parseDbml, tablesFromDdl, toDbml } from '../src/index.js'

describe('DDL import', () => {
  it('reads PostgreSQL DDL including foreign keys declared before their target', async () => {
    const { tables, skipped } = await tablesFromDdl(`
      CREATE TABLE public.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id integer NOT NULL REFERENCES customers(id), total numeric(12,2));
      CREATE TABLE public.customers (id serial PRIMARY KEY, email varchar(200) UNIQUE NOT NULL);
      COMMENT ON TABLE customers IS 'People';
      CREATE INDEX ix_orders_customer ON orders (customer_id);
      ALTER TABLE ONLY public.customers OWNER TO app;
    `)
    expect(skipped).toEqual([])
    const orders = tables.find((t) => t.name === 'orders')!
    expect(orders.foreignKeys[0]).toMatchObject({ columns: ['customer_id'], refTable: 'customers' })
    expect(orders.indexes.some((i) => i.name === 'ix_orders_customer')).toBe(true)
    expect(tables.find((t) => t.name === 'customers')!.comment).toBe('People')
  })

  it('reads MySQL and SQL Server flavoured DDL', async () => {
    const mysql = await tablesFromDdl("CREATE TABLE `items` (`id` int unsigned NOT NULL AUTO_INCREMENT, `name` varchar(50) COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Name', PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;")
    expect(mysql.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'name'])
    expect(mysql.tables[0]!.primaryKey).toEqual(['id'])
    const mssql = await tablesFromDdl('CREATE TABLE [dbo].[notes] ([id] [int] IDENTITY(1,1) NOT NULL, [body] [nvarchar](max) NULL, CONSTRAINT [PK_notes] PRIMARY KEY CLUSTERED ([id] ASC) ON [PRIMARY]) ON [PRIMARY]\nGO')
    expect(mssql.skipped).toEqual([])
    expect(mssql.tables[0]!.columns.map((c) => c.name)).toEqual(['id', 'body'])
  })

  it('keeps the types, identities and schemas the script declares', async () => {
    const { tables } = await tablesFromDdl(`
      CREATE TABLE public.customers (id serial PRIMARY KEY, email character varying(200) NOT NULL, credit numeric(12, 2) DEFAULT 0);
      CREATE TABLE sales.orders (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_id integer REFERENCES public.customers(id), note varchar(40) UNIQUE, placed timestamp with time zone);
      CREATE TABLE [dbo].[notes] ([id] [int] IDENTITY(1,1) NOT NULL, [body] [nvarchar](300) NULL, CONSTRAINT [PK_notes] PRIMARY KEY ([id]))
      GO
      CREATE TABLE \`items\` (\`id\` int(11) unsigned NOT NULL AUTO_INCREMENT, \`flag\` tinyint(1) DEFAULT '0' COMMENT 'not an identity, no auto_increment, default off',
        \`memo\` text COMMENT 'two\\nlines, a back\\\\slash and it''s', \`name\` varchar(50) COLLATE utf8mb4_bin DEFAULT NULL, PRIMARY KEY (\`id\`));
    `)
    const t = (name: string) => tables.find((x) => x.name === name)!
    expect(t('customers').schema).toBe('public')
    expect(t('customers').columns.map((c) => [c.name, c.dataType, c.isIdentity])).toEqual([['id', 'integer', true], ['email', 'character varying(200)', false], ['credit', 'numeric(12,2)', false]])
    expect(t('orders').schema).toBe('sales')
    expect(t('orders').columns.map((c) => c.dataType)).toEqual(['bigint', 'integer', 'varchar(40)', 'timestamp with time zone'])
    expect(t('orders').columns[0]!.isIdentity).toBe(true)
    expect(t('orders').foreignKeys[0]).toMatchObject({ refSchema: 'public', refTable: 'customers' })
    expect(tables.flatMap((x) => [...x.indexes.map((i) => i.name), ...x.foreignKeys.map((f) => f.name)]).filter((n) => n.includes('__dbm__'))).toEqual([])
    expect([t('notes').schema, t('notes').columns.map((c) => c.dataType), t('notes').columns[0]!.isIdentity]).toEqual(['dbo', ['int', 'nvarchar(300)'], true])
    expect([t('items').columns[1]!.isIdentity, t('items').columns[1]!.comment, t('items').columns[1]!.defaultValue]).toEqual([false, 'not an identity, no auto_increment, default off', '0'])
    expect(t('items').columns.find((c) => c.name === 'memo')!.comment).toBe("two\nlines, a back\\slash and it's")
    expect([t('items').schema, t('items').columns.map((c) => c.dataType), t('items').columns[0]!.isIdentity]).toEqual([undefined, ['int', 'tinyint(1)', 'text', 'varchar(50)'], true])
  })

  it('reads a SQL Server script as sqlpackage writes it', async () => {
    const { tables, skipped } = await tablesFromDdl(`CREATE TABLE [dbo].[shift] (
    [id]      INT                IDENTITY (1, 1) NOT NULL,
    [opens]   TIME (7)           NULL,
    [day]     DATE               CONSTRAINT [DF_shift_day] DEFAULT (CONVERT([date],getdate())) NOT NULL,
    [rate]    FLOAT (53)         NULL,
    [at]      DATETIMEOFFSET (7) NULL,
    CONSTRAINT [PK_shift] PRIMARY KEY CLUSTERED ([id] ASC)
);

GO
`)
    expect(skipped).toEqual([])
    const model = parseDbml("Table dbo.shift {\n  id int [pk, increment]\n  opens time\n  day date [not null, default: `CAST(GETDATE() AS date)`]\n  rate float\n  at datetimeoffset\n}\n").tables
    expect(compareSchemas(model, tables).map((c) => `${c.kind} ${'column' in c ? c.column : ''}`)).toEqual([])
  })

  it('takes foreign keys as written: cycles, a table that references itself, actions', async () => {
    const { tables, skipped } = await tablesFromDdl(`
      CREATE TABLE a (id integer PRIMARY KEY, b_id integer NOT NULL, CONSTRAINT a_b FOREIGN KEY (b_id) REFERENCES b (id) ON DELETE CASCADE);
      CREATE TABLE b (id integer PRIMARY KEY, a_id integer REFERENCES a ON UPDATE SET NULL NOT NULL, parent_id integer CONSTRAINT b_parent REFERENCES b(id));
      COMMENT ON TABLE b IS 'Kept';
    `)
    expect(skipped).toEqual([])
    const t = (name: string) => tables.find((x) => x.name === name)!
    expect(t('a').foreignKeys).toEqual([{ name: 'a_b', columns: ['b_id'], refSchema: undefined, refTable: 'b', refColumns: ['id'], onDelete: 'CASCADE' }])
    expect(t('b').foreignKeys.map((k) => [k.name, k.columns[0], k.refTable, k.refColumns[0], k.onUpdate])).toEqual([
      ['fk_b_a_id', 'a_id', 'a', 'id', 'SET NULL'],
      ['b_parent', 'parent_id', 'b', 'id', undefined],
    ])
    expect(t('b').columns.find((c) => c.name === 'a_id')!.nullable).toBe(false)
    expect(t('b').comment).toBe('Kept')
  })

  it('reads foreign keys pg_dump adds after the tables, with their actions', async () => {
    const { tables, skipped } = await tablesFromDdl(`
      CREATE TABLE public.parent (id integer NOT NULL);
      CREATE TABLE public.child (id integer NOT NULL, parent_id integer);
      CREATE SEQUENCE public.child_id_seq AS integer START WITH 1 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1;
      ALTER TABLE ONLY public.child ALTER COLUMN id SET DEFAULT nextval('public.child_id_seq'::regclass);
      ALTER TABLE public.parent ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (SEQUENCE NAME public.parent_id_seq START WITH 1 INCREMENT BY 1);
      CREATE TABLE public.legacy (id integer DEFAULT nextval('public.legacy_id_seq'::regclass) NOT NULL);
      ALTER TABLE ONLY public.parent ADD CONSTRAINT parent_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY public.child ADD CONSTRAINT child_pkey PRIMARY KEY (id);
      ALTER TABLE ONLY public.child ADD CONSTRAINT child_parent_fk FOREIGN KEY (parent_id) REFERENCES public.parent(id) ON DELETE CASCADE NOT VALID;
      COMMENT ON TABLE public.parent IS 'Holds [DATETIME] and BIT values: public.parent stays as written';
    `)
    expect(skipped).toEqual([])
    expect(tables.map((t) => [t.name, t.columns[0]!.isIdentity, t.columns[0]!.defaultValue ?? null]).sort()).toEqual([['child', true, null], ['legacy', true, null], ['parent', true, null]])
    expect(tables.find((t) => t.name === 'parent')!.comment).toBe('Holds [DATETIME] and BIT values: public.parent stays as written')
    expect(tables.find((t) => t.name === 'child')!.foreignKeys).toEqual([{ name: 'child_parent_fk', columns: ['parent_id'], refSchema: 'public', refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE' }])
  })

  it("reads back a model's own CREATE script as the same model, for every database", async () => {
    const model = parseDbml(
      "Table shop.customer {\n  id integer [pk, increment]\n  email varchar(120) [not null, unique, note: 'Login (it''s unique); DATETIME and [x] are words here']\n  credit numeric(12,2) [default: 0]\n  status varchar(10) [not null, default: 'new']\n  born date\n  created timestamp [not null, default: `now()`]\n  Note: 'Zákazník'\n}\nTable shop.invoice {\n  id bigint [pk, increment]\n  customer_id integer [not null, ref: > shop.customer.id]\n  total numeric(12,2) [not null]\n  note varchar(400)\n  issued timestamp\n\n  indexes {\n    customer_id [name: 'ix_invoice_customer']\n  }\n}\n",
    ).tables
    for (const driver of ['postgres', 'mssql', 'mysql'] as const) {
      const script = createScript(model, getDialect(driver))
      const { tables, skipped } = await tablesFromDdl(script)
      expect(skipped, driver).toEqual([])
      expect(compareSchemas(model, tables).map((c) => `${c.kind} ${'column' in c ? c.column : ''}`), driver).toEqual([])
    }
  })

  it('writes a model as CREATE statements for any database', () => {
    const { tables } = parseDbml('Table a {\n  id integer [pk, increment]\n  name varchar(50)\n}\n', {})
    expect(createScript(tables, getDialect('mssql'))).toContain('[id] integer IDENTITY(1,1) NOT NULL')
    expect(createScript(tables, getDialect('postgres'))).toContain('GENERATED BY DEFAULT AS IDENTITY')
    expect(toDbml(tables)).toContain('Table a')
  })
})
