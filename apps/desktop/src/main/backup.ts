import { spawn } from 'node:child_process'
import { createReadStream, statSync } from 'node:fs'
import { BrowserWindow, dialog } from 'electron'
import type { BackupResult } from '@shared/api'
import { db, ensureConnected } from './api'
import { getConnection } from './connections'
import { backupFileType, backupPlan, CURRENT_DATABASE, findTool, restorePlan, toolInstallHint, type BackupPlan } from './backup-commands'

/** Fallback tool names: MariaDB clients before 11 only ship the mysql* names. */
const ALTERNATIVES: Record<string, string[]> = { 'mariadb-dump': ['mysqldump'], mariadb: ['mysql'] }

function runTool(plan: Extract<BackupPlan, { kind: 'tool' }>): Promise<void> {
  const path = [plan.tool, ...(ALTERNATIVES[plan.tool] ?? [])].map((t) => findTool(t)).find(Boolean)
  if (!path) throw new Error(`${plan.tool} was not found. ${toolInstallHint(plan.tool)}.`)
  return new Promise((resolve, reject) => {
    const child = spawn(path, plan.args, { env: { ...process.env, ...plan.env }, stdio: [plan.stdinFile ? 'pipe' : 'ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr!.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)))
    if (plan.stdinFile) createReadStream(plan.stdinFile).on('error', reject).pipe(child.stdin!)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `${plan.tool} exited with code ${code}`))))
  })
}

async function runPlan(connectionId: string, plan: BackupPlan): Promise<void> {
  if (plan.kind === 'tool') return runTool(plan)
  if (plan.kind !== 'sql') return
  await ensureConnected(connectionId)
  let sql = plan.sql
  if (sql.includes(CURRENT_DATABASE)) {
    const [outcome] = await db.runScript(connectionId, 'SELECT current_database()')
    sql = sql.replaceAll(CURRENT_DATABASE, String(outcome?.results?.[0]?.rows[0]?.[0] ?? 'memory'))
  }
  const outcomes = await db.runScript(connectionId, sql)
  const failed = outcomes.find((o) => o.error)
  if (failed?.error) throw new Error(failed.error.message)
}

async function askSave(options: Electron.SaveDialogOptions): Promise<string | undefined> {
  const window = BrowserWindow.getFocusedWindow()
  const r = window ? await dialog.showSaveDialog(window, options) : await dialog.showSaveDialog(options)
  return r.canceled ? undefined : r.filePath
}

async function askOpen(options: Electron.OpenDialogOptions): Promise<string | undefined> {
  const window = BrowserWindow.getFocusedWindow()
  const r = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
  return r.canceled ? undefined : r.filePaths[0]
}

export async function backupDatabase(connectionId: string): Promise<BackupResult | null> {
  const c = getConnection(connectionId)
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')
  const custom = backupFileType(c.driver, 'custom')
  const plain = backupFileType(c.driver, 'sql')
  const filters = custom.ext === plain.ext ? [{ name: custom.name, extensions: [custom.ext] }] : [{ name: custom.name, extensions: [custom.ext] }, { name: plain.name, extensions: [plain.ext] }]
  const safeName = `${c.name.replace(/[\\/:*?"<>|]/g, '_')}-${stamp}.${custom.ext}`
  // SQL Server writes on the server: suggest a server-side path instead of asking for a local file.
  if (c.driver === 'mssql' || c.driver === 'clickhouse') {
    const plan = backupPlan(c, c.driver === 'mssql' ? `C:\\Backup\\${safeName}` : safeName)
    return { sql: plan.kind === 'server-sql' ? plan.sql : '' }
  }
  const file = await askSave({ title: 'Back up database', defaultPath: safeName, filters })
  if (!file) return null
  const plan = backupPlan(c, file, file.toLowerCase().endsWith(`.${plain.ext}`) && plain.ext !== custom.ext ? 'sql' : 'custom')
  await runPlan(connectionId, plan)
  return { path: file, bytes: statSync(file).size }
}

export async function restoreDatabase(connectionId: string): Promise<BackupResult | null> {
  const c = getConnection(connectionId)
  if (c.readOnly) throw new Error('This connection is read-only')
  if (c.driver === 'mssql') {
    const plan = restorePlan(c, `C:\\Backup\\${c.database ?? 'database'}.bak`)
    return { sql: plan.kind === 'server-sql' ? plan.sql : '' }
  }
  const type = backupFileType(c.driver, 'custom')
  const file = await askOpen({ title: 'Restore database', properties: ['openFile'], filters: [{ name: 'Backups', extensions: [...new Set([type.ext, 'sql', 'dump', 'backup'])] }] })
  if (!file) return null
  const plan = restorePlan(c, file)
  await runPlan(connectionId, plan)
  return { path: file, bytes: statSync(file).size }
}
