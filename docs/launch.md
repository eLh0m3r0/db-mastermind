# Launch kit

Texts to paste, in English. Written 2026-11-21 for 1.5.0. Before pasting, check every sentence against what the
release really ships (the release notes of 1.5.0 and ROADMAP.md); remove anything that didn't make it.

Character counts are given where a site has a limit; they were counted, not estimated. Keep the voice: what it
does, for whom, what it costs (nothing), what is not there yet. No superlatives, no comparisons with named
competitors, never ask anyone for upvotes (Product Hunt and Hacker News both forbid it).

---

## 1. Product Hunt

Limits from Product Hunt's own guide ([Build your product page](https://help.producthunt.com/en/articles/17834537-4-build-your-product-page),
read 2026-11-21): name 40 characters, tagline 60, description 500, up to 3 launch tags, gallery images 1270×760,
maker comment 5,000 characters, pricing Free / Paid / Free options, an "open source" flag with the repository link.
Posting needs a personal account with posting access (not a company account). A launch can be scheduled up to 30
days ahead; scheduled launches are reviewed.

**Name** (13 / 40)

> DB Mastermind

**Tagline** (50 / 60)

> Free, open-source database client and data modeler

Alternatives: *Open-source database client with ER models and AI* (49) · *Database client, data modeler and MCP server, all free* (54)

**Description** (260 / 260; Product Hunt allows 500, the first 260 show in previews)

> A desktop database client for PostgreSQL, SQL Server, MySQL, Oracle, SQLite and six more. Browse and filter data, write SQL, draw and migrate models, export Prisma or Drizzle code, and let Claude Code or Cursor query it over MCP. MIT, no account, no telemetry.

