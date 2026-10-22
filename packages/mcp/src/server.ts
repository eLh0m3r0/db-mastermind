import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  buildSystemPrompt,
  DB_TOOLS,
  describeError,
  KnowledgeBase,
  loadSqlTools,
  schemaOverview,
  type DbTool,
  type ConnectionConfig,
  type DatabaseService,
  type StatementOutcome,
  type ToolContext,
} from '@dbmastermind/core'

export interface McpServerOptions {
  db: DatabaseService
  connections: ConnectionConfig[]
  /** Allow INSERT/UPDATE/DELETE/DDL from agents (read-only connections stay read-only). */
  allowWrites?: boolean
  /** Allow agents to create knowledge base files. */
  allowKnowledgeWrites?: boolean
  /** Hide table contents (query results, samples) from agents. */
  schemaOnly?: boolean
  version?: string
  /** Called for every statement an agent ran (audit log). */
  onExecuted?: (connectionId: string, outcome: StatementOutcome) => void
  /**
   * Asks the user before a write on connections whose AI access is "write" (the app's own assistant, which can show
   * a confirmation). External agents can't be asked, so without this they need agentWrites.
   */
  confirmWrite?: (sql: string) => Promise<boolean>
  /**
   * Runs before a database tool; a returned message is the tool's answer instead (the app's assistant asks the user
   * before saving a knowledge base file or, when set so, before a read query).
   */
  beforeTool?: (name: string, args: Record<string, unknown>) => Promise<string | undefined>
}

const INSTRUCTIONS = `DB Mastermind gives you safe access to the user's databases.
Start with list_connections, then list_tables / search_schema / describe_table to learn the schema before writing SQL.
The knowledge base (search_knowledge, read_knowledge) holds the team's notes on what tables mean and how they relate: check it for business questions.
run_query is read-only unless the user enabled writes. Always limit exploratory queries.`

