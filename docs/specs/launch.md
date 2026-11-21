# Milestone 12 — Launch (1.5.0): the specification

Written 2026-11-21. The owner wants to launch the app publicly (Product Hunt and elsewhere). Until now it was
built for his team, which is why the modeler speaks DeZign for Databases. The app has enough depth; what a wider
audience of developers and analysts lacks is **a way in they recognise** (their formats, their services, npm)
and **a first install without friction**. The owner agreed to all of it on 2026-11-21.

Two tracks with disjoint files. Track A is the app and core, track B is distribution, the website and the
repository.

## The rules (as in docs/specs/workbench.md)

1. **No new toolbar buttons, no new settings, no new kinds of screens.** A feature appears in the menu where its
   object already is (the model's Import menu, the diagram's Export menu, "Import connections"), in the command
   palette and by dropping a file.
2. **Nothing may get harder or break.** DeZign compatibility, the existing imports and exports and every e2e flow
   stay as they are.
3. **Readable over fitting**: full names in menus; a long menu item is fine, a squeezed one is not.
4. **Every feature is verified against the real thing**, as the DeZign work was: generated Prisma is validated by
   Prisma, generated Drizzle and TypeScript are compiled, generated SQLAlchemy is imported by SQLAlchemy; imports
   are checked on real public files of each tool. Tools and samples are fetched by the tests into a temp folder
   (env-gated, as `DBM_DEZ_SAMPLES` is); they are not dependencies of the repository, and other projects' files
   are not copied into it (fixtures are hand-written in the format).
5. Czech texts for every new string (`i18n-cs.ts`; `apps/desktop/test/ui-coverage.test.ts` checks), an e2e flow
   for each feature (`DBM_E2E_BACKGROUND=1`, throwaway HOME, dialogs stubbed), unit tests for the pure logic.
6. The conventions of CLAUDE.md hold: values across IPC are `CellValue`, identifiers through `quoteIdent`, new
   dependencies pinned to an exact version published at least two weeks ago, comments say why.

---

## Track A — the app

### A1. Code from a model: Prisma, Drizzle, SQLAlchemy, TypeScript types

**What the user does.** In a diagram's Export menu (a model's and a live database's: both are `DiagramView`,
next to *Copy as Mermaid / PlantUML / DBML*) picks **Code ▸ Prisma schema · Drizzle schema (TypeScript) ·
SQLAlchemy models (Python) · TypeScript types**. A save dialog offers the tool's usual file name
(`schema.prisma`, `schema.ts`, `models.py`, `types.ts`). From the command line:
`dbm export model.dbml --format prisma|drizzle|sqlalchemy|typescript [--out file]`, and the same with `--url`
for a live database.

**Core**: `packages/core/src/orm-export.ts`, pure functions over `TableInfo[]` (+ enums, + the database the
model is for; PostgreSQL when it has none).

- **Prisma**: what `prisma db pull` would write. Names as they are in the database (an identifier Prisma can't
  take is sanitized with `@map` / `@@map`); scalar types with `@db.*` native types for the model's database;
  `@id`, `@@id`, `@unique`, `@@unique`, `@@index`, defaults (`autoincrement()`, `now()`, `uuid()`,
  `dbgenerated("…")` for the rest), enums, `@relation` with `fields` / `references` / `onDelete` / `onUpdate`,
  **both sides** of every relation (the list or optional field on the referenced model), relation names when two
  tables are related more than once, self-relations, composite keys. A table without a primary key or unique
  index gets `@@ignore` as `db pull` does; an unknown type is `Unsupported("…")`. `datasource db` with the
  provider (`postgresql`, `mysql`, `sqlserver`, `sqlite`, `cockroachdb`) and `url = env("DATABASE_URL")`.
  For a database Prisma has no provider for (Oracle, DuckDB, ClickHouse, BigQuery, Trino) the menu item is not
  offered.
