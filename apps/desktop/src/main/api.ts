import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { basename, extname, join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import {
  buildBatchInserts,
  buildChangeStatements,
  detectDelimiter,
  explainQuery,
  DIALECT_NAMES,
  extractSql,
  schemaOverview,
  writeSqlPrompt,
  listActivity,
  listGrants,
  listPrincipals,
  buildDataDictionary,
  compareTableData,
  type DictionaryNote,
  stopSession,
  filterPrompt,
  sanitizeFilter,
  parseDelimited,
  parseXlsx,
  DatabaseService,
  getDialect,
  inlineParams,
  KnowledgeBase,
  staleKnowledge,
  tablesFromDdl,
  tablesFromPrisma,
  toDbml,
  resolveInside,
  SAMPLE_KNOWLEDGE,
  sampleDatabaseSql,
  parseConnectionString,
  qualify,
  type ConnectionConfig,
} from '@dbmastermind/core'
import type { ExportFormat, MastermindApi } from '@shared/api'
import * as connections from './connections'
import { createExportWriter, EXPORT_EXTENSIONS } from './export'
import { cancelChat, respondApproval, startChat } from './ai/assistant'
import { completeText, extractJson } from './ai/complete'
import { listModels, testProvider } from './ai/models'
import { exportConnections, importConnections } from './importers'
import { backupDatabase, restoreDatabase } from './backup'
import { managed } from './managed'
import { installUpdate } from './updates'
import { reloadTeam, setTeamFolder, teamDir, teamStatus } from './team'
import { removeTeamConnection, writeTeamConnection } from './team-folder'
import { addToMcpClient, mcpClientStatuses, type McpLaunch } from './mcp-clients'
import { applyMcpHttp, mcpHttpStatus } from './mcp-http'
import { buildMenu } from './menu'
import * as library from './library'
import { getSettings, updateSettings } from './settings'
import { isPortable } from './storage'

export const db = new DatabaseService()

const running = new Map<string, AbortController>()

function track<T>(runId: string | undefined, fn: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (!runId) return fn()
  const controller = new AbortController()
  running.set(runId, controller)
  return fn(controller.signal).finally(() => running.delete(runId))
}

/** Reads CSV/TSV (UTF-8, or Windows-1250 as Czech Excel saves it) or the first sheet of an .xlsx file. */
async function readImportFile(path: string, delimiter?: string) {
  const buffer = await readFile(path)
  if (/\.xlsx$/i.test(path)) return { format: 'xlsx' as const, rows: parseXlsx(buffer) }
  let text: string
  let encoding = 'utf-8'
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    encoding = 'windows-1250'
    text = new TextDecoder('windows-1250').decode(buffer)
  }
  const d = delimiter || detectDelimiter(text.slice(0, 20_000))
  return { format: 'csv' as const, delimiter: d, encoding, rows: parseDelimited(text, d) }
}

function knowledge(connectionId: string): KnowledgeBase {
  const path = connections.getConnection(connectionId).knowledgeBasePath
  if (!path) throw new Error('This connection has no knowledge base folder')
  return new KnowledgeBase(path)
}

const FILES_GROUP = 'Files'

/** Czech/European exports: `;` separated with decimal commas, which DuckDB's sniffer reads as text. */
async function csvOptions(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(64 * 1024), 0, 64 * 1024, 0)
    const sample = buffer.subarray(0, bytesRead).toString('utf8')
    if (detectDelimiter(sample) !== ';') return ''
    return /;-?\d+,\d+(;|\r?\n|$)/.test(sample) ? ", decimal_separator = ','" : ''
  } finally {
    await handle.close()
  }
}

export async function ensureConnected(id: string) {
  if (!db.isOpen(id)) await db.connect(connections.getConnection(id))
}

const FORMAT_NAMES: Record<ExportFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  jsonl: 'JSON Lines',
  sql: 'SQL',
  markdown: 'Markdown',
  xlsx: 'Excel',
}