**Launch tags** (pick 3 from Product Hunt's list when posting): Developer Tools · Open Source · Artificial Intelligence
(alternatives if offered: SQL, Databases)

**Pricing**: Free. **Open source**: yes, https://github.com/eLh0m3r0/db-mastermind

**Links**: https://dbmastermind.app · https://github.com/eLh0m3r0/db-mastermind ·
https://apps.microsoft.com/detail/9p0grd7bz4nf

**Gallery** (1270×760, in this order; the images come from `e2e/launch-shots.mjs` in the next wave, the names here
are the current website screenshots they replace):

1. The table browser with nested filters and the row panel (`table-filters.png`): the everyday client.
2. The SQL editor with autocomplete and results (`query.png`).
3. A model on the canvas with the detail panel (`modeler.png`).
4. A generated migration with its data checks (`migration.png`).
5. The AI assistant answering from the knowledge base (`ai.png`).
6. An agent (Claude Code) using the MCP server on a real database.
7. Video: the short recorded tour, last.

**Maker's first comment** (2,506 / 5,000)

> Hi Product Hunt, I'm Václav.
>
> DB Mastermind started as the database tool for my team at work: we needed one app for browsing data, writing SQL and keeping our data model, on Windows laptops without admin rights, on SQL Server and PostgreSQL. It grew into a general client, and this release is the first one meant for everyone.
>
> What it does:
> • Browse tables of any size with filters you build with AND/OR groups, edit with a change set you review before saving, and see every open transaction.
> • An SQL editor that knows your schema: it writes whole JOINs from foreign keys and warns about an UPDATE without WHERE before you run it.
> • ER diagrams of a live database, and models of a new one: draw tables, keep the model as a DBML text file in Git, and get a migration that checks your data first and comes with a rollback script.
> • Start a model from an SQL script, a Prisma schema, a Mermaid diagram, drawDB or MySQL Workbench; export Prisma, Drizzle, SQLAlchemy or TypeScript code from it.
> • Drop a .env or docker-compose file on the window and its databases become connections. Supabase, Neon, RDS, Azure and Cloud SQL connection strings are recognised.
> • AI with the provider you choose (your own key, your Claude Code or Codex subscription, or a local model), and an MCP server so Claude Code, Codex or Cursor can read your databases. Read-only unless you allow writes.
>
> PostgreSQL, SQL Server, Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery and Trino, on Windows, macOS and Linux.
>
> The honest part:
> • It's free and MIT-licensed, with no paid tier, no account and no telemetry. The only thing it does on its own is check GitHub for updates, and you can turn that off.
> • It is developed by an AI maintainer: Claude (Anthropic's model) writes the code, the tests and the releases, working for me. I decide what the product does, use it every day and answer for it. Every feature lands with tests against real databases in CI, and the whole process is in the repository.
> • The Windows build in the Microsoft Store is signed. The downloads from GitHub are not signed with a certificate Windows trusts, and the macOS app isn't notarized yet, so both operating systems warn the first time; the website says how to get past that.
> • It's young. If something doesn't work with your database, an issue with the error message helps the most.
>
> I'd like to hear from people who use another client every day: what would you miss on the first day if you switched?
>
> https://dbmastermind.app

---

## 2. Show HN

Rules ([news.ycombinator.com/showhn.html](https://news.ycombinator.com/showhn.html), read 2026-11-21): something
people can run, no sign-up in the way, title starts with "Show HN", don't ask anyone to upvote or comment. Post the
GitHub repository as the URL (people can read the code and download from there), the text below as the first
comment. Be there for the first hours to answer.

**Title** (78 / 80)

> Show HN: DB Mastermind – open-source database client, data modeler, MCP server

**URL**: https://github.com/eLh0m3r0/db-mastermind

**First comment**

> I built DB Mastermind for my team at work and this is its first public release. It is a desktop database client (Electron, TypeScript, MIT) for PostgreSQL, SQL Server, Oracle, MySQL/MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery and Trino.
>
> The parts that may be interesting here:
>
> - Read-only is enforced by the database, not by parsing SQL. Queries from the AI assistant or an MCP agent that nobody confirmed run in a read-only transaction that is always rolled back, because classifying statements isn't enough (`SELECT setval(...)`, functions that write, T-SQL batches like `SELECT 1 DELETE ...` without semicolons).
> - Transactions are shown from the driver's real state (PostgreSQL's ReadyForQuery status, MySQL's server status flag, `@@TRANCOUNT`), never guessed from the SQL text, and closing a tab never commits silently.
> - Models are DBML text files. Comparing a model with a live database gives a migration that checks the data first (NULLs, duplicates, orphans) and comes with a rollback script. Models also come from SQL scripts, Prisma, Mermaid, drawDB and MySQL Workbench files, and go out as Prisma, Drizzle, SQLAlchemy or TypeScript.
> - It reads and writes DeZign for Databases projects in place, which is why it exists: my team used DeZign.
> - The MCP server and a CLI (`dbm query`, `dbm diff model.dbml --url ...` with an exit code for CI) are also an npm package that works without the app.
>
> How it is made: the code is written by Claude as the project's maintainer, working for me; I decide what it does and use it daily. Tests run against real databases in Docker in CI, and CLAUDE.md in the repository is the maintainer's notes, including the mistakes it learned from.
>
> Not there yet: the GitHub downloads aren't signed for Windows or notarized for macOS (the Microsoft Store version is signed), and there is no Snowflake, Redshift or MongoDB.
>
> No account, no telemetry; the only request it makes on its own is the update check, which can be turned off.

---

## 3. Reddit

I could not read the current rules of these subreddits (Reddit refuses automated reading). Before posting, read
each sidebar: several communities limit self-promotion (Reddit's own guideline is that most of your activity
should not be about your own project), some only allow it in a weekly thread or on certain days, and some need a
flair. Post from an account that takes part in the community, answer every comment, and don't cross-post the same
day.

### r/PostgreSQL

**Title**: I made a free, open-source desktop client for PostgreSQL; feedback from daily psql/pgAdmin users welcome

> I've been building DB Mastermind, an MIT-licensed desktop database client, and just made its first public release. PostgreSQL is the database it is tested on the most, so I'd like to hear what PostgreSQL people think.
>
> What it does with PostgreSQL:
> - Partitions, sequences, types, triggers and row-level security policies in the explorer; object definitions that re-create what the server has.
> - EXPLAIN and EXPLAIN ANALYZE as a plan tree (ANALYZE of INSERT/UPDATE/DELETE is rolled back), with a comparison to the previous plan.
> - Server activity: sessions, lock waits (who blocks whom), the slowest queries from pg_stat_statements, table and index sizes with unused or duplicate indexes.
> - Transactions you can see: the state comes from the protocol's transaction status, not from parsing your SQL.
> - Backup and restore through pg_dump / pg_restore.
> - Supabase, Neon and other hosted PostgreSQL connection strings are recognised (Supabase's transaction pooler on port 6543 is explained, since it takes no session settings).
> - Models as DBML files with migrations, and export to Prisma, Drizzle or SQLAlchemy.
>
> It also works with SQL Server, MySQL, Oracle and others, has an optional AI assistant (bring your own key or a local model), and runs on Windows, macOS and Linux. No account, no telemetry.
>
> What would make you switch from what you use now, or what's missing?
>
> https://github.com/eLh0m3r0/db-mastermind

### r/SQLServer

**Title**: Azure Data Studio is retired; I've been building a free open-source client that may cover part of it

> Microsoft retired Azure Data Studio on February 28, 2026 and recommends VS Code with the MSSQL extension. Some people prefer a standalone app, so here is one more option: DB Mastermind, a free, MIT-licensed desktop client for Windows, macOS and Linux.
>
> For SQL Server it has:
> - Import of your Azure Data Studio, SSMS and other tools' connections (passwords are asked for, not imported).
> - SQL logins, Windows authentication (on Windows) and Microsoft Entra ID. To be clear: Entra ID hasn't been tested against a real Azure tenant yet, so reports are very welcome.
> - Several result sets per batch with PRINT/RAISERROR messages, execution plans, and a transaction indicator based on @@TRANCOUNT.
> - Server activity with blocking sessions, top queries from query stats, index usage and sizes, BACKUP/RESTORE.
> - Schema and data compare with scripts, ER diagrams, and a portable Windows build that needs no admin rights (or the Microsoft Store version, or an MSI for IT).
>
> What it doesn't have: SQL Server Agent jobs, Profiler / Extended Events, DACPAC/BACPAC, database projects, notebooks in .ipynb format.
>
> What would you need from it before you could use it at work?
>
> https://dbmastermind.app/azure-data-studio.html

### r/dataengineering

**Title**: Open-source desktop SQL client that also queries CSV/Parquet files, exports ORM code and has a CLI for CI

> Sharing a project in case it's useful: DB Mastermind, an MIT-licensed desktop client for PostgreSQL, SQL Server, Oracle, MySQL, SQLite, DuckDB, ClickHouse, BigQuery, Trino and others.
>
> The parts that might matter for data work:
> - Drop a CSV, Parquet, JSON or Excel file on the window and query it with SQL (DuckDB inside; semicolon-separated files with decimal commas work).
> - Copy tables between connections, also across engines; import CSV, Excel, JSON or Parquet into a table.
> - `dbm` on the command line: `dbm query` streams a result to CSV/JSON, `dbm dictionary` writes a data dictionary, `dbm diff model.dbml --url $DATABASE_URL` exits 2 with the migration when a database drifted from its model.
> - Models as DBML files; code export to Prisma, Drizzle, SQLAlchemy or TypeScript types.
> - An MCP server so coding agents can read a database, read-only by default.
>
> No account, no telemetry. I'm interested in what breaks on your setups.
>
> https://github.com/eLh0m3r0/db-mastermind

---

## 4. MCP directories

Submit only after `dbmastermind-mcp` is on npm (the release job publishes it and its MCP registry entry; see the
checklist). What each one wants, as checked on 2026-11-21:

| Directory | How it takes submissions | Checked |
|---|---|---|
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | `server.json` published by the release job (`mcp-publisher`, GitHub OIDC, name `io.github.eLh0m3r0/dbmastermind-mcp`). Verify with `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.eLh0m3r0/dbmastermind-mcp"`. | Docs read: [quickstart](https://modelcontextprotocol.io/registry/quickstart), [GitHub Actions](https://modelcontextprotocol.io/registry/github-actions). The registry is in preview. |
| [GitHub MCP Registry](https://github.com/mcp) | No submission form found. GitHub's launch post says servers self-published to the official registry appear there; a GitHub how-to says to email partnerships@github.com after publishing. | Not settled: the page itself doesn't say how servers are listed. |
| [PulseMCP](https://www.pulsemcp.com/submit) | Paused: "not accepting new MCP server or client submissions right now"; it recommends the official registry and says it will pick servers up from there when it resumes. | Page read. |
| [mcpservers.org](https://mcpservers.org/submit) (the Awesome MCP Servers directory) | Web form: name, category, short description, repository link, the official registry name, remote or not, contact email. Free (review up to two weeks) or $39 (24 hours). Use the free plan. | Page read. |
| [mcp.so](https://mcp.so/submit) | Web form with the GitHub repository URL and a name. The page offers a $39 paid instant listing; how the free route works is not described there. | Page read; free route not confirmed. |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | Pull request adding one line to README.md in the Databases category, alphabetical, linked to the repository with a short description. | CONTRIBUTING.md read. Whether a Glama listing or badge is required was not stated there: read the README's top before opening the PR. |
| [Glama](https://glama.ai/mcp/servers) | An "Add Server" button on the directory (GitHub sign-in, per third-party guides). After listing, a `glama.json` in the repository root (`$schema` + `maintainers`) claims the listing. | Only partly: the button exists; the steps weren't readable without signing in. |
| [Smithery](https://smithery.ai) | Its current docs describe local (stdio) servers as an `.mcpb` bundle published with `smithery mcp publish`; an npm package alone isn't enough. | Not checked on Smithery's own pages (they returned 404 to automated reading); skip unless an MCPB bundle is made. |
| [Cursor Directory](https://cursor.directory/mcp) | Not checked: the site refused automated reading (HTTP 429). | Look by hand. |
| [modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) | Not a target any more: the README lists only reference servers and points everyone else to the MCP Registry. | README read. |

Text for the forms (short description, 95 characters, the same as `server.json`):

> Explore and query PostgreSQL, SQL Server, Oracle, MySQL, SQLite and more. Read-only by default.

Longer description:

> MCP server for PostgreSQL, SQL Server, Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, BigQuery, Trino and CockroachDB. Agents list tables, describe them with keys and incoming references, find join paths, sample rows and run queries, read-only unless you pass --allow-writes (queries run in a read-only transaction that is rolled back). A folder of Markdown notes can be the database's knowledge base. Run with `npx -y dbmastermind-mcp --url <connection-url>`. MIT.

---

## 5. Launch day checklist

The week before:

- [ ] 1.5.0 released; its release notes end with the Website / Privacy line.
- [ ] `dbmastermind-mcp` is on npm (`npm view dbmastermind-mcp version` says 1.5.0) and in the MCP registry (the
      `curl` above lists it). Then switch the repository README's "standalone server" paragraph from building it
      from source to `npx -y dbmastermind-mcp`, and update the CLI help example if needed.
- [ ] Trusted publishing configured on npmjs.com (package → Settings → Trusted publisher: GitHub Actions,
      `eLh0m3r0/db-mastermind`, workflow `release.yml`), the repository variable `NPM_TRUSTED_PUBLISHING=1` set, and
      the `NPM_TOKEN` secret deleted.
- [ ] The Microsoft Store has the current version (Partner Center submission; the website's Windows button goes
      there).
- [ ] Private vulnerability reporting is enabled in the repository's settings (security section), so SECURITY.md's
      link works.
- [ ] Gallery images and the video made with `e2e/launch-shots.mjs`; the video uploaded where Product Hunt can embed
      it.
- [ ] Product Hunt draft complete (name, tagline, description, tags, gallery, links, pricing Free, open source,
      maker comment saved), scheduled for a Tuesday to Thursday, 00:01 Pacific time.
- [ ] Fresh installs checked by hand on Windows (Store and the GitHub installer), macOS (the Open Anyway steps
      from the website) and Linux (AppImage and .deb).
- [ ] Every claim in these texts checked against the release: hosted services (and the Supabase pooler note), the
      new imports and exports, `dbm export`.
- [ ] Issue templates and labels ready for a wave of bug reports; the demo database works from the start screen.

On the day:

- [ ] Product Hunt goes live at 00:01 PT; post the maker comment at once.
- [ ] Show HN in the morning US time (not at the same minute as Product Hunt), then stay to answer for a few hours.
- [ ] One subreddit a day after that, never the same day as Show HN, each following its own rules.
- [ ] MCP directories (section 4), after npm and the registry are confirmed.
- [ ] Watch GitHub issues and the release download counts; fix what blocks installs first.
- [ ] Never ask anyone to upvote, anywhere. Sharing the link with people who'd use it is fine.

After:

- [ ] Answer every comment within a day for the first week.
- [ ] A short "what we learned / what's next" in the next release notes; ROADMAP.md updated with what people asked
      for.
