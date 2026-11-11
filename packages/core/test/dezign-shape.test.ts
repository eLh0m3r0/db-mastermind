import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assembleDezignProject, dezignChildren, newDezignProject, parseDbml, parseDezignXml, readDezign, saveToDezign, toDbml, type DezignElement, type TableInfo } from '../src/index.js'

/**
 * The shape of what we write against the shape of what DeZign writes. From the models in DBM_DEZ_SAMPLES that
 * DeZign 14 wrote (file format 140), a grammar is taken: which elements each element holds, which of them it
 * always holds, and in which order. A project made from scratch here and a model saved after edits must fit it:
 * no element DeZign never writes there, none missing that DeZign always writes, none out of order.
 * Not a proof that DeZign opens the file, but the part of that question a machine can answer.
 */
const root = process.env.DBM_DEZ_SAMPLES

interface Shape {
  instances: number
  /** child tag → in how many instances of the parent it appears */
  children: Map<string, number>
  /** "a>b": a was seen before b */
  before: Set<string>
}

function learn(el: DezignElement, grammar: Map<string, Shape>): void {
  const kids = dezignChildren(el)
  const shape = grammar.get(el.tag) ?? { instances: 0, children: new Map<string, number>(), before: new Set<string>() }
  grammar.set(el.tag, shape)
  shape.instances += 1
  const tags = kids.map((k) => k.tag)
  for (const tag of new Set(tags)) shape.children.set(tag, (shape.children.get(tag) ?? 0) + 1)
  for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) if (tags[i] !== tags[j]) shape.before.add(`${tags[i]}>${tags[j]}`)
  for (const kid of kids) learn(kid, grammar)
}

/** Where `el` (and what is under it) does not fit the grammar. */
function misfits(el: DezignElement, grammar: Map<string, Shape>, out = new Map<string, number>()): Map<string, number> {
  const shape = grammar.get(el.tag)
  const note = (problem: string) => out.set(problem, (out.get(problem) ?? 0) + 1)
  const kids = dezignChildren(el)
  if (!shape) note(`${el.tag}: DeZign never writes this element`)
  else {
    const tags = kids.map((k) => k.tag)
    for (const tag of new Set(tags)) if (!shape.children.has(tag)) note(`${el.tag} > ${tag}: never there in DeZign's files`)
    // An element that holds nothing in our file (a leaf with text) is not asked for children.
    if (kids.length) for (const [tag, count] of shape.children) if (shape.instances >= 3 && count === shape.instances && !tags.includes(tag)) note(`${el.tag}: ${tag} is always there in DeZign's files, missing here`)
    for (let i = 0; i < tags.length; i++) for (let j = i + 1; j < tags.length; j++) if (tags[i] !== tags[j] && shape.before.has(`${tags[j]}>${tags[i]}`) && !shape.before.has(`${tags[i]}>${tags[j]}`)) note(`${el.tag}: ${tags[i]} comes before ${tags[j]} here, after it in DeZign's files`)
  }
  for (const kid of kids) misfits(kid, grammar, out)
  return out
}

/** "parent>leaf" → how many values DeZign wrote there, and how many of them were whole numbers. */
type Values = Map<string, [seen: number, numbers: number]>
const leafText = (el: DezignElement) => (el.children.every((c) => typeof c === 'string') ? el.children.join('').trim() : undefined)

function learnValues(el: DezignElement, values: Values): Values {
  for (const kid of dezignChildren(el)) {
    const value = leafText(kid)
    if (value === undefined) learnValues(kid, values)
    else {
      const known = values.get(`${el.tag}>${kid.tag}`) ?? [0, 0]
      values.set(`${el.tag}>${kid.tag}`, [known[0] + 1, known[1] + (/^-?\d+$/.test(value) ? 1 : 0)])
    }
  }
  return values
}

/**
 * Values that are a whole number every time DeZign writes them and are not one here. DeZign reads such a value
 * with no default: `<HEADERCOLOR></HEADERCOLOR>` in one new diagram object was enough for DeZign 14.9.3 to refuse
 * the whole project ("'' is not a valid integer value"). Names only, never the value.
 */
