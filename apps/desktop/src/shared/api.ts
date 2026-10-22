import type {
  ConnectionConfig,
  DataCompareResult,
  DesignTable,
  Grant,
  Principal,
  ExplainResult,
  FilterGroup,
  FilterNode,
  QueryResult,
  RowChange,
  SchemaSnapshot,
  ServerInfo,
  SessionActivity,
  SortSpec,
  StatementOutcome,
  TablePage,
  TableRef,
} from '@dbmastermind/core'

export type ThemePreference = 'system' | 'light' | 'dark'

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  portable: boolean
  dataDir: string
  /** How an agent launches this app as a stdio MCP server. */
  mcpCommand: { command: string; args: string[] }
  /** Set when an organization's managed configuration file is in effect. */
  managed?: ManagedInfo
}

/** What an IT department (or whoever prepared the app folder) enforces through `dbmastermind-managed.json`. */
export interface ManagedPolicies {
  /** false: the AI assistant, inline AI and AI filters are off on every connection. */
  allowAi?: boolean
  /** Only these AI providers can be used. */
  allowedAiProviders?: AiProviderId[]
  /** Upper limit for what AI may see. */
  maxAiDataSharing?: AiDataSharing
  /** false: agents can't use DB Mastermind as an MCP server (stdio or HTTP). */
  allowMcp?: boolean
  /** false: agents can only read through MCP. */
  allowMcpWrites?: boolean
  /** No check for new versions on GitHub. */
  disableUpdateCheck?: boolean
}

export interface ManagedInfo {
  path: string
  policies: ManagedPolicies
  connections: number
  /** The file couldn't be read; AI and MCP are off until it's fixed. */
  error?: string
}

export type McpClientId = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'vscode'

export interface McpClientStatus {
  id: McpClientId
  label: string
  /** The config file DB Mastermind edits for this client. */
  path: string
  installed: boolean
  /** The config already has a `dbmastermind` server. */
  configured: boolean
}

export type AiProviderId = 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'gemini' | 'ollama' | 'openai-compatible' | 'claude-code' | 'codex'

export interface AiProviderSettings {
  id: AiProviderId
  enabled: boolean
  apiKey?: string
  baseUrl?: string
  model?: string
  /** Azure deployment / resource name. */
  resourceName?: string
}

export type AiDataSharing = 'schema' | 'schema-and-samples' | 'full'

export interface AiSettings {
  activeProvider?: AiProviderId
  providers: AiProviderSettings[]
  dataSharing: AiDataSharing
  /** Allow the assistant to run read-only queries without asking each time. */
  autoRunReadQueries: boolean
}

export interface McpSettings {
  enabled: boolean
  port: number
  token: string
  allowWrites: boolean
}

/** Editor snippet: typing `trigger` offers `body`, whose `${name}` fields are filled in with Tab. */
export interface Snippet {
  trigger: string
  name: string
  body: string
}

export interface AppSettings {
  theme: ThemePreference
  /** Stronger text and border colors; 'system' follows the OS "increase contrast" setting. */
  contrast?: 'system' | 'normal' | 'high'
  language: 'en' | 'cs'
  pageSize: number
  maxResultRows: number
  editorFontSize: number
  confirmDangerousStatements: boolean
  showSystemSchemas: boolean
  nullDisplay: string
  dateFormat: 'iso' | 'locale'
  ai: AiSettings
  mcp: McpSettings
  /** User snippets (built-ins are always available unless overridden by trigger). */
  snippets?: Snippet[]
  /** Shared folder with the team's connections, saved queries and knowledge bases. */
  teamFolder?: string
}

/** A backup or restore: the file, or (SQL Server) the statement to run on the server. */
export interface BackupResult {
  path?: string
  bytes?: number
  sql?: string
}

export interface TeamStatus {
  folder?: string
  /** Set by the managed configuration: users can't change it. */
  locked: boolean
  connections: number
  queries: number
  error?: string
}

