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
| Generative AI | **Yes, declare it** (certification of 1.0.0 failed without it): the optional AI assistant writes SQL, explanations and notes with the AI provider the user sets up (their own API key, Claude Code / Codex subscription or a local model). Off until configured; can be turned off per connection or by IT. |
| System requirements | Minimum: 4 GB memory, 64-bit (x64) Windows 10 or 11 |

**Restricted capability `runFullTrust` (justification):**

> DB Mastermind is a desktop database client built with Electron. It needs full trust to connect to databases over the network (PostgreSQL, SQL Server, Oracle, MySQL and others, including through SSH tunnels and Windows authentication), to read and write files the user picks (CSV/Excel import and export, SQL scripts, Markdown notes), and to run the database tools the user asks for (pg_dump for backups). It does not install services or drivers and does not change system settings.

## Age rating (IARC questionnaire)

Category: *Productivity / utility (not a game)*. Answer **No** to violence, sexual content, gambling, drugs, purchases, location sharing and user-to-user communication. For generative AI, answer **Yes**: the app has an optional AI assistant that writes SQL and answers questions about the user's own database, using the AI provider the user configures; there is no chat between users and nothing is shared publicly. Expected result: 3+ / Everyone.

## Store listing — English (en-us)

**Product name:** DB Mastermind

**Short description:**

> Free, open-source database client and data modeler for PostgreSQL, SQL Server, Oracle, MySQL, SQLite and more. Design a database, browse and query it, turn results into charts, and let an AI assistant or your coding agent read it safely.

**Description:**

> DB Mastermind is a free, open-source database client with no paid tier and no feature limits.
>
> EVERYDAY WORK, DONE WELL
> • Data browser for millions of rows with advanced filters: nested AND/OR groups, 25+ operators, raw SQL conditions.
> • Inline editing with a reviewed change set, paste from Excel, copy as CSV, JSON, Markdown or SQL.
> • SQL editor with schema-aware autocomplete that writes whole JOINs from foreign keys and knows every function of the database (extensions too), snippets, history, saved queries and execution plans, also for INSERT, UPDATE and DELETE.
> • Export everything to CSV, Excel, JSON or SQL, and query CSV, Parquet, JSON and Excel files with SQL.
> • Transactions you can see: commit changes yourself, per connection; every open transaction and every lock is shown.
> • Open a view, function or table as SQL and change it; open and save .sql files; warnings while you type (unknown table, UPDATE or DELETE without WHERE).
> • Totals of selected cells, find a value anywhere in a database, value profile of a column.
> • Messages from the server next to the results (PostgreSQL NOTICE and RAISE, SQL Server PRINT, MySQL warnings, Oracle DBMS_OUTPUT); tables without a primary key are edited through a unique index.
> • PostgreSQL in depth: partitions, sequences, types, triggers and row-level security in the explorer, and definitions that re-create what the server has.
>
> MODEL, UNDERSTAND AND REDESIGN
> • Model a new database without one: draw tables and relationships, rename and retype right on the diagram; models are DBML text files you can keep in Git, with SQL for any supported database.
> • Opens and saves DeZign for Databases projects (.dez, .dezproj) with their diagrams, domains, subtypes, triggers and versions, without DeZign installed.
> • Interactive ER diagrams with automatic layout, saved diagrams and the join path between any two tables.
> • Design tables, columns, keys and indexes right on the diagram; DB Mastermind writes the migration, checks your data first and gives you the rollback.
> • Compare schemas and data between databases.
>
> SERVERS AND TEAMS
> • Server activity: running sessions, the slowest queries and storage, including unused and duplicate indexes.
> • Copy tables to another database (even another engine), run one script on several connections, import JSON and Parquet.
> • Passwords from your password manager (1Password, Bitwarden, Vault), SSH through a jump host, SQL Server with Microsoft Entra ID.
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
>
> DeZign for Databases is a trademark of Datanamic. DB Mastermind is not affiliated with or endorsed by Datanamic.

**Product features** (one per field):

