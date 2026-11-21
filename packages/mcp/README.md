# dbmastermind-mcp

An MCP server that lets AI agents (Claude Code, Codex, Cursor, Claude Desktop, VS Code and others) explore and
query your databases, read-only unless you allow writes. The package also installs `dbm`, a command line for
scripts and CI.

**PostgreSQL · SQL Server · Oracle · MySQL · MariaDB · SQLite · DuckDB · ClickHouse · BigQuery · Trino ·
CockroachDB.** Hosted services that run one of these engines work the same way (Supabase, Neon, Amazon RDS,
Azure SQL, Google Cloud SQL and others).

Needs Node.js 22.16 or newer. Free and open source (MIT).

## Quick start

Claude Code:

```bash
claude mcp add shop -- npx -y dbmastermind-mcp --url 'postgres://me:${PGPASSWORD}@localhost:5432/shop'
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.shop]
command = "npx"
args = ["-y", "dbmastermind-mcp", "--url", "jdbc:sqlserver://sql01:1433;databaseName=Sales;user=report;password=${SQL_PASSWORD};trustServerCertificate=true"]
```

Claude Desktop, Cursor, Windsurf, Gemini CLI and other clients with a JSON config:

```json
{
  "mcpServers": {
    "shop": {
      "command": "npx",
      "args": ["-y", "dbmastermind-mcp", "--url", "sqlite:///Users/me/data/shop.db"]
    }
  }
}
```

VS Code uses the key `servers` instead of `mcpServers`.

`${NAME}` in a URL or a `--config` file is replaced with the environment variable `NAME` when the server starts, so
passwords don't have to be written into the agent's configuration. In a shell, keep such a URL in single quotes (or
the shell replaces it first), and make sure the agent passes the variable to the servers it starts; most clients take
an `env` entry next to `command` and `args`.

## Connection URLs

| Database | `--url` |
|---|---|
| PostgreSQL, CockroachDB | `postgres://user:password@host:5432/db?sslmode=require` |
| SQL Server | `sqlserver://user:password@host:1433/db`, JDBC (`jdbc:sqlserver://host:1433;databaseName=db;user=…;password=…`) or ADO.NET (`Server=host,1433;Database=db;User Id=…;Password=…`) |
| Oracle | `oracle://user:password@host:1521/service` or `jdbc:oracle:thin:user/password@host:1521/service` |
| MySQL, MariaDB | `mysql://user:password@host:3306/db`, `mariadb://…` |
| SQLite | `sqlite:///path/to/file.db` |
| DuckDB | `duckdb:///path/to/file.duckdb`, or `duckdb://` for an in-memory database |
| ClickHouse | `clickhouse://user:password@host:8123/db` |
| Trino | `trino://user@host:8080/catalog/schema` |
| BigQuery | with `--config`: `{ "name": "bq", "driver": "bigquery", "database": "<project id>", "filePath": "<service account key.json>" }` (without `filePath`, Google's application default credentials) |

JDBC URLs (`jdbc:postgresql://…?user=…&password=…`) work as well.

## What agents get

- **Schema**: `list_connections`, `list_tables`, `describe_table` (columns, keys, indexes, comments, incoming
  references), `search_schema`, `get_relationships`, `find_join_path` (the shortest join chain, with ready SQL),
  `get_definition` (the SQL of a view, function or procedure; a table's CREATE)
- **Data**: `sample_rows`, `run_query` (results as compact CSV), `explain_query` (the plan as a tree)
- **Knowledge base**: point `--knowledge` at a folder of Markdown notes about the database. Agents search and
  read them (`search_knowledge`, `read_knowledge`), and relationships declared there
  (`relations: ["orders.customer_code -> customers.code"]`) count as foreign keys. With
  `--allow-knowledge-writes` they can also add notes (`write_knowledge`).
- **Prompts**: `explore_database`, `document_database`

**Read-only by default.** Without `--allow-writes`, statements run in a read-only transaction that is always rolled
back, so a function that writes or a statement that only looks like a SELECT can't change anything. With
`--read-only` the database session itself is read-only where the engine supports it. `--schema-only` never
returns table contents.

## Options

| Flag | |
|---|---|
| `--url <url>` | A connection (see above). Repeat it for several databases. |
| `--name <name>` | Name for the preceding `--url` (default: host/database) |
| `--knowledge <dir>` | Knowledge base folder for the preceding `--url` |
| `--config <file>` | JSON array of connections: `name`, `url` or `driver`/`host`/`port`/`database`/`user`/`password`, `knowledgeBase`, `readOnly` |
| `--allow-writes` | Allow INSERT, UPDATE, DELETE and DDL |
| `--allow-knowledge-writes` | Let agents create knowledge base files |
| `--schema-only` | Never return table contents |
| `--read-only` | Mark every connection read-only (enforced by the database where supported) |

## `dbm`: the command line

The same connections (`--url`, `--config`, `${ENV}` placeholders) for scripts and CI:

```bash
npx -p dbmastermind-mcp dbm query --url "$DATABASE_URL" "SELECT * FROM orders WHERE created_at > now() - interval '1 day'" --format csv --out orders.csv
npx -p dbmastermind-mcp dbm dictionary --url "$DATABASE_URL" --format html --out docs/database.html
npx -p dbmastermind-mcp dbm check model.dbml                        # model checks; exit 1 when a table has problems
npx -p dbmastermind-mcp dbm diff model.dbml --url "$DATABASE_URL"   # exit 2 and the migration when the database drifted
```

`query` streams one SELECT of any size (csv, tsv, json, jsonl, markdown) and is read-only unless `--allow-writes`.
`diff` never changes the database and keeps tables only the database has unless `--drop-extra`.
`npx -p dbmastermind-mcp dbm --help` lists everything.

## The desktop app

This package is part of [DB Mastermind](https://dbmastermind.app), a free, open-source database client and data
modeler for Windows, macOS and Linux. The app can be the MCP server too, with your saved connections and the
passwords in your system keychain (Settings → MCP server), and there agents can also propose a new connection,
which you review and save in the app.

- Website: [dbmastermind.app](https://dbmastermind.app) · [Privacy](https://dbmastermind.app/privacy.html)
- Source and issues: [github.com/eLh0m3r0/db-mastermind](https://github.com/eLh0m3r0/db-mastermind)

## License

MIT
