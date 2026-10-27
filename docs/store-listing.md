# Microsoft Store listing

Texts and answers for Partner Center, ready to paste. The steps are in [microsoft-store.md](microsoft-store.md).

## Properties

| Field | Value |
|---|---|
| Category | Developer tools (subcategory *Database* if offered) |
| Privacy policy URL | https://dbmastermind.app/privacy.html |
| Website | https://dbmastermind.app |
| Support contact info | https://github.com/eLh0m3r0/db-mastermind/issues |
| Does this product access, collect or transmit personal information? | Yes: it connects to the user's own databases and, only when the user sets one up, sends questions to the AI provider they chose. The privacy policy above explains it. |
| Product declarations | Leave the defaults; don't tick "This app has been tested to meet accessibility guidelines". |
| System requirements | Minimum: 4 GB memory, 64-bit (x64) Windows 10 or 11 |

**Restricted capability `runFullTrust` (justification):**

> DB Mastermind is a desktop database client built with Electron. It needs full trust to connect to databases over the network (PostgreSQL, SQL Server, Oracle, MySQL and others, including through SSH tunnels and Windows authentication), to read and write files the user picks (CSV/Excel import and export, SQL scripts, Markdown notes), and to run the database tools the user asks for (pg_dump for backups). It does not install services or drivers and does not change system settings.

## Age rating (IARC questionnaire)

Category: *Productivity / utility (not a game)*. Answer **No** to violence, sexual content, gambling, drugs, purchases, location sharing and user-to-user communication. If asked about generated content: the app has an optional AI assistant that writes SQL and answers questions about the user's own database, using the AI provider the user configures; there is no chat between users and nothing is shared publicly. Expected result: 3+ / Everyone.

## Store listing — English (en-us)

**Product name:** DB Mastermind

**Short description:**

> Free, open-source database client for PostgreSQL, SQL Server, Oracle, MySQL, SQLite and more. Browse and filter data without limits, write SQL, draw ER diagrams, design schema changes with generated migrations, and ask an AI that knows your database.

**Description:**

> DB Mastermind is a free, open-source database client with no paid tier and no feature limits.
>
> EVERYDAY WORK, DONE WELL
> • Data browser for millions of rows with advanced filters: nested AND/OR groups, 25+ operators, raw SQL conditions.
> • Inline editing with a reviewed change set, paste from Excel, copy as CSV, JSON, Markdown or SQL.
> • SQL editor with schema-aware autocomplete that writes whole JOINs from foreign keys, snippets, history, saved queries and execution plans.
> • Export everything to CSV, Excel, JSON or SQL, and query CSV, Parquet, JSON and Excel files with SQL.
>
> UNDERSTAND AND REDESIGN THE MODEL
> • Interactive ER diagrams with automatic layout, saved diagrams and the join path between any two tables.
> • Design tables, columns, keys and indexes right on the diagram; DB Mastermind writes the migration, checks your data first and gives you the rollback.
> • Compare schemas and data between databases.
>
> AI THAT KNOWS YOUR DATABASE
> • Use your own API key (Anthropic, OpenAI, OpenRouter, Gemini, Azure), a local Ollama model, or your Claude Code / Codex subscription.
> • The assistant explores the schema and runs read-only queries; it asks before any change.
> • A Markdown knowledge base teaches it what your tables and codes mean.
> • Built-in MCP server for Claude Code, Codex, Cursor, VS Code and other agents.
>
> PRIVATE BY DESIGN
> • No telemetry, no account. Passwords are encrypted with Windows. AI is off until you set it up, and can be turned off per connection or by your IT department.
>
> DATABASES: PostgreSQL, SQL Server (including Windows authentication), Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery, Trino.
>
> English and Czech. Light, dark and high-contrast themes.
>
> Open source under the MIT license: https://github.com/eLh0m3r0/db-mastermind

**Product features** (one per field):

1. Data browser with nested AND/OR filters and no row limits
2. SQL editor with JOIN autocomplete from foreign keys
3. Inline editing with a reviewed change set
4. Interactive ER diagrams with saved views and join paths
5. Schema designer that writes and checks the migration
6. Schema and data compare between databases
7. AI assistant with your own key, Ollama, or Claude Code / Codex
8. Markdown knowledge base about your data model
9. MCP server for Claude Code, Codex, Cursor and VS Code
10. Query CSV, Parquet, JSON and Excel files with SQL
11. SSH tunnels, SSL and SQL Server Windows authentication
12. No telemetry, no account, no feature limits

**Search terms** (7): `database client` · `SQL editor` · `PostgreSQL` · `SQL Server` · `MySQL` · `ER diagram` · `database AI`

**What's new in this version:** First release in the Microsoft Store.

**Copyright and trademark info:** © 2026 Václav Mudra. MIT license.