export interface StoredConnection extends ConnectionConfig {
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
  /** Tables pinned to the top of the explorer, as `schema.table` (or `table`). */
  pinnedTables?: string[]
  /** Schemas hidden from the explorer. */
  hiddenSchemas?: string[]
  /** Comes from the organization's managed configuration: server settings are fixed, it can't be deleted. */
  managed?: boolean
  /** Comes from the team folder's connections.json (kept in sync with it). */
  team?: boolean
}

export type ExplorerPrefs = Pick<StoredConnection, 'pinnedTables' | 'hiddenSchemas'>

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  executedAt: string
  durationMs: number
  rowCount?: number
  error?: string
  /** Where the statement came from; missing = the SQL editor. */
  source?: 'editor' | 'grid' | 'import' | 'ai' | 'mcp'
}

/** A named subset of tables with its own layout ("Sales", "Billing"…). */
/** Schema designer changes saved under a name, to continue or apply later (e.g. in the next release window). */
export interface ChangeSet {
  id: string
  connectionId: string
  name: string
  /** Designer drafts by node key, as in the diagram tab. */
  design: Record<string, DesignTable>
  createdAt: string
}

/** A sticky note on an ER diagram. */
export interface DiagramNote {
  id: string
  text: string
  x: number
  y: number
}

export interface SavedDiagram {
  id: string
  connectionId: string
  name: string
  /** Table keys as "schema.table" ("" schema for engines without schemas). */
  tables: string[]
  positions?: Record<string, { x: number; y: number }>
  /** Table header colors (series palette index 1–8) by table key. */
  colors?: Record<string, number>
  notes?: DiagramNote[]
  /** Stored in the team folder (`diagrams/*.json`); when saving, writes it there. */
  team?: boolean
  createdAt: string
  updatedAt: string
}

/** A query result pinned to a dashboard, shown as a chart (or a table when `chart` is null). */
export interface DashboardTile {
  id: string
  title: string
  sql: string
  chart: { kind: 'bar' | 'line' | 'scatter'; x: number; ys: number[] } | null
  /** Grid columns the tile spans (1 or 2). */
  span: 1 | 2
}

export interface Dashboard {
  id: string
  connectionId: string
  name: string
  tiles: DashboardTile[]
  /** Auto-refresh period in seconds; 0 = off. */
  refreshSeconds: number
  createdAt: string
  updatedAt: string
}

export interface SavedQuery {
  id: string
  name: string
  sql: string
  connectionId?: string
  folder?: string
  description?: string
  createdAt: string
  updatedAt: string
}

export type ExportFormat = 'csv' | 'tsv' | 'json' | 'jsonl' | 'sql' | 'markdown' | 'xlsx'

export interface ExportRequest {
  format: ExportFormat
  defaultName: string
  result: Pick<QueryResult, 'fields' | 'rows'>
  /** Target table name for SQL INSERT export. */
  tableName?: string
  connectionId?: string
}

export interface ExportTableRequest {
  format: ExportFormat
  connectionId: string
  table: TableRef
  filter?: FilterNode
  sort?: SortSpec[]
}

export interface RunQueryRequest {
  connectionId: string
  sql: string
  runId: string
  session?: string
  maxRows?: number
  continueOnError?: boolean
  /** Values for `:name` / `?` / `$1` parameters, keyed `name` or `$1`. */
  parameterValues?: Record<string, string | null>
}

export interface CompareDataRequest {
  source: { connectionId: string; table: TableRef }
  target: { connectionId: string; table: TableRef }
  keyColumns?: string[]
}

export interface FetchTableRequest {
  connectionId: string
  table: TableRef
  filter?: FilterNode
  sort?: SortSpec[]
  limit: number
  offset: number
  runId?: string
}

export interface ConnectResult {
  serverInfo: ServerInfo
}

export interface KnowledgeFileInfo {
  path: string
  title: string
  size: number
  modifiedAt: string
  tables: string[]
}

export interface ImportPreview {
  format: 'csv' | 'xlsx'
  delimiter?: string
  encoding?: string
  rows: string[][]
  totalRows: number
}

export interface ImportRequest {
  connectionId: string
  table: TableRef
  path: string
  delimiter?: string
  hasHeader: boolean
  /** Target column for each file column; null skips it. */
  mapping: (string | null)[]
  emptyAsNull: boolean
  /** Delete existing rows first (same transaction). */
  replace: boolean
}

