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
- ✅ SSL/TLS (disable / prefer / require / verify-ca / verify-full, custom CA/cert/key); prefer falls back to plain, verify-full checks the host name also through SSH; tested against TLS servers with a test CA in CI
- ✅ SSH tunnel (password, private key, agent): host keys remembered on first use and verified after, reconnects after a bastion restart; tested against a real SSH server in CI
- ✅ Secrets encrypted with OS keychain (Electron `safeStorage`)
- ✅ Connection colors, groups/folders, environment tag (dev / test / prod) with prod safety rails
- ✅ Read-only connection mode (enforced at session level where the DB supports it)
- ✅ Test connection, reconnect, keep-alive; an unreachable server (VPN down) is retried in the background and the explorer follows a reconnect made by a query — unreleased
- ✅ Import connections from the tools found on the computer (menu shows them with counts): Beekeeper Studio, DBeaver, DataGrip/IntelliJ, pgAdmin 4, SSMS, Azure Data Studio, MySQL Workbench, HeidiSQL, Navicat, Oracle SQL Developer, DbVisualizer, TablePlus, Sequel Ace, VS Code SQLTools, `.pgpass`; or from a file (format detected)

### Schema explorer
- ✅ Tree: databases → schemas → tables / views / materialized views / functions / procedures / sequences
- ✅ Instant fuzzy filter over thousands of objects, `schema.table` narrowing, natural order (t2 before t10). Measured on 5,000 tables / 20 schemas (e2e/flow61): connect 1.5 s, filter 17 ms, open table 45 ms, autocomplete 0.2 s, diagram of a 250-table schema 1.4 s
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
- ✅ Run statement under cursor / selection / whole script; multiple result sets; Copy all (TSV / JSON / Markdown, optionally with each statement) and Download all (Excel with a sheet per result, other formats as a ZIP) — unreleased
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
- ✅ Shortcuts shown per platform (⌘ on macOS, Ctrl+… on Windows/Linux); `UI tour` workflow screenshots the real window on Windows and Linux in both languages for review

---

## Milestone 1 — Relationships & diagrams (v0.2) ✅