1. Data browser with nested AND/OR filters and no row limits
2. SQL editor with JOIN autocomplete from foreign keys
3. Inline editing with a reviewed change set
4. Interactive ER diagrams with saved views and join paths
5. Schema designer that writes and checks the migration
6. Schema and data compare between databases
7. AI assistant with your own Claude Code / Codex subscription, your own API key or with local models
8. Markdown knowledge base about your data model
9. MCP server for Claude Code, Codex, Cursor and VS Code
10. Query CSV, Parquet, JSON and Excel files with SQL
11. SSH tunnels, SSL and SQL Server Windows authentication
12. No telemetry, no account, no feature limits. Free and open source
13. Data modeler that opens and saves DeZign for Databases projects
14. Transactions you can see, with manual commit per connection
15. Server activity: sessions, slowest queries, storage and unused indexes
16. Copy tables between databases and run a script on several connections
17. Passwords from 1Password, Bitwarden or Vault; SSH jump hosts
18. PostgreSQL in depth: every function in completions, partitions, triggers, row-level security, server messages

**Search terms** (7): `database client` · `SQL editor` · `PostgreSQL` · `SQL Server` · `data modeling` · `ER diagram` · `database AI`

**What's new in this version** (1.5.4, since 1.4.0; if the Store still has an older version, put that version's text from the release notes after this one): More ways in: drop a .env, a docker-compose file or a project folder on the window and its databases become connections; connection strings from Supabase, Neon, Amazon RDS, Azure and Google Cloud SQL are recognised; open Mermaid, drawDB, MySQL Workbench and Prisma files as models; export a model or a live database as a Prisma schema, Drizzle schema, SQLAlchemy models or TypeScript types. Easier at first sight: the + for a new tab is always in view, tabs can scroll or shrink (Settings → Appearance), a tab's menu closes the tabs to its left or right; the demo opens on a table with data; toolbars keep their labels; connection and AI errors say what to do; AI is ready as soon as a provider has its key; unsaved changes in a table show on its tab and are never dropped without a question. Safer: the guard for SQL from the AI assistant and from agents, and for read-only connections, now relies on what the database itself confirms; files from other people are read with limits and never run. Also: MySQL models from scripts, MySQL Workbench and live databases compare as the same; DBML from other tools reads as in dbdiagram.io; SQL Server connection URLs with a user and password. AI on a model (Design with AI, Review the model) works without a database. Dashboards are listed in the Saved tab; dashboards and saved queries stay on your computer until you share them with the team. Charts follow your accent color or look.

**Copyright and trademark info:** © 2026 Václav Mudra. MIT license. DeZign for Databases is a trademark of Datanamic; DB Mastermind is not affiliated with or endorsed by Datanamic.

**Additional license terms:** Open source under the MIT license: https://github.com/eLh0m3r0/db-mastermind/blob/main/LICENSE

**Developed by:** Václav Mudra

**Screenshots** (from `docs/screenshots/`, 2880×1800; in this order, with captions):

1. `hero-1440.png` (or a fresh full-size capture of the same split view) — Design, query and chart in one app
1. `table-filters.png` — Browse and filter data without limits
2. `query.png` — SQL editor with schema-aware autocomplete
3. `diagram.png` — Interactive ER diagrams
4. `modeler.png` — Model a new database right on the diagram
5. `designer.png` — Design changes right on the diagram
6. `migration.png` — Reviewed migration with a rollback script
7. `ai.png` — AI assistant that knows your database
8. `query-file.png` — Query CSV and Excel files with SQL
9. `chart.png` — Chart any result in one click

## Store listing — Czech (cs-cz)

**Product name:** DB Mastermind

**Short description:**

> Bezplatný open-source databázový klient a datový modelář pro PostgreSQL, SQL Server, Oracle, MySQL, SQLite a další. Navrhněte databázi, prohlížejte a dotazujte ji, z výsledků udělejte grafy a nechte AI asistenta nebo svého agenta, ať ji bezpečně čte.

**Description:**

