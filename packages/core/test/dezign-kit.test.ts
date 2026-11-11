import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyDezignSave, assembleDezignProject, dezignIntegrity, newDezignProject, parseDbml, readDezign, sameType, saveToDezign, toDbml, type DezignFile, type SaveDezignOptions, type TableInfo } from '../src/index.js'

/**
 * A kit for the one check no test can make: opening what we write in DeZign for Databases itself.
 * `DBM_DEZ_KIT_FROM=<model.dez written by DeZign> DBM_DEZ_KIT_TO=<folder>` writes one file per kind of edit
 * (each made by `saveToDezign` on a copy of the model, as the app does), new projects made from scratch, and a
 * checklist saying what to look for in each. Somebody with DeZign opens them one by one.
 */
const from = process.env.DBM_DEZ_KIT_FROM
const to = process.env.DBM_DEZ_KIT_TO

const isFolder = /\.dezproj$/i.test(from ?? '')
// Passing tests print nothing: DBM_DEZ_REPORT=<file> collects the count lines.
const report = (line: string) => (process.env.DBM_DEZ_REPORT ? appendFileSync(process.env.DBM_DEZ_REPORT, `${line}\n`) : console.log(line))

/** The files of a folder project (one XML file per object), without its archived versions. */
function projectFiles(dir: string, base = dir, out: DezignFile[] = []): DezignFile[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (name.toLowerCase() !== 'archived versions') projectFiles(path, base, out)
    } else if (/\.(xml|dezproj|dds|ddp)$/i.test(name)) out.push({ path: relative(base, path), text: readFileSync(path, 'latin1') })
  }
  return out
}

/**
 * The same for a folder project (`DBM_DEZ_KIT_FROM=<project.dezproj>`): two copies of the project, one as it is
 * and one after a typical editing session. Counts only are printed, so it can be a private model.
 */
describe.skipIf(!from || !to || !isFolder)('a folder project to open in DeZign', () => {
  it('writes the project as it is and after edits', () => {
    const czech = { fallbackEncoding: 'windows-1250' } as const
    const all = projectFiles(dirname(from!))
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const model = readDezign(assembleDezignProject(all), czech)
    const base = viaDbml(model.tables)
    const target = viaDbml(model.tables)
    const parent = target.find((t) => t.primaryKey.length === 1)!
    const key = parent.columns.find((c) => c.name === parent.primaryKey[0])!
    target[0]!.columns.push({ name: 'dbm_added', ordinal: 99, dataType: 'varchar(50)', nullable: false, defaultValue: "'x'", isPrimaryKey: false, isIdentity: false, comment: 'Sloupec přidaný v DB Mastermind' })
    target[0]!.indexes.push({ name: 'dbm_ix', columns: ['dbm_added'], unique: false, primary: false }, { name: 'dbm_ux', columns: ['dbm_added'], unique: true, primary: false, constraint: true })
    target[0]!.checks = [...(target[0]!.checks ?? []), { name: 'dbm_check', expression: "dbm_added <> ''" }]
    target.push({ schema: parent.schema, name: 'dbm_new_table', type: 'table', comment: 'Tabulka přidaná v DB Mastermind', columns: [{ ...key, name: 'id', domain: undefined, comment: null }, { ...key, name: 'parent_id', isPrimaryKey: false, isIdentity: false, domain: undefined, comment: null }], primaryKey: ['id'], foreignKeys: [{ name: 'dbm_new_relationship', columns: ['parent_id'], refSchema: parent.schema, refTable: parent.name, refColumns: [key.name] }], indexes: [] })
    const main = model.diagrams.find((d) => d.main)!
    const saved = saveToDezign(all, base, viaDbml(target), {
      normalize: viaDbml,
      ...czech,
      positions: { [`${parent.schema ?? ''}.dbm_new_table`]: { x: 40, y: 40 } },
      diagrams: { [main.id]: { notes: [...main.notes, { id: 'new', text: 'Přidáno v DB Mastermind', x: 10, y: 10 }] }, 'new:1': { name: 'DB Mastermind', exact: true, tables: [`${parent.schema ?? ''}.${parent.name}`, `${parent.schema ?? ''}.dbm_new_table`] } },
    })
    const write = (folder: string, files: DezignFile[]) => {
      for (const f of files) {
        mkdirSync(dirname(join(to!, folder, f.path)), { recursive: true })
        writeFileSync(join(to!, folder, f.path), f.text, 'latin1')
      }
    }
    write('01-beze-zmeny', all)
    const after = applyDezignSave(all, saved)
    write('02-po-upravach', after)
    const kinds = new Map<string, number>()
    for (const c of saved.changes) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1)
    report(`folder project: ${all.length} files, ${model.tables.length} tables; after edits ${saved.files.length} written, ${saved.deleted.length} deleted, changes ${JSON.stringify(Object.fromEntries(kinds))}`)
    expect(dezignIntegrity(assembleDezignProject(after)).length).toBeLessThanOrEqual(dezignIntegrity(assembleDezignProject(all)).length)
    expect(readDezign(assembleDezignProject(after), czech).tables.length).toBe(model.tables.length + 1)
  })
})

