# Microsoft Store listing

Texts and answers for Partner Center, ready to paste. The steps are in [microsoft-store.md](microsoft-store.md).
`scripts/store-submit.mjs` reads the two "Store listing" sections below (quote blocks, numbered lists, the search
terms in backticks, What's new on its label's line, the screenshot list): keep their labels and shapes.

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
> CHARTS AND DASHBOARDS
> • Turn any result into a bar, line or scatter chart in one click; the colors follow your theme.
> • Pin charts and single numbers to a dashboard that refreshes itself. Yours stay on your computer until you share one with your team.
>
> MODEL, UNDERSTAND AND REDESIGN
> • Model a new database without one: draw tables and relationships, rename and retype right on the diagram; models are DBML text files you can keep in Git, with SQL for any supported database.
> • Opens the models you already have: DeZign for Databases projects (.dez, .dezproj, saved back with their diagrams, domains, subtypes, triggers and versions), MySQL Workbench, drawDB, Mermaid, Prisma and DBML.
> • Code for your application from a model or a live database: Prisma or Drizzle schema, SQLAlchemy models, TypeScript types.
> • Interactive ER diagrams with automatic layout, saved diagrams and the join path between any two tables.
> • Design tables, columns, keys and indexes right on the diagram; DB Mastermind writes the migration, checks your data first and gives you the rollback.
> • Compare schemas and data between databases.
>
> CONNECTIONS, SERVERS AND TEAMS
> • Drop a project's .env or docker-compose file on the window and its databases become connections; Supabase, Neon, Amazon RDS, Azure and Google Cloud SQL are recognised.
> • Share notes, dashboards and saved queries with your team through a folder in Git, OneDrive or on a network drive.
> • Server activity: running sessions, the slowest queries and storage, including unused and duplicate indexes.
> • Copy tables to another database (even another engine), run one script on several connections, import JSON and Parquet.
> • Passwords from your password manager (1Password, Bitwarden, Vault), SSH through a jump host, SQL Server with Microsoft Entra ID.
>
> AI THAT KNOWS YOUR DATABASE
> • Use your own API key (Anthropic, OpenAI, OpenRouter, Gemini, Azure), a local Ollama model, or your Claude Code / Codex subscription.
> • You decide per connection what AI may do: nothing, see the schema only, read data, or change it after you confirm. Read-only is enforced by the database itself.
> • The assistant explores the schema and runs read-only queries; it asks before any change.
> • A Markdown knowledge base, shared with your team, teaches it what your tables and codes mean.
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
8. Markdown knowledge base about your data model, shared with your team through Git or OneDrive
9. MCP server for Claude Code, Codex, Cursor and VS Code
10. Query CSV, Parquet, JSON and Excel files with SQL
11. SSH tunnels, SSL and SQL Server Windows authentication
12. No telemetry, no account, no feature limits. Free and open source
13. Opens DeZign for Databases (and saves back), MySQL Workbench, drawDB, Mermaid and Prisma models; exports Prisma, Drizzle, SQLAlchemy and TypeScript
14. Transactions you can see, with manual commit per connection
15. Server activity: sessions, slowest queries, storage and unused indexes
16. Copy tables between databases, run a script on several connections; passwords from 1Password, Bitwarden or Vault; SSH jump hosts
17. Customizable appearance and skins, dark mode, and compact mode
18. PostgreSQL in depth: every function in completions, partitions, triggers, row-level security, server messages
19. Charts from any result, and dashboards you keep for yourself or share with your team
20. AI permissions per connection: off, schema only, read, or changes after your confirmation

**Search terms** (7): `SQL editor` · `PostgreSQL` · `SQL Server` · `ER diagram` · `database AI` · `db client` · `data modeling`