**Additional license terms:** Open source under the MIT license: https://github.com/eLh0m3r0/db-mastermind/blob/main/LICENSE

**Developed by:** Václav Mudra

**Screenshots** (from `docs/screenshots/`, 1440×900; in this order, with captions):

1. `table-filters.png` — Browse and filter data without limits
2. `query.png` — SQL editor with schema-aware autocomplete
3. `diagram.png` — Interactive ER diagrams
4. `designer.png` — Design changes right on the diagram
5. `migration.png` — Reviewed migration with a rollback script
6. `ai.png` — AI assistant that knows your database
7. `query-file.png` — Query CSV and Excel files with SQL
8. `chart.png` — Chart any result in one click

## Store listing — Czech (cs-cz)

**Product name:** DB Mastermind

**Short description:**

> Bezplatný open-source databázový klient pro PostgreSQL, SQL Server, Oracle, MySQL, SQLite a další. Prohlížení a filtrování dat bez omezení, SQL editor, ER diagramy, návrh změn schématu s vygenerovanou migrací a AI, která zná vaši databázi.

**Description:**

> DB Mastermind je bezplatný open-source databázový klient bez placené verze a bez omezení funkcí.
>
> KAŽDODENNÍ PRÁCE
> • Prohlížení milionů řádků s pokročilými filtry: vnořené skupiny AND/OR, přes 25 operátorů, vlastní SQL podmínka.
> • Úpravy přímo v tabulce s kontrolou změn před uložením, vkládání z Excelu, kopírování jako CSV, JSON, Markdown nebo SQL.
> • SQL editor s našeptávačem, který z cizích klíčů napíše celý JOIN, šablony, historie, uložené dotazy a prováděcí plány.
> • Export do CSV, Excelu, JSON nebo SQL a dotazy SQL přímo nad soubory CSV, Parquet, JSON a Excel.
>
> DATOVÝ MODEL
> • Interaktivní ER diagramy s automatickým rozložením, uloženými pohledy a cestou JOIN mezi libovolnými tabulkami.
> • Návrh tabulek, sloupců, klíčů a indexů přímo v diagramu; DB Mastermind napíše migraci, předem zkontroluje data a připraví i vrácení změn.
> • Porovnání schémat i dat mezi databázemi.
>
> AI, KTERÁ ZNÁ VAŠI DATABÁZI
> • Vlastní API klíč (Anthropic, OpenAI, OpenRouter, Gemini, Azure), lokální model v Ollamě nebo předplatné Claude Code / Codex.
> • Asistent prozkoumá schéma a spouští jen čtecí dotazy; před každou změnou se zeptá.
> • Znalostní báze v Markdownu ho naučí, co znamenají vaše tabulky a kódy.
> • Vestavěný MCP server pro Claude Code, Codex, Cursor, VS Code a další agenty.
>
> SOUKROMÍ
> • Žádná telemetrie, žádný účet. Hesla šifruje Windows. AI je vypnutá, dokud ji nenastavíte, a lze ji vypnout pro jednotlivá připojení nebo centrálně z IT.
>
> DATABÁZE: PostgreSQL, SQL Server (včetně přihlášení přes Windows), Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery, Trino.
>
> Česky i anglicky. Světlý, tmavý a vysoce kontrastní motiv.
>
> Open source pod licencí MIT: https://github.com/eLh0m3r0/db-mastermind

**Product features:**

1. Prohlížení dat s vnořenými filtry AND/OR, bez limitu řádků
2. SQL editor, který z cizích klíčů napíše JOIN
3. Úpravy v tabulce s kontrolou změn před uložením
4. Interaktivní ER diagramy s uloženými pohledy a cestami JOIN
5. Návrhář schématu, který napíše a zkontroluje migraci
6. Porovnání schémat a dat mezi databázemi
7. AI asistent s vlastním klíčem, Ollamou nebo Claude Code / Codex
8. Znalostní báze o datovém modelu v Markdownu
9. MCP server pro Claude Code, Codex, Cursor a VS Code
10. SQL dotazy nad soubory CSV, Parquet, JSON a Excel
11. SSH tunely, SSL a přihlášení do SQL Serveru přes Windows
12. Žádná telemetrie, žádný účet, žádná omezení funkcí

**Search terms:** `databázový klient` · `SQL editor` · `PostgreSQL` · `SQL Server` · `MySQL` · `ER diagram` · `databáze AI`

**What's new in this version:** První vydání v Microsoft Store.

**Screenshots:** the same files; captions:

1. Prohlížení a filtrování dat bez omezení
2. SQL editor s našeptávačem podle schématu
3. Interaktivní ER diagramy
4. Návrh změn přímo v diagramu
5. Migrace ke kontrole i se skriptem pro vrácení
6. AI asistent, který zná vaši databázi
7. SQL dotazy nad soubory CSV a Excel
8. Graf z výsledku jedním kliknutím
