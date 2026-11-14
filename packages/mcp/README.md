# dbmastermind-mcp

MCP server that gives AI agents (Claude Code, Codex, Cursor, Claude Desktop, VS Code…) safe access to your
databases: **PostgreSQL, SQL Server, Oracle, MySQL, MariaDB, SQLite, DuckDB**.

- Read-only by default: writes only with `--allow-writes`, and read-only connections stay read-only
- Schema exploration: `list_tables`, `describe_table` (columns, keys, indexes, comments, incoming references),
  `search_schema`, `get_relationships`, `find_join_path` (shortest join chain with ready SQL), `get_definition`
  (the SQL of a view, function or procedure; a table's CREATE)
- Data: `sample_rows`, `run_query` (results as compact CSV), `explain_query` (normalized plan tree)
- **Knowledge base**: point `--knowledge` at a folder of Markdown notes about the database; agents search and
  read them (`search_knowledge`, `read_knowledge`), and relationships declared there
  (`relations: ["orders.customer_code -> customers.code"]`) count as foreign keys
- Prompts: `explore_database`, `document_database`

Part of [DB Mastermind](https://github.com/eLh0m3r0/db-mastermind), a free open-source database client. The
desktop app can also act as this MCP server, using your saved connections and keychain passwords
(Settings → MCP server). There agents also get `propose_connection`: they can suggest a connection, which the
app shows to you to review, type the password and save; nothing is saved or connected before you do.

## Usage

```bash
# Claude Code
claude mcp add shop -- npx -y dbmastermind-mcp --url "postgres://me:${PGPASSWORD}@localhost/shop" --knowledge ./docs/db

# Codex CLI (~/.codex/config.toml)
[mcp_servers.shop]
command = "npx"
args = ["-y", "dbmastermind-mcp", "--url", "sqlserver://report:secret@sql01:1433;databaseName=Sales;trustServerCertificate=true"]
```

Options:

| Flag | |
|---|---|
| `--url <url>` | Connection URL: `postgres://`, `mysql://`, `mariadb://`, `sqlserver://`, `sqlite:///path`, JDBC or ADO.NET strings. Repeatable. `${ENV}` placeholders are expanded. |
| `--name <name>` | Name for the preceding `--url` |
| `--knowledge <dir>` | Knowledge base folder for the preceding `--url` |
| `--config <file>` | JSON array of connections (`name`, `url` or `driver/host/port/database/user/password`, `knowledgeBase`, `readOnly`) |
| `--allow-writes` | Allow INSERT/UPDATE/DELETE/DDL |
| `--allow-knowledge-writes` | Let agents create knowledge base files |
| `--schema-only` | Never return table contents |
| `--read-only` | Mark all connections read-only (enforced by the database where supported) |

## `dbm`: the command line for scripts and CI

The package also installs `dbm`, which uses the same connections (`--url`, `--config`, `${ENV}` placeholders):

```bash
npx -p dbmastermind-mcp dbm query --url "$DATABASE_URL" "SELECT * FROM orders WHERE created_at > now() - interval '1 day'" --format csv --out orders.csv
npx -p dbmastermind-mcp dbm dictionary --url "$DATABASE_URL" --format html --out docs/database.html
npx -p dbmastermind-mcp dbm check model.dbml            # model checks; exit 1 when a table has problems
npx -p dbmastermind-mcp dbm diff model.dbml --url "$DATABASE_URL"   # exit 2 + the migration when the database drifted
```

`query` streams one SELECT of any size (csv, tsv, json, jsonl, markdown) and is read-only unless `--allow-writes`.
`diff` keeps tables only the database has unless `--drop-extra`.

## License

MIT
