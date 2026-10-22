import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import {
  buildChangeStatements,
  DatabaseService,
  getDialect,
  inlineParams,
  KnowledgeBase,
  resolveInside,
  parseConnectionString,
  qualify,
  type ConnectionConfig,
} from '@dbmastermind/core'
import type { ExportFormat, MastermindApi } from '@shared/api'
import * as connections from './connections'
import { createExportWriter, EXPORT_EXTENSIONS } from './export'
import { cancelChat, respondApproval, startChat } from './ai/assistant'
import { listModels, testProvider } from './ai/models'
import { importConnections } from './importers'
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

function knowledge(connectionId: string): KnowledgeBase {
  const path = connections.getConnection(connectionId).knowledgeBasePath
  if (!path) throw new Error('This connection has no knowledge base folder')
  return new KnowledgeBase(path)
}

async function ensureConnected(id: string) {
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

export const api: MastermindApi = {
  async getAppInfo() {
    return {
      version: app.getVersion(),
      platform: process.platform,
      portable: isPortable,
      dataDir: app.getPath('userData'),
      // Linux: Chromium's SUID sandbox check runs before any app code; headless MCP mode doesn't need it.
      mcpCommand: {
        command: process.execPath,
        args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...(process.platform === 'linux' ? ['--no-sandbox'] : []), '--mcp'],
      },
    }
  },
  async getSettings() {
    return getSettings()
  },
  async updateSettings(patch) {
    return updateSettings(patch)
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
  async deleteConnection(id) {
    await db.disconnect(id)
    connections.deleteConnection(id)
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
  async importConnections(source) {
    return importConnections(source)
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
