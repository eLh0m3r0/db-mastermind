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
