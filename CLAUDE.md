# DB Mastermind — maintainer notes

You are the sole maintainer (developer, PM, release manager) of this project. The owner is a product sponsor
who does not review code. Work autonomously: pick the next item from `ROADMAP.md`, ship it with tests, update
the roadmap, commit, push. Product decisions are in `docs/STRATEGY.md`.

## Layout

- `packages/core`: everything database-related, with no Electron dependency. Drivers (`src/drivers/*`), SQL
  dialects, filter → SQL builder, row mutations, script splitter, connection URL parser, `DatabaseService`
  (used by both the app and the MCP server). Source is consumed directly as TypeScript and bundled by the apps.
- `packages/mcp`: `dbmastermind-mcp` CLI, a stdio MCP server built on core.
- `apps/desktop`: Electron app (electron-vite). `src/main` is the main process (owns `DatabaseService`, settings,
  secrets), `src/preload` exposes a typed API, and `src/renderer` is React UI.
- `docs/`: architecture, strategy, user docs.

## Commands

```bash
npm install
npm run db:up                 # Docker: postgres:54329 mysql:33069 mariadb:33070 mssql:14339
npm test                      # unit tests (fast, no DB)
npm run test:integration      # every driver against real databases
npm run typecheck
npm run dev                   # desktop app with HMR
```

`DBM_SKIP=mssql npm run test:integration` skips engines that aren't available.

## Conventions

- TypeScript strict, ESM, no default exports except React components where idiomatic.
- Values crossing IPC/MCP are `CellValue` (see `values.ts`): never pass Date/Buffer/bigint across.
- Every SQL built from user input is parameterized; identifiers go through `dialect.quoteIdent`.
- Read-only connections are enforced in `DatabaseService` (statement classification) and at the database
  session level where supported. Don't bypass `DatabaseService` from the app.
- New driver = implement `DatabaseDriver`, add to `createDriver`, add a fixture to
  `test/drivers.integration.test.ts` and a service to `docker-compose.test.yml`.
- Comments explain *why*, not what. Keep them sparse.
- UI text is English; Czech translations live in the i18n files.

## Gotchas learned the hard way

- mysql2 emits `fields` with `undefined` for statements without result sets.
- mysql2 parses MariaDB JSON (BLOB + json hint) into objects; `typeCast` re-stringifies it.
- `KILL QUERY` must complete before a connection is reused, or it can kill the next statement.
- node:sqlite can't be interrupted; cancelling abandons the worker and opens a fresh one.
- pg user queries use identity type parsers (exact text); catalog queries must use `pg.types`.
- npm optional-deps bug: if rolldown/vitest says "Cannot find native binding", delete `node_modules` and
  `package-lock.json` and reinstall.
- DuckDB: one connection per statement (interrupt cancels a whole connection). File databases checkpoint after
  every commit (`checkpoint_threshold = 0b`): DuckDB 1.4 fails replaying some WAL entries, and a second
  instance on the same file needs the data in the file. A table with indexes, views or incoming foreign keys
  can't be ALTERed: `generateMigration` drops/recreates indexes and views around it, creates new tables last,
  and warns about referenced tables.
- DuckDB bindings are per-platform npm packages: release.yml fetches the other architecture's binding with
  `npm pack`, `build/after-pack.cjs` keeps only the target's binding in each package.
- `runScript` without a session runs multi-statement scripts on a temporary session, so BEGIN … COMMIT stay
  on one connection.
- This checkout lives in an iCloud-synced folder: never package the app locally into `apps/desktop/release`
  (hundreds of MB keep iCloud busy and file access hangs for minutes). Package to a temp dir instead:
  `npx electron-builder --dir -c.directories.output="$TMPDIR/dbm-release"`.
- The UI starts in the system language (Czech on a Czech Mac). E2E scripts pass `DBM_LANGUAGE: 'en'` so English
  labels match.
- CockroachDB goes through the PostgreSQL driver: its catalog returns NULL where PostgreSQL has booleans
  (`relispartition`), so wrap such columns in `coalesce`. `serverInfo().product === 'CockroachDB'` switches
  EXPLAIN (text plan) and activity (crdb_internal, CANCEL QUERIES/SESSION).
- ClickHouse placeholders are `{__pN}` tokens the driver replaces with escaped literals (typed query parameters
  don't compare across types). Its dialect has empty begin/commit: code that wraps scripts must skip empty ones.
  Rows are read-only (no primary key reported; the sorting key shows as an `ORDER BY` index).
- New dependencies: pin an exact version published at least two weeks ago.
- Things that touch the user's machine in tests (MCP client configs, DataGrip, team folders) run against a temp
  `HOME` / `DBM_USER_DATA`; never against the real configuration.
- electron-updater is CommonJS with a lazy `autoUpdater` export: load it through `loadAutoUpdater()` (falls back to
  `default.autoUpdater`); a plain `import('electron-updater')` destructure is undefined and silently broke updates
  in 0.9.0/0.9.1. `update-check.yml` builds the current code as 0.0.1, installs it on Windows and updates it to the
  latest release; the updater logs to `<data>/logs/updater.log`.
- Text that ends up in the MSIX manifest (app description) must not contain a bare `&`.
- AI permissions are enforced in main through `aiAccess(config)` (main/ai-access.ts): never check `aiEnabled` directly.
- winget: package `eLh0m3r0.DBMastermind`; the release `winget` job runs `komac update` (pinned 2.16.0) with the `WINGET_TOKEN` secret and skips until the package exists in microsoft/winget-pkgs. GitHub's Windows runners can't run the winget client reliably (hangs / AppX errors) — check manifests with `komac analyze` locally instead.
- BigQuery: filter values are text and BigQuery is strictly typed, so `Dialect.typedParam` casts them to the column type (engine passes `columnTypes`); LIKE has no ESCAPE clause (backslash). The emulator (goccy 0.8.1, port 19050 in tests) ignores LIKE escapes and rejects duplicate result column names — real BigQuery handles both, so tests avoid them.
- Shortcut text in the UI goes through `keys('⇧⌘↵')` (lib/api) so Windows/Linux show Ctrl+Shift+Enter; never hardcode ⌘. To see the app on Windows/Linux, run the `UI tour` workflow (workflow_dispatch) and download its screenshot artifacts.
- Trino driver speaks the HTTP protocol with fetch (no client library): `{__pN}` placeholders are inlined as literals and cast to the column type by `trinoDialect.typedParam` (Trino won't compare varchar with numbers/dates). 64-bit integers stay exact through `JSON.parse` with the reviver's `context.source`. Result column types use the protocol's spelling (`decimal(10, 2)`, `timestamp`), the schema uses information_schema's (`decimal(10,2)`, `timestamp(3)`). Local test server: `docker run -p 18080:8080 trinodb/trino:483` (memory + tpch catalogs).
- AI/MCP SQL nobody confirmed runs with `runScript(..., { readOnly: true })`: a read-only transaction (`dialect.beginReadOnly`) on its own session, always rolled back. Statement classification alone is not a guard (`SELECT setval(…)`, functions that write, T-SQL `SELECT 1 DELETE …` without semicolons). Read-only SQL Server connections use the same guard (ApplicationIntent=ReadOnly only binds on replicas). Tests: packages/core/test/readonly-guard.integration.test.ts.
