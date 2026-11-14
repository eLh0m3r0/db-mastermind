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

## Milestone 8 — Modeling without DeZign installed

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

### 8.1 Open a DeZign model and use it ✅
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

### 8.2 Save it back ✅ (checked in DeZign 14.9.3 itself)
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
- ✅ The diagram of a DeZign project draws relationships as DeZign does: identifying ones (the parent's key is part
  of the child's key) solid, the others dashed. A key edited here keeps the project's own mark of it (`RELTYPE`) and
  the index DeZign keeps on the key (older projects) in step, so DeZign 14.9.3 draws a file we saved, a new
  identifying relationship and one made identifying, exactly as the app does (checked side by side); changing a
  primary key used to fail the save check in projects with that index
- ✅ Reports as DeZign makes them (Export → Data dictionary (HTML)…): a title page (title, author, company, version,
  description), which parts each table's chapter holds (referenced by, indexes, checks, notes, custom properties,
  labels, to-do items, view definitions), an image of the diagram, the report's color and order; remembered for the
  next report (e2e/flow36)
- ✅ A DeZign project switched to another database (DeZign's "Switch target DBMS"; SQL DDL → Switch the project to…):
  column and domain types translated, the new database id written (a folder project's in its `.dds`), the types
  under the names DeZign's list has for them (PostgreSQL: CHARACTER VARYING, NUMERIC…). DeZign 14.9.3 opens a SQL
  Server project switched to PostgreSQL 16 with all 98 column types as written
- ✅ Conditional generation (DeZign Expert): `{$IFDEF name}` / `{$IFNOTDEF name}` … `{$ENDIF name}`, nested, in view,
  trigger and procedure code, check constraints and the project's scripts; "Directives" (shown when the model has
  any) picks the ones that apply, and SQL DDL and the comparison with a database make the script with them
- ✅ IDEF1X notation per diagram (DeZign's NOTATION), next to crow's feet: dependent tables rounded, independent
  ones square, a dot at the child's end with P / Z / 1 for the cardinality, a diamond at an optional parent's end,
  non-identifying relationships dashed; chosen above the canvas and saved into the project's diagram
- ✅ DeZign's to-do list: a to-do item of a table (its dialog's Description tab) and of a column (under the grid),
  listed under "To-do list" in the object browser, kept in the model (`Todo:` / `todo:`) and saved where DeZign 14.9.3
  keeps it (`TODO` right after the id)
- ✅ Labels on tables and columns (DeZign's labels, such as "PII"): picked in a table's dialog (the table's on its
  Description tab, a column's under the grid), listed under "Labeled objects" in the object browser, kept in the
  model and saved where DeZign keeps them (`OBJLABELS`; a folder project's labels are read from its `labels`
  folder). The labels themselves are made in DeZign
- ✅ Subtypes edited from the model: a relationship's dialog makes the table a subtype of its parent (DBML
  `subtype: true`; the canvas labels the line). Saved as DeZign keeps them: the supertype's cluster (made once,
  with its connection and its symbol on each diagram of the supertype), the relationship from the cluster (RELTYPE 2),
  and back to an ordinary relationship. DeZign 14.9.3 opens new subtypes, one turned back and one added to a
  cluster as saved (e2e/flow96)

- ✅ The DROP script DeZign writes next to the CREATE one (SQL DDL → DROP script…): views, then the tables in an
  order their foreign keys allow, then the domains the model made
- ✅ Model check for names longer than the model's database keeps (PostgreSQL 63 bytes, cut without a word:
  two long constraint names become one; MySQL 64, SQL Server and Oracle 128), counted in bytes as they count
- ✅ A diagram shows its tables as DeZign does: its attribute display level (all columns, keys, primary keys,
  first 10 or 20, names only), data types or none, and the columns hidden in one table's box. Changed in the
  diagram's toolbar (columns of one table: its menu → Columns shown), saved into the project; codes checked by
  setting them in DeZign 14.9.3
