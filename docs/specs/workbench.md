# Milestone 11 — Workbench: the specification

Written 2026-11-14 from the competitor review (ROADMAP.md, "Backlog — what other tools have") and the owner's
answer: do A (SQL editor), B (data grid), E (server health) and F (agents and automation); C (company sign-ins)
later, since nobody here has Entra ID to test with; D (moving data) is not needed now. The owner's condition:
**the app works well today; nothing may get harder to use, nothing may break.**

## The UX rules for this milestone

These decide every detail below. When an implementation question isn't answered here, the answer is the one that
keeps these rules.

1. **No new buttons on existing toolbars.** A feature appears where its object is (the explorer row, the grid's
   context menu, the column header), in the command palette and in the app menu. The query toolbar, the table
   toolbar and the home screen stay exactly as they are.
2. **No new kinds of screens where an existing one does the job.** An object's definition opens in an ordinary
   query tab; a found value opens the ordinary table tab with an ordinary filter; server health is part of the
   Server activity tab; a notebook is an ordinary knowledge base note.
3. **Nothing shows until it is relevant.** Selection totals appear only with two or more cells selected; editor
   warnings only where the app is sure; a health section that the database can't answer says so in one line.
4. **No new settings.** Defaults are chosen so nobody needs to change them.
5. **Safe as before.** Every new statement goes through `DatabaseService` (read-only connections, statement
   classification, audit log); values are parameters; identifiers are quoted by the dialect. Nothing new runs
   writes on its own.
6. **Every feature is verified**: unit tests for the pure logic in core, integration tests on real databases for
   engine-specific SQL, an e2e flow clicking through it in the app, Czech texts, and a look at screenshots in a
   narrow and a wide window.

---

## A. The SQL editor as a workbench

### A1. Definitions of views and routines (and the CREATE statement of a table)

**What the user does.** Clicks a function or procedure in the explorer (today the row does nothing), or picks
*Definition (SQL)* in the context menu of a view, function, procedure or table.

**What happens.** A query tab opens with the object's definition as the database keeps it, ready to edit and run:

| Engine | Views | Functions / procedures |
|---|---|---|
| PostgreSQL / CockroachDB | `CREATE OR REPLACE VIEW … AS` + `pg_get_viewdef` (materialized: `CREATE MATERIALIZED VIEW`) | `pg_get_functiondef` (already `CREATE OR REPLACE`) |
| MySQL / MariaDB | `SHOW CREATE VIEW` with `CREATE` → `CREATE OR REPLACE` | `SHOW CREATE FUNCTION / PROCEDURE` (a `DROP … IF EXISTS` line before it, since MySQL has no OR REPLACE for routines) |
| SQL Server | `OBJECT_DEFINITION` with the first `CREATE` → `CREATE OR ALTER` | same |
| Oracle | `ALL_VIEWS.TEXT` → `CREATE OR REPLACE VIEW … AS` | `ALL_SOURCE` lines → `CREATE OR REPLACE …` |
| SQLite | `sqlite_master.sql` (a `DROP VIEW IF EXISTS` line before it) | — |
| DuckDB | `duckdb_views().sql` with `CREATE` → `CREATE OR REPLACE` | — |
| ClickHouse, BigQuery, Trino | `SHOW CREATE` / `INFORMATION_SCHEMA.VIEWS` | — (the menu item isn't offered) |

A table's *Definition (SQL)* is the CREATE TABLE the app generates from the catalog (the same generator as the
designer's migrations) with its indexes and foreign keys; the first line says so (`-- Generated from the catalog`),
because it is not the server's own text.

- The tab's title is the object's name; opening the same object again goes back to its tab (like table tabs).
- Running the statement changes the object; the schema reloads as after any DDL. A read-only connection shows the
  definition and refuses to run it, as it refuses any DDL today.
- The query tab remembers which object it shows (`object` on QueryTab) only to find it again; it is otherwise an
  ordinary query tab (Save, Format, AI, transactions all work).
- Overloaded PostgreSQL functions: each overload is its own row in the explorer already (`arguments`); the
  definition is fetched by `oid` resolved from schema + name + identity arguments.

**Not now:** triggers (the schema snapshot has none; a later step adds them to introspection), editing packages
in Oracle as a pair (spec + body show as two objects when they come).

### A2. SQL files on disk

**What the user does.** *File → Open SQL File…* (⌘⇧O, also in the command palette), or drops a `.sql` file on the
window, or starts the app with one (command line, *Open with*).

**What happens.** The file opens in a query tab on the connection selected in the sidebar (with no connection
selected, the app says "Choose a connection first" and opens nothing). The tab shows the file name; ⌘S writes the
file back (no dialog); the unsaved dot works as for saved queries. A file tab offers no "Save query" dialog: it
*is* saved, to its file.

- *Save as file…* is a link in the existing Save query dialog ("or save as a .sql file…"), so a scratch query can
  become a file without a new button.
- When the file changed on disk and the tab has no unsaved changes, activating the tab reloads it silently; with
  unsaved changes, a toast offers *Reload from disk* (the text in the tab stays until the user decides).
- Encoding: UTF-8 (with or without BOM), otherwise Windows-1250 as for CSV imports; the file is written back in
  UTF-8 (BOM kept if it had one) with its own line endings.
- Restoring the window keeps the tab with its path; a file that no longer exists keeps the text and says so when
  saving ("The file was moved or deleted: save it as…").

**Not now:** a folder of scripts in the sidebar (the knowledge base already gives a Git-friendly folder with a tree).

### A3. Warnings while typing

A quiet wavy underline (warning color, not red) with a tooltip, computed 400 ms after typing stops, **only for
what the app knows for sure**:

1. **Unknown table**: a name after `FROM`, `JOIN`, `UPDATE`, `INTO`, `DELETE FROM`, `TABLE` that is neither a table
   or view in the snapshot, nor a CTE of the statement, nor created earlier in the script, nor a temporary
   (`#x`, `temp.`), system (`pg_*`, `information_schema`, `sys`, `dual`, `sqlite_*`, `duckdb_*`, `system.*`) or
   function call (`generate_series(…)`) — and only when its schema (if written) is one the snapshot knows and is
   not hidden. Tooltip: *Unknown table “custmers”. Did you mean “customers”?* with a one-click fix.
2. **Unknown column**: `alias.column` or `table.column` whose table is known and has no such column. Unqualified
   columns are not checked (they need full scope resolution; a wrong guess would teach people to ignore the marks).
3. **UPDATE / DELETE without WHERE**: *Changes every row of “orders”.* (today this is only a confirmation when it
   runs; the confirmation stays).

No gutter icons, no counters, no setting. Nothing is marked before the schema has loaded, inside string literals
or comments, or on engines whose names the snapshot can't vouch for (BigQuery, Trino: catalogs and datasets outside
the connection are common).