> DB Mastermind je bezplatný open-source databázový klient bez placené verze a bez omezení funkcí.
>
> KAŽDODENNÍ PRÁCE
> • Prohlížení milionů řádků s pokročilými filtry: vnořené skupiny AND/OR, přes 25 operátorů, vlastní SQL podmínka.
> • Úpravy přímo v tabulce s kontrolou změn před uložením, vkládání z Excelu, kopírování jako CSV, JSON, Markdown nebo SQL.
> • SQL editor s našeptávačem, který z cizích klíčů napíše celý JOIN a zná všechny funkce databáze (i z rozšíření), šablony, historie, uložené dotazy a prováděcí plány, také pro INSERT, UPDATE a DELETE.
> • Export do CSV, Excelu, JSON nebo SQL a dotazy SQL přímo nad soubory CSV, Parquet, JSON a Excel.
> • Transakce pod kontrolou: změny potvrzujete sami, pro každé připojení zvlášť; každá otevřená transakce i zámek jsou vidět.
> • Pohled, funkci nebo tabulku otevřete jako SQL a upravíte; soubory .sql otevřete i uložíte; upozornění už při psaní (neznámá tabulka, UPDATE nebo DELETE bez WHERE).
> • Součty vybraných buněk, hledání hodnoty v celé databázi, profil hodnot sloupce.
> • Zprávy serveru hned u výsledků (PostgreSQL NOTICE a RAISE, SQL Server PRINT, varování MySQL, Oracle DBMS_OUTPUT); tabulky bez primárního klíče upravíte přes unikátní index.
> • PostgreSQL do hloubky: partitions, sekvence, typy, triggery a zabezpečení na úrovni řádků v průzkumníku a definice, které znovu vytvoří to, co server má.
>
> DATOVÝ MODEL
> • Interaktivní ER diagramy s automatickým rozložením, uloženými pohledy a cestou JOIN mezi libovolnými tabulkami.
> • Návrh tabulek, sloupců, klíčů a indexů přímo v diagramu; DB Mastermind napíše migraci, předem zkontroluje data a připraví i vrácení změn.
> • Porovnání schémat i dat mezi databázemi.
> • Model nové databáze bez databáze: tabulky a vztahy kreslíte, přejmenujete a měníte typy přímo v diagramu; modely jsou textové soubory DBML vhodné pro Git, s SQL pro kteroukoli podporovanou databázi.
> • Otevírá a ukládá projekty DeZign for Databases (.dez, .dezproj) včetně diagramů, domén, podtypů, triggerů a verzí, i bez nainstalovaného DeZignu.
>
> SERVERY A TÝMY
> • Aktivita serveru: běžící relace, nejnáročnější dotazy a úložiště včetně nepoužívaných a duplicitních indexů.
> • Kopírování tabulek do jiné databáze (i jiného typu), jeden skript na více připojeních, import JSON a Parquet.
> • Hesla ze správce hesel (1Password, Bitwarden, Vault), SSH přes jump host, SQL Server s Microsoft Entra ID.
>
> AI, KTERÁ ZNÁ VAŠI DATABÁZI
> • Vlastní API klíč (Anthropic, OpenAI, OpenRouter, Gemini, Azure), lokální model v Ollamě nebo předplatné Claude Code / Codex.
> • Asistent prozkoumá schéma a spouští jen čtecí dotazy; před každou změnou se zeptá.
> • Znalostní báze v Markdownu ho naučí, co znamenají vaše tabulky a kódy.
> • Vestavěný MCP server pro Claude Code, Codex, Cursor, VS Code a další agenty.
>
> SOUKROMÍ
> • Žádná telemetrie, žádný účet. Hesla šifruje Windows.
> • AI je vypnutá, dokud ji nenastavíte, a lze ji vypnout pro jednotlivá připojení nebo centrálně z IT.
>
> DATABÁZE: PostgreSQL, SQL Server (včetně přihlášení přes Windows), Oracle, MySQL, MariaDB, SQLite, DuckDB, ClickHouse, CockroachDB, BigQuery, Trino.
>
> Česky i anglicky. Světlý, tmavý a vysoce kontrastní motiv.
>
> Open source pod licencí MIT: https://github.com/eLh0m3r0/db-mastermind
>
> DeZign for Databases je ochranná známka společnosti Datanamic. DB Mastermind není s Datanamic nijak spojen ani jím schválen.

