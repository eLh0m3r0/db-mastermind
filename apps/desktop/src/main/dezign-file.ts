import { readdir, readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { app } from 'electron'
import { assembleDezignProject, readDezign, toDbml } from '@dbmastermind/core'
import type { OpenedModelFile } from '@shared/api'

// Size of a table in the diagram (DiagramView): DeZign's layout is spread to fit it.
const NODE = { width: 240, header: 32, row: 22 }

/** The parts of a folder project the model needs; archived versions (hundreds of MB) are left alone. */
async function projectFiles(projectFile: string): Promise<{ path: string; text: string }[]> {
  const dir = dirname(projectFile)
  const paths: string[] = []
  for (const name of await readdir(dir)) {
    if (extname(name).toLowerCase() === '.dds' || join(dir, name) === projectFile) paths.push(name)
  }
  for (const name of await readdir(dir, { withFileTypes: true })) {
    if (!name.isDirectory() || !['data dictionary', 'diagrams'].includes(name.name.toLowerCase())) continue
    for (const entry of await readdir(join(dir, name.name), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.xml') paths.push(join(entry.parentPath, entry.name).slice(dir.length + 1))
    }
  }
  const out: { path: string; text: string }[] = []
  // A large project has thousands of small files: read them a batch at a time, not all at once.
  for (let i = 0; i < paths.length; i += 64) {
    out.push(...(await Promise.all(paths.slice(i, i + 64).map(async (path) => ({ path, text: await readFile(join(dir, path), 'latin1') })))))
  }
  return out
}

/** A DeZign for Databases model (`.dez`, or the `.dezproj` of a folder project) as a DBML model. The file is only read. */
export async function openDezignModel(path: string): Promise<OpenedModelFile> {
  const binary = extname(path).toLowerCase() === '.dezproj' ? assembleDezignProject(await projectFiles(path)) : await readFile(path, 'latin1')
  // DeZign writes the Windows code page of the machine it ran on; the user's language is the best guess for short texts.
  const centralEuropean = /^(cs|sk|pl|hu|sl|hr|ro|sq)\b/i.test(app.getLocale())
  const model = readDezign(binary, { node: NODE, fallbackEncoding: centralEuropean ? 'windows-1250' : 'windows-1252' })
  return {
    path,
    text: toDbml(model.tables),
    imported: { from: 'dezign', tables: model.tables.length, positions: model.positions, leftOut: model.leftOut },
  }
}
