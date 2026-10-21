# DB Mastermind

**The free, open-source database client that understands your data model.**

Browse, filter, query, diagram and design databases, with an AI assistant that knows your schema and your
team's notes. It also exposes everything over MCP to Claude Code, Codex, Cursor and other agents.

> 🚧 Early development. See the [roadmap](ROADMAP.md) for what is done and what is coming.

## Why

Most good database GUIs keep the useful parts (more drivers, unlimited tabs, diagrams, AI) behind a
paywall. DB Mastermind is MIT-licensed and has **no feature limits**.

- **PostgreSQL, SQL Server, MySQL, MariaDB, SQLite**. More are coming.
- **Fast data grid** with nested AND/OR filters, 25+ operators, relative date ranges and raw `WHERE`
- **SQL editor** with schema-aware autocomplete, multiple result sets, cancel, and history
- **Relationships everywhere**: foreign-key navigation, interactive ER diagrams, virtual relations
- **Schema designer on live databases**: sketch changes on the diagram and get a reviewed migration script
- **AI your way**: your own API key (Anthropic, OpenAI, OpenRouter, Azure, Gemini), a local model (Ollama,
  LM Studio), or your existing Claude Code / Codex subscription
- **Knowledge base**: Markdown notes per database that the AI uses (and helps you write)
- **MCP server**: `npx dbmastermind-mcp` gives any agent safe, read-only-by-default database access
- **Runs without installation on Windows**: download the zip, unzip, run. No admin rights needed.

## Install

Download the latest build from [Releases](../../releases):

| Platform | File |
|---|---|
| Windows (no install) | `DB-Mastermind-<version>-win-x64-portable.zip` |
| Windows (installer, per-user) | `DB-Mastermind-<version>-win-x64-setup.exe` |
| macOS (Apple Silicon / Intel) | `DB-Mastermind-<version>-mac-arm64.dmg` / `-x64.dmg` |
| Linux | `DB-Mastermind-<version>-linux-x86_64.AppImage` / `.deb` |

Builds aren't code-signed yet. On macOS, right-click the app and choose **Open** the first time. On Windows,
click **More info → Run anyway**.

## Development

```bash
npm install
npm run db:up              # test databases in Docker
npm run dev                # start the app
npm test                   # unit tests
npm run test:integration   # driver tests against real databases
```

See [CLAUDE.md](CLAUDE.md) for architecture and conventions.

## License

[MIT](LICENSE). Free for personal and commercial use.
