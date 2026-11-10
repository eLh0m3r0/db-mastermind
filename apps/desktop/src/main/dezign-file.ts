import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { app } from 'electron'
import { assembleDezignProject, parseDbml, readDezign, saveToDezign, toDbml, type DezignFile, type TableInfo } from '@dbmastermind/core'
import type { DezignSaveOutcome, DezignSaveRequest, OpenedModelFile } from '@shared/api'
import { dataPath } from './storage'

// Size of a table in the diagram (DiagramView): DeZign's layout is spread to fit it.
const NODE = { width: 240, header: 32, row: 22 }
const isProject = (path: string) => extname(path).toLowerCase() === '.dezproj'

/** The parts of a folder project the model needs; archived versions (hundreds of MB) are left alone. */
async function projectFiles(projectFile: string): Promise<DezignFile[]> {
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
  const out: DezignFile[] = []
  // A large project has thousands of small files: read them a batch at a time, not all at once.
  for (let i = 0; i < paths.length; i += 64) {
    out.push(...(await Promise.all(paths.slice(i, i + 64).map(async (path) => ({ path, text: await readFile(join(dir, path), 'latin1') })))))
  }
  return out
}

const load = async (path: string): Promise<DezignFile[]> => (isProject(path) ? projectFiles(path) : [{ path: basename(path), text: await readFile(path, 'latin1') }])

function read(files: DezignFile[], project: boolean) {
  // DeZign writes the Windows code page of the machine it ran on; the user's language is the best guess for short texts.
  const centralEuropean = /^(cs|sk|pl|hu|sl|hr|ro|sq)\b/i.test(app.getLocale())
  const fallbackEncoding = centralEuropean ? ('windows-1250' as const) : ('windows-1252' as const)
  return { fallbackEncoding, model: readDezign(project ? assembleDezignProject(files) : files[0]!.text, { node: NODE, fallbackEncoding }) }
}

const fingerprint = (dbml: string) => createHash('sha256').update(dbml).digest('hex')
const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables

/** A DeZign for Databases model (`.dez`, or the `.dezproj` of a folder project) as a DBML model. */
export async function openDezignModel(path: string): Promise<OpenedModelFile> {
  const { model } = read(await load(path), isProject(path))
  const text = toDbml(model.tables)
  return {
    path,
    text,
    imported: { from: 'dezign', tables: model.tables.length, positions: model.positions, leftOut: model.leftOut, hash: fingerprint(text) },
  }
}

/**
 * Writes the edited model back into the DeZign project it was opened from (or, with `dryRun`, says what would
 * change). The files it is about to change are copied to the app's data folder first.
 */
export async function saveDezignModel(request: DezignSaveRequest): Promise<DezignSaveOutcome> {
  const { path } = request
  const ext = extname(path).toLowerCase()
  if (ext !== '.dez' && ext !== '.dezproj') throw new Error('Not a DeZign for Databases model')
  const project = isProject(path)
  const files = await load(path)
  const { model, fallbackEncoding } = read(files, project)
  // Somebody else's changes (a colleague, Git, DeZign itself) must not be overwritten by a model opened before them.
  if (fingerprint(toDbml(model.tables)) !== request.hash) {
    throw new Error('The DeZign file changed on disk since this model was opened. Open it again (Save as keeps your version as a .dbml file).')
  }
  const edited = parseDbml(request.text)
  if (edited.errors.length) throw new Error(`The model has errors (line ${edited.errors[0]!.line}): fix them before saving.`)
  // Tables without a schema sit under the connection's default schema in the window's diagram.
  const positions = Object.fromEntries(Object.entries(request.positions ?? {}).flatMap(([key, p]) => (request.defaultSchema && key.startsWith(`${request.defaultSchema}.`) ? [[key, p], [key.slice(request.defaultSchema.length), p]] : [[key, p]])))
  const result = saveToDezign(files, viaDbml(model.tables), edited.tables, { node: NODE, fallbackEncoding, positions, normalize: viaDbml })
  const outcome: DezignSaveOutcome = { changes: result.changes, written: result.files.length, deleted: result.deleted.length, hash: request.hash }
  if (request.dryRun || (!result.files.length && !result.deleted.length)) return outcome

  const dir = dirname(path)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backup = dataPath('dezign-backups', `${stamp} ${basename(path, extname(path))}`)
  const existing = new Set(files.map((f) => f.path))
  for (const rel of [...result.files.map((f) => f.path), ...result.deleted]) {
    if (!existing.has(rel)) continue
    await mkdir(dirname(join(backup, rel)), { recursive: true })
    await copyFile(join(dir, rel), join(backup, rel))
  }
  for (const file of result.files) {
    const target = join(dir, file.path)
    await mkdir(dirname(target), { recursive: true })
    // Written next to the target and moved over it: a crash never leaves half a file.
    const temp = `${target}.dbm-saving`
    await writeFile(temp, file.text, 'latin1')
    await rename(temp, target)
  }
  for (const rel of result.deleted) await rm(join(dir, rel), { force: true })
  const after = read(await load(path), project).model
  return { ...outcome, backup, hash: fingerprint(toDbml(after.tables)) }
}