export interface AiChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface AiChatRequest {
  chatId: string
  connectionId: string
  messages: AiChatMessage[]
  context?: { sql?: string; table?: string; error?: string }
}

export type AiEvent =
  | { chatId: string; type: 'text'; text: string }
  | { chatId: string; type: 'tool-start'; id: string; name: string; input: unknown }
  | { chatId: string; type: 'tool-end'; id: string; output: string; error?: boolean }
  | { chatId: string; type: 'approval'; id: string; kind: 'sql' | 'file'; detail: string }
  | { chatId: string; type: 'usage'; inputTokens: number; outputTokens: number }
  | { chatId: string; type: 'done' }
  | { chatId: string; type: 'error'; message: string }

export interface WorkspaceState {
  tabs: unknown[]
  activeTabId?: string
}

export interface FileFilter {
  name: string
  extensions: string[]
}

/** Everything the renderer can ask the main process to do. */
export interface MastermindApi {
  getAppInfo(): Promise<AppInfo>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  listConnections(): Promise<StoredConnection[]>
  saveConnection(config: ConnectionConfig): Promise<StoredConnection>
  /** Updates explorer preferences (pins, hidden schemas) without touching or reconnecting the connection. */
  setExplorerPrefs(id: string, prefs: ExplorerPrefs): Promise<void>
  deleteConnection(id: string): Promise<void>
  duplicateConnection(id: string): Promise<StoredConnection>
  testConnection(config: ConnectionConfig): Promise<ServerInfo>
  connect(id: string): Promise<ConnectResult>
  disconnect(id: string): Promise<void>
  isConnected(id: string): Promise<boolean>
  parseConnectionString(text: string): Promise<Partial<ConnectionConfig>>
  /** Writes the full statement history of a connection (or all) to CSV; returns the path or null. */
  exportHistory(connectionId?: string): Promise<string | null>
  /** State of the local HTTP MCP endpoint (Settings → MCP server). */
  mcpHttpStatus(): Promise<{ running: boolean; error?: string; url: string }>
  /** Backs the database up to a file (pg_dump, mysqldump, SQLite/DuckDB copy); SQL Server returns the BACKUP statement. */
  backupDatabase(connectionId: string): Promise<BackupResult | null>
  /** Restores a backup file into the database (replaces its contents); SQL Server returns the RESTORE statement. */
  restoreDatabase(connectionId: string): Promise<BackupResult | null>
  /** The team folder in use and what it shares. */
  teamStatus(): Promise<TeamStatus>
  /** Picks a team folder (dialog when `path` is undefined; null clears it). */
  setTeamFolder(path?: string | null): Promise<TeamStatus>
  /** Writes a connection (without passwords) to the team folder's connections.json. */
  addConnectionToTeam(id: string): Promise<void>
  /** Removes a connection from the team folder's connections.json (it stays on this computer). */
  removeConnectionFromTeam(id: string): Promise<void>
  /** Which agent apps are installed and already know about DB Mastermind. */
  mcpClients(): Promise<McpClientStatus[]>
  /** Adds DB Mastermind to an agent app's MCP config (keeping a `.bak` copy); returns the changed file. */
  addToMcpClient(id: McpClientId): Promise<{ path: string; via: 'cli' | 'file'; backup: boolean }>
  importConnections(source: 'beekeeper' | 'dbeaver' | 'datagrip' | 'pgpass' | 'file'): Promise<number>
  /** Writes connections without passwords or keys to a JSON file for colleagues; all when `ids` is empty. */
  exportConnections(ids?: string[]): Promise<string | null>
  /** Creates (or reuses) the demo SQLite database with its knowledge base; returns the connection id. */
  createSampleDatabase(): Promise<string>

  getSchema(connectionId: string, refresh?: boolean): Promise<SchemaSnapshot>
  listDatabases(connectionId: string): Promise<string[]>

