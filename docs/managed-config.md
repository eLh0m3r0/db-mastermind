# Managed configuration (for IT and team leads)

Put a `dbmastermind-managed.json` file next to the app to give everyone the same connections, AI setup and
rules. Users can't change it from the app.

## Where the file is looked for

The first file found wins:

1. the path in the `DBM_MANAGED_CONFIG` environment variable
2. next to the executable, e.g. in the unzipped portable folder, beside `DB Mastermind.exe`
3. on macOS, next to `DB Mastermind.app`
4. the system folder:
   - Windows: `%ProgramData%\DB Mastermind\managed.json`
   - macOS: `/Library/Application Support/DB Mastermind/managed.json`
   - Linux: `/etc/dbmastermind/managed.json`

**Settings → About** shows which file is in effect and a summary of the rules.

## Example

```json
{
  "connections": [
    {
      "id": "erp-prod",
      "name": "ERP production",
      "driver": "mssql",
      "host": "erp-sql.corp.local",
      "port": 1433,
      "database": "ERP",
      "options": { "authentication": "windows" },
      "readOnly": true,
      "environment": "production",
      "color": "#dc2626",
      "knowledgeBasePath": "\\\\fileserver\\data-team\\kb\\erp"
    },
    { "id": "dwh", "name": "Data warehouse", "driver": "postgres", "host": "dwh.corp.local", "database": "dwh" }
  ],
  "aiProviders": [
    { "id": "azure", "enabled": true, "resourceName": "corp-openai", "model": "gpt-5" }
  ],
  "defaultAiProvider": "azure",
  "teamFolder": "\\\\fileserver\\data-team\\dbmastermind",
  "policies": {
    "allowedAiProviders": ["azure", "ollama"],
    "maxAiDataSharing": "schema-and-samples",
    "allowMcpWrites": false,
    "disableUpdateCheck": false
  }
}
```

## Connections

- Each connection needs a stable `id` (any text), a `name` and a `driver`: `postgres`, `mssql`, `mysql`, `mariadb`,
  `oracle`, `sqlite` or `duckdb`. Every other field of the connection form can be set too:
  - `host`, `port`, `database`, `user`, `filePath` (SQLite, DuckDB)
  - `options`, e.g. `{ "authentication": "windows" }` for SQL Server Windows authentication
  - `ssl`, `ssh` (without secrets)
  - `readOnly`, `environment` (`development`, `test`, `staging` or `production`)
  - `color`, `group`, `knowledgeBasePath`, `aiEnabled`
- Fields in the file always win. If a user edits them, the edit is reset.
- Fields the file leaves out, usually `user`, are filled in by each user.
- **Passwords are never read from this file.** Each user enters their own, and it's stored encrypted in their OS
  keychain.
- Managed connections show a building icon and can't be deleted.

## Policies

| Policy | Effect |
|---|---|
| `allowAi: false` | AI assistant, inline AI and AI filters are off on every connection |
| `allowedAiProviders` | only these providers appear and can be used (`anthropic`, `openai`, `openrouter`, `azure`, `gemini`, `ollama`, `openai-compatible`, `claude-code`, `codex`) |
| `maxAiDataSharing` | the most AI may see: `schema`, `schema-and-samples` or `full` |
| `allowMcp: false` | agents can't use the app as an MCP server, over stdio or HTTP |
| `allowMcpWrites: false` | agents can only read through MCP |
| `disableUpdateCheck: true` | no check for new versions on GitHub |

`teamFolder` sets the [team folder](team-folder.md) for everyone (users can't change it).

`aiProviders` pre-fills provider settings (endpoint, model, Azure resource) without keys.

If the file can't be read, for example because of broken JSON, the app **fails closed**: AI and MCP stay off until
it's fixed, and Settings → About shows the error.