- **Drizzle**: what `drizzle-kit pull` writes: `pgTable` / `mysqlTable` / `sqliteTable` from the right
  `drizzle-orm/*-core`, camelCase keys with the database name as the string, `.notNull()`, `.primaryKey()`,
  `.default(…)` / `.defaultNow()` / `sql\`…\``, `.references(() => other.col, { onDelete })`, composite
  `primaryKey` / `foreignKey` / `unique` / `index` in the table's third argument, `pgEnum`. PostgreSQL (also
  CockroachDB), MySQL / MariaDB, SQLite; not offered for other databases.
- **SQLAlchemy 2.0** declarative: `class Base(DeclarativeBase)`, a class per table (`__tablename__`,
  `__table_args__` with the schema, composite constraints and indexes), `Mapped[…]` / `mapped_column(…)` with
  the SQL type, `ForeignKey("table.column", ondelete=…)`, `server_default=text("…")`. Any database.
- **TypeScript types**: an `interface` per table (PascalCase name, columns as they are named, quoted when they
  must be), `| null` for nullable columns, a union of literals for enums; numbers that don't fit a JS number
  (`bigint`, `numeric`) are `string`, as the drivers return them. Any database.
- Types are mapped through one classifier of a column type's family (reuse what `type-map.ts` knows; don't write
  a second table of type names per generator).

**Verified by** (rule 4) `packages/core/test/orm-export.tools.test.ts`, run when `DBM_ORM_TOOLS=1` (and in a CI
job): into a temp folder it installs pinned `prisma`, `drizzle-orm` + `typescript`, and `sqlalchemy` (pip, in a
venv), then for a set of models (the demo database, a model with every type family, composite and repeated
relations, self-reference, enums, names that need quoting; for each supported database):
`prisma validate` passes; `tsc --noEmit --strict` passes on the Drizzle file and on the types; Python imports
the SQLAlchemy module and `Base.metadata.create_all()` runs on SQLite (and the compiled DDL for PostgreSQL is
produced without error). Unit tests without tools: Prisma out → `tablesFromPrisma` in gives the same tables.

### A2. Models from other tools: Mermaid, drawDB, MySQL Workbench

**What the user does.** The model's Import menu item *SQL script or Prisma schema…* becomes
**SQL, Prisma, Mermaid, drawDB or MySQL Workbench file…** (one item, the format is recognised by extension and
content). *Open a model* (home page, File → Open Model, the command palette), a file dropped on the window and
the command line also take `.mwb`, `.mmd` / `.mermaid`, `.prisma` and a drawDB `.json` / `.ddb` (a dropped
`.json` that is not a drawDB diagram is still a data file to query). Such a file opens as a new unsaved model
(Save makes a `.dbml`); the opened file is never changed. A notice says what was opened and what could not be
taken, with counts, as the DeZign notice does.

**Core**: one module per format under `packages/core/src/`, each returning tables (+ enums, positions, notes,
what was left out) that go through `toDbml` as the Prisma import does.

- **Mermaid `erDiagram`** (also inside a Markdown code fence): entities with attributes (`type name PK, FK, UK
  "comment"`), relationships with their cardinality. A relationship names no columns: use the columns the label
  names (our own export writes them), else the child's `FK` columns that match the parent's key by name, else add
  the key column(s) as drawing a relationship from table to table does; many-to-many is left out and counted.
- **drawDB** JSON export: tables with fields (type, default, check, primary, unique, not null, increment,
  comment), indices, relationships with their actions, table positions and colors, notes, subject areas (as
  diagram frames if that is cheap, otherwise counted as left out), enums and custom types. Read the format from
  drawDB's own source (github.com/drawdb-io/drawdb: its JSON schemas and templates); both id styles (numbers in
  older exports, strings in newer). drawDB is AGPL: learn the format from it, copy nothing into this repository.
- **MySQL Workbench `.mwb`** (a zip with `document.mwb.xml`; `fflate` is already a dependency): schemas, tables,
  columns (type with length / precision / scale, flags such as UNSIGNED, NOT NULL, AUTO_INCREMENT, default,
  comment), indexes (primary, unique, plain, with prefixes), foreign keys with rules, the positions of the first
  diagram's table figures. Types stay MySQL's (the model is "for MySQL").