async function askSavePath(format: ExportFormat, defaultName: string): Promise<string | null> {
  const ext = EXPORT_EXTENSIONS[format]
  const window = BrowserWindow.getFocusedWindow()
  const options = {
    title: 'Export',
    defaultPath: `${defaultName.replace(/[\\/:*?"<>|]/g, '_')}.${ext}`,
    filters: [{ name: FORMAT_NAMES[format], extensions: [ext] }],
  }
  const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}


/** How an agent starts this app as a stdio MCP server. */
function mcpLaunch(): McpLaunch {
  return {
    command: process.execPath,
    args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--mcp'],
  }
}
export const api: MastermindApi = {
  async getAppInfo() {
    return {
      version: app.getVersion(),
      platform: process.platform,
      portable: isPortable,
      dataDir: app.getPath('userData'),
      // Linux: Chromium's SUID sandbox check runs before any app code; headless MCP mode doesn't need it.
      mcpCommand: mcpLaunch(),
      managed: managed()?.info,
    }
  },
  async getSettings() {
    return getSettings()
  },
  async updateSettings(patch) {
    const next = updateSettings(patch)
    if (patch.language) buildMenu()
    if (patch.mcp) await applyMcpHttp()
    return next
  },

  async listConnections() {
    return connections.listConnections()
  },
  async saveConnection(config) {
    const saved = connections.saveConnection(config)
    // Reconnect with new settings next time it's used.
    if (db.isOpen(saved.id)) await db.disconnect(saved.id)
    return saved
  },
  async setExplorerPrefs(id, prefs) {
    connections.setExplorerPrefs(id, prefs)
  },
  async deleteConnection(id) {
    await db.disconnect(id)
    connections.deleteConnection(id)
    for (const d of library.listDiagrams(id)) library.deleteDiagram(d.id)
    for (const c of library.listChangeSets(id)) library.deleteChangeSet(c.id)
    for (const d of library.listDashboards(id)) library.deleteDashboard(d.id)
  },
  async duplicateConnection(id) {
    return connections.duplicateConnection(id)
  },
  async testConnection(config) {
    return db.test(config as ConnectionConfig)
  },
  async connect(id) {
    const config = connections.getConnection(id)
    const serverInfo = await db.connect(config)
    connections.touchConnection(id)
    return { serverInfo }
  },
  async disconnect(id) {
    await db.disconnect(id)
  },
  async isConnected(id) {
    return db.isOpen(id)
  },
  async parseConnectionString(text) {
    return parseConnectionString(text)
  },
  async mcpHttpStatus() {
    return mcpHttpStatus()
  },
  async backupDatabase(connectionId) {
    return backupDatabase(connectionId)
  },
  async restoreDatabase(connectionId) {
    return restoreDatabase(connectionId)
  },
  async installUpdate() {
    await installUpdate()
  },
  async teamStatus() {
    return teamStatus()
  },
  async setTeamFolder(path) {
    if (path === undefined) {
      const window = BrowserWindow.getFocusedWindow()
      const options = { title: 'Team folder', properties: ['openDirectory' as const, 'createDirectory' as const] }
      const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return teamStatus()
      path = r.filePaths[0]
    }
    return setTeamFolder(path)
  },
  async addConnectionToTeam(id) {
    const dir = teamDir()
    if (!dir) throw new Error('Choose a team folder first (Settings → General)')
    writeTeamConnection(dir, connections.getConnection(id))
    await reloadTeam()
  },
  async removeConnectionFromTeam(id) {
    const dir = teamDir()
    if (!dir) return
    removeTeamConnection(dir, id)
    await reloadTeam()
  },
  async mcpClients() {
    return mcpClientStatuses()
  },
  async addToMcpClient(id) {
    return addToMcpClient(id, mcpLaunch())
  },
  async exportHistory(connectionId) {
    const window = BrowserWindow.getFocusedWindow()
    const options = { title: 'Export history', defaultPath: 'db-mastermind-history.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] }
    const r = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    const names = new Map(connections.listConnections().map((c) => [c.id, c.name]))
    const csv = (v: unknown) => (v === undefined || v === null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v))
    const lines = ['executed_at,connection,source,duration_ms,rows,error,sql']
    for (const h of library.listHistory(connectionId, undefined, Number.MAX_SAFE_INTEGER).reverse()) {
      lines.push([h.executedAt, names.get(h.connectionId) ?? h.connectionId, h.source ?? 'editor', h.durationMs, h.rowCount, h.error, h.sql].map(csv).join(','))
    }
    // BOM so Excel opens UTF-8 (Czech characters) correctly.
    await writeFile(r.filePath, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8')
    return r.filePath
  },
  async importConnections(source) {
    return importConnections(source)
  },
  async exportConnections(ids) {
    return exportConnections(ids)
  },

  async createSampleDatabase() {
    const dir = join(app.getPath('userData'), 'sample')
    const file = join(dir, 'coffee-shop.db')
    const kbDir = join(dir, 'coffee-shop-knowledge')
    const existing = connections.listConnections().find((c) => c.driver === 'sqlite' && c.filePath === file)
    if (existing && existsSync(file)) return existing.id
    await mkdir(kbDir, { recursive: true })
    await rm(file, { force: true })
    const sample = new DatabaseSync(file)
    try {
      sample.exec('BEGIN')
      for (const sql of sampleDatabaseSql()) sample.exec(sql)
      sample.exec('COMMIT')
    } finally {
      sample.close()
    }
    for (const [name, content] of Object.entries(SAMPLE_KNOWLEDGE)) await writeFile(join(kbDir, name), content, 'utf8')
    const saved = connections.saveConnection({
      id: existing?.id ?? '',
      name: 'Demo coffee shop',
      driver: 'sqlite',
      filePath: file,
      knowledgeBasePath: kbDir,
      color: '#0f9f6e',
      group: 'Examples',
    })
    return saved.id
  },

  async getSchema(connectionId, refresh) {
    await ensureConnected(connectionId)
    return db.schema(connectionId, refresh)
  },
  async listDatabases(connectionId) {
    await ensureConnected(connectionId)
    return db.driver(connectionId).listDatabases()
  },

  async runQuery(request) {
    await ensureConnected(request.connectionId)
    const outcomes = await track(request.runId, (signal) =>
      db.runScript(request.connectionId, request.sql, {
        session: request.session,
        maxRows: request.maxRows ?? getSettings().maxResultRows,
        continueOnError: request.continueOnError,
        parameterValues: request.parameterValues,
        signal,
      }),
    )
    for (const o of outcomes) {
      library.addHistory({
        connectionId: request.connectionId,
        sql: o.sql,
        executedAt: new Date().toISOString(),
        durationMs: o.durationMs,
        rowCount: o.results?.reduce((n, r) => n + r.rowCount, 0),
        error: o.error?.message,
      })
    }
    return outcomes
  },
  async explainQuery(connectionId, sql, analyze) {
    await ensureConnected(connectionId)
    return explainQuery(db, connectionId, sql, analyze)
  },
  async listActivity(connectionId) {
    await ensureConnected(connectionId)
    return listActivity(db, connectionId)
  },
  async listPrincipals(connectionId) {
    await ensureConnected(connectionId)
    return listPrincipals(db, connectionId)
  },
  async listGrants(connectionId, principal) {
    await ensureConnected(connectionId)
    return listGrants(db, connectionId, principal)
  },
  async stopSession(connectionId, sessionId, mode) {
    await ensureConnected(connectionId)
    if (connections.getConnection(connectionId).readOnly) throw new Error('This connection is read-only')
    await stopSession(db, connectionId, sessionId, mode)
  },
  async exportDataDictionary(connectionId, format, schemas) {
    await ensureConnected(connectionId)
    const config = connections.getConnection(connectionId)
    const snapshot = await db.schema(connectionId)
    const notes = new Map<string, DictionaryNote[]>()
    if (config.knowledgeBasePath) {
      const kb = knowledge(connectionId)
      for (const file of await kb.list().catch(() => [])) {
        if (!file.tables.length) continue
        const doc = await kb.read(file.path).catch(() => null)
        if (!doc?.body.trim()) continue
        for (const table of file.tables) {
          const key = table.toLowerCase()
          notes.set(key, [...(notes.get(key) ?? []), { title: doc.title, body: doc.body }])
        }
      }
    }
    const ext = format === 'html' ? 'html' : 'md'
    const window = BrowserWindow.getFocusedWindow()
    const options = {
      title: 'Data dictionary',
      defaultPath: `${config.name.replace(/[\\/:*?"<>|]/g, '_')} - data dictionary.${ext}`,
      filters: [{ name: format === 'html' ? 'HTML' : 'Markdown', extensions: [ext] }],
    }
    const result = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const info = db.serverInfo(connectionId)
    const content = buildDataDictionary(snapshot, {
      format,
      schemas,
      notes,
      title: config.name,
      subtitle: [info ? `${info.product} ${info.version}`.trim() : config.driver, snapshot.database].filter(Boolean).join(' · '),
    })
    await writeFile(result.filePath, content, 'utf8')
    return result.filePath
  },
  async openModelFile(path, defaultDir) {
    if (!path) {
      const window = BrowserWindow.getFocusedWindow()
      const options = { title: 'Open model', defaultPath: defaultDir, properties: ['openFile' as const], filters: [{ name: 'DBML', extensions: ['dbml'] }] }
      const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return null
      path = r.filePaths[0]
    }
    if (extname(path).toLowerCase() !== '.dbml') throw new Error('Models are .dbml files')
    return { path, text: await readFile(path, 'utf8') }
  },
  async saveSqlFile(text, name, defaultDir) {
    const window = BrowserWindow.getFocusedWindow()
    const options = { title: 'Save SQL', defaultPath: defaultDir ? join(defaultDir, name) : name, filters: [{ name: 'SQL', extensions: ['sql'] }] }
    const r = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    if (extname(r.filePath).toLowerCase() !== '.sql') throw new Error('Scripts are saved as .sql files')
    await writeFile(r.filePath, text, 'utf8')
    return r.filePath
  },
  async importDdlFile() {
    const window = BrowserWindow.getFocusedWindow()
    const options = { title: 'Import SQL DDL or a Prisma schema', properties: ['openFile' as const], filters: [{ name: 'SQL DDL or Prisma schema', extensions: ['sql', 'ddl', 'txt', 'prisma'] }] }
    const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (r.canceled || !r.filePaths[0]) return null
    const source = await readFile(r.filePaths[0], 'utf8')
    if (extname(r.filePaths[0]).toLowerCase() === '.prisma' || /^\s*(model|datasource|generator)\s+\w+\s*\{/m.test(source)) {
      const prisma = tablesFromPrisma(source)
      return { path: r.filePaths[0], dbml: toDbml(prisma.tables, { enums: prisma.enums }), skipped: prisma.errors.map((e) => ({ sql: '', error: e.message })) }
    }
    const { tables, skipped } = await tablesFromDdl(source)
    return { path: r.filePaths[0], dbml: toDbml(tables, { defaultSchema: 'main' }), skipped }
  },
  async saveModelFile(text, path, defaultDir) {
    if (!path) {
      const window = BrowserWindow.getFocusedWindow()
      const options = { title: 'Save model', defaultPath: defaultDir ? join(defaultDir, 'model.dbml') : 'model.dbml', filters: [{ name: 'DBML', extensions: ['dbml'] }] }
      const r = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
      if (r.canceled || !r.filePath) return null
      path = r.filePath
    }
    // Only model files: the renderer must not be able to write anything else.
    if (extname(path).toLowerCase() !== '.dbml') throw new Error('Models are saved as .dbml files')
    await writeFile(path, text, 'utf8')
    return path
  },
  async queryFile(path) {
    if (!path) {
      const window = BrowserWindow.getFocusedWindow()
      const options = {
        title: 'Query a file with SQL',
        properties: ['openFile' as const],
        filters: [
          { name: 'Data files', extensions: ['csv', 'tsv', 'txt', 'parquet', 'json', 'jsonl', 'ndjson', 'xlsx'] },
          { name: 'All files', extensions: ['*'] },
        ],
      }
      const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      if (r.canceled || !r.filePaths[0]) return null
      path = r.filePaths[0]
    }
    // One in-memory DuckDB connection serves all ad-hoc file queries.
    const existing = connections.listConnections().find((c) => c.driver === 'duckdb' && !c.filePath && c.group === FILES_GROUP)
    const connection = existing ?? connections.saveConnection({ id: '', name: 'Files (DuckDB)', driver: 'duckdb', group: FILES_GROUP })
    const literal = `'${path.replaceAll("'", "''")}'`
    const ext = extname(path).slice(1).toLowerCase()
    const reader =
      ext === 'parquet' ? `read_parquet(${literal})`
      : ext === 'json' || ext === 'jsonl' || ext === 'ndjson' ? `read_json(${literal})`
      : ext === 'xlsx' ? `read_xlsx(${literal})`
      : `read_csv(${literal}${await csvOptions(path)})`
    return { connectionId: connection.id, sql: `SELECT *\nFROM ${reader}\nLIMIT 1000;\n`, title: basename(path) }
  },
  async compareData(request) {
    await Promise.all([ensureConnected(request.source.connectionId), ensureConnected(request.target.connectionId)])
    return compareTableData(db, request)
  },
  async cancelQuery(runId) {
    running.get(runId)?.abort()
  },
  async releaseSession(connectionId, session) {
    await db.releaseSession(connectionId, session)
  },

  async fetchTable(request) {
    await ensureConnected(request.connectionId)
    return track(request.runId, (signal) =>
      db.fetchTable(request.connectionId, {
        table: request.table,
        filter: request.filter,
        sort: request.sort,
        limit: request.limit,
        offset: request.offset,
        signal,
      }),
    )
  },
  async countTable(request) {
    await ensureConnected(request.connectionId)
    return track(request.runId, (signal) =>
      db.countTable(request.connectionId, { table: request.table, filter: request.filter, signal }),
    )
  },
  async importPreview(path, delimiter) {
    const data = await readImportFile(path, delimiter)
    return { format: data.format, delimiter: data.delimiter, encoding: data.encoding, rows: data.rows.slice(0, 51), totalRows: data.rows.length }
  },
  async importFile(request) {
    await ensureConnected(request.connectionId)
    const data = await readImportFile(request.path, request.delimiter)
    const rows = request.hasHeader ? data.rows.slice(1) : data.rows
    const used = request.mapping.map((target, i) => ({ target, i })).filter((m): m is { target: string; i: number } => !!m.target)
    if (!used.length) throw new Error('Map at least one column')
    const dialect = db.driver(request.connectionId).dialect
    const statements = buildBatchInserts(
      request.table,
      used.map((m) => m.target),
      rows.map((r) => used.map((m) => r[m.i] ?? null)),
      dialect,
      { emptyAsNull: request.emptyAsNull },
    )
    if (request.replace) statements.unshift({ sql: `DELETE FROM ${qualify(dialect, request.table)}`, params: [] })
    await db.transactionRaw(request.connectionId, statements)
    library.addHistory({
      connectionId: request.connectionId,
      sql: `-- Imported ${rows.length} rows from ${basename(request.path)} into ${qualify(dialect, request.table)}`,
      executedAt: new Date().toISOString(),
      durationMs: 0,
      rowCount: rows.length,
      source: 'import',
    })
    return rows.length
  },
  async previewChanges(connectionId, table, changes) {
    const dialect = getDialect(connections.getConnection(connectionId).driver)
    return buildChangeStatements(table, changes, dialect).map((q) => inlineParams(q, dialect))
  },
  async applyChanges(connectionId, table, changes) {
    await ensureConnected(connectionId)
    const affected = await db.applyChanges(connectionId, table, changes)
    const dialect = getDialect(connections.getConnection(connectionId).driver)
    for (const q of buildChangeStatements(table, changes, dialect)) {
      library.addHistory({
        connectionId,
        sql: inlineParams(q, dialect),
        executedAt: new Date().toISOString(),
        durationMs: 0,
        source: 'grid',
      })
    }
    return affected
  },

  async listHistory(connectionId, search, limit) {
    return library.listHistory(connectionId, search, limit)
  },
  async clearHistory(connectionId) {
    library.clearHistory(connectionId)
  },
  async listSavedQueries() {
    return library.listSavedQueries()
  },
  async saveQuery(query) {
    return library.saveQuery(query)
  },
  async deleteSavedQuery(id) {
    library.deleteSavedQuery(id)
  },
  async listDashboards(connectionId) {
    return library.listDashboards(connectionId)
  },
  async saveDashboard(dashboard) {
    return library.saveDashboard(dashboard)
  },
  async deleteDashboard(id) {
    library.deleteDashboard(id)
  },
  async listDiagrams(connectionId) {
    return library.listDiagrams(connectionId)
  },
  async saveDiagram(diagram) {
    return library.saveDiagram(diagram)
  },
  async deleteDiagram(id) {
    library.deleteDiagram(id)
  },
  async listChangeSets(connectionId) {
    return library.listChangeSets(connectionId)
  },
  async saveChangeSet(changeSet) {
    return library.saveChangeSet(changeSet)
  },
  async deleteChangeSet(id) {
    library.deleteChangeSet(id)
  },

  async exportResult(request) {
    const path = await askSavePath(request.format, request.defaultName)
    if (!path) return null
    const dialect = request.connectionId ? getDialect(connections.getConnection(request.connectionId).driver) : undefined
    const writer = createExportWriter(path, request.format, request.result.fields, { tableName: request.tableName, dialect })
    await writer.writeRows(request.result.rows)
    await writer.close()
    return path
  },
  async exportTable(request) {
    const path = await askSavePath(request.format, request.table.name)
    if (!path) return null
    await ensureConnected(request.connectionId)
    const dialect = db.driver(request.connectionId).dialect
    const batch = 5000
    let offset = 0
    let writer: ReturnType<typeof createExportWriter> | undefined
    // Page through the table so exports of any size use constant memory.
    for (;;) {
      const page = await db.fetchTable(request.connectionId, {
        table: request.table,
        filter: request.filter,
        sort: request.sort,
        limit: batch,
        offset,
      })
      writer ??= createExportWriter(path, request.format, page.result.fields, {
        tableName: qualify(dialect, request.table),
        dialect,
      })
      await writer.writeRows(page.result.rows)
      offset += page.result.rows.length
      if (page.result.rows.length < batch) break
    }
    await writer?.close()
    return path
  },
  async exportQuery(request) {
    const path = await askSavePath(request.format, request.defaultName)
    if (!path) return null
    await ensureConnected(request.connectionId)
    const dialect = db.driver(request.connectionId).dialect
    let writer: ReturnType<typeof createExportWriter> | undefined
    let rows = 0
    try {
      for await (const batch of db.streamQuery(request.connectionId, request.sql.trim().replace(/;\s*$/, ''))) {
        writer ??= createExportWriter(path, request.format, batch.fields, { tableName: request.defaultName, dialect })
        await writer.writeRows(batch.rows)
        rows += batch.rows.length
      }
    } finally {
      await writer?.close()
    }
    return { path, rows }
  },
  async pickFile(options) {
    const window = BrowserWindow.getFocusedWindow()
    if (options.save) {
      const r = await dialog.showSaveDialog(window!, { title: options.title, filters: options.filters, defaultPath: options.defaultPath })
      return r.canceled ? null : (r.filePath ?? null)
    }
    const r = await dialog.showOpenDialog(window!, {
      title: options.title,
      filters: options.filters,
      defaultPath: options.defaultPath,
      properties: ['openFile'],
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  async pickDirectory(title) {
    const window = BrowserWindow.getFocusedWindow()
    const r = await dialog.showOpenDialog(window!, { title, properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  },
  async readTextFile(path) {
    return readFile(path, 'utf8')
  },
  async openExternal(url) {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  },
  async showItemInFolder(path) {
    shell.showItemInFolder(path)
  },

  async kbEnsureFolder(connectionId) {
    const config = connections.getConnection(connectionId)
    if (config.knowledgeBasePath) return config.knowledgeBasePath
    const folder = join(app.getPath('userData'), 'knowledge', `${config.name.replace(/[^\p{L}\p{N}._-]+/gu, '_')}-${config.id.slice(0, 6)}`)
    await mkdir(folder, { recursive: true })
    connections.saveConnection({ ...config, knowledgeBasePath: folder })
    return folder
  },
  async kbIssues(connectionId) {
    await ensureConnected(connectionId)
    return staleKnowledge(knowledge(connectionId), await db.schema(connectionId))
  },
  async kbList(connectionId) {
    return knowledge(connectionId).list()
  },
  async kbRead(connectionId, path) {
    return (await knowledge(connectionId).read(path)).content
  },
  async kbWrite(connectionId, path, content) {
    const saved = await knowledge(connectionId).write(path, content)
    // Relations may have changed: refresh lazily.
    if (db.isOpen(connectionId)) void db.schema(connectionId, true).catch(() => {})
    return saved
  },
  async kbDelete(connectionId, path) {
    const kb = knowledge(connectionId)
    await rm(resolveInside(kb.root, path))
  },
  async listAiModels(provider) {
    return listModels(provider)
  },
  async testAiProvider(provider) {
    return testProvider(provider)
  },
  async aiChat(request) {
    // Runs in the background; progress arrives as 'ai:event' messages.
    startChat(request)
  },
  async aiWriteSql(connectionId, request, sql, selection) {
    const config = connections.getConnection(connectionId)
    if (config.aiEnabled === false) throw new Error('AI is turned off for this connection')
    await ensureConnected(connectionId)
    const snapshot = await db.schema(connectionId)
    let notes: string | undefined
    if (config.knowledgeBasePath) {
      const hits = await knowledge(connectionId).search(request, 3).catch(() => [])
      notes = hits.map((h) => `${h.title}: ${h.excerpt}`).join('\n') || undefined
    }
    const { system, prompt } = writeSqlPrompt({ driver: config.driver, dialectName: DIALECT_NAMES[config.driver], request, schema: schemaOverview(snapshot), sql, selection, notes })
    return extractSql(await completeText(system, prompt))
  },
  async aiSuggestFilter(connectionId, table, request) {
    const config = connections.getConnection(connectionId)
    if (config.aiEnabled === false) throw new Error('AI is turned off for this connection')
    await ensureConnected(connectionId)
    const info = await db.findTable(connectionId, table)
    if (!info) throw new Error('Table not found')
    const { system, prompt } = filterPrompt(info, request)
    return sanitizeFilter(extractJson(await completeText(system, prompt)), info)
  },
  async cancelAiChat(chatId) {
    cancelChat(chatId)
  },
  async respondAiApproval(id, answer) {
    respondApproval(id, answer)
  },

  async loadWorkspace() {
    return library.loadWorkspace()
  },
  async saveWorkspace(state) {
    library.saveWorkspace(state)
  },
}
