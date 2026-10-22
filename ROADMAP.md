# DB Mastermind — Roadmap

> The most capable free & open-source database client, with AI that actually knows your data model.
> Everything is free. There is no "Pro" tier, no feature gates, no telemetry.

Legend: ✅ done · 🚧 in progress · ⬜ planned · 💡 idea / research

This file is the single source of truth for what is being built. It is maintained by the
project's (AI) maintainer and updated with every release.

---

## Guiding principles

1. **No limits.** Unlimited connections, tabs, rows, saved queries, diagrams. Nothing paywalled — ever.
2. **Keyboard-first, mouse-friendly.** Every action reachable from the command palette (`Ctrl/Cmd+K`).
3. **Safe by default.** Explicit read-only connections, confirmation before destructive SQL on
   production-tagged connections, AI is read-only unless the user opts in.
4. **Runs anywhere, installs nowhere.** Windows portable `.zip` (no admin, no installer), per-user
   installer, macOS `.dmg`, Linux AppImage/deb.
5. **AI is a power tool, not a gimmick.** Schema-aware, knowledge-base-aware, works with your own API key,
   local models, or your existing Claude Code / Codex subscription, and exposes the same capabilities
   to external agents via MCP.
6. **Local-first & private.** Credentials encrypted with the OS keychain. Nothing leaves the machine
   unless the user sends it to an AI provider they configured.

---

## Milestone 0 — Foundation (v0.1) ✅ released, polishing in v0.1.x

### Platform & distribution
- ✅ Electron + TypeScript + React monorepo (`packages/core`, `packages/mcp`, `apps/desktop`)
- ✅ GitHub Actions CI: typecheck, lint, unit tests, integration tests against real PostgreSQL / MySQL /
  MariaDB / SQL Server containers
- ✅ Release pipeline: tag → build for macOS (arm64 + x64), Windows (x64 + arm64), Linux (x64)
- ✅ Windows: portable `.zip` (settings stored next to the exe), per-user NSIS installer (no admin)
- ✅ Update notification from GitHub Releases (all builds)
- ✅ Auto-update for the Windows installer (NSIS) and Linux AppImage: downloads in the background, "Restart now" or installs on quit. macOS keeps the download link until builds are signed; portable/MSI/Scoop are updated by their owners
- ✅ Settings & data stored in OS app-data dir, or `./data` next to the executable in portable mode

### Connections
- ✅ Drivers: **PostgreSQL**, **SQL Server / Azure SQL**, **MySQL**, **MariaDB**, **SQLite**
- ✅ Connection form with URL paste (`postgres://…`, `mysql://…`, `sqlserver://…`, JDBC strings)
- ✅ SSL/TLS (disable / require / verify-ca / verify-full, custom CA/cert/key)
- ✅ SSH tunnel (password, private key, agent)
- ✅ Secrets encrypted with OS keychain (Electron `safeStorage`)
- ✅ Connection colors, groups/folders, environment tag (dev / test / prod) with prod safety rails
- ✅ Read-only connection mode (enforced at session level where the DB supports it)
- ✅ Test connection, reconnect, keep-alive
- ✅ Import connections from Beekeeper Studio, DBeaver, DataGrip/IntelliJ, `.pgpass` (with passwords), a colleague's JSON

### Schema explorer
- ✅ Tree: databases → schemas → tables / views / materialized views / functions / procedures / sequences
- ✅ Instant fuzzy filter over thousands of objects
- ✅ Column details (type, nullability, default, PK/FK/identity, comments) on hover
- ✅ Pin favourite tables to the top of the explorer
- ✅ Hide chosen schemas per connection
- ✅ Context actions: open data, open structure, copy name, generate SELECT/INSERT/UPDATE/DELETE, count rows,
  open in diagram, ask AI about table

### Table data browser
- ✅ Virtualized data grid (millions of rows via paging, smooth scrolling, no row limits)
- ✅ Column resize (double-click to auto-fit), reorder, hide, pin (freeze) leading columns; remembered per table
- ✅ Sort by multiple columns
- ✅ **Advanced filter builder** — nested AND/OR groups, 20+ operators (equals, contains, starts with,
  regex, in list, between, is null, is empty, date ranges like "last 7 days"…), per-column quick filters,
  raw SQL `WHERE` mode, filters saved per table, filter presets
