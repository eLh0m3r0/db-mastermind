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
- node:sqlite can't be interrupted; cancelling abandons the worker and opens a fresh one. A worker stuck in a query
  keeps the process from exiting, so before-quit exits hard when `sqliteWorkersAlive()` is still > 0 (e2e/flow86).
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
- AI permissions are enforced in main through `aiAccess(config)` (main/ai-access.ts): never check `aiEnabled` directly. `aiEnabled: false` in the managed config or team folder is read from there (not the saved copy) and beats the connection's own `ai`; listings mark such connections `aiLockedOff`.
- Website: https://dbmastermind.app (docs/ on GitHub Pages, docs/CNAME, HTTPS enforced). SignPath Foundation requires the "Code signing policy" (docs/code-signing.html, linked from the home page) and privacy policy (docs/privacy.html; summary in the home page #privacy section) on the site and README, and a link on every release page: release notes end with `Website: [dbmastermind.app](https://dbmastermind.app) · [Code signing policy](https://dbmastermind.app/code-signing.html) · [Privacy](https://dbmastermind.app/privacy.html)`. Keep the privacy section true: any new automatic network access needs a line there and a way to turn it off.
- winget: package `eLh0m3r0.DBMastermind`; the release `winget` job runs `komac update` (pinned 2.16.0) with the `WINGET_TOKEN` secret and skips until the package exists in microsoft/winget-pkgs. GitHub's Windows runners can't run the winget client reliably (hangs / AppX errors) — check manifests with `komac analyze` locally instead.
- BigQuery: filter values are text and BigQuery is strictly typed, so `Dialect.typedParam` casts them to the column type (engine passes `columnTypes`); LIKE has no ESCAPE clause (backslash). The emulator (goccy 0.8.1, port 19050 in tests) ignores LIKE escapes and rejects duplicate result column names — real BigQuery handles both, so tests avoid them.
- Shortcut text in the UI goes through `keys('⇧⌘↵')` (lib/api) so Windows/Linux show Ctrl+Shift+Enter; never hardcode ⌘. To see the app on Windows/Linux, run the `UI tour` workflow (workflow_dispatch) and download its screenshot artifacts.
- Trino driver speaks the HTTP protocol with fetch (no client library): `{__pN}` placeholders are inlined as literals and cast to the column type by `trinoDialect.typedParam` (Trino won't compare varchar with numbers/dates). 64-bit integers stay exact through `JSON.parse` with the reviver's `context.source`. Result column types use the protocol's spelling (`decimal(10, 2)`, `timestamp`), the schema uses information_schema's (`decimal(10,2)`, `timestamp(3)`). Local test server: `docker run -p 18080:8080 trinodb/trino:483` (memory + tpch catalogs).
- AI/MCP SQL nobody confirmed runs with `runScript(..., { readOnly: true })`: a read-only transaction (`dialect.beginReadOnly`) on its own session, always rolled back. Statement classification alone is not a guard (`SELECT setval(…)`, functions that write, T-SQL `SELECT 1 DELETE …` without semicolons). Read-only SQL Server connections use the same guard (ApplicationIntent=ReadOnly only binds on replicas). Tests: packages/core/test/readonly-guard.integration.test.ts.
  - "Is it a read?" is `isReadOnlyScript(sql, driver)`, never `classifyStatement` alone: for T-SQL it scans the whole statement for writes/EXEC/COMMIT; SQLite pragmas are reads only from an allowlist; `DECLARE … BEGIN` is not a read. Raw grid filters must pass `isReadOnlyCondition` on every connection (engine fetchTable/countTable).
  - SQL Server: never `request.cancel()` a batch that may write (it stops the rest of the batch); only read-only batches stop early at maxRows.
  - SQLite has one connection: `releaseSession` rolls back only the transaction its own session opened (the worker reports `isTransaction` with each reply).
- Dropped connections (server restart, VPN, idle kill): drivers keep `SessionTransactions` per session. No open transaction → reconnect/retry silently (retry only when it can't apply a write twice); open transaction → `ConnectionLostError` once, never silent autocommit. PG checked-out clients need an 'error' listener or the main process crashes. SQL Server reuses SPIDs, so it checks `@@TRANCOUNT`. Test: connection-loss.integration.test.ts (kills sessions from an admin connection).
- SSH host keys are trust-on-first-use (core/ssh.ts `useKnownHostsFile`, `<userData>/known-hosts.json`, shared with the MCP child); a changed key throws HostKeyMismatchError; the connection form shows the key with Forget. Writes are atomic and an unreadable file refuses the connection (never treat it as empty). e2e/flow63.
- SSH tunnels (core/ssh.ts) reconnect lazily: the next forwarded socket re-opens the SSH connection. ssh2 Clients need a permanent 'error' listener and `forwardOut` can throw synchronously — both used to crash the app. Test: ssh.integration.test.ts against the `ssh` service (container `dbm-ssh`, restarted by the test; DBM_SSH_KEY for key auth).
- TLS (core/tls.ts): `prefer` falls back to plain when the server has no TLS (pg/mysql drivers don't do that themselves); verify-full checks the real host name, also through an SSH tunnel (PG: checkServerIdentity on the configured host; MySQL: `stream` into the tunnel so mysql2 keeps the host name, plus a manual check for IP hosts, which mysql2 skips). Test: tls.integration.test.ts with scripts/tls-test-servers.sh (test CA, pg-tls :54330, my-tls :33071).
- Errors thrown across contextBridge keep only their message: the renderer's `api` (lib/api.ts) is built from `window.mastermind.call`, which returns the raw IpcResult, and throws `ApiError` with `code` there. Codes like PASSWORD_REQUIRED (core `isPasswordProblem` → main connect) depend on it.
- Connections without a saved password (imports leave passwords out) or with a rejected one ask for it (features/connections/PasswordPrompt.tsx, e2e/flow64).
- macOS self-update without signing: main/mac-update.ts (latest-mac.yml from the latest release → arch zip → SHA-512 check → ditto unpack → detached script swaps the bundle after quit). Squirrel.Mac would need a signed app. Checked by update-check.yml `mac` job (e2e/mac-update-check.mjs). DBM_UPDATE_FEED overrides the download base URL.
- macOS saved secrets: packaged apps encrypt them with AES-256-GCM (`enc:v2:`) using a key kept in the login keychain and read through /usr/bin/security (storage.ts `macSecretKey`, one key per data folder); `enc:v1:` (Electron safeStorage) is read once more and re-saved. safeStorage's item asked after every update because macOS partitions keychain access by cdhash for apps without an Apple Developer ID — a stable self-signed certificate does NOT fix that. Dev/e2e runs keep safeStorage unless DBM_MAC_SECRET_KEY=1. The key is created only when `security` exits 44 (item not found) and never overwritten (`readOrCreateMacKey`). A secret that doesn't decrypt is kept as ciphertext by `UnreadableSecrets` and written back on save, so a keychain hiccup never erases passwords (e2e/flow84).
- macOS release builds are signed with the project's self-signed certificate (secrets MAC_SIGN_P12/MAC_SIGN_PASSWORD, CN "DB Mastermind", SHA-1 1F:2D:19:85:DA:E1:CE:07:58:A7:C3:3A:9A:68:0E:4A:47:4F:74:D5, valid to 2036; the .p12 must be `openssl pkcs12 -export -legacy`, rcodesign cannot read OpenSSL 3's default AES p12 and reports a wrong password) via rcodesign in build/after-pack.cjs. It gives a stable designated requirement (not the keychain fix; see the secrets note). Never rotate the certificate casually: a new one triggers that prompt once for every user.