- ✅ Frames (DeZign's group boxes) edited on the diagram: added ("Add a frame"), moved by their caption, resized at
  their corner, renamed and removed from their menu; saved into the project and opened by DeZign 14.9.3 as saved
- ✅ Diagrams of a DeZign project renamed and removed (the tables stay; whatever was drawn on the diagram goes
  with it). DeZign 14.9.3 opens the saved files and keeps them as saved
- ✅ Archive a version (the model's "Archive version…", as DeZign's File → Versions → Archive current version): the
  project as it is saved is kept in it, in a single file as another VERSION element, in a folder project as a
  file in `archived versions`; numbered past the project's own. Byte for byte what DeZign 14.9.3 writes for the
  same model (project path apart), and DeZign lists the versions made here next to its own. Teams that let
  DeZign archive a version with every ALTER script keep doing so from here
- ✅ Compare with a version archived in the project ("Compare with version…" lists them, newest first): the
  changes since then and the ALTER script for the model's database. DeZign sells this in its top edition only
- ✅ Comparing with an archived version needs no database: the script is for the database the project is made
  for and goes to a file (Save script…), as DeZign's "Compare archived models" does
- ✅ Compare the model with a SQL script ("Compare with file…" takes a `.sql` too, e.g. a pg_dump or mysqldump of
  production, as DeZign's "compare model to SQL script"): the changes and the ALTER script. The script is read as
  it declares its tables — types with their lengths, schemas, identities (also pg_dump's separate `ADD GENERATED`
  and `nextval` defaults), defaults, comments (MySQL `COMMENT`, SQL Server `MS_Description`), foreign keys with
  their actions, references between schemas and in cycles. Tested on real dumps: a model created in PostgreSQL,
  MySQL and SQL Server, dumped by pg_dump, mysqldump and Microsoft's sqlpackage, reads back with no difference;
  scripts DeZign itself generated read back as their models (keys and references that differ only in letter case,
  as unquoted names in PostgreSQL, are no change) (`ddl-dump.integration.test.ts`; a real
  project of hundreds of tables too). "Import SQL…" reads scripts the same way
- ✅ A PostgreSQL model's script for MySQL and SQL Server runs there: serial becomes an identity integer (one per
  table where the database allows only one; in MySQL it leads a unique key), `time with time zone` the time,
  long strings what the database can hold (nvarchar(max); MySQL TEXT where a row would pass 65,535 bytes), the
  date and the time in defaults and checks the database's own (checks MySQL and Oracle refuse are left out).
  A real project of hundreds of tables is created in MySQL and SQL Server without a failed statement, and its
  mysqldump reads back as the translated model (`ddl-dump.integration.test.ts`)
- ✅ An archived version opens as it was ("Open this version" in its comparison): its tables and diagrams in a model
  tab of their own, not tied to the project, so nothing is written into it (DeZign: switch to an archived version)
- ✅ A new DeZign project can be a folder project (Save as… → `.dezproj`, for Git): a folder of its name with a
  file per object, made as DeZign's "Save project as → Folder based" makes it (byte for byte against DeZign
  14.9.3's own, project path apart); DeZign opens new ones for PostgreSQL and SQL Server and saves them as made
- ✅ A folder project in Git: two people who edit other tables on their branches, each adding a table, save
  files the other did not touch, so Git merges them without a conflict (checked with real git; a save touches
  only the files of the objects it changed and DeZign 14 ids never repeat)
- ✅ A model made here goes the other way too: Save as… offers a new DeZign project (`.dez`, format 140, for the
  database of the model's connection: PostgreSQL, SQL Server or MySQL) with tables, keys, relationships, indexes,
  checks, comments and the diagram; the tab then follows that file. DeZign 14.9.3 opens all three kinds and
  saves them again as the same model
- ✅ Every save passes a reference check (no id used twice, no key, index, relationship or diagram object
  pointing nowhere) and chains of random edits run as tests, on made-up models in CI and on real ones locally.
  They found and fixed two defects before anyone met them (ids replaced inside other values in files that
  number their objects; a dropped supertype leaving its subtype cluster)

### 8.3 The model holds a whole database ✅
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
  model, `COLLATE` in the script, read from and written to the project; for SQL Server and MySQL projects only,
  as DeZign's own templates have none for PostgreSQL, and left out when the script is translated for another
  database) and the project's begin and end database scripts, put around the CREATE script for the
  project's own database and around the ALTER script
- ✅ A relationship drawn from table to table (the dot in a table's header, dropped anywhere on the other
  table) makes the key column too, as drawing one does in DeZign: a column for each column of the other table's
  primary key, with its type and domain, or the column of that name the table already has
- ✅ Columns a DeZign project inherited from an attribute package (DeZign locks them to the package): one whose
  definition is changed here is taken out of the package, and the list of changes before saving says so
- ✅ A comparison's single changes can be left out of the script (a box at each change of a table with several;
  the table's box for all of them), as DeZign's list of differences allows
- ✅ Renames in a comparison: a column or a table that the model renamed came out as DROP and ADD (the data
  gone). The comparison now offers what is probably one thing under a new name (a table most of whose columns
  are the dropped table's; a column of the same type where one left and one came), ticked by default, and
  writes RENAME; keys and indexes on a renamed column stay. Any schema comparison has it (e2e/flow95 against
  PostgreSQL: the renamed column keeps its rows)
- ✅ The table panel of the diagram edits what used to need the text: a column's comment, its place among the
  columns, the named type (domain) it follows, auto-increment; the names of foreign keys and indexes, ON UPDATE;
  check constraints. It opens for a model with no database connected (e2e/flow96: a DeZign model edited in the
  panel and saved back into its file)
- ✅ A model is edited without typing DBML, as in DeZign: a relationship clicked on the canvas opens its properties
  (cardinality, ON DELETE/UPDATE, name, the columns of a key of several columns); a table's comment of several lines,
  its notes and its columns' notes and collation; a table moved to another schema (the relationships that point at
  it follow, also when one is renamed); double-click opens a table's properties; Duplicate and Delete in a table's
  menu, the Delete key on the selected tables (kept again in their panel). Several tables selected are lined up or
  spread evenly; tables snap to the grid; ⌘Z/⌘⇧Z also take moves back and forth. A database's diagram keeps its
  behaviour (the key no longer hides a table from the canvas without changing anything). e2e/flow97
- ✅ DeZign's dialogs for a model: double-click a table for its dialog (columns in a grid with the selected one's
  notes and collation below; indexes and checks, foreign keys, description and notes, the SQL it makes; nothing
  changes before OK), double-click a relationship's line for its dialog (name, parent table, the columns, the
  cardinality as pictures, identifying, mandatory parent, on delete/update, a preview of the line). A table's menu
  has Properties…. A database's diagram still opens a table's data on double-click
