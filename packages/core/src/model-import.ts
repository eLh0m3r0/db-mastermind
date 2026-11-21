import type { DriverId } from './types.js'
import { emptyImport, type ImportedModel, type ModelFormat } from './imported-model.js'
import { tablesFromPrisma } from './prisma.js'
import { tablesFromMermaid } from './mermaid.js'
import { isDrawDb, tablesFromDrawDb } from './drawdb.js'
import { tablesFromMwb } from './mwb.js'
import { checkSize, cleanImportedModel, FILE_LIMITS } from './untrusted.js'

export * from './imported-model.js'

/** The format of a model file, from its name and its content; undefined when it is none of them. */
export function modelFormatOf(name: string, head: string): ModelFormat | undefined {
  const ext = /\.([^.\\/]+)$/.exec(name)?.[1]?.toLowerCase() ?? ''
  if (ext === 'mwb') return 'mwb'
  if (ext === 'prisma') return 'prisma'
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid'
  if (ext === 'ddb') return 'drawdb'
  if (ext === 'json') return isDrawDb(head) ? 'drawdb' : undefined
  if (ext === 'md' || ext === 'markdown') return /```\s*mermaid[\s\S]*?\berDiagram\b/.test(head) ? 'mermaid' : undefined
  // A script picked in the Import dialog may be any of them: the content says which.
  if (/^\s*(?:%%.*\n\s*)*erDiagram\b/m.test(head) && !/\bCREATE\s+TABLE\b/i.test(head)) return 'mermaid'
  if (/^\s*(model|datasource|generator)\s+\w+\s*\{/m.test(head)) return 'prisma'
  if (/^\s*\{/.test(head) && isDrawDb(head)) return 'drawdb'
  return undefined
}

/**
 * Reads a model file of another tool. `bytes` is the file as it is (an .mwb is a zip). The file may come from
 * anybody: it is size-limited and what it names is cleaned (untrusted.ts).
 */
export function readModelFile(name: string, bytes: Uint8Array): ImportedModel {
  return cleanImportedModel(readModel(name, bytes))
}

function readModel(name: string, bytes: Uint8Array): ImportedModel {
  const file = name.split(/[\\/]/).pop() ?? name
  checkSize(file, bytes.length, /\.mwb$/i.test(name) ? FILE_LIMITS.mwb : FILE_LIMITS.model, 'a model')
  const text = () => new TextDecoder('utf-8').decode(bytes)
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  const format = isZip && /\.mwb$/i.test(name) ? 'mwb' : modelFormatOf(name, isZip ? '' : text())
  switch (format) {
    case 'mwb':
      return tablesFromMwb(bytes)
    case 'drawdb':
      return tablesFromDrawDb(text())
    case 'mermaid':
      return tablesFromMermaid(text())
    case 'prisma': {
      const source = text()
      const prisma = tablesFromPrisma(source)
      const provider = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"(\w+)"/.exec(source)?.[1]
      const database = ({ postgresql: 'postgres', postgres: 'postgres', cockroachdb: 'postgres', mysql: 'mysql', sqlserver: 'mssql', sqlite: 'sqlite' } as Record<string, DriverId>)[provider ?? '']
      return { ...emptyImport('prisma'), tables: prisma.tables, enums: prisma.enums, database, leftOut: prisma.errors.length ? { scalarLists: prisma.errors.length } : {} }
    }
    default:
      throw new Error(`${name.split(/[\\/]/).pop()} is not a model this app can read (MySQL Workbench, drawDB, Mermaid or Prisma)`)
  }
}
