import { readFileSync } from 'node:fs'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DatabaseService, parseConnectionString, type ConnectionConfig } from '@dbmastermind/core'
import { createMcpServer } from './server.js'

const HELP = `dbmastermind-mcp: MCP server for your databases

Usage:
  dbmastermind-mcp --url <connection-url> [--name <name>] [options]
  dbmastermind-mcp --config <connections.json> [options]

Connections:
  --url <url>            postgres://…, mysql://…, mariadb://…, sqlserver://…, sqlite:///path, JDBC or ADO.NET strings.
                         Repeat for several databases. \${ENV_VAR} placeholders are expanded.
  --name <name>          Name for the preceding --url (default: host/database)
  --config <file>        JSON array of connections: [{ "name", "url" | driver/host/port/database/user/password, "knowledgeBase", "readOnly" }]
  --knowledge <dir>      Knowledge base folder for the preceding --url

Options:
  --allow-writes         Allow INSERT/UPDATE/DELETE/DDL (off by default)
  --allow-knowledge-writes  Let agents create knowledge base files
  --schema-only          Never return table contents, only schema
  --read-only            Mark all connections read-only (enforced by the database where supported)

Tip: the DB Mastermind desktop app can run as an MCP server with your saved connections and keychain passwords.
See Settings → MCP server in the app.

Examples:
  claude mcp add shop -- npx -y dbmastermind-mcp --url "postgres://me:\${PGPASSWORD}@localhost/shop"
  codex mcp add shop -- npx -y dbmastermind-mcp --config ~/dbs.json
`

const expandEnv = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '')

interface FileConnection extends Partial<ConnectionConfig> {
  url?: string
  knowledgeBase?: string
}

function parseArgs(argv: string[]) {
  const connections: ConnectionConfig[] = []
  const flags = { allowWrites: false, allowKnowledgeWrites: false, schemaOnly: false, readOnly: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    switch (arg) {
      case '--url': {
        const parsed = parseConnectionString(expandEnv(next()))
        const name = parsed.driver === 'sqlite' ? (parsed.filePath ?? 'sqlite') : `${parsed.host ?? 'localhost'}${parsed.database ? `/${parsed.database}` : ''}`
        connections.push({ ...parsed, id: `c${connections.length + 1}`, name })
        break
      }
      case '--name': {
        const last = connections.at(-1)
        if (!last) throw new Error('--name must follow --url')
        last.name = next()
        break
      }
      case '--knowledge': {
        const last = connections.at(-1)
        if (!last) throw new Error('--knowledge must follow --url')
        last.knowledgeBasePath = next()
        break
      }
      case '--config': {
        const list = JSON.parse(expandEnv(readFileSync(next(), 'utf8'))) as FileConnection[]
        for (const item of list) {
          const base = item.url ? parseConnectionString(item.url) : {}
          connections.push({
            ...base,
            ...item,
            driver: (item.driver ?? (base as ConnectionConfig).driver)!,
            id: item.id ?? `c${connections.length + 1}`,
            name: item.name ?? `connection ${connections.length + 1}`,
            knowledgeBasePath: item.knowledgeBase ?? item.knowledgeBasePath,
          })
        }
        break
      }
      case '--allow-writes':
        flags.allowWrites = true
        break
      case '--allow-knowledge-writes':
        flags.allowKnowledgeWrites = true
        break
      case '--schema-only':
        flags.schemaOnly = true
        break
      case '--read-only':
        flags.readOnly = true
        break
      case '-h':
      case '--help':
        process.stdout.write(HELP)
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument ${arg}`)
    }
  }
  if (flags.readOnly) for (const c of connections) c.readOnly = true
  return { connections, flags }
}

async function main() {
  const { connections, flags } = parseArgs(process.argv.slice(2))
  if (connections.length === 0) {
    process.stderr.write(HELP)
    process.exit(1)
  }
  const db = new DatabaseService()
  const server = createMcpServer({ db, connections, ...flags })
  await server.connect(new StdioServerTransport())
  const shutdown = async () => {
    await db.disconnectAll()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  process.stdin.on('close', () => void shutdown())
}

main().catch((err: unknown) => {
  process.stderr.write(`dbmastermind-mcp: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