**Product features:**

1. Prohlížení dat s vnořenými filtry AND/OR, bez limitu řádků
2. SQL editor, který z cizích klíčů napíše JOIN
3. Úpravy v tabulce s kontrolou změn před uložením
4. Interaktivní ER diagramy s uloženými pohledy a cestami JOIN
5. Návrhář schématu, který napíše a zkontroluje migraci
6. Porovnání schémat a dat mezi databázemi
7. AI asistent s vlastním předplatným Claude Code / Codex, vlastním API klíčem nebo s využitím lokálních modelů
8. Znalostní báze o datovém modelu v Markdownu, sdílitelná s týmem i mezi jednotlivými připojeními
9. MCP server pro Claude Code, Codex, Cursor a VS Code
10. SQL dotazy nad soubory CSV, Parquet, JSON a Excel
11. SSH tunely, SSL a přihlášení do SQL Serveru přes Windows
12. Žádná telemetrie, žádný účet, žádná omezení funkcí. Zdarma a open source navždy
13. Nástroj pro datové modelování, který otevírá a ukládá i projekty DeZign for Databases
14. Transakce pod kontrolou, ruční potvrzování pro každé připojení
15. Aktivita serveru: relace, nejnáročnější dotazy, úložiště a nepoužívané indexy
16. Kopírování tabulek mezi databázemi a skript na více připojeních
17. Hesla z 1Password, Bitwardenu nebo Vaultu; SSH přes jump host
18. PostgreSQL do hloubky: všechny funkce v našeptávači, partitions, triggery, zabezpečení řádků, zprávy serveru

**Search terms:** `databázový klient` · `SQL editor` · `PostgreSQL` · `SQL Server` · `datové modelování` · `ER diagram` · `databáze AI`

**What's new in this version:** Víc cest dovnitř: přetáhněte do okna soubor .env, docker-compose nebo složku projektu a jejich databáze se stanou připojeními; připojovací řetězce ze Supabase, Neonu, Amazon RDS, Azure a Google Cloud SQL aplikace pozná; soubory Mermaid, drawDB, MySQL Workbench a Prisma se otevřou jako model; model nebo živou databázi vyexportujete jako schéma Prisma, schéma Drizzle, modely SQLAlchemy nebo typy TypeScriptu. Srozumitelnější na první pohled: tlačítko + pro novou záložku je vždy vidět, záložky se mohou posouvat nebo zužovat (Nastavení → Vzhled), nabídka záložky zavře záložky vlevo nebo vpravo; ukázková databáze se otevře na tabulce s daty; lišty si nechávají popisky; chyby připojení a AI říkají, co dělat; AI je připravené, jakmile má poskytovatel klíč; neuložené změny v tabulce jsou vidět na záložce a nikdy se nezahodí bez dotazu. Bezpečnější: ochrana pro SQL od AI asistenta a agentů a pro připojení jen pro čtení se teď opírá o to, co potvrdí sama databáze; soubory od cizích lidí se čtou s limity a nikdy se nespouštějí. Dále: modely MySQL ze skriptů, z MySQL Workbench a z živé databáze se porovnají jako stejné; DBML z jiných nástrojů se čte jako v dbdiagram.io; připojovací URL pro SQL Server s uživatelem a heslem. AI nad modelem (Navrhnout s AI, Zhodnotit model) funguje i bez databáze. Dashboardy jsou v záložce Uložené; dashboardy i uložené dotazy zůstávají ve vašem počítači, dokud je nenasdílíte týmu. Grafy se řídí zvolenou barvou nebo vzhledem.

**Screenshots:** the same files; captions:

1. Prohlížení a filtrování dat bez omezení
2. SQL editor s našeptávačem podle schématu
3. Interaktivní ER diagramy
4. Model nové databáze přímo v diagramu
5. Návrh změn přímo v diagramu
6. Migrace ke kontrole i se skriptem pro vrácení
7. AI asistent, který zná vaši databázi
8. SQL dotazy nad soubory CSV a Excel
9. Graf z výsledku jedním kliknutím