- ✅ Quick filter from cell ("filter by this value", "exclude this value")
- ✅ Inline editing with pending-changes panel, review generated SQL, commit/discard
- ✅ Insert / clone / delete rows, set NULL / DEFAULT
- ✅ Foreign key navigation: click an FK value → open referenced row; "referenced by" panel
- ✅ Cell viewer/editor (⇧↵ or right-click): JSON format/minify with validation, long text, binary as hex with image preview; row details panel
- ✅ Copy as TSV / CSV / JSON / Markdown / SQL INSERT; paste blocks from Excel / Sheets (edits and new rows, as pending changes)
- ✅ Exact or estimated row counts

### SQL editor
- ✅ CodeMirror 6 editor with dialect-aware highlighting
- ✅ Schema-aware autocomplete (schemas, tables, columns, aliases, keywords, functions)
- ✅ Run statement under cursor / selection / whole script; multiple result sets
- ✅ Cancel running query; elapsed timer
- ✅ Format SQL; comment toggle; multi-cursor
- ✅ Query parameters (`:name`, `$1`, `?`) with prompt (bound, never inlined)
- ✅ Query history (searchable, per connection), saved queries in folders
- ✅ Unlimited tabs, restored on restart (including unsaved text)

### Results & export
- ✅ Result grid with the same capabilities as the data browser (filter/sort client-side)
- ✅ Export CSV, TSV, JSON, JSON Lines, Excel (.xlsx), SQL INSERT, Markdown — whole table or query result,
  streamed (no memory limit; query results beyond the row limit are re-run and streamed from the driver)

### General UX
- ✅ Command palette (`Ctrl/Cmd+K`), customizable keyboard shortcuts
- ✅ Light / dark / system theme
- ✅ English + Czech UI

---

## Milestone 1 — Relationships & diagrams (v0.2) ✅