**What's new in this version** (1.5.4, since 1.4.0, the last version in the Store; at most 1500 characters): New since 1.4: drop a project's .env, docker-compose file or folder on the window and its databases become connections; Supabase, Neon, Amazon RDS, Azure and Google Cloud SQL are recognised. Open models from MySQL Workbench, drawDB, Mermaid and Prisma, and export a model or a live database as Prisma, Drizzle, SQLAlchemy or TypeScript. Dashboards are in the Saved tab; dashboards and saved queries stay on your computer until you share them with your team, and the knowledge base shows notes, dashboards, queries and AI tools apart. Charts follow your accent color or look. AI on a model works without a database. Easier at first sight: the + for a new tab is always in view, tabs can scroll or shrink, a tab's menu closes the tabs to its left or right, errors say what to do, and unsaved changes in a table are never dropped without a question. Safer: SQL from the AI assistant, from agents and on read-only connections runs behind a guard the database itself enforces, AI permissions are checked at every step, and files from other people are read with limits and never run.

**Copyright and trademark info:** © 2026 Václav Mudra

**Additional license terms:** Open source under the MIT license. DeZign for Databases is a trademark of Datanamic; DB Mastermind is not affiliated with or endorsed by Datanamic.

**Developed by:** Václav Mudra

**Screenshots** (from `docs/screenshots/`, 2880×1800; in this order, with captions):

1. `hero-1440.png` — Design, query and chart in one app
2. `table-filters.png` — Browse and filter data without limits
3. `query.png` — SQL editor with schema-aware autocomplete
4. `diagram.png` — Interactive ER diagrams
5. `modeler.png` — Model a new database right on the diagram
6. `designer.png` — Design changes right on the diagram
7. `migration.png` — Reviewed migration with a rollback script
8. `ai.png` — AI assistant that knows your database
9. `query-file.png` — Query CSV and Excel files with SQL
10. `dashboard-1440.png` — Charts and dashboards you can share with your team

