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
