import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dezignIntegrity, newDezignProject, parseDbml, readDezign, saveToDezign, toDbml, type SaveDezignOptions, type TableInfo } from '../src/index.js'

/**
 * A kit for the one check no test can make: opening what we write in DeZign for Databases itself.
 * `DBM_DEZ_KIT_FROM=<model.dez written by DeZign> DBM_DEZ_KIT_TO=<folder>` writes one file per kind of edit
 * (each made by `saveToDezign` on a copy of the model, as the app does), new projects made from scratch, and a
 * checklist saying what to look for in each. Somebody with DeZign opens them one by one.
 */
const from = process.env.DBM_DEZ_KIT_FROM
const to = process.env.DBM_DEZ_KIT_TO

describe.skipIf(!from || !to)('a kit of saved files to open in DeZign', () => {
  it('writes one file per kind of edit, and a checklist', () => {
    const original = readFileSync(from!, 'latin1')
    const viaDbml = (tables: TableInfo[]) => parseDbml(toDbml(tables)).tables
    const model = () => viaDbml(readDezign(original).tables)
    const key = (t: TableInfo) => `${t.schema ?? ''}.${t.name}`
    const source = readDezign(original)
    const main = source.diagrams.find((d) => d.main)!
    const lines: string[] = []
    let n = 0
    const column = (name: string, dataType: string, more: Partial<TableInfo['columns'][number]> = {}): TableInfo['columns'][number] => ({ name, ordinal: 99, dataType, nullable: true, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null, ...more })
    /** One file of the kit: the model with `edit` applied, saved into a copy of the original. */
    const file = (name: string, look: string, edit: (tables: TableInfo[]) => void, options: SaveDezignOptions = {}) => {
      const target = model()
      edit(target)
      const saved = saveToDezign([{ path: 'model.dez', text: original }], model(), viaDbml(target), { normalize: viaDbml, ...options })
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
    expect(n).toBeGreaterThan(15)
  })
})
