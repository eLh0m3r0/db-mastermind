import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { app } from 'electron'
import { archiveDezignVersion, assembleDezignProject, dezignAsFolder, dezignDomainsNote, dezignDomainsOfModel, dezignDatabaseFor, listDezignVersions, newDezignProject, parseDbml, readDezign, saveToDezign, toDbml, type DezignFile, type TableInfo } from '@dbmastermind/core'
import type { DezignSaveOutcome, DezignSaveRequest, ModelExportLayout, ModelVersion, OpenedModelFile } from '@shared/api'
import { dataPath } from './storage'
import { paletteFill, paletteIndex } from './palette'

// Size of a table in the diagram (DiagramView): DeZign's layout is spread to fit it.
const NODE = { width: 240, header: 32, row: 22 }
const isProject = (path: string) => extname(path).toLowerCase() === '.dezproj'

/** The parts of a folder project the model needs; archived versions (hundreds of MB) are left alone. */
async function projectFiles(projectFile: string): Promise<DezignFile[]> {
  const dir = dirname(projectFile)
  const paths: string[] = []
  for (const name of await readdir(dir)) {
    if (extname(name).toLowerCase() === '.dds' || name === basename(projectFile)) paths.push(name)
  }
  for (const name of await readdir(dir, { withFileTypes: true })) {
    if (!name.isDirectory() || !['data dictionary', 'diagrams'].includes(name.name.toLowerCase())) continue
    for (const entry of await readdir(join(dir, name.name), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.xml') paths.push(relative(dir, join(entry.parentPath, entry.name)))
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

const paletteColors = (colors: Record<string, string>) => Object.fromEntries(Object.entries(colors).flatMap(([key, hex]) => (paletteIndex(hex) ? [[key, paletteIndex(hex)!]] : [])))

const fingerprint = (dbml: string) => createHash('sha256').update(dbml).digest('hex')
const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables

/** A DeZign for Databases model (`.dez`, or the `.dezproj` of a folder project) as a DBML model. */
export async function openDezignModel(path: string): Promise<OpenedModelFile> {
  return opened(path, read(await load(path), isProject(path)).model)
}

/** A model read from a DeZign project (or one of its archived versions) as a model tab takes it. */
function opened(path: string, model: ReturnType<typeof readDezign>): OpenedModelFile {
  const plain = toDbml(model.tables)
  // The project's domains are listed in the model as a note: a column follows one through its `domain` setting.
  const domains = model.domains.length ? [dezignDomainsNote(model.domains)] : []
  const text = toDbml(model.tables, { extras: domains })
  return {
    path,
    text,
    imported: {
      from: 'dezign',
      tables: model.tables.length,
      positions: model.positions,
      leftOut: model.leftOut,
      colors: paletteColors(model.diagrams.find((d) => d.main)?.colors ?? {}),
      notes: model.diagrams.find((d) => d.main)?.notes ?? [],
      boxes: model.diagrams.find((d) => d.main)?.boxes ?? [],
      display: model.diagrams.find((d) => d.main)?.display,
      sqlObjects: model.sqlObjects,
      targetDatabase: model.targetDatabase,
      scripting: model.scripting,
      diagrams: model.diagrams.filter((d) => !d.main).map(({ id, name, tables, positions, colors, notes, boxes, display }) => ({ id, name, tables, positions, colors: paletteColors(colors), notes, boxes, display })),
      // Of the tables alone: the note above is ours, not the project's.
      hash: fingerprint(plain),
    },
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
  const bare = (key: string) => (request.defaultSchema && key.startsWith(`${request.defaultSchema}.`) ? key.slice(request.defaultSchema.length) : undefined)
  const withBare = <T>(entries: [string, T][]): [string, T][] => entries.flatMap(([key, v]) => (bare(key) ? [[key, v], [bare(key)!, v]] : [[key, v]]))
  const positions = Object.fromEntries(withBare(Object.entries(request.positions ?? {})))
  const diagrams: NonNullable<Parameters<typeof saveToDezign>[3]>['diagrams'] = Object.fromEntries(
    // A tab that loaded the source's diagrams knows them whole: what it lists is what each diagram shows.
    (request.diagrams ?? []).map((d) => [d.id, { name: d.name, exact: !!request.layout, tables: d.tables.flatMap((key) => [key, ...(bare(key) ? [bare(key)!] : [])]), positions: Object.fromEntries(withBare(Object.entries(d.positions))), notes: d.notes }]),
  )
  // Colors go to the file only where the palette color differs from what the file's own color maps to.
  const colorChanges = (diagramId: string, wanted: Record<string, number> | undefined) => {
    const current = paletteColors(model.diagrams.find((d) => d.id === diagramId)?.colors ?? {})
    const asked = Object.fromEntries(Object.entries(wanted ?? {}).map(([key, index]) => [(bare(key) ?? key).toLowerCase(), index]))
    const out: Record<string, string | null> = {}
    for (const key of new Set([...Object.keys(current).map((k) => k.toLowerCase()), ...Object.keys(asked)])) {
      const was = Object.entries(current).find(([k]) => k.toLowerCase() === key)?.[1]
      if (was !== asked[key]) out[key] = asked[key] ? (paletteFill(asked[key]!) ?? null) : null
    }
    return out
  }
  // A tab from before notes and colors were loaded cannot say which ones are gone: every note of the file stays,
  // and only the ones the tab has an edited copy of change.
  const keepingAll = (diagramId: string, edited: { id: string; text: string; x: number; y: number }[] | undefined) => {
    const known = model.diagrams.find((d) => d.id === diagramId)?.notes ?? []
    return known.map((o) => edited?.find((n) => n.id === o.id) ?? o)
  }
  // What the tables show, with the hidden columns keyed as the file names its tables. Frames change only where the
  // tab sends its list (a request without one, from an older tab or the API, leaves them as they are).
  const displayOf = (display: DezignSaveRequest['display']) => (display ? { ...display, hidden: display.hidden ? Object.fromEntries(withBare(Object.entries(display.hidden))) : undefined } : undefined)
  for (const d of request.diagrams ?? []) {
    if (request.layout) Object.assign(diagrams[d.id]!, { notes: d.notes ?? [], colors: colorChanges(d.id, d.colors), display: displayOf(d.display), ...(d.boxes ? { boxes: d.boxes } : {}) })
    else diagrams[d.id]!.notes = keepingAll(d.id, d.notes)
  }
  const main = model.layout.diagramId
  if (main) diagrams[main] = request.layout ? { notes: request.notes ?? [], colors: colorChanges(main, request.colors), display: displayOf(request.display), ...(request.boxes ? { boxes: request.boxes } : {}) } : { notes: keepingAll(main, request.notes) }
  for (const id of request.removedDiagrams ?? []) if (id !== main) diagrams[id] = { remove: true }
  const result = saveToDezign(files, viaDbml(model.tables), edited.tables, { node: NODE, fallbackEncoding, positions, diagrams, normalize: viaDbml, domains: request.domains, views: request.views, scripts: request.scripts })
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

/**
 * Writes a model made here as a new DeZign project, for the database of its connection (PostgreSQL without one):
 * a single file (`.dez`), or a folder project (`.dezproj`, for Git) in a folder of its name next to the path, as
 * DeZign's "Save project as → Folder based" makes one. Returns the project file.
 */
export async function exportDezignModel(path: string, dbml: string, layout: ModelExportLayout = {}): Promise<string> {
  const model = parseDbml(dbml)
  if (model.errors.length) throw new Error(`The model has errors (line ${model.errors[0]!.line}): fix them before saving.`)
  // Tables without a schema sit under the connection's default schema in the window's diagram.
  const positions = Object.fromEntries(Object.entries(layout.positions ?? {}).map(([key, p]) => [layout.defaultSchema && key.startsWith(`${layout.defaultSchema}.`) ? key.slice(layout.defaultSchema.length) : key, p]))
  // The model's domains are made in the new project, so its columns can follow them there too.
  const text = newDezignProject(model.tables, { database: dezignDatabaseFor(layout.driver), positions, domains: dezignDomainsOfModel(dbml) })
  if (extname(path).toLowerCase() === '.dezproj') {
    const name = basename(path, extname(path))
    const dir = join(dirname(path), name)
    // A folder project is a folder of its own: never written into one that holds something already.
    if ((await readdir(dir).catch(() => [])).length) throw new Error(`The folder ${dir} is not empty: pick another name for the project.`)
    for (const file of dezignAsFolder(text, name)) {
      await mkdir(dirname(join(dir, file.path)), { recursive: true })
      await writeFile(join(dir, file.path), file.text, 'latin1')
    }
    return join(dir, `${name}.dezproj`)
  }
  const temp = `${path}.dbm-saving`
  await writeFile(temp, text, 'latin1')
  await rename(temp, path)
  return path
}

const fallbackEncoding = () => (/^(cs|sk|pl|hu|sl|hr|ro|sq)\b/i.test(app.getLocale()) ? ('windows-1250' as const) : ('windows-1252' as const))

/** The folder a folder project keeps its archived versions in (one XML file each), if it has one. */
async function archiveDir(projectFile: string): Promise<string | undefined> {
  const dir = dirname(projectFile)
  const name = (await readdir(dir, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.toLowerCase() === 'archived versions')?.name
  return name ? join(dir, name) : undefined
}

/** The versions archived in a DeZign project, newest first. */
export async function listModelVersions(path: string): Promise<ModelVersion[]> {
  const ext = extname(path).toLowerCase()
  if (ext !== '.dez' && ext !== '.dezproj') return []
  let versions: ModelVersion[]
  if (!isProject(path)) {
    versions = listDezignVersions(await readFile(path, 'latin1'), { fallbackEncoding: fallbackEncoding() }).map((v, i) => ({ id: String(i), ...v }))
  } else {
    const dir = await archiveDir(path)
    if (!dir) return []
    versions = []
    for (const name of (await readdir(dir)).filter((n) => extname(n).toLowerCase() === '.xml')) {
      // Each file is a whole model (megabytes): what the list shows is in its first lines.
      const file = await open(join(dir, name), 'r')
      try {
        const { buffer, bytesRead } = await file.read(Buffer.alloc(16384), 0, 16384, 0)
        const info = listDezignVersions(buffer.subarray(0, bytesRead).toString('latin1'), { fallbackEncoding: fallbackEncoding() })[0]
        if (info) versions.push({ id: name, ...info })
      } finally {
        await file.close()
      }
    }
  }
  const order = (v: ModelVersion) => `${v.date} ${v.number.padStart(8, '0')}`
  return versions.sort((a, b) => (order(a) < order(b) ? 1 : -1))
}

/** Archives the project as it is on disk now: a single file gets the copy inside it (backed up first), a folder project a file. */
export async function archiveModelVersion(path: string, request: { label?: string; comments?: string; hash: string }): Promise<{ number: number; label: string }> {
  const ext = extname(path).toLowerCase()
  if (ext !== '.dez' && ext !== '.dezproj') throw new Error('Not a DeZign for Databases model')
  const project = isProject(path)
  const files = await load(path)
  const { model, fallbackEncoding } = read(files, project)
  // A version is of the model the user has seen: not of one a colleague or DeZign changed in the meantime.
  if (fingerprint(toDbml(model.tables)) !== request.hash) throw new Error('The DeZign file changed on disk since this model was opened or saved. Open it again before archiving a version.')
  const existing = project ? (await listModelVersions(path)).map((v) => Number(v.number)).filter((n) => Number.isFinite(n)) : []
  const result = archiveDezignVersion(files, { label: request.label, comments: request.comments, encoding: model.encoding, fallbackEncoding }, existing)
  const dir = dirname(path)
  if (!project) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backup = dataPath('dezign-backups', `${stamp} ${basename(path, extname(path))}`)
    await mkdir(backup, { recursive: true })
    await copyFile(path, join(backup, basename(path)))
  }
  for (const file of result.files) {
    const target = project ? join(dir, file.path) : path
    await mkdir(dirname(target), { recursive: true })
    const temp = `${target}.dbm-saving`
    await writeFile(temp, file.text, 'latin1')
    await rename(temp, target)
  }
  const label = listDezignVersions(result.files[0]!.text, { encoding: model.encoding }).find((v) => v.number === String(result.number))?.label ?? ''
  return { number: result.number, label }
}

/** An archived version of a DeZign project as a DBML model. */
export async function openModelVersion(path: string, id: string): Promise<OpenedModelFile> {
  if (!isProject(path)) return opened(path, readDezign(await readFile(path, 'latin1'), { archived: Number(id), fallbackEncoding: fallbackEncoding() }))
  const dir = await archiveDir(path)
  // The id is a file name out of the list: nothing else in the folder, and nothing outside it, can be asked for.
  if (!dir || basename(id) !== id || !(await readdir(dir)).includes(id)) throw new Error('The archived version is not in the project')
  const version = (await readFile(join(dir, id), 'latin1')).replace(/^\uFEFF?\s*<\?xml[^>]*\?>\s*/, '')
  return opened(path, readDezign(`<dezign>\n${version}\n</dezign>`, { archived: 0, fallbackEncoding: fallbackEncoding() }))
}
