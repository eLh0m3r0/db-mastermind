# Product strategy

## Who it is for

1. **Analysts and developers who live in databases**: IT analysts, BI people, backend developers, support
   engineers. They need to find data fast, understand an unfamiliar schema and answer questions.
2. **Teams inside companies**, mostly on Windows, often without admin rights, often on SQL Server.
   They need a tool that runs from a zip file and doesn't need an IT ticket.
3. **AI-native developers** who already use Claude Code, Codex or Cursor. They want their agents to understand
   the database safely through MCP.

## Positioning

> *DB Mastermind is the database client that understands your data model:
> browse, query, diagram and design, with AI that knows your schema and your team's notes.*

Three pillars, in priority order:

1. **A great everyday client.** Fast grid, powerful filters, excellent SQL editor, no limits.
   It has to match Beekeeper Studio / TablePlus on day-to-day UX, otherwise nothing else matters.
2. **Understand the model.** Relationships everywhere: FK navigation, ER diagrams, virtual relations,
   and a Markdown knowledge base that captures what the schema can't say.
3. **Design the model.** A data modeling studio like dbdiagram, drawDB or DbSchema, connected to the live
   database: design visually or in DBML, diff against the database, generate migrations.

AI runs through all three. The same capabilities are exposed in the app and over MCP.

## License and business model

**Decision:** open core.

| Part | License | Price |
|---|---|---|
| Everything in this repository: the app, drivers, AI, MCP server, diagrams, data modeling | **MIT** | Free for everyone, including commercial use |
| Builds from GitHub Releases | MIT | Free |
| Mac App Store / Microsoft Store editions (signed, sandboxed, auto-updated by the store) | MIT source, paid convenience | One-time, ~€19 |
| Future `ee/` folder: team & enterprise features | Source-available (code public, production use by organisations of more than 5 people requires a paid license) | Per seat / year |

Planned enterprise features, built only once there's demand, and only features individuals don't need:
- Team workspace: shared connections (without secrets), shared knowledge base, diagrams and saved queries,
  synced via Git or a shared folder
- Central policy: managed config file / Windows Group Policy (allowed AI providers, forced read-only for
  prod, disabled export)
- Audit log of executed statements
- Signed MSI for software distribution tools (Intune, SCCM)
- Priority support and custom drivers

Other income: GitHub Sponsors and paid support or onboarding for companies.

**Why this model:** MIT keeps adoption friction at zero, so colleagues can use it at work without legal review.
Store editions earn money from people who'd rather pay than click through an unsigned-app warning.
Team and enterprise features earn money from organisations, which can afford it, without ever taking a feature
away from an individual.

## Distribution

- GitHub Releases: macOS dmg (arm64, x64), Windows portable zip + per-user installer, Linux AppImage/deb
- Later: winget, Homebrew cask, Scoop, Mac App Store, Microsoft Store
- The `dbmastermind-mcp` npm package works without the desktop app

## What success looks like

- v0.1: I and my colleagues replace Beekeeper Studio for daily work.
- v0.3: AI + knowledge base make onboarding onto an unknown database dramatically faster.
- v1.0: 1k GitHub stars, listed in winget/Homebrew, first sponsors.

## Maintenance model

The project is developed by an AI maintainer (Claude) with the project owner as product sponsor.
To stay sustainable:
- Every feature lands with tests. Drivers are tested against real databases in CI (Docker).
- `CLAUDE.md` documents conventions so any future session can continue the work.
- `ROADMAP.md` is the single source of truth for what to do next.
- Releases are fully automated from tags.