export function createMcpServer(options: McpServerOptions): Server {
  const { db, connections } = options
  const server = new Server(
    { name: 'dbmastermind', version: options.version ?? '0.1.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} }, instructions: INSTRUCTIONS },
  )
  const single = connections.length === 1

  const findConnection = (ref: unknown): ConnectionConfig => {
    if ((ref === undefined || ref === '') && single) return connections[0]!
    const key = String(ref ?? '').trim().toLowerCase()
    const found = connections.find((c) => c.id.toLowerCase() === key || c.name.toLowerCase() === key)
    if (!found) {
      throw new Error(
        `Unknown connection "${String(ref ?? '')}". Available: ${connections.map((c) => c.name).join(', ') || 'none'}`,
      )
    }
    return found
  }

  const contextFor = async (config: ConnectionConfig): Promise<ToolContext> => {
    if (!db.isOpen(config.id)) await db.connect(config)
    return {
      db,
      connectionId: config.id,
      knowledge: config.knowledgeBasePath ? new KnowledgeBase(config.knowledgeBasePath) : undefined,
      // A connection's own permissions (set in the app) win over the server-wide flags.
      allowData: !options.schemaOnly && (!config.ai || config.ai.access === 'read' || config.ai.access === 'write'),
      allowKnowledgeWrites: config.ai ? config.ai.knowledgeWrites === true : options.allowKnowledgeWrites,
      confirmWrite:
        options.confirmWrite && config.ai?.access === 'write'
          ? options.confirmWrite
          : (config.ai ? config.ai.agentWrites === true && config.ai.access === 'write' : options.allowWrites)
            ? async () => true
            : undefined,
      maxRows: 100,
      onExecuted: options.onExecuted ? (o) => options.onExecuted!(config.id, o) : undefined,
    }
  }

  const connectionProperty = {
    type: 'string',
    description: single ? 'Optional, there is only one connection' : `Connection name: ${connections.map((c) => c.name).join(', ')}`,
  }

  const reserved = ['list_connections', ...DB_TOOLS.map((t) => t.name)]
  /** Team tools (knowledge base tools/*.sql) by name, with the connections that define them. */
  const teamTools = async () => {
    const byName = new Map<string, { tool: DbTool; connections: string[] }>()
    for (const c of connections) {
      if (!c.knowledgeBasePath) continue
      const { tools } = await loadSqlTools(new KnowledgeBase(c.knowledgeBasePath), reserved)
      for (const t of tools) {
        const entry = byName.get(t.name) ?? { tool: t, connections: [] }
        entry.connections.push(c.name)
        byName.set(t.name, entry)
      }
    }
    return byName
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...[...(await teamTools()).values()].map(({ tool, connections: names }) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: {
          ...tool.inputSchema,
          properties: { connection: { type: 'string', description: `Connection: ${names.join(', ')}` }, ...tool.inputSchema.properties },
          required: single ? tool.inputSchema.required : ['connection', ...(tool.inputSchema.required ?? [])],
        },
        annotations: { readOnlyHint: true },
      })),
      {
        name: 'list_connections',
        description: 'List the databases available through DB Mastermind.',
        inputSchema: { type: 'object' as const, properties: {} },
        annotations: { readOnlyHint: true },
      },
      ...DB_TOOLS.filter((t) => t.name !== 'write_knowledge' || options.allowKnowledgeWrites || connections.some((c) => c.ai?.knowledgeWrites)).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: {
          ...t.inputSchema,
          properties: { connection: connectionProperty, ...t.inputSchema.properties },
          required: single ? t.inputSchema.required : ['connection', ...(t.inputSchema.required ?? [])],
        },
        annotations: { readOnlyHint: t.readOnly || (t.name === 'run_query' && !options.allowWrites && !connections.some((c) => c.ai?.agentWrites)) },
      })),
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params
    try {
      if (name === 'list_connections') {
        const lines = connections.map(
          (c) =>
            `${c.name} — ${c.driver}${c.driver === 'sqlite' ? ` ${c.filePath}` : ` ${c.host ?? ''}${c.database ? `/${c.database}` : ''}`}${c.readOnly ? ' (read-only)' : ''}${c.environment ? ` [${c.environment}]` : ''}${c.knowledgeBasePath ? ' (has knowledge base)' : ''}`,
        )
        return { content: [{ type: 'text', text: lines.join('\n') || 'No connections are shared with agents.' }] }
      }
      const config = findConnection((args as Record<string, unknown>).connection)
      const ctx = await contextFor(config)
      const tool = DB_TOOLS.find((t) => t.name === name) ?? (await loadSqlTools(ctx.knowledge, reserved)).tools.find((t) => t.name === name)
      if (!tool) throw new Error(`Unknown tool ${name}${reserved.includes(name) ? '' : ` for ${config.name}`}`)
      const stop = await options.beforeTool?.(name, args as Record<string, unknown>)
      if (stop) return { content: [{ type: 'text', text: stop }] }
      const text = await tool.run(ctx, args as Record<string, unknown>)
      return { content: [{ type: 'text', text }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `ERROR: ${describeError(err).message}` }], isError: true }
    }
  })

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: connections.map((c) => ({
      uri: `dbmastermind://${encodeURIComponent(c.name)}/schema`,
      name: `${c.name} schema`,
      description: `Tables, columns and relationships of ${c.name}`,
      mimeType: 'text/plain',
    })),
  }))

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const m = /^dbmastermind:\/\/([^/]+)\/schema$/.exec(request.params.uri)
    if (!m) throw new Error('Unknown resource')
    const config = findConnection(decodeURIComponent(m[1]!))
    await contextFor(config)
    const snapshot = await db.schema(config.id)
    return { contents: [{ uri: request.params.uri, mimeType: 'text/plain', text: schemaOverview(snapshot, 200_000) }] }
  })

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'explore_database',
        description: 'Get oriented in a database: schema overview, knowledge base and suggested next steps.',
        arguments: [{ name: 'connection', description: 'Connection name', required: !single }],
      },
      {
        name: 'document_database',
        description: 'Write a knowledge base for a database (one Markdown file per area) from its schema and data.',
        arguments: [{ name: 'connection', description: 'Connection name', required: !single }],
      },
    ],
  }))

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const config = findConnection(request.params.arguments?.connection)
    const ctx = await contextFor(config)
    const system = await buildSystemPrompt(ctx)
    if (request.params.name === 'document_database') {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `${system}\n\nTask: document the database "${config.name}" as a knowledge base. Use the tools to study the schema, relationships and samples of data. Then write Markdown files with write_knowledge (if available) or output them: README.md with an overview and a map of areas; one file per functional area describing each table's purpose, important columns, codes/enums, and how tables join. Put \`tables: [...]\` in front matter and list relationships the database does not declare as \`relations: ["a.col -> b.col"]\`.`,
            },
          },
        ],
      }
    }
    return {
      messages: [{ role: 'user', content: { type: 'text', text: `${system}\n\nGive me a short orientation in this database: main areas, the most important tables and how they connect.` } }],
    }
  })

  return server
}