function notNumbers(el: DezignElement, values: Values, out = new Map<string, number>()): Map<string, number> {
  for (const kid of dezignChildren(el)) {
    const value = leafText(kid)
    if (value === undefined) notNumbers(kid, values, out)
    else {
      const [seen, numbers] = values.get(`${el.tag}>${kid.tag}`) ?? [0, 0]
      if (seen >= 20 && numbers === seen && !/^-?\d+$/.test(value)) out.set(`${el.tag} > ${kid.tag}: always a whole number in DeZign's files, ${value ? 'something else' : 'empty'} here`, (out.get(`${el.tag} > ${kid.tag}: always a whole number in DeZign's files, ${value ? 'something else' : 'empty'} here`) ?? 0) + 1)
    }
  }
  return out
}

function findProjects(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) findProjects(path, out)
    else if (/\.dezproj$/i.test(name)) out.push(dir)
  }
  return out
}
function projectFiles(dir: string, base = dir, out: { path: string; text: string }[] = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') projectFiles(path, base, out)
    } else out.push({ path: relative(base, path), text: readFileSync(path, 'latin1') })
  }
  return out
}

function find(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) find(path, out)
    else if (/\.dez$/i.test(name)) out.push(path)
  }
  return out
}

describe.skipIf(!root)('what we write has the shape of what DeZign 14 writes', () => {
  const files = root ? find(root).map((path) => readFileSync(path, 'latin1')) : []
  const format140 = files.filter((text) => /<FILEFORMATVERSION>140</.test(text))
  // DeZign 14 files come in two styles: some (the samples shipped with DeZign among them) hold every element even
  // when it is empty (POSNR, DESC, NOTE …), the others leave those out. A new project is written the second way,
  // so what must be in an element is learned from those; the first say what may be where, like the older formats.
  const wordy = (text: string) => /<ENT>\s*<NAME>[^<]*<\/NAME>\s*<ID>[^<]*<\/ID>\s*<POSNR>/.test(text)
  const written = format140.filter((text) => !wordy(text))
  const grammar = new Map<string, Shape>()
  for (const text of written) learn(parseDezignXml(text), grammar)
  const values: Values = new Map()
  for (const text of format140) learnValues(parseDezignXml(text), values)
  // Elements the few DeZign 14 files happen not to use (table constraints, indexes) are known from the files of
  // DeZign 6 to 12, which wrote them the same way: those say what may be where and in which order, not what must be.
  const older = new Map<string, Shape>()
  for (const text of [...format140.filter(wordy), ...files.filter((t) => /<FILEFORMATVERSION>(60|120)</.test(t))]) learn(parseDezignXml(text), older)
  // A table's check constraint, which none of the public files has, as a DeZign 14 project writes it:
  // … NOTE, VALUE, CONLEVEL, CONTYPE, ATTRIBUTEIDS.
  const constraint = grammar.get('CONSTRAINT')
  if (constraint) {
    constraint.children.set('VALUE', 0)
    for (const before of ['NAME', 'NAMETEMPLATE', 'ID', 'SCHEMA', 'DESC', 'NOTE']) constraint.before.add(`${before}>VALUE`)
    for (const after of ['CONLEVEL', 'CONTYPE', 'ATTRIBUTEIDS']) constraint.before.add(`VALUE>${after}`)
  }
  for (const [tag, shape] of older) {
    const known = grammar.get(tag)
    if (!known) grammar.set(tag, { ...shape, instances: 0 })
    else {
      for (const child of shape.children.keys()) if (!known.children.has(child)) known.children.set(child, 0)
      for (const pair of shape.before) if (!known.before.has(pair) && !known.before.has(pair.split('>').reverse().join('>'))) known.before.add(pair)
    }
  }
  const report = (label: string, problems: Map<string, number>) => {
    if (problems.size) console.log(`${label}:\n${[...problems].map(([p, n]) => `  ${n}× ${p}`).join('\n')}`)
  }
  const model = parseDbml(
    "Table sales.customer {\n  id integer [pk, increment]\n  name varchar(120) [not null, note: 'Jméno']\n  email varchar(255) [unique]\n  Note: 'Zákazník'\n}\nTable sales.invoice {\n  id integer [pk, increment]\n  customer_id integer [not null]\n  total numeric(10,2) [not null, default: 0]\n  issued date\n\n  indexes {\n    (customer_id, issued) [name: 'ix_invoice_customer']\n    (customer_id, total) [unique, name: 'ux_invoice']\n  }\n  checks {\n    `total >= 0` [name: 'invoice_total_ok']\n  }\n}\nRef customer_invoice: sales.invoice.customer_id > sales.customer.id [delete: cascade]\n",
  ).tables

  it('has files to learn from', () => {
    expect(files.length + (root ? findProjects(root).length : 0)).toBeGreaterThan(0)
  })

  it.skipIf(!written.length)('a project made from scratch fits', () => {
    const all = new Map<string, number>()
    for (const database of ['postgres', 'mssql', 'mysql'] as const) {
      const problems = misfits(parseDezignXml(newDezignProject(model, { database })), grammar)
      notNumbers(parseDezignXml(newDezignProject(model, { database })), values, problems)
      report(`new ${database} project`, problems)
      for (const [p, n] of problems) all.set(p, (all.get(p) ?? 0) + n)
    }
    expect([...all.keys()]).toEqual([])
  })

  it('a model saved after edits fits the files of its own DeZign version as well as it did', () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    // Every format with a few files to learn from is judged by its own files (DeZign 14 by the grammar above).
    const formatOf = (text: string) => /<FILEFORMATVERSION>(\d+)</.exec(text)?.[1] ?? ''
    const own = new Map<string, Map<string, Shape>>([['140', grammar]])
    const ownValues = new Map<string, Values>()
    for (const text of files) learnValues(parseDezignXml(text), ownValues.get(formatOf(text)) ?? ownValues.set(formatOf(text), new Map()).get(formatOf(text))!)
    for (const format of new Set(files.map(formatOf))) {
      const same = files.filter((t) => formatOf(t) === format)
      if (format === '140' || same.length < 3) continue
      const learned = new Map<string, Shape>()
      for (const text of same) learn(parseDezignXml(text), learned)
      own.set(format, learned)
    }
    let checked = 0
    for (const [i, original] of files.entries()) {
      const format = own.get(formatOf(original))
      if (!format) continue
      checked += 1
      // What must be in an element is what this very file always has there (files of one format still differ by
      // the DeZign release that wrote them); what may be there, and in which order, the whole format says.
      const grammar = new Map<string, Shape>()
      learn(parseDezignXml(original), grammar)
      for (const [tag, shape] of format) {
        const known = grammar.get(tag)
        if (!known) grammar.set(tag, { ...shape, instances: 0 })
        else {
          for (const child of shape.children.keys()) if (!known.children.has(child)) known.children.set(child, 0)
          for (const pair of shape.before) if (!known.before.has(pair.split('>').reverse().join('>'))) known.before.add(pair)
        }
      }
      const base = viaDbml(readDezign(original).tables)
      const target = structuredClone(base)
      const parent = target.find((t) => t.primaryKey.length === 1)
      if (!parent || !target[0]) continue
      const key = parent.columns.find((c) => c.name === parent.primaryKey[0])!
      target[0]!.columns.push({ name: 'dbm_added', ordinal: 99, dataType: 'varchar(50)', nullable: false, defaultValue: "'x'", isPrimaryKey: false, isIdentity: false, comment: 'Added' })
      target[0]!.indexes.push({ name: 'dbm_ix', columns: ['dbm_added'], unique: false, primary: false }, { name: 'dbm_ux', columns: ['dbm_added'], unique: true, primary: false, constraint: true })
      // (A table check only where this format's files show how one is written.)
      if (grammar.get('CONSTRAINT')?.children.has('VALUE')) target[0]!.checks = [...(target[0]!.checks ?? []), { name: 'dbm_check', expression: "dbm_added <> ''" }]
      target.push({ schema: parent.schema, name: 'dbm_new_table', type: 'table', comment: 'New', columns: [{ ...key, name: 'id' }, { ...key, name: 'parent_id', isPrimaryKey: false, isIdentity: false }], primaryKey: ['id'], foreignKeys: [{ name: 'dbm_rel', columns: ['parent_id'], refSchema: parent.schema, refTable: parent.name, refColumns: [key.name] }], indexes: [] })
      const main = readDezign(original).diagrams.find((d) => d.main)!
      const saved = saveToDezign([{ path: 'm.dez', text: original }], base, viaDbml(target), {
        normalize: viaDbml,
        positions: { [`${parent.schema ?? ''}.dbm_new_table`]: { x: 40, y: 40 } },
        // (A text area only where this format's files show what one looks like.)
        diagrams: { ...(grammar.has('TEXTAR') ? { [main.id]: { notes: [...main.notes, { id: 'new', text: 'Note', x: 10, y: 10 }] } } : {}), 'new:1': { name: 'Another', exact: true, tables: [`${parent.schema ?? ''}.${parent.name}`] } },
      })
      // Judged against the other files only where the file itself did not already differ.
      const before = misfits(parseDezignXml(original), grammar)
      const after = misfits(parseDezignXml(saved.files[0]!.text), grammar)
      notNumbers(parseDezignXml(original), ownValues.get(formatOf(original))!, before)
      notNumbers(parseDezignXml(saved.files[0]!.text), ownValues.get(formatOf(original))!, after)
      const added = new Map([...after].filter(([p, n]) => n > (before.get(p) ?? 0)))
      report(`model ${i + 1} after edits`, added)
      expect([...added.keys()], `model ${i + 1} (format ${formatOf(original)})`).toEqual([])
    }
    if (files.length) expect(checked).toBeGreaterThan(0)
  })

  // A folder project (one file per object) is judged by its own files: what a new file holds must be what the
  // project's files of that kind always hold, in their order. Prints element names and counts only.
  it('new files of a folder project are shaped like the project\'s own', () => {
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const projects = root ? findProjects(root) : []
    for (const dir of projects) {
      const all = projectFiles(dir)
      const grammar = new Map<string, Shape>()
      for (const f of all.filter((x) => /\.xml$/i.test(x.path))) learn(parseDezignXml(f.text), grammar)
      const values: Values = new Map()
      for (const f of all.filter((x) => /\.xml$/i.test(x.path))) learnValues(parseDezignXml(f.text), values)
      const model = readDezign(assembleDezignProject(all))
      const base = viaDbml(model.tables)
      const target = structuredClone(base)
      const parent = target.find((t) => t.primaryKey.length === 1)!
      const key = parent.columns.find((c) => c.name === parent.primaryKey[0])!
      target[0]!.columns.push({ name: 'dbm_added', ordinal: 99, dataType: 'varchar(50)', nullable: false, defaultValue: "'x'", isPrimaryKey: false, isIdentity: false, comment: 'Added' })
      target[0]!.indexes.push({ name: 'dbm_ix', columns: ['dbm_added'], unique: false, primary: false }, { name: 'dbm_ux', columns: ['dbm_added'], unique: true, primary: false, constraint: true })
      target[0]!.checks = [...(target[0]!.checks ?? []), { name: 'dbm_check', expression: "dbm_added <> ''" }]
      target.push({ schema: parent.schema, name: 'dbm_new_table', type: 'table', comment: 'New', columns: [{ ...key, name: 'id', domain: undefined }, { ...key, name: 'parent_id', isPrimaryKey: false, isIdentity: false, domain: undefined }], primaryKey: ['id'], foreignKeys: [{ name: 'dbm_rel', columns: ['parent_id'], refSchema: parent.schema, refTable: parent.name, refColumns: [key.name] }], indexes: [] })
      const main = model.diagrams.find((d) => d.main)!
      const saved = saveToDezign(all, base, viaDbml(target), {
        normalize: viaDbml,
        positions: { [`${parent.schema ?? ''}.dbm_new_table`]: { x: 40, y: 40 } },
        diagrams: { [main.id]: { notes: [...main.notes, { id: 'new', text: 'Note', x: 10, y: 10 }] }, 'new:1': { name: 'Another', exact: true, tables: [`${parent.schema ?? ''}.${parent.name}`] } },
      })
      const before = new Map<string, number>()
      for (const f of all.filter((x) => /\.xml$/i.test(x.path) && saved.files.some((w) => w.path === x.path))) notNumbers(parseDezignXml(f.text), values, misfits(parseDezignXml(f.text), grammar, before))
      const after = new Map<string, number>()
      for (const f of saved.files.filter((x) => /\.xml$/i.test(x.path))) notNumbers(parseDezignXml(f.text), values, misfits(parseDezignXml(f.text), grammar, after))
      const added = new Map([...after].filter(([p, n]) => n > (before.get(p) ?? 0)))
      report(`folder project: ${saved.files.length} files written`, added)
      expect([...added.keys()]).toEqual([])
    }
  })
})