- **Check on real files** (env-gated, `scripts/model-samples.mjs <folder>` fetches them as
  `scripts/dezign-samples.mjs` does): MySQL's Sakila ships `sakila.mwb` next to `sakila-schema.sql` — the model
  read from the `.mwb` and the one read from the SQL script must compare as the same (`compareSchemas`); public
  drawDB exports and Mermaid ER diagrams from GitHub must open without an error and without losing a table.
  Counts only in the output.

### A3. Services by name

Supabase, Neon, Timescale, Amazon RDS / Aurora, Azure Database and Azure SQL, Google Cloud SQL already work
(they are PostgreSQL, MySQL or SQL Server); nothing says so.

- `packages/core/src/services.ts`: `detectService(host)` from host name patterns → `{ name, tls: 'require' }`
  and, where it is certain, one sentence about that service (Supabase's transaction pooler on port 6543 takes no
  session settings — the PgBouncer case the driver already explains).
- Connection form: when the host is a known service, one quiet line under the host says which
  ("Supabase (PostgreSQL)"); a pasted connection string that says nothing about TLS gets *require* for such a
  host; an empty name is prefilled with the service's name. The paste field's placeholder names a few services.
  No logos (the form uses neutral monograms), no new driver entries.
- Only services that run the real engine are named. Compatible reimplementations (PlanetScale, TiDB, YugabyteDB)
  are not claimed until tested.

### A4. Connections from a project: `.env` and docker-compose

**What the user does.** Drops a `.env`, a `docker-compose.yml` / `compose.yaml` or a project folder on the
window, or picks it in *Import connections → From a file…*. The connections found there are imported like any
other import.

- `.env` (also `.env.local`, `.env.development`…): `DATABASE_URL` and any other variable whose value is a
  connection URL; the `DB_CONNECTION` / `DB_HOST` / `DB_PORT` / `DB_DATABASE` / `DB_USERNAME` / `DB_PASSWORD`
  set; `PGHOST`…, `MYSQL_HOST`… sets. Quotes, `export`, comments, `${VAR}` and `${VAR:-default}` are resolved
  within the file.
- Compose: services whose image is a database we connect to (postgres, timescale, postgis, mysql, mariadb,
  `mcr.microsoft.com/mssql/server`, clickhouse, cockroachdb, oracle free / xe, trino) with the published port on
  `localhost` and the user, password and database from their `environment` / `env_file`, variables resolved
  from the `.env` next to the file.
- A folder: its `.env*` files, compose files and `prisma/schema.prisma` datasource (top level only); the same
  connection found twice is offered once.
- **Passwords are taken** (unlike imports from other tools, which can't read them): the file is the user's own
  and holds them in plain text; they are saved encrypted like any password. Nothing is connected until the user
  opens the connection. Files over 1 MB are refused; only the chosen file and the `.env` beside it are read.
- The names: the variable's or the service's name with the folder's name ("shop — DATABASE_URL").

### A — e2e

One flow per feature (`e2e/flow112…`): export each code format from the demo model and check the file; open a
hand-written `.mwb`, drawDB JSON and Mermaid file and check tables, relationships and positions; paste a
Supabase-style URL and see the service line and TLS; import a `.env` and a compose file and connect to the
PostgreSQL test container with the imported password.

---

## Track B — distribution, website, repository

### B1. `dbmastermind-mcp` on npm and in the MCP registry

- `packages/mcp/package.json`: description and keywords name every engine, `homepage` is
  https://dbmastermind.app, `publishConfig.access: public`, `mcpName` (the MCP registry checks it against
  `server.json`; the name is `io.github.<GitHub login>/…` — take the exact rules from
  modelcontextprotocol.io/registry). `packages/mcp/server.json` beside it; the release keeps its version in step.
- **A test that the package as published starts**: `npm pack` → install the tarball into an empty folder →
  `npx dbmastermind-mcp --url sqlite:///…` answers `initialize` and `tools/list` over stdio, `dbm query` prints
  rows. In CI on Node 22 and 24, Linux, macOS and Windows. The package has never been published: this is the
  only proof it works from npm.