- ✅ Auto layout with relationship lines routed around tables (ports at the exact rows, crossing minimization, orthogonal routes with rounded corners); a 25-table test schema went from 9 crossings + 5 lines under tables to 13 crossings + none under tables, the demo database has none
- ✅ **Interactive ER diagram** of a schema or a selection of tables (auto layout, crow's-foot notation)
- ✅ "Explore from table": start with one table, expand neighbours by FK hop
- ✅ Join path between two tables in the diagram, with ready SELECT … JOIN SQL (also the `find_join_path` AI/MCP tool)
- ✅ Saved diagrams per connection: named subject areas with their own tables and layout, saved automatically
- ✅ Diagram table colors (saved with the diagram; DBML TableGroups color the model) and sticky notes
- ✅ Virtual / logical relationships (when the DB has no real FKs) — stored in the knowledge base and
  used by FK navigation, diagrams, autocomplete joins and AI
- ✅ Export diagram to PNG, SVG, Mermaid, DBML, PlantUML
- ✅ Join autocomplete in SQL editor based on FKs + virtual relationships
- ✅ dbdiagram-style DBML editing for designing new schemas, generate migration DDL (Model tab)

---

## Milestone 2 — AI (v0.3) ✅

### Providers (bring your own)
- ✅ AI permissions in one place (Settings → AI permissions): per connection Off / Schema only / Read data / Read and write, external agents (MCP) on/off, agents may write, AI may edit notes; app-wide default; organization policies cap it
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
- ✅ Unconfirmed AI queries (assistant, MCP agents, team tools) run in a read-only transaction enforced by the database and rolled back, so a SELECT calling a function that writes changes nothing (PostgreSQL, MySQL/MariaDB, SQL Server, Oracle)

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
- ✅ Execute in the SQL editor (review first) or save as a migration file (plain SQL, Flyway `V…__name.sql`, or a
  Liquibase changelog in formatted SQL with its rollback)
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
- ✅ Subject areas in a model: TableGroups shown one at a time, edits stay in the area · logical vs physical model 💡

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
- ✅ BigQuery: datasets as schemas, typed filters (text values cast to the column type), SQL with named parameters,
  streaming exports, arrays/structs/exact NUMERIC and INT64; service account key (encrypted) or gcloud sign-in;
  read-only grid (keys aren't enforced); integration-tested in CI against the BigQuery emulator
- ✅ Trino (and Starburst) over its HTTP protocol, no extra dependency: the connection's catalog is browsed, any
  catalog is queryable; typed filters, exact BIGINT/DECIMAL, streaming exports that cancel the server query, EXPLAIN
  (ANALYZE); read-only grid; integration-tested in CI against Trino 483
- ✅ SQL Server Windows (integrated) authentication (msnodesqlv8 + ODBC, tested on Windows CI)

---

## Milestone 6 — Teams & enterprise (v0.7, see docs/STRATEGY.md)

- ✅ Managed configuration file (pre-defined connections, AI endpoints, policies) for IT departments — docs/managed-config.md
- ✅ Share connections with colleagues: export without passwords/keys, import from the file
- ✅ Shared team folder (network drive, OneDrive, Git): connections, knowledge bases, saved queries, ER diagrams. A Teams channel works through OneDrive sync (docs/team-folder.md)
  kept in sync automatically
- ✅ Audit log: every statement (editor, grid edits, imports, the in-app AI and external MCP agents) with its source, exportable to CSV
- ✅ MSI package for Intune / SCCM (per-machine, silent `msiexec /i … /qn`; CI installs it and runs the smoke test)

---

## Milestone 7 — v1.0 ✅ released 1.0.0 (2026-10-27)

1.0 shipped on the owner's decision after his own use and a full regression run of the e2e click-through flows; Windows users get a signed build through the Microsoft Store, and the colleague pilot runs on 1.0 with fixes as 1.0.x.


- ✅ Website on https://dbmastermind.app (GitHub Pages from docs/, HTTPS) with a download button for your OS and a privacy policy; Czech quick guide (docs/navod.md), team-folder and managed-config docs
- ✅ High-contrast theme (light and dark, WCAG AA text; follows the OS "increase contrast" setting), Windows forced-colors support, visible focus rings
- ✅ AI tool plugins: `tools/*.sql` in the knowledge base become read-only, parameter-bound tools for the assistant and MCP
  agents (docs/ai-tools.md; verified end to end with Claude Code over MCP)
- ✅ Microsoft Store: [live since 1.0.0](https://apps.microsoft.com/detail/9p0grd7bz4nf) (MSIX signed by the Store). Every release attaches `…-store.appx`; the owner submits updates in Partner Center every few releases (docs/microsoft-store.md) · Mac App Store: not planned (sandbox would cut features)
- ✅ macOS releases signed with a stable project certificate; saved passwords encrypted with a key that survives updates (no keychain prompt)
- ⬜ Windows code signing — no "unknown publisher" warning. SignPath Foundation declined on 2026-10-23 (the project needs more public visibility first: stars, articles, users; reapply later). Meanwhile the Microsoft Store build is signed by Microsoft; a paid certificate is the owner's call
- ⬜ Pilot with colleagues on 1.0 from the Microsoft Store (read-only connections first); fixes ship as 1.0.x
- ✅ Scoop manifest and Homebrew cask (this repo is the tap) updated with every release · winget: first version submitted (microsoft/winget-pkgs#458825, in review); later releases open a PR automatically (release.yml `winget` job, komac, `WINGET_TOKEN` secret) — once merged: submit 0.9.3 with `komac update` (it shipped while the first PR was in review) and add the `winget install` line to README/website

### Later, when someone needs it
- Redshift, Snowflake, Cassandra drivers (need real accounts to test properly)
- Driver plugins (third-party code in the app needs a sandbox and signing story first)
- macOS notarization (needs a paid Apple Developer ID)
- SQLite in its own process: node:sqlite can't interrupt a running statement, so a cancelled runaway query keeps one CPU core busy until the app quits (quitting itself works). Worth it if the pilot hits it.

### Not planned
- MongoDB, Redis: a different kind of tool (documents and key-value stores, not tables)
- Chocolatey, Flathub, AUR: winget, Scoop and Homebrew cover Windows and macOS; IT departments get the MSI; Linux has the AppImage and .deb
- Mac App Store: its sandbox would cut features
- Direct SharePoint / Teams access without the OneDrive client: a synced OneDrive folder already works as the team folder or knowledge base

---

## Milestone 8 — Modeling without a license

Teams that design databases in DeZign for Databases (and similar paid modelers) can open their models here,
keep working, and get what those tools charge extra for (ALTER scripts against a live database) for free.
Not a clone: their features, rethought and connected to live databases, the knowledge base and AI.

**Rules for everything in this milestone** (the owner's requirement: obvious at first sight, nothing to explain):

1. **A model is a document.** Open the file, edit, save. It saves back in the format it came in. No import
   wizard, no project setup, no conversion step.
2. **No connection needed.** A model opens without any database. A database is picked at the moment it is
   needed ("Compare with database", "Generate ALTER") and remembered for that model.
3. **No new settings.** Checks and conventions ship with sensible defaults. What a team wants to change lives
   in a file next to the model, not in a settings page.
4. **One screen.** Canvas, table editor, issues. Everything else sits behind one menu and the command palette.
5. **Agents get the model like everything else**: the same tools and permissions as the connection it is linked
   to; nothing extra to configure.

### 8.1 Open a DeZign model and use it 🚧
- ✅ Open `.dez` files (DeZign 4 to 14, file formats 41–140) as a model: Open model in the Model tab or the command
  palette. Tables, columns, types, keys, relationships with their rules, unique constraints, indexes, defaults,
  comments, schemas. Checked on public models of formats 41, 51, 60, 120, 140
- ✅ Folder projects (`.dezproj`, one file per object; archived versions are not read). A large real project
  (hundreds of tables) opens and draws in under a second
- ✅ The layout of the main diagram comes along (spread to the size of our tables)
- ✅ Text in the Windows code page DeZign wrote it in (Czech reads correctly; the file's own `iso-8859-1` label is wrong)
- ✅ Everything a model already does works on it: DDL for any database, ALTER script against a live database,
  compare with a `.dbml` or another DeZign file, data dictionary, AI review
- ✅ Proven on real databases: the DDL of each of 37 public models (DeZign 4 to 14; PostgreSQL, MySQL, SQL Server,
  Oracle, Firebird and database-independent ones) runs on the model's own database (PostgreSQL 17, MySQL 8.4,
  SQL Server 2022; the others translated to PostgreSQL), and the model compared with what the database then has
  shows no difference. Each model is then edited at random forty times over (new, renamed and dropped tables and
  columns, types, keys, indexes, relationships) and the ALTER script of every round runs and leaves no difference
  either: 8,000 statements. `packages/core/test/dezign-realworld.integration.test.ts`, with a model of its own in CI
- ✅ What that turned up, fixed for every model and every schema compare: foreign keys of new tables wait until
  everything they reference exists; made-up constraint names never repeat; related tables are dropped in an
  order that works; a key that loses a column goes before the column; PostgreSQL type changes under a default;
  one type under its many names (`varchar` and `character varying`, `numeric(8)` and `numeric(8,0)`, `serial`)
  and one default under its spellings are no longer a difference; index columns with capitals; MySQL defaults
- ✅ DDL for the model's own database keeps its types as they are written; for another database they are
  translated, now including Oracle `NUMBER`, MySQL display widths and `ENUM`, and DeZign's database-independent
  types. `ENUM` values, text defaults typed without quotes and a domain's check (`value …`) come out as valid SQL
- ✅ Checked against DeZign's own output: public repositories keep scripts DeZign generated next to their models.
  DeZign's script and ours each make a PostgreSQL database and the two are compared (tables, columns, types,
  keys, indexes, the name of every constraint). They come out the same. To get there, a DeZign project's scripts
  are now written the way DeZign writes them: names without quotes (PostgreSQL stores `isAdmin` as `isadmin`;
  quoted it would be a different column than the one DeZign's script made), domains as types of the database
  where the project keeps them (`CREATE DOMAIN`, columns typed by it), primary keys named by the project's own
  names and template (`PK_%table%`), foreign keys by their relationships, unique constraints and indexes by
  their names, and a UNIQUE constraint is made as a constraint of its table (a unique index stays an index).
  A database whose columns are typed by the domains no longer shows as different from the model
- ✅ Relationship names are part of the model (`Ref name: a.b > c.d`), read from DeZign and written back
- ✅ The whole day through the window, on a real PostgreSQL (e2e/flow95): a DeZign model with its own schema
  against a database that has other people's tables; compare, script, run, identical; edit the model; ALTER
  script, run, identical
- ✅ Views, sequences, procedures and triggers of the project are kept as the SQL it holds for them and added to
  the generated DDL script (as comments when the script is for another database than the project's)
- ✅ Domains: a column keeps the domain it follows (`[domain: 'name']` in the model, with the domain's type), a new
  column can be given one, and a type of its own takes a column out of its domain. The project's domains are
  listed in the model as a note; they are made and changed in DeZign
- ✅ What the model can't show (relationships drawn without columns, the "Notes" DeZign keeps next to a
  description) is listed with counts when the file opens, never dropped silently, and stays in the file
- ✅ A large diagram opens with all of it in view (the view is fitted to where the tables are, not to the ones
  already drawn: a model of several hundred tables used to open with a third outside the window)
- ✅ Opening never changes the DeZign file; Save as makes a `.dbml` model of it
- ✅ A model needs no connection: File → Open Model (⌘O), "Open a model" on the start page, a file dropped on the
  window, or the file itself (command line, double-click; `.dbml` is registered on macOS and Windows, DeZign files
  on macOS only so that on Windows they stay with DeZign). DDL goes to a `.sql` file; the database is picked in the
  model's toolbar when the ALTER script is wanted and remembered for that file
- ✅ The project's other diagrams are subject areas of the model: each shows its own tables in its own layout, a
  table can be on several, tables added or moved there are saved back to that diagram
- ✅ Table colors (mapped to the nearest of the diagram's eight colors) and text areas (as notes) of every diagram.
  Edited, new and removed notes and recolored tables are saved back to that diagram
- ✅ Diagrams are managed here: "New diagram…" makes one in the project, tables are added to a diagram from the
  search above the canvas and taken off from their menu (they stay in the model), and relationship lines follow
  the tables on each diagram
- ✅ Group boxes are drawn as captioned frames behind their tables (not edited here; stamps are kept in the file
  and not shown)

### 8.2 Save it back 🚧 (works end to end; checked in DeZign 14.9.3 itself)
- ✅ Save writes the edited model into the same `.dez` or folder project: only the touched elements change,
  everything else stays byte for byte, the file keeps its format version, code page and line ends
- ✅ Rename, comments, types, nullability, defaults, identity, add/remove/reorder columns, primary key, unique
  constraints and indexes; new and dropped tables; new, dropped and changed relationships; tables moved in the diagram
- ✅ New objects are copies of a neighbour of the same kind (so they have the element layout of the DeZign version
  that wrote the file), with ids in the file's own style and names from its name templates; folder projects get
  files named like their neighbours
- ✅ Before anything is written: the changes are listed for confirmation, the result is read back and compared with
  the edited model (a mismatch writes nothing), the files as they were are copied to `<data>/dezign-backups`
- ✅ A project that changed on disk since it was opened (a colleague, Git, DeZign) is not overwritten
- ✅ The shape of what is written, against what DeZign writes (`packages/core/test/dezign-shape.test.ts` with
  `DBM_DEZ_SAMPLES`): from DeZign's own files a grammar is taken (which elements each element holds, which it
  always holds, in which order), per file format and per file. A project made from scratch and every model
  saved after edits (37 public models, DeZign 5 to 14, and a folder project) must fit it. It found, and the
  writer now has: the settings sections DeZign 14 writes into every project, `NAMETEMPLATE` next to every
  constraint and relationship name, a new diagram placed with the other diagrams (it was written after the
  controls), copied tables and columns keeping every field of their neighbours, "no domain" written the file's
  way, a table's indexes before its constraints, new constraints and indexes shaped like the project's own
- ✅ Verified in DeZign itself (14.9.3, the trial, run under Wine in Docker: `scripts/dezign-check`). A kit of
  one file per kind of edit (`packages/core/test/dezign-kit.test.ts`: renamed, new, retyped and dropped columns,
  a new table with a relationship, a dropped and a renamed table, an index and a unique constraint, a check, a
  relationship between existing tables, a renamed foreign key and index, a moved table, a note and a color, a
  new diagram, all of it at once, and projects made from scratch for PostgreSQL, SQL Server and MySQL) is opened
  in DeZign and saved there again with "Save project as"; what DeZign wrote is read back and compared with what
  we wrote (`DBM_DEZ_KIT_BACK`). Every file opens and comes back as the same model: the kit made from a model
  DeZign 14.9.3 wrote, the kit made from a DeZign 6 model (DeZign converts it when it opens it), and a folder
  project as it is and after edits. DeZign found what reading back could not:
  - an empty number (`<HEADERCOLOR></HEADERCOLOR>` of a new table on a diagram) stops the whole project from
    opening ("'' is not a valid integer value"); the shape test now also learns which values are always numbers
  - DeZign makes names from their templates again when it opens a project: a typed name of an index, a
    constraint, a check or a relationship was replaced by the pattern's (and a copied index got its neighbour's
    name). A typed name is now written as DeZign keeps one, as its own template; names made from a pattern
    follow a renamed table the way DeZign renames them
  - projects that came to DeZign 14 from older versions give columns and indexes ids that are unique in the whole
    project (`ATTR-<table>-<n>-<token>`): plain numbers were renumbered by DeZign and a new relationship lost its
    columns. The first relationship of a pre-14 file has the constraint id that format uses (`1`)
  - a character reference (`&#345;`) for a letter outside the file's code page is shown as typed: such a letter
    is now written without its diacritic, as DeZign (which works in one code page) would hold it. Node 24 reads
    windows-1252 as ISO-8859-1 (€ „ “ – Š ž came out as control characters): the reader has its own table
  - DeZign moves the end of a relationship line with a moved table and routes the line of a new relationship
    itself, so the straight connector we write is enough
- ✅ Renaming an index, a unique constraint, a check or a foreign key in the model is written into the element
  that has the name (it used to be dropped silently: they are matched by their columns and condition)
- ✅ A copied column, table or relationship does not take its neighbour's labels, custom properties, character
  set or relationship phrases; a dropped table takes the lines from views to it along (DeZign 14.5 draws views);
  files of DeZign 4 to 11 get their id counters (`LASTID`, `ATTRLASTID`, …) moved on with new objects
- ⬜ Subtype clusters and the domains themselves edited from the model (today they are kept as they are)

- ✅ Compare with a version archived in the project ("Compare with version…" lists them, newest first): the
  changes since then and the ALTER script for the model's database. DeZign sells this in its top edition only
- ✅ A model made here goes the other way too: Save as… offers a new DeZign project (`.dez`, format 140, for the
  database of the model's connection: PostgreSQL, SQL Server or MySQL) with tables, keys, relationships, indexes,
  checks, comments and the diagram; the tab then follows that file. DeZign 14.9.3 opens all three kinds and
  saves them again as the same model
- ✅ Every save passes a reference check (no id used twice, no key, index, relationship or diagram object
  pointing nowhere) and chains of random edits run as tests, on made-up models in CI and on real ones locally.
  They found and fixed two defects before anyone met them (ids replaced inside other values in files that
  number their objects; a dropped supertype leaving its subtype cluster)

### 8.3 The model holds a whole database 🚧
- ✅ Check constraints in the model: DBML `checks` blocks and column `check:`, written into CREATE TABLE for any
  database, read from DeZign models and saved back to them
- ✅ Checks in the ALTER script: PostgreSQL, MySQL and SQL Server say which checks a table has, so a check the
  model has and the database lacks is added and one the model no longer has is dropped. They go by name (a
  database stores a condition rewritten its own way, so conditions can't be compared as text); a check without
  a name in the model stands for one the database named itself. A named check whose condition changed is not
  noticed by the text, so the database is asked: the model's condition is put on a temporary copy of the
  table's columns (thrown away) and read back as the database stores it; if that differs from what the table
  has, the check is replaced under its name. PostgreSQL, MySQL and SQL Server
- ✅ DBML `TablePartial` (reusable column sets, e.g. audit columns) with `~name` injection
- ✅ Blocks the model does not hold (Project, notes, Records, TablePartial) stay as written when the model is
  rewritten from the canvas or by a fix
- ✅ What a DeZign project says about its scripts beyond names: a column's collation (`[collate: '…']` in the
  model, `COLLATE` in the script, read from and written to the project; left out when the script is translated
  for another database) and the project's begin and end database scripts, put around the CREATE script for the
  project's own database and around the ALTER script
- ✅ Renames in a comparison: a column or a table that the model renamed came out as DROP and ADD (the data
  gone). The comparison now offers what is probably one thing under a new name (a table most of whose columns
  are the dropped table's; a column of the same type where one left and one came), ticked by default, and
  writes RENAME; keys and indexes on a renamed column stay. Any schema comparison has it (e2e/flow95 against
  PostgreSQL: the renamed column keeps its rows)
- ✅ The table panel of the diagram edits what used to need the text: a column's comment, its place among the
  columns, the named type (domain) it follows, auto-increment; the names of foreign keys and indexes, ON UPDATE;
  check constraints. It opens for a model with no database connected (e2e/flow96: a DeZign model edited in the
  panel and saved back into its file)
- ⬜ Custom properties on tables and columns; DeZign attribute packages as `TablePartial`
- ⬜ Views, sequences, triggers and procedures edited in the model (a DeZign project's are carried into the DDL
  as they are; a model made here has none yet)
- ⬜ Domains defined in a model made here (a DeZign project's are used by its columns already)
- ⬜ Several diagrams per model with their own layout, notes and group boxes
- ⬜ A model as a folder (one file per table, SQL files for the rest): small Git diffs, merges without conflicts

### 8.4 Easy on the first day ✅
- ✅ Update a model from its database ("From database" → Update the model): what the database has and the model
  lacks is added, what differs follows the database, and what only the model knows stays (comments, domains,
  checks, virtual relationships, layout); tables only the model has stay unless asked. DeZign's "compare model
  to database and update model"
- ✅ Start page: "New model" and "Open a model" next to the connections; a model file opened from the system goes
  straight to the designer with the connection sidebar out of the way
- ✅ A model from scratch without knowing DBML: an empty model offers "Add the first table", which opens it in the
  designer; more tables, columns and relationships are added there (e2e/flow94)
- ✅ Model checks that run by themselves (instant, also on 300 tables): tables without a key, foreign keys to
  columns that are not unique or of another type, indexes that repeat or cover each other, foreign keys without
  an index, names in a different style than nearly all others. A quiet counter in the toolbar; the list is
  grouped by kind, a click goes to the table, safe fixes are one click (or one click for all of a kind)
- ✅ Undeclared relationships are suggested from names and types (`customer_id` next to `customers`, or a column
  named like another table's key); adding one checks the real rows first when the model's database has both tables
- ✅ Diagram to PDF from the Export menu: the whole diagram on one page, or at readable size on as many A4 sheets
  as it needs (each marked with its row and column)

### Later, when the pilot asks for it 💡
- Naming rules and a glossary of abbreviations kept in the knowledge base (logical name ↔ physical name)
- Logical model: one model, several target databases
- Test data generated in foreign-key order
- Command line for CI: check a model, diff it against a database, write the documentation
- Alembic output next to Flyway and Liquibase
- Enterprise Architect repositories, read-only (`.qea` is SQLite; server repositories are ordinary connections)
- Other modelers' files (MySQL Workbench, PowerDesigner, pgModeler, erwin XML) when someone brings one

### Not planned
- UML / BPMN, NoSQL document modeling, an own model server (Git and the team folder do that), a stored
  procedure debugger, a report designer
- A separate modeler application: the designer is its own module in the code and opens like a stand-alone
  tool, but one install and one update channel stay

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