  runQuery(request: RunQueryRequest): Promise<StatementOutcome[]>
  cancelQuery(runId: string): Promise<void>
  explainQuery(connectionId: string, sql: string, analyze?: boolean): Promise<ExplainResult>
  releaseSession(connectionId: string, session: string): Promise<void>
  listActivity(connectionId: string): Promise<SessionActivity[]>
  listPrincipals(connectionId: string): Promise<Principal[]>
  listGrants(connectionId: string, principal: string): Promise<Grant[]>
  stopSession(connectionId: string, sessionId: string, mode: 'cancel' | 'terminate'): Promise<void>
  /** Writes HTML/Markdown documentation of the schema (with knowledge base notes); returns the path or null if cancelled. */
  exportDataDictionary(connectionId: string, format: 'html' | 'markdown', schemas?: string[]): Promise<string | null>
  compareData(request: CompareDataRequest): Promise<DataCompareResult>
  /** Opens a CSV / Parquet / JSON / Excel file for SQL in the built-in DuckDB; asks for the file when `path` is omitted. */
  /** Opens a .dbml model file (asks for it when `path` is omitted). */
  openModelFile(path?: string, defaultDir?: string): Promise<{ path: string; text: string } | null>
  /** Saves a .dbml model; asks where when `path` is omitted. Returns the path, or null if cancelled. */
  saveModelFile(text: string, path?: string, defaultDir?: string): Promise<string | null>
  /** Reads a SQL DDL script (pg_dump, mysqldump, SSMS…) into DBML; asks for the file. */
  /** Saves a SQL script (migrations); asks where, suggesting `name`. Returns the path or null. */
  saveSqlFile(text: string, name: string, defaultDir?: string): Promise<string | null>
  importDdlFile(): Promise<{ path: string; dbml: string; skipped: { sql: string; error: string }[] } | null>
  queryFile(path?: string): Promise<{ connectionId: string; sql: string; title: string } | null>

  fetchTable(request: FetchTableRequest): Promise<TablePage>
  countTable(request: Omit<FetchTableRequest, 'limit' | 'offset'>): Promise<number>
  importPreview(path: string, delimiter?: string): Promise<ImportPreview>
  importFile(request: ImportRequest): Promise<number>
  previewChanges(connectionId: string, table: TableRef, changes: RowChange[]): Promise<string[]>
  applyChanges(connectionId: string, table: TableRef, changes: RowChange[]): Promise<number[]>