- ✅ Domains of a DeZign project renamed (the columns that follow one follow its new name; DeZign keeps them by id)
  and removed (only one no column follows), saved into the project; DeZign 14.9.3 opens both kinds of file as saved
- ✅ A diagram of the selected tables (DeZign: subdiagram from the selection), where they stand
- ✅ Batch rename (DeZign's batch renaming tool, "Rename…" at the model): a text or a regular expression replaced in
  the names of tables, columns or both, every rename shown before it is done (a name that would be empty or taken
  is left out and says why). Keys, indexes, relationships at both ends and checks follow (not text in quotes or
  comments). Saved into a DeZign project as renames: the tables and columns keep their ids, a column's check keeps
  its place with the new name in it. DeZign 14.9.3 opens a project with every table and column renamed as saved
- ✅ Enums and table groups of a model of its own edited in dialogs from the object browser (a renamed enum renames
  the type of the columns that use it; one in use can't be removed): nothing of a model needs typing DBML any more
- ✅ A DeZign project's scripts before and after its CREATE and ALTER scripts edited in the model ("Project
  scripts…", DeZign's project settings): saved into the project (a folder project's project file) and used by the
  next script; DeZign 14.9.3 opens the saved project with the scripts as written
- ✅ A model's canvas handles as DeZign's: dragging on the empty canvas selects tables, the wheel (two fingers)
  scrolls and ⌘ with it zooms, ⌘A selects every table, the zoom shows as a percentage (a click: 100 %). A
  database's diagram keeps drag-to-pan
- ✅ Copy and paste of tables, within a model and between models (DeZign does both): ⌘C puts the selected tables on
  the clipboard as DBML with the relationships among them, ⌘V adds DBML tables as new ones under free names, keeping
  their relationships to each other and to tables the model has. Text fields keep their own clipboard
- ✅ The model's objects next to the diagram, as DeZign's object browser (Objects / Text switch; a DeZign project
  opens on its objects): tables, relationships, domains and views, found by name without diacritics; a click shows
  the table on the diagram (on the whole model's when the diagram shown doesn't have it), a double-click opens the
  table's or the relationship's dialog. The DBML text stays one click away
- ✅ Writing the canvas into the model keeps the whole model: tables the canvas didn't show (another schema, a focus,
  past the first 400) stay as they were (they used to be left out); a model's canvas shows all its schemas
- ✅ The Notes DeZign keeps next to a description, of tables and columns: `Remarks:` in a table, `remarks:` on a
  column (never in a script), read from the project and written back; DeZign 14.9.3 opens them as saved
- ✅ A relationship's cardinality (DeZign: zero or more, one or more, zero or one, exactly one): `-` for one-to-one
  in the model and `cardinality: '…'` where it says more, drawn at the child's end of the line, written back.
  Codes checked by how DeZign 14.9.3 draws them; never in a script
- ✅ DeZign attribute packages (the same columns put into many tables, such as audit columns): a column says which
  package it comes from (`[package: 'name']`), the object browser lists the packages the project uses, a table's
  dialog puts a package's columns into the table ("Add a package…") linked to it as DeZign links them, and a
  column whose name or definition is changed leaves its package. DeZign 14.9.3 treats the columns put in here as
  the package's: a change to the package's definition reaches them as it reaches the others
- ✅ Saving a model also saves what the canvas has not written into the model yet (no separate "Write to DBML"
  before Save); so do SQL DDL, the comparisons, Rename… and Domains… (e2e/flow97)
- ✅ Custom properties of tables and columns (DeZign's user defined properties: text, number, yes/no, a value
  from a list, as the project defines them): a table's on a Properties tab of its dialog, a column's under the
  grid; kept in the model (`Properties:` / `properties:`) and saved into the project where DeZign keeps them
  (`USERDEFPROPS`, in the order of their definitions). DeZign 14.9.3 opens a project with values changed, added
  and removed as saved. The properties themselves are defined in DeZign
- ✅ Views of a DeZign project edited in the model ("Views…"): their SQL as DeZign keeps it (`%viewname%` for the
  view's name), written back on Save and used in the DDL script. DeZign 14.9.3 opens the saved view as written
- ✅ A DeZign project's triggers, procedures and sequences edited in the model ("Views and code…", next to its
  views; the object browser lists them): code as DeZign keeps it (`%triggername%`, `%table%`), sequences by their
  settings (increment, start, minimum, maximum, cache, cycle in the database's own word), new triggers of a table
  and new sequences, triggers, procedures and sequences removed, and new procedures (a GUID and the next place, as DeZign
  makes them). Saved into the project (a folder project's
  sequence as a file of its own) and used in the DDL. DeZign 14.9.3 opens a project with a changed, a new and a
  removed trigger and a new sequence, and an older PostgreSQL project with a changed and a new sequence, as saved
  (e2e/flow91). Fixed on the way: a sequence's CYCLE was read only as `1`, but DeZign keeps `cycle`/`CYCLE`
- ✅ Views, triggers, procedures and sequences in a model made here (DBML has none): made in "Views and code…",
  kept in the model's file with its layout and written into the DDL (e2e/flow97)
- ✅ Domains of a DeZign project managed from the model ("Domains…"): a new type for a domain goes to every column
  that follows it, as DeZign propagates it; new domains are made and offered in the table panel. Saved into the
  project (a new domain with a column that follows it opened in DeZign 14.9.3 as saved; projects of the full
  version, which the trial refuses, were not checked there). The model's domains note is the list
- ✅ Several diagrams per model with their own layout, notes and frames, also for a model made here: its layout
  (positions, colors, notes, frames, named diagrams) is kept at the end of its .dbml file as one comment line that
  DBML tools skip, and comes back when the file is opened (it used to be lost)
- ✅ A model as a folder (one file per object): Save as… → DeZign folder project (`.dezproj`), which the team uses
  anyway; saving changes only the files of the objects that changed, so branches merge without conflicts

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
- DeZign's Datanamic Repository (commit, get latest, conflicts): Git with folder projects and the team folder do it
- UML / BPMN, NoSQL document modeling, an own model server (Git and the team folder do that), a stored
  procedure debugger, a report designer
- A separate modeler application: the designer is its own module in the code and opens like a stand-alone
  tool, but one install and one update channel stay

## Milestone 9 — A modeling tool of its own (1.1.0)

What docs/STRATEGY.md ("Two ways in") asks for, without losing anything of Milestone 8 (the DeZign tests guard
compatibility while the screens change).

- ✅ Home page: *Databases* and *Models* side by side, each with a short list of what it does, connections and
  recent models under them; fits a laptop screen without scrolling (recent models are remembered when opened)
- ✅ A model tab hides the connections sidebar (⌘B or the button in the tab bar shows it; remembered apart from
  the databases' choice, and the sidebar has its own hide button); its left side is the model's objects
- ✅ A lean model bar: Open, Save, Save as, Import (SQL script, from the database), SQL DDL (the model's own
  database first), AI, Compare (its arrow picks the database or a version/file; with no database linked, picking
  one compares at once), More (rename, views and code, directives; what only a DeZign project has — domains,
  project scripts, archived versions — in a "DeZign project" submenu); texts name DeZign only for its files.
  Both bars stay one line at any window width (labels give way to icons with tooltips; the diagram's columns,
  types and notation are one View menu)
- ✅ One detail panel for the selected table, column or relationship, docked right in a wide window and a drawer
  over the canvas in a narrow one (Esc closes it, a pin keeps it docked); the table and relationship dialogs are
  gone. Columns are one line each (key, name, type, NOT NULL); the one being worked on shows its details (default,
  comment, domain, notes, labels, properties, to do, its package). A relationship's identifying / mandatory /
  subtype are in its row; the table's SQL is at the bottom. A model is always editable (no Design switch) and
  takes canvas changes as they are made (no "Write to DBML"): written once nothing is being typed, ⌘Z takes them back
- ✅ In place on the canvas: a double-click on a table's name, a column's name or its type types over it (Enter
  keeps, Esc drops); a selected table offers "+ column" and NN toggles; keys pointing at a renamed column or
  table follow it. A double-click elsewhere on a table (or on a line) opens the panel; once open, it follows the
  table clicked. Each edit is a step of ⌘Z (e2e/flow97)
- ✅ Review before 1.1.0 (own pass with e2e/review-tour.mjs, then Codex on screenshots and code): editing on a
  named diagram no longer duplicates the rest of the model; renames reach tables the canvas does not show; the
  table whose details open is brought into view and Fit view fits what the drawer leaves; another file opened in
  a tab starts its own undo and drops what the previous one had pending; DeZign saves put a folder project back
  when a write fails, keep a backup folder per save and stop on any change made on disk meanwhile
  (apps/desktop/test/dezign-file.test.ts)

## Milestone 10 — Transactions you can see ✅ released 1.2.0 (2026-11-14)

From the pilot (a colleague used to DataGrip): changes made in the SQL editor commit at once, and nothing shows
whether a tab holds an open transaction. Kept small: one switch per connection, no session modes.

- ✅ Transaction state asked of the database, not guessed from the SQL text (PostgreSQL's protocol status, MySQL's
  server status, SQL Server `@@TRANCOUNT`/`XACT_STATE()`, SQLite's worker, Oracle and DuckDB from their own
  sessions): DDL that commits on its own (MySQL, Oracle) and a failed PostgreSQL transaction show as they are
- ✅ "Commit changes manually" per connection (off by default; not offered where the database has no transactions:
  ClickHouse, BigQuery, Trino). The first statement that changes something opens a transaction in the tab
- ✅ The query toolbar shows an open transaction (also one started with `BEGIN` on an automatic connection) with
  **Commit** and **Roll back**, and what ran in it (each statement and the rows it changed); a failed transaction
  offers only Roll back; a statement that committed it implicitly says so
- ✅ Each query tab keeps its own session (no shared-session mode); on SQLite, which has one connection, a tab
  can't write into the transaction another tab opened
- ✅ Nothing open is lost silently: closing a tab, disconnecting and quitting ask Commit / Roll back / Cancel;
  a tab with an open transaction is marked in the tab bar
- ✅ Server activity marks the sessions of this app (which tab), offers "Only DB Mastermind" and highlights sessions
  idle in an open transaction
- ✅ Integration tests per engine (PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, SQLite, DuckDB:
  packages/core/test/transactions.integration.test.ts) and e2e/flow98
- ✅ A grid save waits at most 5 s for rows another session locked (PostgreSQL `lock_timeout`, MySQL/MariaDB
  `innodb_lock_wait_timeout`, SQL Server `LOCK_TIMEOUT`, set back afterwards) and names the query tab that holds
  them, with "Go to the tab"; Oracle has no such limit for DML and still waits
- ✅ The transaction label shows how long it has been open and turns solid after 10 minutes (probably forgotten)
- ✅ Shortcuts ⌥⇧⌘↵ Commit, ⌥⇧⌘⌫ Roll back (menu Query); the toolbar gives way in narrow windows (labels → icons,
  the label → the change count); production connections suggest manual commit; UI tour shows the transaction scene
- ✅ The AI assistant's confirmed writes on a manual-commit connection wait in the chat's own transaction (Commit /
  Roll back in the AI panel; the model is told its reads don't see them yet)
- ✅ A query waiting for a lock says which tab (or other session) holds it, with "Go to the tab" (PostgreSQL, MySQL,
  MariaDB, SQL Server, Oracle with v$ access)
- ✅ Oracle grid saves no longer hang on locked rows either (`SELECT … FOR UPDATE WAIT` first)
- ✅ With manual commit the grid joins in: Save writes into the table tab's own transaction (one save stays all or
  nothing through a savepoint), the tab reads its own uncommitted rows, Commit / Roll back in its toolbar
- ✅ Saving a connection reconnects only when host, user, TLS… changed (`needsReconnect`): a new name, color, AI
  permissions or commit mode keep open transactions

- ✅ Another database on the same server: "Open another database…" (connection menu) lists the server's databases;
  each opens as a connection of its own (made on the first pick with this one's settings, not its explorer choices),
  so read-only, color, commit mode and AI permissions stay per database; a password typed for the session carries
  over without being saved (PostgreSQL, MySQL/MariaDB, SQL Server, ClickHouse; e2e/flow100)

Not planned: a shared session for all tabs, switching the database inside a connection (it would blur which
database a tab's settings protect), SQL formatting settings beyond what there is.

### Appearance (changelog only: not on the website)

- ✅ Settings → Appearance: theme and contrast (moved from General), density (compact rows in tables and the
  explorer), six accent colors
- ✅ An easter egg for colleagues: playful looks in the same place, never advertised — Retro (Retro 2001, Green
  terminal), Seasonal (Halloween, Christmas), Games (Medieval campaign, Fantasy hero); only in their spirit, no names
  or logos of anything real; each with a small drawn picture (tab bar, home screen); e2e/flow99
- ✅ Appearance redone after the owner's review: the look first, all as the same small cards; mode and contrast only
  for the standard looks (the others say they have their own colors); the selected tab is marked with the accent and
  a connection's color is a dot; SQL highlighting follows the look (keywords in the accent); theme rules apply to
  :root only (React Flow's own "dark" class reset the palette inside the ER diagram); every look reviewed on six
  screens with e2e/look-tour.mjs

---

## Milestone 11 — Workbench 🚧

The owner picked A, B, E and F of the backlog below (2026-11-14); C waits until somebody can test company sign-ins,
D is not needed now. The specification, with the UX rules every item follows (no new toolbar buttons, existing
screens reused, nothing shown before it is relevant, no new settings): [docs/specs/workbench.md](docs/specs/workbench.md).

- ⬜ A1 Definitions of views and routines in a query tab; a table's CREATE statement
- ⬜ A2 SQL files on disk (⌘⇧O, drop, ⌘S writes back)
- ⬜ A3 Warnings while typing (unknown table / column, UPDATE or DELETE without WHERE)
- ⬜ A4 ⌘-click to the definition; "Used by" in the structure tab
- ⬜ A5 Compare a plan with the previous one
- ⬜ B1 Totals of the selected cells · B2 a cell set to an SQL expression · B3 find a value anywhere · B4 profile a column
- ⬜ E Server activity: Sessions · Top queries · Storage (sizes, unused and repeated indexes)
- ⬜ F1 Agents propose connections, the user reviews them · F2 `dbm` command line · F3 runnable SQL in notes

## Backlog — what other tools have (review 2026-11-14) 💡

An independent pass over the app against DataGrip 2026.2, DBeaver 26.x, Beekeeper Studio 6, TablePlus, SSMS and
the retired Azure Data Studio (Microsoft ended it in early 2026; its SQL Server users are looking for a new
client). Nothing here is scheduled: it is the pool the next milestones are picked from, in rough priority order.
Each item has to pass the usual test (obvious at first sight, no new settings page).

**Where we are already ahead** (keep it that way): AI on your own key, a local model or an existing Claude Code /
Codex subscription; the MCP server with the same permissions as the app; a knowledge base of the data model;
modeling, model ↔ database diff and migrations for free (DataGrip has no modeler, DbSchema and DeZign charge);
DeZign projects saved back in place; data compare and schema compare free (DBeaver: PRO only); a portable Windows
build, the MSI and the managed config; transactions you can see in every tab.

### A. The SQL editor as a workbench (what a DataGrip user misses first)
- **Source of database objects**: open a view, function, procedure, trigger or sequence as its `CREATE OR REPLACE`
  text, edit it and run it (errors at their line; Oracle compile errors from `USER_ERRORS`); "Show / Copy DDL" for
  any object, tables included. Today functions and procedures are only listed in the explorer
- **SQL files on disk**: open a `.sql` file in a tab and ⌘S writes it back (today scripts can only be saved);
  a folder of scripts per connection (or the knowledge base's `queries/`) shown in the sidebar, Git friendly
- **Inspections while typing**: unknown table or column underlined, ambiguous column, `UPDATE`/`DELETE` without
  `WHERE` marked in the editor (today only a confirmation when it runs), a join on columns of different types;
  quick fixes where the fix is obvious
- **Navigation**: ⌘-click a table or column → its structure; "Where is it used" (views, routines, foreign keys,
  saved queries, knowledge base notes); search in the source of all views and routines
- Compare two query plans (before / after an index) in the EXPLAIN viewer

### B. Data grid
- Sum / average / count / min / max of the selected cells in the status bar
- A cell set to an SQL expression (`now()`, `gen_random_uuid()`) besides NULL and DEFAULT (DataGrip 2026.2)
- Transposed view of a result (one record as a column of fields) for wide tables
- **Find a value anywhere**: search all tables (or chosen schemas) of a connection for a text or a number,
  read-only, typed by column, cancellable, results grouped by table (DataGrip's full-text search; analysts ask for
  it when they get only an order number)
- Column profile without AI: nulls, distinct, top values, min/max and a small histogram; AI can explain it after
- Compare two results side by side (the same query on two connections, or before / after a change)
- Spatial values (PostGIS, SQL Server geography) on a map

### C. Connections companies need
- **Microsoft Entra ID** sign-in for Azure SQL / Fabric, Azure PostgreSQL and MySQL (interactive with MFA, then
  managed identity / service principal): the SQL Server teams of the strategy's second group sign in this way, and
  ADS / SSMS users expect it (Beekeeper added it in 5.6)
- AWS RDS / Aurora IAM tokens and Google Cloud SQL IAM sign-in
- Passwords from a password manager or a command (1Password, Bitwarden, HashiCorp Vault, `pass`): the secret is
  fetched when connecting and never stored
- SSH through a jump host (several hops), SOCKS / HTTP proxy, Kerberos for PostgreSQL / SQL Server on Linux and macOS
- Snowflake and Redshift stay in "Later, when someone needs it" (Beekeeper 5.9 shipped Snowflake)

### D. Moving data
- **Copy tables between connections**: structure and data of chosen tables or a whole schema to another
  connection, even another engine (types translated as in forward engineering), streamed, in foreign-key order,
  resumable (DBeaver's data transfer, DataGrip's "Copy table to"); today only data compare's sync script moves rows
  between connections, as one script
- Import JSON / JSON Lines / Parquet into a table (DuckDB reads them already), not only CSV / Excel
- Run one script on several connections (dev, test, prod or the 20 tenant databases), results per target, stop on
  the first error or go on
- Query across connections in one SQL statement through DuckDB's PostgreSQL / MySQL / SQLite scanners
  (DBeaver 26.2 sells this as Multi-Source), read-only

### E. Server health (what ADS and SSMS users looked at)
- Top queries by time and calls (`pg_stat_statements`, SQL Server Query Store, MySQL `performance_schema`),
  with "Open in editor" and "Explain"
- Table and index sizes, unused and duplicate indexes, missing indexes the server suggests, PostgreSQL bloat
- SQL Server Agent jobs and their history, read-only first
- Users & roles: create a user, grant and revoke through reviewed SQL (the browser is read-only today)

### F. Agents and automation
- MCP tools to add and edit a connection without its password (DataGrip 2026.2 has `create_database_connection`);
  the password is typed in the app
- A command line (`dbm`): run a query or saved query to CSV / JSON, export, check a model, diff a model with a
  database, write the data dictionary, for CI and scripts (DataGrip 2026.2 and DBeaver's dbvr added CLIs); merges
  with "Command line for CI" in Milestone 8
- SQL notebooks in the knowledge base: a Markdown note with runnable SQL blocks and their results / charts,
  saved as plain `.md` (Azure Data Studio's notebooks had users; ours would live in Git with the rest of the notes)

### G. Smaller things
- Local history of a query tab (its text over time, not only what was run)
- More UI languages (German, Polish, Slovak) once the i18n files can take community translations
- Git status of models and knowledge base files (changed / new) in their trees; committing stays in the user's Git tool

### Still not planned after this review
- A stored procedure debugger, a JVM / JDBC driver bridge, a plugin marketplace, MongoDB / Redis / DynamoDB
  (see Milestone 7 and 8); a cloud / web edition (CloudBeaver): the app is local-first

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