### A4. Go to definition, and where a table is used

- **⌘-click** (Ctrl-click) on a table or view name in the editor opens its structure; on a function name its
  definition (A1). While ⌘ is held, the name under the mouse is underlined like a link. No new shortcut to learn
  beyond the one every editor has.
- The **Structure tab** gets a "Used by" section at the bottom: views whose definition names the table, tables
  whose foreign keys point at it, saved queries that mention it, knowledge base notes about it; each line opens
  its target. Nothing new elsewhere.

**Not now:** rename refactoring, usages inside routine bodies (needs every routine's source fetched).

### A5. Compare two plans

The plan view keeps the previous plan of the same tab. When there is one, its header shows
*Compare with previous* (a link-styled button inside the plan view, not on the query toolbar): the two plans side
by side with the total cost (and time for EXPLAIN ANALYZE) of each and the change in percent.

---

## B. Data grid

### B1. Totals of the selection

With two or more cells selected, the grid's existing footer shows *Count 12 · Sum 1 234.50 · Avg 102.88 · Min 3 ·
Max 990* (numbers only; for text: *Count 12 · Distinct 4*; NULLs are counted apart: *3 empty*). A click on a value
copies it. Nothing shows for one cell. Same in table tabs and query results. Computed in the renderer from the
loaded rows (a pure function with unit tests), capped at 1 000 000 cells.

### B2. A cell set to an SQL expression

In the cell's context menu next to *Set NULL* and *Set DEFAULT*: *Set SQL expression…* → a small input
(`now()`, `gen_random_uuid()`, `price * 1.21`). The pending change shows the expression in italics with `=` before
it; the generated SQL (review panel) uses it as written. It is the user typing SQL in their own client, exactly
as in the editor: not offered on read-only connections, audited like every grid save.

### B3. Find a value anywhere

**What the user does.** Connection context menu → *Find a value…*, or the command palette *Find a value in all
tables…*, or the explorer's schema menu (pre-scoped to that schema).

**What happens.** A *Find value* tab: one input, the scope (all schemas or the chosen ones), *Exact / Contains*
(exact by default: fast, and what an order number needs), *Tables / Tables and views*. Results stream in as each
table answers: table name, the columns that matched, the first five rows. *Open* opens the table tab with the
filter `col1 = value OR col2 = value` — the ordinary filter, editable as always. *Stop* cancels the rest.

- Which columns: for a number, numeric and text columns; for a date, date columns and text; for a UUID, uuid and
  text columns; for other text, text columns only. Binary, JSON, spatial and LOB columns are skipped (said in the
  header: "searches text, number and date columns").
- Each table is one parameterized `fetchTable` with an OR filter and `LIMIT 5`, run two at a time, each with its
  own cancel. Read-only by construction (it is the grid's read path).
- The input remembers the last search per connection (for this run of the app).

### B4. Profile a column

The column header's context menu gets *Profile values…*: a small popover with rows, empty (NULL) count, distinct
count, min / max, and the 10 most common values with their share as bars. It respects the tab's current filter
(it profiles what the user is looking at). A click on a common value filters the grid to it. One aggregate query
and one GROUP BY query through `DatabaseService`, cancellable.

**Not now:** transposed grid (the row details panel already shows one record as a list), compare two results,
a map for spatial values.

---

## E. Server health — part of Server activity

Server activity becomes one tab with three sections in a segmented control at its top:
**Sessions** (today's view, unchanged and still the default), **Top queries**, **Storage**. The command palette gets
*Top queries* and *Table sizes*, which open the same tab on that section. No new menu entries elsewhere.

### E1. Top queries

| Engine | Source | Unavailable when |
|---|---|---|
| PostgreSQL | `pg_stat_statements` | the extension isn't installed: one line with the SQL to enable it (and that it needs `shared_preload_libraries`) |
| MySQL / MariaDB | `performance_schema.events_statements_summary_by_digest` | performance_schema off |
| SQL Server | `sys.dm_exec_query_stats` + `sys.dm_exec_sql_text` | no VIEW SERVER STATE |
| Oracle | `v$sqlstats` | no access to v$ views |

Columns: query (one line, full on hover), calls, total time, mean time, rows; sorted by total time (a header
click sorts by another). Each row: *Open in editor*, *Explain*. Refresh is manual (these are cumulative numbers).

### E2. Storage

Tables with their total, data and index size and row estimate, largest first (PostgreSQL, MySQL/MariaDB, SQL
Server, Oracle, DuckDB); below them **index findings**: indexes never used since the server's statistics were
reset (PostgreSQL `pg_stat_user_indexes`, SQL Server `dm_db_index_usage_stats`, MySQL `sys.schema_unused_indexes`;
unique and primary indexes never listed, the reset time shown so "unused" means something) and indexes that repeat
or cover another one (the model checks the app already has, run on the live schema). Each finding offers *Open
DROP INDEX in editor* — never run directly.

**Not now:** SQL Server Agent jobs, editing users and grants.

---

## F. Agents and automation

### F1. An agent proposes a connection

A tool `propose_connection` in the app's MCP server (desktop app only, not the standalone `dbmastermind-mcp`)
takes a name, driver, host, port, database, user (or a connection URL; a password in it is dropped). It never
creates the connection: it writes a proposal file into the app's data folder; the running app (or the next start)
shows *“Claude Code proposes a connection: shop on localhost:5432”* with *Review…* and *Dismiss*. *Review…* opens
the ordinary connection form prefilled, read-only switched on; the user types the password and saves. Nothing
reaches the saved connections without the user pressing Save. The tool answers the agent: "proposed; the user
reviews it in DB Mastermind".

Why not create it directly (DataGrip does): the MCP server is a separate process, the app owns the encrypted
store, and an agent that can change a connection's host could send a saved password elsewhere.

### F2. A command line for scripts and CI: `dbm`

A second binary in the `dbmastermind-mcp` npm package (`npx -p dbmastermind-mcp dbm …`), connections given like the
MCP server's (`--url`, `--config`, `${ENV}` placeholders):

```
dbm query  --url <url> "SELECT …" [--format csv|tsv|json|jsonl|markdown] [--out file] [--allow-writes]
dbm dictionary --url <url> [--format html|markdown] --out docs/db.html
dbm check  model.dbml                        # model checks; exit 1 when any problem
dbm diff   model.dbml --url <url> [--out migration.sql]   # exit 0 same, 2 different (drift check in CI)
```

Read-only unless `--allow-writes` (enforced as in the MCP server). Streaming for `query` (no memory limit).
Errors to stderr, exit 1. `--help` per command.

### F3. Runnable SQL in knowledge base notes (notebooks)

In a knowledge base note's preview, every ```` ```sql ```` block gets a small *Run* button in its corner; the result
(first 200 rows, the grid's look in compact form) appears under the block; *Open in editor* moves the SQL into a
query tab. Results are not written into the note (the file stays plain Markdown for Git). Runs as the editor does
on that connection (read-only connections stay read-only; dangerous statements ask). Nothing changes for notes
without SQL blocks.

---

## Order of work and checks

1. A1 definitions · A2 files · B1 totals (each with tests, committed one by one)
2. B3 find a value · B4 profile · B2 SQL expression
3. A3 warnings · A4 go to definition / used by · A5 plan compare
4. E1 / E2 server health
5. F1 proposals · F2 `dbm` · F3 notebooks
6. Regression: `npm run typecheck`, `npm test`, `npm run test:integration` (PostgreSQL, MySQL, MariaDB, SQL
   Server, SQLite, DuckDB), the e2e flows that touch the editor, grid, explorer and activity (flow98 transactions,
   flow100, the smoke flows) plus new flows for this milestone; screenshots narrow and wide; Czech texts
   (`i18n-dictionary.test.ts`).
7. Review by Codex of the whole branch; fixes; ROADMAP and the changelog updated.
