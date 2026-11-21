# Product strategy

## Why it exists

To help people and teams understand their data, with one tool for the whole job: design the database, query it
and see it in charts. Free for everyone.

The owner does not want to earn money on this product (decided 2026-11-21, before the public launch). It
started as the database tool of his own team and is paid for by him.

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

## Two ways in: a database or a model

The owner's direction (2026-11-13), after the DeZign work: the app is a product of its own, not a copy of
DeZign for Databases. It does what DeZign does, the way a tool of today does it.

1. **Two equal jobs.** *Work with a database* (connections, data, SQL, a live diagram, AI on it) and *design a
   model* (a document, like a Word file, with no database needed until it is compared or migrated). The home
   page offers the two side by side and fits a laptop screen without scrolling.
2. **DeZign is a file format, not the way the app works.** Its projects open, are edited and save back in place,
   checked against DeZign itself, so a team can switch person by person. The app's texts name DeZign only where a
   file is opened or saved; nothing is "as in DeZign". A new model's own format is DBML (text, Git friendly) with
   "Save as DeZign project" for those who need it.
3. **Edit in place, details beside it.** What is done most is done on the canvas: rename a table or a column,
   add a column, change its type, NOT NULL, draw a relationship. The rest of the selected object (indexes,
   checks, notes, properties, a relationship's settings) is in one detail panel: docked on the right in a wide
   window, a drawer over the canvas in a narrow one (Esc closes it, a pin keeps it). No setting decides this; the
   window's width does. Modal dialogs only for decisions: save, delete, switch the database.
4. **Few buttons.** A model's bar holds Save, Compare with database, SQL and View; everything else is behind
   "More" and the command palette. A model hides the connections sidebar: its left side is its own objects.
5. **Free for developers.** MIT as everything else: colleagues use it without a licence, DeZign users included.

## License and business model

Everything in this repository is **MIT**: the app, the drivers, AI, the MCP server, diagrams and data modeling.
It is free for everyone, including commercial use. There is no paid tier, no account and no telemetry, and
none is planned.

| What | Price |
|---|---|
| The app from GitHub Releases, the Microsoft Store, Homebrew, Scoop, the MSI for IT | Free |
| `dbmastermind-mcp` and `dbm` from npm | Free |
| Team features (team folder, managed configuration, audit log) | Free, in the same MIT code |

Income: none is needed to keep it going. People who want to say thanks can use Ko-fi. If a company asks for
work done for it alone (support, onboarding, a driver nobody else needs), that can be paid work; it is not a
version of the product.

**What public texts say:** "free, MIT-licensed, no paid tier" in the present tense. They make no promise about
the future ("forever", "never"): the owner does not want one made in his name, and a plain fact that can be
checked today is worth more than a promise.

**History:** until 2026-11-21 this page planned an open core (paid editions in the app stores and a
source-available `ee/` folder for team and enterprise features). None of it was built: the Microsoft Store
edition is free, the Mac App Store was dropped because its sandbox would cut features, and the team features
shipped under MIT with everything else.

## Distribution

- GitHub Releases: macOS dmg (arm64, x64), Windows portable zip, per-user installer and MSI, Linux AppImage and .deb
- Microsoft Store (signed by Microsoft), Homebrew cask and Scoop (this repository is the tap and the bucket);
  winget waits for its first review. Not planned: the Mac App Store (see above)
- The `dbmastermind-mcp` npm package (the MCP server and the `dbm` command line) works without the desktop app

## What success looks like

- v0.1: I and my colleagues replace Beekeeper Studio for daily work. ✅
- v0.3: AI + knowledge base make onboarding onto an unknown database dramatically faster. ✅
- v1.x, after the public launch (1.5): people outside the owner's company use it daily and say what is missing;
  issues and pull requests from strangers; listed in winget and the MCP registry.

## Maintenance model

The project is developed by an AI maintainer (Claude) with the project owner as product sponsor.
To stay sustainable:
- Every feature lands with tests. Drivers are tested against real databases in CI (Docker).
- `CLAUDE.md` documents conventions so any future session can continue the work.
- `ROADMAP.md` is the single source of truth for what to do next.
- Releases are fully automated from tags.
