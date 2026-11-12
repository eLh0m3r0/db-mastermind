import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assembleDezignProject, dezignAsFolder, dezignIntegrity, newDezignProject, parseDbml, readDezign, saveToDezign, toDbml, type DezignFile, type TableInfo } from '../src/index.js'

/**
 * A folder project is meant for Git: two people edit the model on their own branches and merge. That works only
 * when a save touches the files of the objects it changed and nothing shared by everybody (a counter, a list of
 * all objects). Checked with real git: two branches, each saved from here, merged without a conflict.
 */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const temps: string[] = []
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables

function readFolder(dir: string, base = dir, out: DezignFile[] = []): DezignFile[] {
  for (const name of readdirSync(dir)) {
    if (name === '.git') continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) readFolder(path, base, out)
    else out.push({ path: relative(base, path).split('\\').join('/'), text: readFileSync(path, 'latin1') })
  }
  return out
}

describe.skipIf(!hasGit)('a folder project in Git', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' })
  const model = (dir: string) => readDezign(assembleDezignProject(readFolder(dir))).tables
  const column = (name: string, dataType: string, more: Partial<TableInfo['columns'][number]> = {}) => ({ name, ordinal: 99, dataType, nullable: true, isPrimaryKey: false, isIdentity: false, ...more })
  const table = (name: string, columns: TableInfo['columns'], foreignKeys: TableInfo['foreignKeys'] = []): TableInfo => ({ schema: 'shop', name, type: 'table', comment: null, columns, primaryKey: ['id'], foreignKeys, indexes: [] })

  /** What one person does on their branch: open the project, edit, save from here, commit. */
  const work = (dir: string, branch: string, edit: (tables: TableInfo[]) => TableInfo[]) => {
    git(dir, 'checkout', '-q', '-b', branch, 'main')
    const files = readFolder(dir)
    const base = viaDbml(model(dir))
    const saved = saveToDezign(files, base, viaDbml(edit(structuredClone(base))), { normalize: viaDbml })
    for (const file of saved.files) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true })
      writeFileSync(join(dir, file.path), file.text, 'latin1')
    }
    for (const path of saved.deleted) rmSync(join(dir, path))
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', branch)
    return saved
  }

  it('two people edit different tables, each adds a table; the branches merge without a conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dbm-dezign-git-'))
    temps.push(dir)
    const start = parseDbml(
      "Table shop.customer {\n  id bigint [pk, increment]\n  email varchar(120) [not null]\n}\nTable shop.invoice {\n  id bigint [pk, increment]\n  customer_id bigint [not null, ref: > shop.customer.id]\n  total numeric(12,2)\n}\nTable shop.product {\n  id bigint [pk, increment]\n  title varchar(200)\n}\n",
    ).tables
    const project = newDezignProject(start, { database: 'postgresql16', positions: { 'shop.customer': { x: 40, y: 40 }, 'shop.invoice': { x: 400, y: 40 }, 'shop.product': { x: 40, y: 400 } } })
    for (const file of dezignAsFolder(project, 'Shop')) {
      mkdirSync(dirname(join(dir, file.path)), { recursive: true })
      writeFileSync(join(dir, file.path), file.text, 'latin1')
    }
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'start')

    const alice = work(dir, 'alice', (t) => {
      const customer = t.find((x) => x.name === 'customer')!
      customer.columns.push(column('phone', 'varchar(30)', { comment: 'Kontakt' }))
      return [...t, table('payment', [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('invoice_id', 'bigint', { nullable: false })], [{ name: 'payment_invoice', columns: ['invoice_id'], refSchema: 'shop', refTable: 'invoice', refColumns: ['id'] }])]
    })
    const bob = work(dir, 'bob', (t) => {
      const product = t.find((x) => x.name === 'product')!
      product.columns.find((c) => c.name === 'title')!.dataType = 'varchar(300)'
      product.columns.push(column('price', 'numeric(12,2)'))
      return [...t, table('supplier', [column('id', 'bigint', { nullable: false, isPrimaryKey: true }), column('name', 'varchar(100)')])]
    })
    // Neither branch touched a file the other did: that is what lets Git merge them.
    const touched = (s: typeof alice) => new Set([...s.files.map((f) => f.path), ...s.deleted])
    expect([...touched(alice)].filter((p) => touched(bob).has(p))).toEqual([])

    git(dir, 'checkout', '-q', 'main')
    git(dir, 'merge', '-q', '--no-edit', 'alice')
    git(dir, 'merge', '-q', '--no-edit', 'bob')
    expect(git(dir, 'status', '--porcelain')).toBe('')

    const merged = readFolder(dir)
    expect(dezignIntegrity(assembleDezignProject(merged))).toEqual([])
    const tables = readDezign(assembleDezignProject(merged))
    expect(tables.tables.map((t) => t.name).sort()).toEqual(['customer', 'invoice', 'payment', 'product', 'supplier'])
    const byName = (name: string) => tables.tables.find((t) => t.name === name)!
    expect(byName('customer').columns.map((c) => c.name)).toEqual(['id', 'email', 'phone'])
    expect(byName('product').columns.find((c) => c.name === 'title')!.dataType).toBe('varchar(300)')
    expect(byName('payment').foreignKeys[0]!.refTable).toBe('invoice')
    // Both new tables are on the diagram.
    expect(tables.diagrams[0]!.tables).toEqual(expect.arrayContaining(['shop.payment', 'shop.supplier']))
  })
})
