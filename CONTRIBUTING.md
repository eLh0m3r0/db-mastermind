# Contributing

Thank you for looking. Bug reports, ideas and pull requests are all welcome.

## How this project is run

DB Mastermind belongs to [Václav Mudra](https://vaclavmudra.com), who decides what the product does. The code,
the tests, the reviews and the releases are done by an AI maintainer (Claude, made by Anthropic) working for him.
The owner doesn't review code; the maintainer does, against the conventions below and the test suite.

What that means for a pull request:

- The maintainer reads it, runs the tests and answers in the pull request. Expect questions about tests and about
  behaviour on the other databases and operating systems.
- A change that fits the [roadmap](ROADMAP.md) and the [product direction](docs/STRATEGY.md) is merged when it
  passes CI; anything that changes what the product is (new screens, new settings, a new dependency, a change to
  what leaves the computer) is a decision for the owner and may take longer.
- The maintainer may finish a pull request itself (rebase it, add tests or translations) and says so when it does.
- For a bigger change, open an issue first, so nobody spends a weekend on something that can't be merged.

Security problems: not in an issue or a pull request, see [SECURITY.md](SECURITY.md).

## Build and run

Node.js 22.16 or newer (CI uses 24) and npm.

```bash
npm install
npm run dev                   # the desktop app with hot reload
npm test                      # unit tests (fast, no database)
npm run typecheck
```

Integration tests run every driver against real databases in Docker:

```bash
npm run db:up                 # PostgreSQL, MySQL, MariaDB, SQL Server, Oracle, ClickHouse, CockroachDB, BigQuery emulator, Trino, SSH
npm run test:integration
DBM_SKIP=mssql,oracle npm run test:integration   # skip engines you don't have running
```

The MCP server and `dbm` as npm would publish them (packs, installs the tarball into an empty folder, starts it):

```bash
node packages/mcp/test/packed-package.mjs
```

End-to-end flows drive the real app with Playwright (`e2e/flow*.mjs`). Run them with `DBM_E2E_BACKGROUND=1`, a
throwaway `HOME` and `DBM_LANGUAGE=en`; see [CLAUDE.md](CLAUDE.md) for which flows need which fixtures.

## Layout

- `packages/core`: everything about databases, no Electron: drivers, SQL dialects, the filter builder, migrations,
  model import and export, and `DatabaseService`, used by both the app and the MCP server.
- `packages/mcp`: the `dbmastermind-mcp` MCP server and the `dbm` command line (published to npm).
- `apps/desktop`: the Electron app. `src/main` owns connections, settings and secrets, `src/preload` exposes a typed
  API, `src/renderer` is the React UI.
- `docs/`: the website (dbmastermind.app) and the user documentation.

## Conventions

The full list, with the reasons behind each, is in [CLAUDE.md](CLAUDE.md). The ones a pull request meets first:

- TypeScript strict, ESM, no default exports except React components.
- Every SQL built from user input is parameterized; identifiers go through `dialect.quoteIdent`.
- Read-only means read-only: the app goes through `DatabaseService`, and SQL nobody confirmed runs in a read-only
  transaction. Don't add a path around it.
- Values crossing IPC or MCP are `CellValue` (no `Date`, `Buffer` or `bigint`).
- A new driver implements `DatabaseDriver`, is added to `createDriver`, gets a fixture in
  `packages/core/test/drivers.integration.test.ts` and a service in `docker-compose.test.yml`.
- New dependencies are pinned to an exact version published at least two weeks earlier.
- Every change comes with tests: unit tests for logic, integration tests against the real database for SQL, an e2e
  flow for a new piece of UI.
- Comments explain *why*, not what, and are sparse.
- No new automatic network access without a line in [docs/privacy.html](docs/privacy.html) and a way to turn it
  off.

## Translations

The UI is in English and Czech. English text is written in the code; the Czech translation of every string is in
`apps/desktop/src/renderer/src/lib/i18n-cs.ts` (menus: `apps/desktop/src/main/menu.ts`), and
`apps/desktop/test/ui-coverage.test.ts` fails when one is missing. If you don't speak Czech, say so in the pull
request and the maintainer will add them. Shortcuts in UI text go through `keys('⇧⌘↵')`, so Windows and Linux show
Ctrl.

## License

By contributing you agree that your contribution is licensed under the [MIT license](LICENSE) of the project.