**Trailer** (optional, in the Store listing's trailers): `dbm-launch-87s.mp4` with `dbm-launch-poster.png` as its thumbnail, both 1920×1080, from the launch video folder. Title: *DB Mastermind in 90 seconds*.

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
> GRAFY A DASHBOARDY
> • Z jakéhokoli výsledku sloupcový, čárový nebo bodový graf jedním kliknutím; barvy se řídí vaším vzhledem.
> • Grafy a jednotlivá čísla připnete na dashboard, který se sám obnovuje. Vaše dashboardy zůstávají ve vašem počítači, dokud je nenasdílíte týmu.
>
> DATOVÝ MODEL
> • Interaktivní ER diagramy s automatickým rozložením, uloženými pohledy a cestou JOIN mezi libovolnými tabulkami.
> • Návrh tabulek, sloupců, klíčů a indexů přímo v diagramu; DB Mastermind napíše migraci, předem zkontroluje data a připraví i vrácení změn.
> • Porovnání schémat i dat mezi databázemi.
> • Model nové databáze bez databáze: tabulky a vztahy kreslíte, přejmenujete a měníte typy přímo v diagramu; modely jsou textové soubory DBML vhodné pro Git, s SQL pro kteroukoli podporovanou databázi.
> • Otevře modely, které už máte: projekty DeZign for Databases (.dez, .dezproj, uloží je i zpět včetně diagramů, domén, podtypů, triggerů a verzí), MySQL Workbench, drawDB, Mermaid, Prisma a DBML.
> • Kód pro vaši aplikaci z modelu nebo živé databáze: schéma Prisma nebo Drizzle, modely SQLAlchemy, typy TypeScriptu.
>
> PŘIPOJENÍ, SERVERY A TÝMY
> • Přetáhněte do okna soubor .env nebo docker-compose projektu a jeho databáze se stanou připojeními; Supabase, Neon, Amazon RDS, Azure a Google Cloud SQL aplikace pozná.
> • Poznámky, dashboardy a uložené dotazy sdílíte s týmem přes složku v Gitu, na OneDrivu nebo na síťovém disku.
> • Aktivita serveru: běžící relace, nejnáročnější dotazy a úložiště včetně nepoužívaných a duplicitních indexů.
> • Kopírování tabulek do jiné databáze (i jiného typu), jeden skript na více připojeních, import JSON a Parquet.
> • Hesla ze správce hesel (1Password, Bitwarden, Vault), SSH přes jump host, SQL Server s Microsoft Entra ID.
>
> AI, KTERÁ ZNÁ VAŠI DATABÁZI
> • Vlastní API klíč (Anthropic, OpenAI, OpenRouter, Gemini, Azure), lokální model v Ollamě nebo předplatné Claude Code / Codex.
> • Pro každé připojení určíte, co AI smí: nic, jen vidět schéma, číst data, nebo měnit po vašem potvrzení. Čtení hlídá sama databáze.
> • Asistent prozkoumá schéma a spouští jen čtecí dotazy; před každou změnou se zeptá.
> • Znalostní báze v Markdownu, sdílená s týmem, ho naučí, co znamenají vaše tabulky a kódy.
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
12. Žádná telemetrie, žádný účet, žádná omezení funkcí. Zdarma a open source
13. Otevře modely z DeZign for Databases (i uloží zpět), MySQL Workbench, drawDB, Mermaid a Prisma; exportuje Prisma, Drizzle, SQLAlchemy a TypeScript
14. Transakce pod kontrolou, ruční potvrzování pro každé připojení
15. Aktivita serveru: relace, nejnáročnější dotazy, úložiště a nepoužívané indexy
16. Kopírování tabulek mezi databázemi, skript na více připojeních; hesla z 1Password, Bitwardenu nebo Vaultu; SSH přes jump host
17. Konfigurovatelný vzhled a skiny, dark mode a kompaktní režim
18. PostgreSQL do hloubky: všechny funkce v našeptávači, partitions, triggery, zabezpečení řádků, zprávy serveru
19. Grafy z jakéhokoli výsledku a dashboardy jen pro vás nebo sdílené s týmem
20. Oprávnění AI pro každé připojení: vypnuto, jen schéma, čtení, nebo změny po vašem potvrzení

**Search terms:** `SQL editor` · `PostgreSQL` · `SQL Server` · `ER diagram` · `databáze AI` · `datový model` · `databázový klient`

**What's new in this version:** Novinky od verze 1.4: přetáhněte do okna soubor .env, docker-compose nebo složku projektu a jejich databáze se stanou připojeními; Supabase, Neon, Amazon RDS, Azure a Google Cloud SQL aplikace pozná. Modely z MySQL Workbench, drawDB, Mermaid a Prisma otevřete a model nebo živou databázi vyexportujete jako Prisma, Drizzle, SQLAlchemy nebo TypeScript. Dashboardy jsou v záložce Uložené; dashboardy i uložené dotazy zůstávají ve vašem počítači, dokud je nenasdílíte týmu, a znalostní báze ukazuje zvlášť poznámky, dashboardy, dotazy a nástroje AI. Grafy se řídí zvolenou barvou nebo vzhledem. AI nad modelem funguje i bez databáze. Srozumitelnější na první pohled: tlačítko + pro novou záložku je vždy vidět, záložky se mohou posouvat nebo zužovat, nabídka záložky zavře záložky vlevo nebo vpravo, chyby říkají, co dělat, a neuložené změny v tabulce se nikdy nezahodí bez dotazu. Bezpečnější: SQL od AI asistenta, od agentů a na připojeních jen pro čtení hlídá sama databáze, oprávnění AI se ověřují při každém kroku a soubory od cizích lidí se čtou s limity a nikdy se nespouštějí.

**Copyright and trademark info:** © 2026 Václav Mudra

**Additional license terms:** Open source pod MIT licencí. DeZign for Databases is a trademark of Datanamic; DB Mastermind is not affiliated with or endorsed by Datanamic.

**Screenshots:** the same files; captions:

1. Návrh, dotaz a graf v jedné aplikaci
2. Prohlížení a filtrování dat bez omezení
3. SQL editor s našeptávačem podle schématu
4. Interaktivní ER diagramy
5. Model nové databáze přímo v diagramu
6. Návrh změn přímo v diagramu
7. Migrace ke kontrole i se skriptem pro vrácení
8. AI asistent, který zná vaši databázi
9. SQL dotazy nad soubory CSV a Excel
10. Grafy a dashboardy, které můžete sdílet s týmem

**Trailer:** the same video; title: *DB Mastermind za 90 sekund*.