- ✅ **Interactive ER diagram** of a schema or a selection of tables (auto layout, crow's-foot notation)
- ✅ "Explore from table": start with one table, expand neighbours by FK hop
- ✅ Join path between two tables in the diagram, with ready SELECT … JOIN SQL (also the `find_join_path` AI/MCP tool)
- ✅ Saved diagrams per connection: named subject areas with their own tables and layout, saved automatically
- ✅ Diagram table colors (saved with the diagram; DBML TableGroups color the model) and sticky notes
- ✅ Virtual / logical relationships (when the DB has no real FKs) — stored in the knowledge base and
  used by FK navigation, diagrams, autocomplete joins and AI
- ✅ Export diagram to PNG, SVG, Mermaid, DBML, PlantUML
- ✅ Join autocomplete in SQL editor based on FKs + virtual relationships
- 💡 dbdiagram-style DBML editing for designing new schemas, generate migration DDL

---

## Milestone 2 — AI (v0.3) ✅

### Providers (bring your own)
- ✅ Anthropic (Claude), OpenAI, OpenRouter (any model), Azure OpenAI, Google Gemini,
  any OpenAI-compatible endpoint, **Ollama / LM Studio** (fully local)
- ✅ **Use your existing subscription**: delegate to a locally installed **Claude Code** or **Codex CLI**
  (runs the agent headless with DB Mastermind's MCP tools attached)
- ✅ API keys encrypted with OS keychain; per-connection "AI allowed" switch; data sharing level
  (schema only / schema + sample rows / full query results)

### In-app assistant
- ✅ Chat panel with tool use: list tables, describe table, run read-only query, sample rows, read
  knowledge base, search schema
- ✅ Inline "Ask AI" in the SQL editor (`Ctrl/Cmd+I`): natural language → SQL, explain, optimize,
  fix the error that just happened ("Fix with AI" on a failed statement)
- ✅ "Explain with AI" on any table or column in the explorer (values, codes, distribution)
- ✅ AI-suggested filters in the data browser ("orders from last month over 1000 CZK"), validated against real columns
- ✅ Writes (UPDATE/DELETE/DDL) proposed by AI always require explicit user confirmation

### Knowledge base
- ✅ Per-connection folder of Markdown files (business glossary, table docs, relationships, gotchas)
- ✅ Built-in Markdown editor + file tree; works with any folder (Git repo, Obsidian vault, shared drive)
- ✅ **Generate knowledge base** with AI from schema + statistics + sample data, reviewed before saving
- ✅ Front-matter conventions (`tables:`, `columns:`, `relations:`) so docs link to schema objects;
  virtual relationships defined in Markdown
- ✅ Knowledge base used as context by in-app AI and exposed over MCP
- ✅ Staleness detection: notes about tables, columns or relationships that no longer exist are flagged, AI can fix them

### MCP server
- ✅ `npx dbmastermind-mcp` — standalone stdio MCP server using the same connections & knowledge base
- ✅ Desktop app as MCP server (`--mcp` stdio mode: saved connections + keychain passwords)
- ✅ Streamable HTTP endpoint inside the running app (localhost, bearer token, origin check; audited)
- ✅ One-click "Add to Claude Code / Claude Desktop / Codex / Cursor / VS Code" (writes their config with a .bak copy) + copyable snippets
- ✅ Tools: `list_connections`, `list_tables`, `describe_table`, `search_schema`, `run_query` (read-only by
  default), `explain_query`, `get_relationships`, `read_knowledge`, `write_knowledge` (opt-in)
- ✅ Resources: schema snapshots and knowledge base files; prompts: "document this database",
  "write a report query"

---

## Milestone 3 — Data Modeling Studio (v0.4) ✅

The dbdiagram / drawDB / DbSchema / "Design for Databases" experience, working **directly on live databases**.

### Live schema designer (design on top of the real database)
- ✅ Open the ER diagram of a live connection in **design mode**. Every edit becomes a *pending change*;
  nothing touches the database yet
- ✅ Edits: create/rename/drop table, add/rename/drop/retype column, nullability, defaults, PK, FK (drag from
  column to column), unique constraints, indexes, comments
- ✅ **Change set panel**: pending changes (persisted with the diagram, revert per table), undo/redo (⌘Z / ⇧⌘Z), per-change toggle in the migration review
- ✅ **Migration script generator** per dialect (PostgreSQL, SQL Server, MySQL/MariaDB, SQLite table-rebuild
  strategy), dependency-ordered (drop FKs → alter → recreate FKs), wrapped in a transaction where DDL is
  transactional
- ✅ **Impact analysis** before running: data-loss warnings (narrowing types, dropping columns, NOT NULL on
  columns with NULLs; counts are checked live), lock/rewrite warnings for large tables, dependent views
- ✅ Rollback script generated alongside the forward script
- ✅ Execute in the SQL editor (review first) or save as a migration file (plain SQL, Flyway `V…__name.sql`)
- ✅ A migration can be opened for another connection of the same engine (dev → test → prod); named change sets saved and loaded in the designer
- ✅ AI in the live designer: "add soft delete to all customer tables", "move the address into its own table". The AI
  proposes DBML, *Apply to design* turns it into pending changes (ALTERs, not recreates) reviewed as a migration

### Offline models
- ✅ **Model documents** as `.dbml` files (saved next to the knowledge base, versioned in Git)
- ✅ Visual designer for models: add/edit tables, columns, types, PK/FK, indexes on the canvas, written back to DBML (enums and groups kept)
- ✅ **DBML editor** with live diagram (text → canvas and canvas → text)
- ✅ Reverse engineer: model from a live connection ("From database", or "Edit as model" from any diagram)
- ✅ Forward engineer: DDL for any supported database from the model, with type translation (boolean → bit, jsonb → nvarchar(max), indexed text → bounded strings; verified by running PostgreSQL's schema on every engine)
- ✅ **Model ↔ database diff** → migration script, reviewed and opened in the SQL editor
- ✅ Model versions: compare a model with another DBML file (older copy, another branch) — changes and migration
- ✅ Import from DBML, SQL DDL scripts (pg_dump, mysqldump, SSMS) and Prisma schemas · Django/Rails migrations via the AI assistant
- ✅ Export: SQL (any engine), DBML, Mermaid, PlantUML, PNG, SVG, HTML data dictionary (PDF via its print view)
- ✅ AI on models: design or extend, review, suggest indexes, normalize, add audit columns — results apply to the model
- ✅ **Data dictionary** of a live database: self-contained HTML (search, dark mode, print) or Markdown, with knowledge base notes
- ✅ Data dictionary for model documents (HTML)
- 💡 Logical vs physical model, subject areas (multiple diagrams per model)

---

## Milestone 4 — Power tools (v0.5)

- ✅ Table structure editor (columns, indexes, constraints, FKs) with DDL preview: "Edit structure" opens the live designer
- ✅ New table (in the designer); rename / empty / drop open reviewed SQL with warnings (row count, referencing tables)
- ✅ CSV / Excel import with column mapping (auto-matched by name), delimiter & Windows-1250 detection, one transaction
- ✅ Visual EXPLAIN / query plan viewer for all databases (EXPLAIN ANALYZE on PostgreSQL)
- ✅ Charts from query results (bar, line, scatter) and pinned dashboards with auto-refresh (charts, big numbers, tables)
- ✅ Schema compare (two connections / two schemas) → migration script (structural matching of keys and indexes)
- ✅ Data compare between tables / environments (any two connections, even different engines) with a sync script
- ✅ Backup / restore from the connection menu: pg_dump/pg_restore/psql, mysqldump/mysql (found on PATH or in the usual install folders), SQLite and DuckDB copies without tools, SQL Server BACKUP/RESTORE statements
- ✅ Server activity: sessions and running queries with auto-refresh, cancel query, end session (PG, MySQL/MariaDB, MSSQL, Oracle)
- ✅ Server activity: lock waits (who waits for whom), blocking sessions highlighted even when idle
- ✅ Users & roles browser: memberships, members and object privileges (PostgreSQL incl. column grants, MySQL/MariaDB, SQL Server, Oracle)
- ✅ Snippets with fields (built-in, dialect-aware: sel, cnt, dup, orph, cte, tx…; your own in Settings)
- ✅ Pin a result to keep it next to the next query's results · split view: any two tabs side by side (⌘\ or tab menu → Open to the side)

---

## Milestone 5 — More databases (v0.6)

- ✅ Oracle (thin mode, no Instant Client: PL/SQL blocks, explain plans, migrations)
- ✅ DuckDB (in process): `.duckdb` files, and SQL straight over CSV / Parquet / JSON / Excel files — "Query a file",
  drag & drop, Czech decimal-comma CSVs detected
- ✅ CockroachDB through the PostgreSQL driver (schema, editing, streaming, its own EXPLAIN and session views,
  designer migrations; integration-tested in CI). TimescaleDB, Supabase, Neon and other PostgreSQL-compatible services
  work as PostgreSQL
- ✅ ClickHouse over HTTP: schema (sorting keys, engines, views), filters, SQL, streaming exports, EXPLAIN; read-only
  grid (no row-level UPDATE); integration-tested in CI
- ⬜ Redshift, Snowflake, BigQuery, Cassandra (need cloud accounts to test)
- 💡 MongoDB, Redis (document/key-value browsers)
- ✅ SQL Server Windows (integrated) authentication (msnodesqlv8 + ODBC, tested on Windows CI)

---

## Milestone 6 — Teams & enterprise (v0.7, see docs/STRATEGY.md)

- ✅ Managed configuration file (pre-defined connections, AI endpoints, policies) for IT departments — docs/managed-config.md
- ✅ Share connections with colleagues: export without passwords/keys, import from the file
- ✅ Shared team folder (network drive, OneDrive, Git): connections, knowledge bases, saved queries, ER diagrams
  kept in sync automatically
- ✅ Audit log: every statement (editor, grid edits, imports, the in-app AI and external MCP agents) with its source, exportable to CSV
- ✅ MSI package for Intune / SCCM (per-machine, silent `msiexec /i … /qn`; CI installs it and runs the smoke test)

---

## Milestone 7 — v1.0

- ✅ Website on GitHub Pages (docs/index.html) with a download button for your OS; Czech quick guide (docs/navod.md), team-folder and managed-config docs
- ✅ High-contrast theme (light and dark, WCAG AA text; follows the OS "increase contrast" setting), Windows forced-colors support, visible focus rings
- ✅ AI tool plugins: `tools/*.sql` in the knowledge base become read-only, parameter-bound tools for the assistant and MCP
  agents (docs/ai-tools.md; verified end to end with Claude Code over MCP)
- 💡 Driver plugins (third-party code in the app needs a sandbox and signing story first)
- ⬜ Mac App Store and Microsoft Store editions
- ⬜ Code signing (macOS notarization, Windows signing) once sponsored
- ✅ Scoop manifest and Homebrew cask (this repo is the tap) updated with every release · winget ⬜

---

## Comparison target

What Beekeeper Studio's free edition limits or lacks, and what DB Mastermind ships for free:

| Capability | DB Mastermind |
|---|---|
| Unlimited tabs, connections, saved queries | ✅ always |
| SQL Server, Oracle, and other "Ultimate" drivers | ✅ free |
| Advanced nested filters | ✅ |
| ER diagrams & relationship exploration | ✅ |
| AI with your own key / local model / subscription | ✅ |
| MCP server for external agents | ✅ |
| Knowledge base of your data model | ✅ |
| Portable Windows build without install | ✅ |
