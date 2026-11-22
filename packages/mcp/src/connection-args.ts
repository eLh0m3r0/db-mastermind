import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseConnectionString, type ConnectionConfig } from '@dbmastermind/core'

/** `${ENV_VAR}` placeholders, so passwords stay out of command lines and files. */
export const expandEnv = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? '')

interface FileConnection extends Partial<ConnectionConfig> {
  url?: string
  knowledgeBase?: string
}

/** `--allow-files <file-or-folder>` for the connection before it (DuckDB): what SQL nobody confirmed may read. */
export function allowFiles(connection: ConnectionConfig | undefined, path: string): void {
  if (!connection) throw new Error('--allow-files must follow --url')
  if (connection.driver !== 'duckdb') throw new Error('--allow-files is for DuckDB connections')
  connection.files = [...(connection.files ?? []), resolve(path)]
}

/** A connection from `--url` (postgres://…, JDBC, ADO.NET), named after its host and database. */
export function connectionFromUrl(url: string, id: string): ConnectionConfig {
  const parsed = parseConnectionString(expandEnv(url))
  const name = parsed.driver === 'sqlite' ? (parsed.filePath ?? 'sqlite') : `${parsed.host ?? 'localhost'}${parsed.database ? `/${parsed.database}` : ''}`
  return { ...parsed, id, name } as ConnectionConfig
}

/** Connections from a `--config` JSON file: [{ name, url | driver/host/…, knowledgeBase, readOnly }]. */
export function connectionsFromFile(path: string, already = 0): ConnectionConfig[] {
  const list = JSON.parse(expandEnv(readFileSync(path, 'utf8'))) as FileConnection[]
  return list.map((item, i) => {
    const base = item.url ? parseConnectionString(item.url) : {}
    return {
      ...base,
      ...item,
      driver: (item.driver ?? (base as ConnectionConfig).driver)!,
      id: item.id ?? `c${already + i + 1}`,
      name: item.name ?? `connection ${already + i + 1}`,
      knowledgeBasePath: item.knowledgeBase ?? item.knowledgeBasePath,
      // DuckDB: files and folders agents may read (relative to the config file).
      ...(item.files ? { files: item.files.map((f) => resolve(dirname(path), expandEnv(f))) } : {}),
    } as ConnectionConfig
  })
}