- `release.yml`: the `mcp-npm` job also runs from `workflow_dispatch` (so a first publish doesn't need a new
  release), publishes with the `NPM_TOKEN` secret, or without a token through npm trusted publishing (OIDC:
  `id-token: write`, npm ≥ 11.5.1, no `NODE_AUTH_TOKEN`) when the repository variable `NPM_TRUSTED_PUBLISHING`
  is `1`; after a publish it publishes `server.json` to the MCP registry with `mcp-publisher` (GitHub OIDC).
  Without token and variable it skips, as today.
- `packages/mcp/README.md` (it is the npm page): every engine, the quick start first.

### B2. Linux without `--no-sandbox` where the sandbox can work

Today every Linux build starts with `--no-sandbox` (`electron-builder.yml` `executableArgs`). For a client that
holds database passwords that is the first thing a security-minded reader notices.

- The `.deb` installs `chrome-sandbox` SUID root, so its sandbox works: no flag.
- An AppImage can't ship a SUID helper: the sandbox works where unprivileged user namespaces are allowed and
  not on a default Ubuntu 24.04. A small launcher decides at start: SUID helper present → sandbox; user
  namespaces usable → sandbox; otherwise `--no-sandbox` and one line on stderr saying why and how to allow it.
- `--mcp` (headless, no window) stays without it, as today.
- Checked in CI on `ubuntu-24.04` with the packaged builds: the installed `.deb` starts sandboxed without any
  system change; the AppImage starts (fallback) as the system is, and sandboxed after user namespaces are
  allowed; auto-update of the AppImage, the path agents get for MCP and `--mcp` keep working. If this can't be
  proven in CI, leave the flag and say what stopped it.

### B3. Website, README, repository

- **Home page**: the hero's first paragraph and the meta description speak to everyone (no DeZign in them);
  a "Works with" line names the services of A3. On Windows the main button goes to the Microsoft Store
  (signed, no SmartScreen), with the installer and the portable zip as the other choices.
- **`docs/dezign.html`** "For DeZign for Databases users": what the Modeling section says about it today, in
  full, with the trademark line; linked from the Modeling section and the footer.
- **`docs/azure-data-studio.html`** "Coming from Azure Data Studio": Microsoft retired it; what its users find
  here (SQL Server with Windows authentication and Entra ID, plans, server activity, notebooks as notes with
  runnable SQL, import of its connections). Every statement about another product is checked on its vendor's
  own page and dated; what can't be checked is left out. No comparison tables of other vendors' prices.
- Both new pages use `site.css` + `theme.js`, are linked from the home page and have their own title and
  description.
- **README**: the same opening as the home page; the macOS first-launch steps as the website has them
  (System Settings → Privacy & Security → Open Anyway; "right-click → Open" no longer works); the code exports,
  new imports and services; the npm line only says `npx` once the package is published.
- **`SECURITY.md`** (how to report privately: GitHub's private vulnerability reporting; what counts; what the
  app does with secrets, in five lines) and **`CONTRIBUTING.md`** (build, tests, conventions from CLAUDE.md,
  translations, that the maintainer is an AI working for the owner and how a pull request is handled).
- **`docs/launch.md`**: the launch kit, ready to paste — Product Hunt (name, tagline ≤ 60 characters,
  description ≤ 260, topics, the maker's first comment, gallery order), Show HN, Reddit posts for r/PostgreSQL,
  r/SQLServer, r/dataengineering, the MCP directories to submit to once the npm package exists, a checklist for
  the day. Honest about the project: free, MIT, no paid tier, maintained by an AI maintainer with a human
  owner; that is said plainly in the first comment and is not the headline.
- **`e2e/launch-shots.mjs`**: gallery images at 1270×760 (Product Hunt's size) of the six strongest screens and
  a short recorded tour (Playwright's video of the window), written to a folder given as an argument, never
  into the repository's working tree by default.

### Waiting for the owner (issue #1)

- `NPM_TOKEN` (or the first publish by hand), then the trusted publisher on npmjs.com.
- Apple Developer ID for notarization (the pipeline change comes when the certificate exists: it can't be
  tested before).
- The Product Hunt account, the launch date, the video upload.
