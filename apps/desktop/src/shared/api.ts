import type {
  ConnectionConfig,
  ExplainResult,
  FilterGroup,
  FilterNode,
  QueryResult,
  RowChange,
  SchemaSnapshot,
  ServerInfo,
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

export interface AppSettings {
  theme: ThemePreference
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
}

export interface StoredConnection extends ConnectionConfig {
  createdAt: string
  updatedAt: string
  lastUsedAt?: string
}

export interface HistoryEntry {
  id: string
  connectionId: string
  sql: string
  executedAt: string
  durationMs: number
  rowCount?: number
  error?: string
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
  deleteConnection(id: string): Promise<void>
  duplicateConnection(id: string): Promise<StoredConnection>
  testConnection(config: ConnectionConfig): Promise<ServerInfo>
  connect(id: string): Promise<ConnectResult>
  disconnect(id: string): Promise<void>
  isConnected(id: string): Promise<boolean>
  parseConnectionString(text: string): Promise<Partial<ConnectionConfig>>
  importConnections(source: 'beekeeper' | 'dbeaver' | 'file'): Promise<number>
  /** Creates (or reuses) the demo SQLite database with its knowledge base; returns the connection id. */
  createSampleDatabase(): Promise<string>

  getSchema(connectionId: string, refresh?: boolean): Promise<SchemaSnapshot>
  listDatabases(connectionId: string): Promise<string[]>

  runQuery(request: RunQueryRequest): Promise<StatementOutcome[]>
  cancelQuery(runId: string): Promise<void>
  explainQuery(connectionId: string, sql: string, analyze?: boolean): Promise<ExplainResult>
  releaseSession(connectionId: string, session: string): Promise<void>

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

  exportResult(request: ExportRequest): Promise<string | null>
  exportTable(request: ExportTableRequest): Promise<string | null>
  pickFile(options: { title?: string; filters?: FileFilter[]; save?: boolean; defaultPath?: string }): Promise<string | null>
  pickDirectory(title?: string): Promise<string | null>
  readTextFile(path: string): Promise<string>
  openExternal(url: string): Promise<void>
  showItemInFolder(path: string): Promise<void>

  /** Knowledge base of a connection; creates a default folder in the data dir when asked. */
  kbEnsureFolder(connectionId: string): Promise<string>
  kbList(connectionId: string): Promise<KnowledgeFileInfo[]>
  kbRead(connectionId: string, path: string): Promise<string>
  kbWrite(connectionId: string, path: string, content: string): Promise<string>
  kbDelete(connectionId: string, path: string): Promise<void>

  listAiModels(provider: AiProviderSettings): Promise<string[]>
  testAiProvider(provider: AiProviderSettings): Promise<string>
  /** Streams AiEvents on the 'ai:event' channel; resolves when the run has started. */
  aiChat(request: AiChatRequest): Promise<void>
  /** Natural language → filter for one table, validated against its columns. */
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
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { message: string; code?: string; name?: string } }

export const API_CHANNEL = 'mastermind:api'

export const API_METHODS = [
  'getAppInfo',
  'getSettings',
  'updateSettings',
  'listConnections',
  'saveConnection',
  'deleteConnection',
  'duplicateConnection',
  'testConnection',
  'connect',
  'disconnect',
  'isConnected',
  'parseConnectionString',
  'importConnections',
  'createSampleDatabase',
  'getSchema',
  'listDatabases',
  'runQuery',
  'cancelQuery',
  'explainQuery',
  'releaseSession',
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
  'exportResult',
  'exportTable',
  'pickFile',
  'pickDirectory',
  'readTextFile',
  'openExternal',
  'showItemInFolder',
  'kbEnsureFolder',
  'kbList',
  'kbRead',
  'kbWrite',
  'kbDelete',
  'listAiModels',
  'testAiProvider',
  'aiChat',
  'aiSuggestFilter',
  'cancelAiChat',
  'respondAiApproval',
  'loadWorkspace',
  'saveWorkspace',
] as const satisfies readonly (keyof MastermindApi)[]

// Compile error if a method is added to MastermindApi but not to API_METHODS.
const _exhaustive: Exclude<keyof MastermindApi, (typeof API_METHODS)[number]> extends never ? true : never = true
void _exhaustive
