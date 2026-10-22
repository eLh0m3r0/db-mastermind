# Team AI tools (`tools/*.sql`)

Give the AI assistant, and agents connected over MCP (Claude Code, Codex, Cursor…), ready-made answers to your
team's common questions. A tool is a SQL file in the connection's knowledge base folder, under `tools/`:

```sql
-- tool: open_invoices
-- description: Unpaid invoices of one customer, oldest first
-- param: customer_id (number, required): customers.id
-- param: currency (string): ISO code, e.g. CZK
SELECT i.number, i.due_date, i.amount
FROM invoices i
WHERE i.customer_id = :customer_id
  AND i.paid_at IS NULL
  AND (:currency IS NULL OR i.currency = :currency)
ORDER BY i.due_date
```

- **`-- tool:`** is the name the AI calls: letters, digits, `_` or `-`. Without it, the file name is used.
- **`-- description:`** tells the AI when to use the tool, so write it like the question it answers. It's required,
  and a plain comment on the next line continues it.
- **`-- param: name (type, required): description`**: the type is `string`, `number` or `boolean`. Use the
  parameter in the SQL as `:name`.
- Tools only read. Anything other than `SELECT`/`WITH` is refused, and values are bound as parameters, never
  pasted into the SQL.
- If the user shares only the schema with AI (Settings → AI assistant), tools are refused as well, because they
  return data.

In the app, the **wrench** button in the knowledge base lists the tools, shows files that aren't valid and why,
and creates a new tool from a template. Tools travel with the knowledge base, so a team shares them through Git
or the [team folder](team-folder.md).
