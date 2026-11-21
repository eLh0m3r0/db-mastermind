import { open, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { FILE_LIMITS, isDrawDb, modelFormatOf, readCapped, readModelFile, toDbml, type ImportedModel } from '@dbmastermind/core'
import type { OpenedModelFile } from '@shared/api'
import { paletteIndex } from './palette'

/**
 * Models of other tools opened as a new, unsaved model: MySQL Workbench (.mwb), drawDB (.json export, .ddb),
 * Mermaid ER diagrams (.mmd, .mermaid) and Prisma schemas. The file itself is only read, never written.
 */
export const FOREIGN_MODEL = /\.(mwb|mmd|mermaid|prisma|ddb)$/i
/** A JSON file larger than this is data, never a diagram (it is not read to find out). */
const LARGEST_DIAGRAM = FILE_LIMITS.model

/** Whether a file is a model of another tool: by its extension, and for JSON by its content (a drawDB diagram). */
export async function isForeignModel(path: string): Promise<boolean> {
  if (FOREIGN_MODEL.test(path)) return true
  if (extname(path).toLowerCase() !== '.json') return false
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || !info.size || info.size > LARGEST_DIAGRAM) return false
  // A drawDB export starts with an object; a JSON data file is often an array (and then not read whole).
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(Math.min(info.size, 256))
    await handle.read(head, 0, head.length, 0)
    if (!/^\s*\{/.test(head.toString('utf8').replace(/^\ufeff/, ''))) return false
  } finally {
    await handle.close()
  }
  const text = await readCapped(path, { limit: LARGEST_DIAGRAM, what: 'a model' }).then(
    (b) => b.toString('utf8'),
    () => '',
  )
  return isDrawDb(text.replace(/^\ufeff/, ''))
}

export async function readForeignModel(path: string): Promise<ImportedModel> {
  // Only a plain file, and never more than the limit (counted while reading: a size can lie, /dev/zero has none).
  const bytes = await readCapped(path, { limit: /\.mwb$/i.test(path) ? FILE_LIMITS.mwb : FILE_LIMITS.model, what: 'a model' })
  return readModelFile(basename(path), new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
}

/** Whether a file picked for the model's Import is one of these formats (the rest is read as a SQL script). */
export function foreignFormatOf(path: string, text: string) {
  return /\.mwb$/i.test(path) ? 'mwb' : modelFormatOf(path, text)
}

const paletteColors = (colors: Record<string, string>) => Object.fromEntries(Object.entries(colors).flatMap(([key, hex]) => (paletteIndex(hex) ? [[key, paletteIndex(hex)!]] : [])))

/** What a model tab takes from another tool's model. */
export function foreignModelFile(path: string, model: ImportedModel): OpenedModelFile {
  return {
    path,
    text: toDbml(model.tables, { enums: model.enums }),
    foreign: {
      format: model.format,
      tables: model.tables.length,
      relationships: model.tables.reduce((n, t) => n + t.foreignKeys.length, 0),
      database: model.database,
      positions: model.positions,
      colors: paletteColors(model.colors),
      notes: model.notes,
      boxes: model.boxes,
      diagrams: model.diagrams.map((d) => ({ ...d, colors: paletteColors(d.colors) })),
      leftOut: model.leftOut,
    },
  }
}

export async function openForeignModel(path: string): Promise<OpenedModelFile> {
  return foreignModelFile(path, await readForeignModel(path))
}
