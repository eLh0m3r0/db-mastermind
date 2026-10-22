<div align="center">

<img src="apps/desktop/build/icon.png" width="96" alt="" />

# DB Mastermind

**The free, open-source database client that understands your data model.**

Browse, filter, query, diagram and redesign databases, with an AI assistant that knows your schema and your
team's notes. It also exposes everything over MCP to Claude Code, Codex, Cursor and other agents.

[Download](https://github.com/eLh0m3r0/db-mastermind/releases/latest) · [Roadmap](ROADMAP.md) · [Report an issue](https://github.com/eLh0m3r0/db-mastermind/issues/new)

PostgreSQL · SQL Server · MySQL · MariaDB · SQLite — Windows · macOS · Linux — MIT, no feature limits

</div>

![Table browser with nested filters and row details](docs/screenshots/table-filters.png)

## Highlights

**A great everyday client**
- Virtualized data grid: millions of rows, inline editing with a reviewed change set, copy as TSV / CSV / JSON /
  Markdown / SQL, row details panel
- **Advanced filters**: nested AND/OR groups, 25+ operators (contains, in list, between, regex, *last N days*,
  *this month*…), raw `WHERE`, quick filters from any cell
- **Foreign keys everywhere**: click an arrow in a cell to open the referenced row, or jump to rows that
  reference this one
- SQL editor with schema-aware autocomplete, multiple result sets, cancel, format, history and saved queries
- Export a page or the whole (filtered) table to CSV, Excel, JSON, SQL or Markdown, streamed with no row limit
- Command palette (`Ctrl/⌘ K`), quick table open (`Ctrl/⌘ P`), light & dark themes

![SQL editor](docs/screenshots/query.png)

**Understand and redesign the model**
- **Interactive ER diagrams** with automatic layout, crow's-foot notation, focus on a table and its neighbours,
  export to PNG / SVG / Mermaid / DBML
- **Schema designer on the live database**: edit tables, columns, keys and indexes right on the diagram. DB
  Mastermind generates the migration for your database (including SQLite table rebuilds and dependent views),
  checks the existing data first (NULLs, duplicates, orphans) and writes a rollback script

![Schema designer](docs/screenshots/designer.png)
![Generated migration with impact checks](docs/screenshots/migration.png)

**AI that knows your database**
- Bring your own model: **Anthropic, OpenAI, OpenRouter, Gemini, Azure OpenAI, Ollama / LM Studio** (local)
- …or use your existing **Claude Code** or **Codex** subscription, with nothing extra to pay
- The assistant explores the schema, runs read-only queries, and asks before any write
- **Knowledge base**: a folder of Markdown notes per database (business meaning, codes, joins, gotchas).
  The AI reads it, and can write the first version for you. Relationships documented there
  (`relations: ["orders.customer_code -> customers.code"]`) show up in diagrams and FK navigation

![AI assistant using the knowledge base](docs/screenshots/ai.png)

## Install

Download from [Releases](https://github.com/eLh0m3r0/db-mastermind/releases/latest):

| Platform | File |
|---|---|
| **Windows, no installation** (no admin rights, settings stay in the folder) | `DB-Mastermind-<version>-win-x64-portable.zip` → unzip → run `DB Mastermind.exe` |
| Windows installer (per user, no admin) | `DB-Mastermind-<version>-win-x64-setup.exe` |
| macOS Apple Silicon / Intel | `DB-Mastermind-<version>-mac-arm64.dmg` / `-mac-x64.dmg` |
| Linux | `DB-Mastermind-<version>-linux-x86_64.AppImage` or `-linux-amd64.deb` |

Builds aren't code-signed yet. **macOS**: right-click the app → *Open* the first time (or run
`xattr -dr com.apple.quarantine "/Applications/DB Mastermind.app"`). **Windows**: *More info → Run anyway*.

New to the app? Click **Try the demo database** on the start screen.

## Use it from Claude Code, Codex, Cursor… (MCP)

DB Mastermind can run as an MCP server, so coding agents can explore your databases safely: read-only by default,
and only connections where you allow AI. Open **Settings → MCP server** for ready-made commands. Claude Code, for example:

```bash
claude mcp add dbmastermind -- "/Applications/DB Mastermind.app/Contents/MacOS/DB Mastermind" --mcp
```

The agent gets `list_connections`, `list_tables`, `describe_table`, `search_schema`, `get_relationships`,
`sample_rows`, `run_query`, `explain_query`, `search_knowledge`, `read_knowledge` and prompts like
*document_database*.

On a server without the desktop app, use the standalone server with a connection URL (npm package coming soon;
until then build it with `npm run build -w packages/mcp` and run `node packages/mcp/dist/cli.js`):

```bash
dbmastermind-mcp --url "postgres://user:${PGPASSWORD}@host/db" --knowledge ./db-notes
```

## Knowledge base conventions

Any folder of `.md` files works. Optional front matter links notes to tables and declares relationships that
the schema doesn't:

```markdown
---
tables: [orders, order_items]
relations:
  - orders.customer_code -> customers.code
  - order_items(order_id) -> orders(id)
---
# Sales
`status` P = paid, S = shipped, X = cancelled (excluded from revenue).
```

## Development

```bash
npm install
npm run db:up              # PostgreSQL, MySQL, MariaDB, SQL Server in Docker
npm run dev                # start the app
npm test                   # unit tests
npm run test:integration   # every driver and migration against real databases
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions, [docs/STRATEGY.md](docs/STRATEGY.md) for product
direction.

## License

[MIT](LICENSE). Free for personal and commercial use.
