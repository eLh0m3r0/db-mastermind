# Security

## Reporting a vulnerability

Please report it privately, not in a public issue: open the repository's **Security** tab and click
**Report a vulnerability** ([direct link](https://github.com/eLh0m3r0/db-mastermind/security/advisories/new)).
GitHub keeps the report visible only to you and the maintainers.

Say what is affected (the desktop app, `dbmastermind-mcp` / `dbm`, or the website), the version, the operating
system, and the steps that show the problem. Please don't include real passwords, connection strings or data.

You will get an answer in the advisory. A fix ships in a new release; the advisory is published after that, with
credit to you if you want it.

Only the latest release gets fixes. The installer, the AppImage and the macOS app update themselves; the Microsoft
Store updates its copy.

## What counts

- A saved password, API key or token that leaves the computer, or is stored readable where the app says it is
  encrypted.
- A write through a path that should be read-only: a read-only connection, an AI assistant or agent query that
  nobody confirmed, `dbmastermind-mcp` without `--allow-writes`, a connection where AI is limited to reading.
- AI or MCP access to a connection where it is turned off, including through a managed configuration or a team
  folder.
- The local MCP HTTP endpoint answering without its token or to another computer.
- SSH host keys or TLS certificates accepted when they should be refused.
- Code run by opening a file (a model, a DeZign project, an `.sql`, `.env`, CSV or Excel file) or a crafted
  database response, beyond what the user asked to run.
- An update installed without its checksum being verified.

Not in scope: problems that need an already compromised computer or user account, writes made with
`--allow-writes` or after the user confirmed them, vulnerabilities in the database servers themselves, and the
known state that downloads from GitHub are not signed with a certificate Windows trusts or notarized by Apple.

## What the app does with secrets

1. Passwords and API keys are encrypted before they are saved: on macOS with AES-256-GCM and a key kept in the login keychain, on Windows with DPAPI, on Linux with the secret service (GNOME Keyring, KWallet).
2. On Linux without a secret service the app can't encrypt them, and the connection form says so before you save one.
3. A secret is sent only to the database, SSH server or AI provider it belongs to; exports, shared connections and team folders never include it.
4. `dbmastermind-mcp` keeps no secrets of its own: it reads `${VARIABLE}` placeholders from the environment when it starts.
5. There is no telemetry and no account; the only network access the app makes on its own is the update check with GitHub, which can be turned off ([privacy policy](https://dbmastermind.app/privacy.html)).

## What the read-only guard promises

SQL nobody confirmed (the AI assistant, MCP agents) and everything on a connection marked read-only runs through
the same guard. What it promises: **no data is changed or deleted, and no transaction escapes.** It does not rely
on the app reading the SQL right: the app reads every character as the database does or refuses the text, allows
only what reads, refuses functions that act outside the data (below), and then lets the database itself decide.

| Database | What the database itself enforces |
|---|---|
| PostgreSQL | one statement per message (extended protocol), a read-only transaction that is always rolled back, its state checked after every statement, strings read the standard way whatever the database is set to, a time limit where the session has none; the session is reset afterwards |
| MySQL, MariaDB | one statement per query, a read-only transaction that is always rolled back, a time limit; the connection is closed afterwards |
| SQL Server | the server plans each batch first and it may contain only reads; a transaction that is always rolled back and checked, a lock timeout and a time limit. A login without SHOWPLAN permission is checked by the app's own reading only, and a batch that first creates a `#temp` table and then uses it (your own SQL on a read-only connection) can't be planned up front: in both cases what remains is the rollback and the login's own rights |
| Oracle | one statement per call, a read-only transaction |
| SQLite | one statement per call, `query_only` |
| DuckDB | one read statement by its own parser, a read-only copy with no access to URLs, extensions or other files, except the files you opened in the app (*Query a file*, a drop) or named with `--allow-files` |
| ClickHouse | one query per request, `readonly = 2` on every query: writes and changing `readonly` are refused (tested against ClickHouse 24.8) |
| BigQuery | a dry run must report a query; not tested against the service |
| Trino | one statement per request; nothing more: only the app's own checks; not tested against a server |

What it doesn't stop: things a function can do that a read-only transaction allows. The app refuses the ones it
knows by name, however the name is spelled (quoted, escaped, qualified, in any case the database accepts; names
written with Unicode escapes are refused outright): reading or writing server files, locks that outlive the
statement, ending other sessions, the network, `pg_sleep`, functions that run SQL given to them as text
(`query_to_xml`, `dblink`, DuckDB's `query`), and MySQL `OUTFILE` / `DUMPFILE` / `LOAD_FILE` anywhere in the text.
But a name list only closes the doors it knows: a user-defined function that does such a thing under another
name, an Oracle function with an autonomous transaction, or an extension's function can still do it. Reading is
still reading: SQL nobody confirmed sees what the login sees.

Every tool the AI has (listing tables, describing them, sampling rows, explaining a query, running one) reaches
the database through one narrow view that offers only these guarded operations; plans are made without running
the query.

**So give a login used with AI or agents only the rights it needs:** no superuser or DBA role, no `FILE` privilege
(MySQL, MariaDB), no `pg_read_server_files` / `pg_write_server_files` / `pg_execute_server_program` (PostgreSQL),
no `sysadmin` or `xp_cmdshell` (SQL Server), and read access to the tables it should answer about. A read-only
replica, where you have one, is better still.

## What AI permissions promise

Each connection says what AI may do: nothing, *Schema only*, read, or write with your confirmation, and whether
agents over MCP may use it at all. The permissions are read again for every tool call, every approval and every
write, in the app's assistant, over the MCP endpoint and in `--mcp` mode, so a change applies to work already
running. AI turned off by an organization's managed configuration or a team folder applies to the server, not to
one saved connection: copies and other databases on it are off too.

*Schema only* means no value that comes from a row reaches the AI. Names, types, comments, the catalog's row
estimates and query plans made without running the query are schema. Errors that can quote a value (conversions,
constraint violations) are reduced to their kind and position. The knowledge base is your own notes and is shared
as it is, so don't write there what the AI shouldn't read.

## What the app's window is trusted with

The app has two parts: the main process, which holds connections, secrets and files, and the window, which is a
sandboxed, context-isolated page whose content security policy runs scripts only from the app itself. Today the window is
trusted like the user: it receives a connection's saved password to show in the connection form, the settings
with their keys, and some older file functions accept a path from it without the user having picked that file
(newer ones don't). So a flaw that let foreign code run inside the window would reach those. No such flaw is
known; values from databases and files are shown as text, never as markup. Narrowing this (the window gets no
secrets, and every file method takes only files you handed over) is planned as the next milestone in
[ROADMAP.md](ROADMAP.md).