  listHistory(connectionId?: string, search?: string, limit?: number): Promise<HistoryEntry[]>
  clearHistory(connectionId?: string): Promise<void>
  listSavedQueries(): Promise<SavedQuery[]>
  saveQuery(query: Omit<SavedQuery, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SavedQuery>
  deleteSavedQuery(id: string): Promise<void>
  listDiagrams(connectionId: string): Promise<SavedDiagram[]>
  saveDiagram(diagram: Omit<SavedDiagram, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<SavedDiagram>
  deleteDiagram(id: string): Promise<void>
  listChangeSets(connectionId: string): Promise<ChangeSet[]>
  saveChangeSet(changeSet: Omit<ChangeSet, 'id' | 'createdAt'>): Promise<ChangeSet>
  deleteChangeSet(id: string): Promise<void>
  listDashboards(connectionId: string): Promise<Dashboard[]>
  saveDashboard(dashboard: Omit<Dashboard, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Dashboard>
  deleteDashboard(id: string): Promise<void>

  exportResult(request: ExportRequest): Promise<string | null>
  exportTable(request: ExportTableRequest): Promise<string | null>
  /** Runs one statement again and streams every row to a file (no row limit). */
  exportQuery(request: { format: ExportFormat; connectionId: string; sql: string; defaultName: string }): Promise<{ path: string; rows: number } | null>
  pickFile(options: { title?: string; filters?: FileFilter[]; save?: boolean; defaultPath?: string }): Promise<string | null>
  pickDirectory(title?: string): Promise<string | null>
  readTextFile(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>

  /** Knowledge base of a connection; creates a default folder in the data dir when asked. */
  kbEnsureFolder(connectionId: string): Promise<string>
  kbList(connectionId: string): Promise<KnowledgeFileInfo[]>
  /** Notes mentioning tables, columns or relationships the database no longer has. */
  kbIssues(connectionId: string): Promise<{ path: string; message: string }[]>
  kbRead(connectionId: string, path: string): Promise<string>
  kbWrite(connectionId: string, path: string, content: string): Promise<string>
  kbDelete(connectionId: string, path: string): Promise<void>

  listAiModels(provider: AiProviderSettings): Promise<string[]>
  testAiProvider(provider: AiProviderSettings): Promise<string>
  /** Streams AiEvents on the 'ai:event' channel; resolves when the run has started. */
  aiChat(request: AiChatRequest): Promise<void>
  /** Natural language → filter for one table, validated against its columns. */
  /** Inline SQL writing (Cmd/Ctrl+I): returns SQL for the request, rewriting `selection` when given. */
  aiWriteSql(connectionId: string, request: string, sql?: string, selection?: string): Promise<string>
  aiSuggestFilter(connectionId: string, table: TableRef, request: string): Promise<FilterGroup>
  cancelAiChat(chatId: string): Promise<void>
  /** `always` approves this and all later requests of the same kind in the chat. */
  respondAiApproval(id: string, answer: boolean | 'always'): Promise<void>

  loadWorkspace(): Promise<WorkspaceState | null>
  saveWorkspace(state: WorkspaceState): Promise<void>
}

/** Events pushed from main to renderer. */
export interface MainEvents {
  'menu:command': string
  'update:available': { version: string; url: string }
  'connection:lost': { connectionId: string; message: string }
  'ai:event': AiEvent
  /** Files in the team folder changed: reload connections and saved queries. */
  'team:changed': undefined
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string; name?: string } }

export const API_CHANNEL = 'mastermind:api'

export const API_METHODS = [
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'listConnections',
  'saveConnection',
  'setExplorerPrefs',
  'deleteConnection',
  'duplicateConnection',
  'testConnection',
  'connect',
  'disconnect',
  'isConnected',
  'parseConnectionString',
  'importConnections',
  'exportHistory',
  'mcpHttpStatus',
  'mcpClients',
  'backupDatabase',
  'restoreDatabase',
  'teamStatus',
  'setTeamFolder',
  'addConnectionToTeam',
  'removeConnectionFromTeam',
  'addToMcpClient',
  'exportConnections',
  'createSampleDatabase',
  'getSchema',
  'listDatabases',
  'runQuery',
  'cancelQuery',
  'explainQuery',
  'releaseSession',
  'listActivity',
  'listPrincipals',
  'listGrants',
  'stopSession',
  'exportDataDictionary',
  'compareData',
  'queryFile',
  'openModelFile',
  'saveModelFile',
  'importDdlFile',
  'saveSqlFile',
  'fetchTable',
  'countTable',
  'importPreview',
  'importFile',
  'previewChanges',
  'applyChanges',
  'listHistory',
  'clearHistory',
  'listSavedQueries',
  'saveQuery',
  'deleteSavedQuery',
  'listDiagrams',
  'saveDiagram',
  'deleteDiagram',
  'listChangeSets',
  'saveChangeSet',
  'deleteChangeSet',
  'listDashboards',
  'saveDashboard',
  'deleteDashboard',
  'exportResult',
  'exportTable',
  'exportQuery',
  'pickFile',
  'pickDirectory',
  'readTextFile',
  'openExternal',
  'showItemInFolder',
  'kbEnsureFolder',
  'kbList',
  'kbIssues',
  'kbRead',
  'kbWrite',
  'kbDelete',
  'listAiModels',
  'testAiProvider',
  'aiChat',
  'aiSuggestFilter',
  'aiWriteSql',
  'cancelAiChat',
  'respondAiApproval',
  'loadWorkspace',
  'saveWorkspace',
] as const satisfies readonly (keyof MastermindApi)[]

// Compile error if a method is added to MastermindApi but not to API_METHODS.
const _exhaustive: Exclude<keyof MastermindApi, (typeof API_METHODS)[number]> extends never ? true : never = true
void _exhaustive