describe.skipIf(!from || !to || isFolder)('a kit of saved files to open in DeZign', () => {
  it('writes one file per kind of edit, and a checklist', () => {
    const original = readFileSync(from!, 'latin1')
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    // As the app does on a Czech computer: a file with no letter that settles its code page is Central European.
    const czech = { fallbackEncoding: 'windows-1250' } as const
    const model = () => viaDbml(readDezign(original, czech).tables)
    const key = (t: TableInfo) => `${t.schema ?? ''}.${t.name}`
    const source = readDezign(original, czech)
    const main = source.diagrams.find((d) => d.main)!
    const lines: string[] = []
    let n = 0
    const column = (name: string, dataType: string, more: Partial<TableInfo['columns'][number]> = {}): TableInfo['columns'][number] => ({ name, ordinal: 99, dataType, nullable: true, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null, ...more })
    /** One file of the kit: the model with `edit` applied, saved into a copy of the original. */
    const file = (name: string, look: string, edit: (tables: TableInfo[]) => void, options: SaveDezignOptions = {}) => {
      const target = model()
      edit(target)
      const saved = saveToDezign([{ path: 'model.dez', text: original }], model(), viaDbml(target), { normalize: viaDbml, ...czech, ...options })
      const text = saved.files[0]?.text ?? original
      expect(dezignIntegrity(text).length, name).toBeLessThanOrEqual(dezignIntegrity(original).length)
      n += 1
      const fileName = `${String(n).padStart(2, '0')}-${name}.dez`
      writeFileSync(join(to!, fileName), text, 'latin1')
      lines.push(`## ${fileName}`, '', `Co jsme změnili: ${saved.changes.length ? saved.changes.map((c) => `${c.kind} ${c.table}${c.name ? ` (${c.name})` : ''}`).join('; ') : 'nic (kontrolní kopie originálu)'}`, '', `Na co se podívat: ${look}`, '', '- [ ] otevřel se bez hlášky', '- [ ] změna je vidět, jak je popsáno', '- [ ] Generate → SQL (CREATE skript) proběhne', '- [ ] po Uložit v DeZignu jde soubor znovu otevřít', '')
    }
    mkdirSync(to!, { recursive: true })

    // Tables to work on: one with a few plain columns, and one it can reference.
    const tables = model()
    const withColumns = tables.find((t) => t.columns.filter((c) => !c.isPrimaryKey && !t.foreignKeys.some((f) => f.columns.includes(c.name))).length >= 2) ?? tables[0]!
    const plain = withColumns.columns.filter((c) => !c.isPrimaryKey && !withColumns.foreignKeys.some((f) => f.columns.includes(c.name)))
    const parent = tables.find((t) => t.primaryKey.length === 1 && t !== withColumns) ?? tables.find((t) => t.primaryKey.length === 1)!
    const parentKey = parent.columns.find((c) => c.name === parent.primaryKey[0])!
    const unreferenced = tables.find((t) => !tables.some((o) => o.foreignKeys.some((f) => f.refTable === t.name)) && t !== withColumns) ?? tables.at(-1)!
    const find = (list: TableInfo[], t: TableInfo) => list.find((x) => key(x) === key(t))!
    const newTable = (name: string): TableInfo => ({
      schema: parent.schema,
      name,
      type: 'table',
      comment: 'Tabulka přidaná v DB Mastermind',
      columns: [column('id', parentKey.dataType, { nullable: false, isPrimaryKey: true, ordinal: 1 }), column('parent_id', parentKey.dataType, { nullable: false, ordinal: 2 }), column('note', 'varchar(200)', { ordinal: 3, comment: 'Poznámka: žluťoučký kůň' })],
      primaryKey: ['id'],
      foreignKeys: [{ name: `fk_${name}_parent_id`, columns: ['parent_id'], refSchema: parent.schema, refTable: parent.name, refColumns: [parentKey.name], onDelete: 'CASCADE' }],
      indexes: [],
    })

    file('beze-zmeny', 'soubor je bajt po bajtu originál: slouží jako srovnání, kdyby se neotevřel ani ten.', () => {})
    file('prejmenovany-sloupec', `tabulka ${withColumns.name}: sloupec ${plain[0]!.name} se jmenuje ${plain[0]!.name}_renamed; jeho typ, popis a vazby zůstaly.`, (t) => void (find(t, withColumns).columns.find((c) => c.name === plain[0]!.name)!.name = `${plain[0]!.name}_renamed`))
    file('novy-sloupec', `tabulka ${withColumns.name}: na konci je nový sloupec dbm_added (varchar(50), NOT NULL, výchozí hodnota 'x', s popisem).`, (t) => void find(t, withColumns).columns.push(column('dbm_added', 'varchar(50)', { nullable: false, defaultValue: "'x'", comment: 'Sloupec přidaný v DB Mastermind' })))
    file('zmena-typu-a-popisu', `tabulka ${withColumns.name}: sloupec ${plain[1]!.name} má typ numeric(12,2), je volitelný a má nový popis; tabulka má nový popis.`, (t) => {
      Object.assign(find(t, withColumns).columns.find((c) => c.name === plain[1]!.name)!, { dataType: 'numeric(12,2)', nullable: true, comment: 'Změněný popis sloupce', domain: undefined })
      find(t, withColumns).comment = 'Změněný popis tabulky (ěščřžýáíé)'
    })
    file('odebrany-sloupec', `tabulka ${withColumns.name}: sloupec ${plain[0]!.name} zmizel i z indexů, které ho používaly.`, (t) => {
      const table = find(t, withColumns)
      table.columns = table.columns.filter((c) => c.name !== plain[0]!.name)
      table.indexes = table.indexes.map((i) => ({ ...i, columns: i.columns.filter((c) => c !== plain[0]!.name) })).filter((i) => i.columns.length)
    })
    file('nova-tabulka-s-vazbou', `v modelu i na hlavním diagramu je nová tabulka dbm_new_table s vazbou na ${parent.name} (čára vazby je nakreslená, ON DELETE CASCADE).`, (t) => void t.push(newTable('dbm_new_table')), { positions: { [`${parent.schema ?? ''}.dbm_new_table`]: { x: 40, y: 40 } } })
    file('smazana-tabulka', `tabulka ${unreferenced.name} zmizela z modelu i z diagramů, ostatní tabulky a vazby zůstaly.`, (t) => {
      t.splice(t.findIndex((x) => key(x) === key(unreferenced)), 1)
      for (const other of t) other.foreignKeys = other.foreignKeys.filter((f) => f.refTable !== unreferenced.name)
    })
    file('prejmenovana-tabulka', `tabulka ${withColumns.name} se jmenuje ${withColumns.name}_renamed; vazby na ni a z ní zůstaly, na diagramu je na stejném místě.`, (t) => {
      const table = find(t, withColumns)
      for (const other of t) for (const f of other.foreignKeys) if (f.refTable === table.name) f.refTable = `${table.name}_renamed`
      table.name = `${table.name}_renamed`
    })
    file('index-a-unikatni-omezeni', `tabulka ${withColumns.name}: nový index dbm_ix na ${plain[0]!.name} a nové unikátní omezení dbm_ux na (${plain[0]!.name}, ${plain[1]!.name}).`, (t) => {
      find(t, withColumns).indexes.push({ name: 'dbm_ix', columns: [plain[0]!.name], unique: false, primary: false }, { name: 'dbm_ux', columns: [plain[0]!.name, plain[1]!.name], unique: true, primary: false, constraint: true })
    })
    file('kontrola-check', `tabulka ${withColumns.name}: nové kontrolní omezení dbm_check (${plain[0]!.name} IS NOT NULL OR 1 = 1).`, (t) => void (find(t, withColumns).checks = [...(find(t, withColumns).checks ?? []), { name: 'dbm_check', expression: `${plain[0]!.name} IS NOT NULL OR 1 = 1` }]))
    file('nova-vazba-mezi-existujicimi', `tabulka ${withColumns.name}: nový sloupec dbm_parent_id a vazba na ${parent.name} (čára na diagramu).`, (t) => {
      const table = find(t, withColumns)
      table.columns.push(column('dbm_parent_id', parentKey.dataType))
      table.foreignKeys.push({ name: 'dbm_new_relationship', columns: ['dbm_parent_id'], refSchema: parent.schema, refTable: parent.name, refColumns: [parentKey.name] })
    })
    // (A model without a relationship or an index of its own has nothing to rename: the file is then a plain copy.)
    const withFk = tables.find((t) => t.foreignKeys.some((f) => !f.virtual))
    const withIndex = tables.find((t) => t.indexes.some((ix) => !ix.primary && ix.name))
    file('prejmenovany-cizi-klic-a-index', `cizí klíč tabulky ${withFk?.name ?? '-'} se jmenuje dbm_fk_renamed${withIndex ? ` a index nebo unikátní omezení tabulky ${withIndex.name} dbm_index_renamed` : ''}; sloupce i vazba zůstaly.`, (t) => {
      if (withFk) find(t, withFk).foreignKeys.find((f) => !f.virtual)!.name = 'dbm_fk_renamed'
      if (withIndex) find(t, withIndex).indexes.find((ix) => !ix.primary && ix.name)!.name = 'dbm_index_renamed'
    })
    file('posunuta-tabulka', `na hlavním diagramu je tabulka ${withColumns.name} posunutá doprava dolů, nic jiného se nehnulo.`, () => {}, { positions: { ...source.positions, [key(withColumns)]: { x: (source.positions[key(withColumns)]?.x ?? 0) + 400, y: (source.positions[key(withColumns)]?.y ?? 0) + 300 } } })
    file('poznamka-a-barva', `na hlavním diagramu je nová textová poznámka „Přidáno v DB Mastermind“ a tabulka ${withColumns.name} má světle modrou výplň.`, () => {}, { diagrams: { [main.id]: { notes: [...main.notes, { id: 'new', text: 'Přidáno v DB Mastermind\n(druhý řádek)', x: 60, y: 60 }], colors: { [key(withColumns)]: '#cfe0f7' } } } })
    file('novy-diagram', `projekt má nový diagram „DB Mastermind“ se dvěma tabulkami (${withColumns.name}, ${parent.name}) a čarami vazeb mezi nimi, pokud nějaké mají.`, () => {}, {
      diagrams: { 'new:1': { name: 'DB Mastermind', exact: true, tables: [key(withColumns), key(parent)], positions: { [key(withColumns)]: { x: 0, y: 0 }, [key(parent)]: { x: 500, y: 0 } } } },
    })
    file(
      'vsechno-najednou',
      'všechny předchozí druhy změn v jednom souboru: nová tabulka s vazbou, nový a přejmenovaný sloupec, index, kontrola, poznámka, barva, nový diagram.',
      (t) => {
        const table = find(t, withColumns)
        table.columns.find((c) => c.name === plain[0]!.name)!.name = `${plain[0]!.name}_renamed`
        table.columns.push(column('dbm_added', 'varchar(50)', { comment: 'Sloupec přidaný v DB Mastermind' }))
        table.indexes.push({ name: 'dbm_ix', columns: ['dbm_added'], unique: false, primary: false })
        table.checks = [...(table.checks ?? []), { name: 'dbm_check', expression: 'dbm_added IS NULL OR dbm_added <> \'\'' }]
        t.push(newTable('dbm_new_table'))
      },
      {
        positions: { ...source.positions, [`${parent.schema ?? ''}.dbm_new_table`]: { x: 40, y: 40 } },
        diagrams: { [main.id]: { notes: [...main.notes, { id: 'new', text: 'Přidáno v DB Mastermind', x: 60, y: 60 }], colors: { [key(withColumns)]: '#cfe0f7' } }, 'new:1': { name: 'DB Mastermind', exact: true, tables: [key(withColumns), key(parent)] } },
      },
    )

    // Projects made from scratch (Save as… → .dez in the app), one per database DeZign's id is known for.
    const scratch = parseDbml(
      "Table customer {\n  id integer [pk, increment]\n  name varchar(120) [not null, note: 'Jméno zákazníka']\n  email varchar(255) [unique]\n  Note: 'Zákazník (ěščřžýáíé)'\n}\nTable invoice {\n  id integer [pk, increment]\n  customer_id integer [not null]\n  total numeric(10,2) [not null, default: 0]\n  issued date\n\n  indexes {\n    (customer_id, issued) [name: 'ix_invoice_customer']\n  }\n  checks {\n    `total >= 0` [name: 'invoice_total_ok']\n  }\n}\nRef customer_invoice: invoice.customer_id > customer.id [delete: cascade]\n",
    ).tables
    for (const database of ['postgres', 'mssql', 'mysql'] as const) {
      const text = newDezignProject(scratch, { database })
      expect(dezignIntegrity(text)).toEqual([])
      n += 1
      const fileName = `${String(n).padStart(2, '0')}-novy-projekt-${database}.dez`
      writeFileSync(join(to!, fileName), text, 'latin1')
      lines.push(`## ${fileName}`, '', `Nový projekt vytvořený celý v DB Mastermind (formát DeZign 14, cílová databáze ${database}).`, '', 'Na co se podívat: dvě tabulky (customer, invoice) s vazbou customer_invoice, indexem ix_invoice_customer a kontrolou invoice_total_ok; popisy s českou diakritikou; obě tabulky na hlavním diagramu.', '', '- [ ] otevřel se bez hlášky', '- [ ] tabulky, vazba, index a kontrola jsou vidět', '- [ ] Generate → SQL (CREATE skript) proběhne', '- [ ] po Uložit v DeZignu jde soubor znovu otevřít', '')
    }

    const head = [
      '# Ověření v DeZign for Databases',
      '',
      `Soubory v této složce vznikly z veřejného modelu \`${basename(from!)}\` (formát ${source.formatVersion}, ${source.targetDatabase}, ${source.tables.length} tabulek): každý obsahuje jeden druh úpravy, jak ji do souboru zapisuje DB Mastermind.`,
      'Jde o jedinou věc, kterou neumíme ověřit sami: že DeZign naše soubory otevře a pracuje s nimi dál.',
      '',
      'Postup: v DeZignu (14, stačí zkušební verze) otevřít soubory postupně a u každého odškrtnout čtyři body. Když se něco nepovede, poznamenat číslo souboru a přesné znění hlášky (nebo screenshot).',
      'Nejvíc nás zajímá: nové vazby (jak je nakreslená čára), nové objekty (ID ve stylu souboru) a české znaky.',
      '',
    ]
    writeFileSync(join(to!, 'KONTROLNI-SEZNAM.md'), [...head, ...lines].join('\n'), 'utf8')
    expect(n).toBeGreaterThan(16)
  })
})

