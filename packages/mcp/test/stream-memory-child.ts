// A child process for stream-memory.integration.test.ts: streams one big read to a CSV file the way `dbm query` or
// the desktop app's "export every row" does, and prints its own peak memory.
import { runDbm } from '../src/dbm'
import { DatabaseService, type ConnectionConfig } from '@dbmastermind/core'

const [mode, driver, rowsText, out] = process.argv.slice(2) as [string, string, string, string]
const rows = Number(rowsText)
const CONFIG: Record<string, ConnectionConfig> = {
  postgres: { id: 'pg', name: 'pg', driver: 'postgres', host: '127.0.0.1', port: 54329, user: 'postgres', password: 'mastermind', database: 'mastermind', readOnly: true },
  mssql: { id: 'ms', name: 'ms', driver: 'mssql', host: '127.0.0.1', port: 14339, user: 'sa', password: 'Mastermind!2026', database: 'master', readOnly: true, options: { trustServerCertificate: true } },
}
const URL: Record<string, string> = {
  postgres: 'postgres://postgres:mastermind@127.0.0.1:54329/mastermind',
  mssql: `sqlserver://sa:${encodeURIComponent('Mastermind!2026')}@127.0.0.1:14339/master?trustServerCertificate=true`,
}
const SQL: Record<string, string> = {
  postgres: `SELECT g AS id, md5(g::text) AS v FROM generate_series(1, ${rows}) g`,
  mssql: `SELECT TOP (${rows}) a.object_id AS id, b.name AS v FROM sys.all_columns a CROSS JOIN sys.all_columns b`,
}

let written = 0
if (mode === 'dbm') {
  let stderr = ''
  const code = await runDbm(['query', '--url', URL[driver]!, '--format', 'csv', '--out', out, SQL[driver]!], { stdout: () => {}, stderr: (t) => void (stderr += t) })
  if (code !== 0) throw new Error(stderr)
  written = Number(/(\d+) rows?/.exec(stderr)?.[1] ?? -1)
} else {
  const db = new DatabaseService()
  await db.connect(CONFIG[driver]!)
  // (The desktop app's own writer; loaded by path, as this package's typecheck doesn't know the app's aliases.)
  const exportModule = '../../../apps/desktop/src/main/export'
  const { createExportWriter } = (await import(exportModule)) as { createExportWriter: (path: string, format: string, fields: unknown, options: object) => { writeRows(rows: unknown[][]): Promise<void>; close(): Promise<void> } }
  let writer: ReturnType<typeof createExportWriter> | undefined
  for await (const batch of db.streamQuery(CONFIG[driver]!.id, SQL[driver]!)) {
    writer ??= createExportWriter(out, 'csv', batch.fields, { tableName: 'export', dialect: db.driver(CONFIG[driver]!.id).dialect, csvDelimiter: ',' })
    await writer.writeRows(batch.rows)
    written += batch.rows.length
  }
  await writer?.close()
  await db.disconnectAll()
}
process.stdout.write(`${JSON.stringify({ rows: written, maxRssKb: process.resourceUsage().maxRSS })}\n`)
process.exit(0)