/**
 * The way back: `DBM_DEZ_KIT_BACK=<folder>` holds the kit's files as DeZign saved them again (opened one by one
 * and "Save project as…" under the same name). What we read from DeZign's own copy must be what we read from the
 * file we wrote: DeZign understood everything, and kept it. Prints kinds of differences and counts; the
 * differences themselves only with DBM_DEZ_DEBUG=1 (never with a private model).
 */
const back = process.env.DBM_DEZ_KIT_BACK

function differences(a: unknown, b: unknown, path = '', out: { kind: string; detail: string }[] = []): { kind: string; detail: string }[] {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push({ kind: `${path}.length`, detail: `${path}: ${a.length} → ${b.length}` })
    for (let i = 0; i < Math.min(a.length, b.length); i++) differences(a[i], b[i], `${path}[${i}]`, out)
  } else if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) differences((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, out)
  } else if ((a ?? null) !== (b ?? null) && !(path.endsWith('.dataType') && sameType(String(a), String(b)))) out.push({ kind: path, detail: `${path}: ${JSON.stringify(a)} → ${JSON.stringify(b)}` })
  return out
}

describe.skipIf(!to || !back)('the kit as DeZign saved it again', () => {
  it('reads as the model we wrote', () => {
    // A single file by its name; a folder project by the name of its folder (the project file inside may differ).
    const binary = (path: string) => {
      if (!statSync(path).isDirectory()) return readFileSync(path, 'latin1')
      const inner = readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory() && readdirSync(join(path, name)).some((f) => /\.dezproj$/i.test(f)))
      return assembleDezignProject(projectFiles(readdirSync(path).some((f) => /\.dezproj$/i.test(f)) || !inner[0] ? path : join(path, inner[0])))
    }
    const names = readdirSync(back!).filter((name) => (/\.dez$/i.test(name) || statSync(join(back!, name)).isDirectory()) && existsSync(join(to!, name))).sort()
    expect(names.length).toBeGreaterThan(0)
    const failed: string[] = []
    for (const name of names) {
      const ours = readDezign(binary(join(to!, name)), { fallbackEncoding: 'windows-1250' })
      const theirs = readDezign(binary(join(back!, name)), { fallbackEncoding: 'windows-1250' })
      // Keys that are names (positions of "schema.table") are compared as sorted lists, so only values can differ.
      const view = (m: typeof ours) => ({
        // (DeZign 14 converts a project of an older format when it opens it.)
        formatVersion: ours.formatVersion === '140' ? m.formatVersion : '',
        targetDatabase: m.targetDatabase,
        // DeZign keeps tables in its own order, and on PostgreSQL turns an auto-numbered integer into SERIAL.
        tables: [...m.tables]
          .sort((x, y) => `${x.schema ?? ''}.${x.name}`.localeCompare(`${y.schema ?? ''}.${y.name}`))
          .map((t) => ({ ...t, columns: t.columns.map((c) => (/^(small|big)?serial$/i.test(c.dataType) ? { ...c, dataType: c.dataType.toLowerCase().replace('serial', 'int').replace(/^int$/, 'integer'), isIdentity: true } : c)) })),
        positions: Object.entries(m.positions).sort(([x], [y]) => x.localeCompare(y)),
        // (The order of a diagram's tables is the order of its objects in the file, which is DeZign's to choose.)
        diagrams: m.diagrams.map((d) => ({ ...d, tables: [...d.tables].sort(), positions: Object.entries(d.positions ?? {}).sort(([x], [y]) => x.localeCompare(y)) })),
        sqlObjects: m.sqlObjects,
        domains: m.domains,
        scripting: m.scripting,
        leftOut: m.leftOut,
      })
      const found = differences(view(ours), view(theirs))
      const kinds = new Map<string, number>()
      for (const d of found) kinds.set(d.kind.replace(/\[\d+\]/g, '[]'), (kinds.get(d.kind.replace(/\[\d+\]/g, '[]')) ?? 0) + 1)
      const integrity = dezignIntegrity(binary(join(back!, name))).length
      report(`${name}: ${found.length ? [...kinds].map(([k, n]) => `${n}× ${k}`).join(', ') : 'the same model'}${integrity ? `; ${integrity} dangling references in DeZign's copy` : ''}`)
      if (found.length && process.env.DBM_DEZ_DEBUG) console.log(found.slice(0, 12).map((d) => `  ${d.detail}`).join('\n'))
      if (found.length) failed.push(name)
    }
    expect(failed).toEqual([])
  })
})

