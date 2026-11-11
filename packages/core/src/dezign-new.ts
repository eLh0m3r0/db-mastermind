import { saveToDezign } from './dezign-write.js'
import { translateTables } from './type-map.js'
import type { DriverId, TableInfo } from './types.js'

/**
 * A new DeZign for Databases project (single `.dez` file, file format 140) from a model made here, for people
 * who keep working in DeZign. The project starts as an empty one with DeZign's default settings and gets its
 * tables through the same writer that saves into existing projects.
 *
 * DRAFT like saving back: read back and checked for consistency, not yet opened in DeZign itself.
 */

/** DeZign's target database ids for the engines a model is exported for. */
export const DEZIGN_DATABASES = { postgres: 'postgresql16', mssql: 'mssqlserver2022', mysql: 'mysql8' } as const
export type DezignDatabase = keyof typeof DEZIGN_DATABASES

/** The engine a model of `driver` is exported as: its own where DeZign's id is known, PostgreSQL otherwise. */
export function dezignDatabaseFor(driver: DriverId | undefined): DezignDatabase {
  return driver === 'mssql' ? 'mssql' : driver === 'mysql' || driver === 'mariadb' ? 'mysql' : 'postgres'
}

const leaves = (pairs: [string, string][]) => pairs.map(([tag, value]) => `<${tag}>${value}</${tag}>`).join('\n')
const section = (tag: string, body = '') => `<${tag}>\n${body ? `${body}\n` : ''}</${tag}>`

const GENERATE_OPTIONS =
  'UNSELECTEDOBJECTS DONOTUSECOMMENTS DONOTUSEDEFAULTS DONOTUSETABLEOPTIONS DONOTUSECOLLATIONS DONOTUSECHARSETS DONOTUSETRIGGERS DONOTUSECHECKCONSTRAINTS DONOTUSEPRIMARYKEYS DONOTUSEFOREIGNKEYS DONOTUSEALTERNATEKEYS DONOTUSEINDEXESONPK DONOTUSEINDEXESONFK DONOTUSEINDEXESONAK DONOTUSEOTHERINDEXES DONOTUSEPKCONNAMES DONOTUSEFKCONNAMES DONOTUSEUNIQUECONNAMES DONOTUSECHECKCONNAMES DONOTUSEDEFAULTCONNAMES DONOTUSENOTNULLCONNAMES DONOTUSECONSTRAINTOPTIONS DONOTUSETABLESCRIPTS DONOTUSECOMMENTSINCODE GLOBALPREFIX CONVERTDOMAINS DONOTUSEDATABASESCRIPTS CHECKMODEL GENERATIONDIRECTIVE ARCHIVEMODEL CHANGETEXTFORMAT'.split(
    ' ',
  )

function emptyProject(database: string, diagramId: string, projectId: string, today: string): string {
  const common = leaves([
    ['PROJECTFILENAME', ''],
    ['PROJECTNAME', ''],
    ['PROJECTDESCRIPTION', ''],
    ['AUTHOR', ''],
    ['COPYRIGHT', ''],
    ['LASTGENERATEDFILES', ''],
    ['PRINTORIENTATION', 'PORTRAIT'],
    ['PRINTPAGETYPE', 'A4'],
    ['DEFTABLEOPTIONS', ''],
    ['DEFINDEXOPTIONS', ''],
    ['AUTOCREATEINDEXESONKEYS', '0'],
    ['BEGINDATABASESCRIPT', ''],
    ['ENDDATABASESCRIPT', ''],
    ['BEGINALTERDATABASESCRIPT', ''],
    ['ENDALTERDATABASESCRIPT', ''],
    ['BEGINDROPDATABASESCRIPT', ''],
    ['ENDDROPDATABASESCRIPT', ''],
    ['MODIFIED', today],
    ['CREATED', today],
    ['FILEFORMATVERSION', '140'],
    ['PROJECTID', projectId],
    ['DEFAULTSCHEMANAME', ''],
  ])
  const names = leaves([
    ['PKCONNAMETEMPLATE', 'PK_%table%'],
    ['FKCONNAMETEMPLATE', '%relname%'],
    ['CCONNAMETEMPLATE', 'CC_%table%_%column%'],
    ['NOTNULLCONNAMETEMPLATE', 'NN_%table%_%column%'],
    ['DEFAULTCONNAMETEMPLATE', 'DEF_%table%_%column%'],
    ['TUCONNAMETEMPLATE', 'TUC_%table%_%counter%'],
    ['TCCONNAMETEMPLATE', 'TCC_%table%_%counter%'],
    ['RELNAMETEMPLATE', '%parent%_%child%'],
    ['INDEXNAMETEMPLATE', 'IDX_%table%_%counter%'],
    ['DEFAULTSCHEMANAME', ''],
    ['PKINDEXNAMETEMPLATE', 'IDX_%table%_PK'],
    ['FKINDEXNAMETEMPLATE', 'IDX_%table%_%counter%_FK'],
    ['AKINDEXNAMETEMPLATE', 'IDX_%table%_%counter%_AK'],
  ])
  const font = 'Arial,8,,0,clWindowText,0'
  const display = leaves([
    ['USEINDICATORLINE', '0'],
    ['INDICATORBITMAPS', '0'],
    ['PKINDICATOR', 'PK'],
    ['FKINDICATOR', 'FK'],
    ['PFINDICATOR', 'PF'],
    ['NOTNULLINDICATOR', '*'],
    ['INDICATORPOSITION', '0'],
    ['USEGRADIENT', '0'],
    ['DEFTEXTAREACOLOR', '16777215'],
    ['DEFENTCOLOR', '16119285'],
    ['DEFENTHEADERCOLOR', '16446189'],
    ['DEFVIEWCOLOR', '16313046'],
    ['DEFSTAMPCOLOR', '16777215'],
    ['DEFGROUPBOXCOLOR', '15780518'],
    ['DEFTEXTAREALINECOLOR', '0'],
    ['DEFENTLINECOLOR', '10987431'],
    ['DEFVIEWLINECOLOR', '0'],
    ['DEFSTAMPLINECOLOR', '0'],
    ['DEFSUBCATLINECOLOR', '0'],
    ['DEFCONLINECOLOR', '0'],
    ['DEFGROUPBOXLINECOLOR', '8421504'],
    ['DEFTEXTAREATRANSPARENT', '0'],
    ['DEFSTAMPTRANSPARENT', '0'],
    ['DEFGROUPBOXTRANSPARENT', '1'],
    ['DEFTEXTAREALINEWIDTH', '1'],
    ['DEFSTAMPLINEWIDTH', '1'],
    ['DEFGROUPBOXLINEWIDTH', '1'],
    ['DEFTEXTAREALINESTYLE', '0'],
    ['DEFSTAMPLINESTYLE', '0'],
    ['DEFGROUPBOXLINESTYLE', '2'],
    ['ENTNAMEFONT', 'Arial,9,B,0,clBlack,0'],
    ['ENTPKFONT', 'Arial,8,B,0,clWindowText,0'],
    ['ENTFKFONT', 'Arial,8,I,0,clWindowText,0'],
    ['ENTATTRFONT', font],
    ['TEXTAREAFONT', font],
    ['GROUPBOXFONT', 'Arial,10,B,0,clWindowText,0'],
    ['CAPTIONFONT', font],
    ['VIEWNAMEFONT', 'Arial,9,B,0,clNavy,0'],
    ['VIEWCODEFONT', font],
    ['VIEWCOLUMNFONT', font],
  ])
  const diagram = leaves([
    ['ID', diagramId],
    ['NAME', 'Main Diagram'],
    ['DESC', ''],
    ['TODO', ''],
    ['POSNR', '0'],
    ['ISMAINDIAGRAM', '1'],
    ['BGCOLOR', '15391681'],
    ['DISPLAYLEVEL', '0'],
    ['VIEWDISPLAYLEVEL', '0'],
    ['INDEXESTODISPLAY', '1'],
    ['VISIBLEATTR', '3'],
    ['CAPTIONSTYLE', '0'],
    ['SHOWPKINDICATOR', '1'],
    ['SHOWFKINDICATOR', '1'],
    ['SHOWNOTNULLINDICATOR', '1'],
    ['SHOWINDEXINDICATOR', '1'],
    ['ENTCAPTSTYLE', '1'],
    ['VIEWCAPTSTYLE', '0'],
    ['ENTLABELDISPLAYTYPE', '3'],
    ['NOTATION', '0'],
  ])
  // The sections DeZign 14 writes into every project, with what a project that has not generated or compared
  // anything yet holds in them (no file paths, no server names).
  const indexChoices = leaves([['DONOTUSESEQUENCESEED', '1'], ['DONOTUSEINDEXESONPK', '1'], ['DONOTUSEINDEXESONFK', '1'], ['DONOTUSEINDEXESONAK', '1']])
  const settings = [
    section('COMMONSETTINGS', common),
    section('NAMETEMPLATES', names),
    section('REPOSITORYSETTINGS'),
    section('STOREDFILTERS', leaves([['ADDREMOVEOBJECTSFILTER', '']])),
    section('ImpDB_DBParams'),
    section('ImpDB_Options'),
    section('GenDB_DBParams', leaves([['SQLCREATEFILE', ''], ['SQLDROPFILE', ''], ['DBID', database]])),
    // Every choice of the Generate dialog, as DeZign leaves them in a new project.
    section('GenDB_Options', leaves(GENERATE_OPTIONS.map((tag) => [tag, tag === 'DONOTUSENOTNULLCONNAMES' || tag === 'CHANGETEXTFORMAT' ? '1' : tag === 'ARCHIVEMODEL' ? '0' : '']))),
    section('AltDB_DBParams'),
    section('AltDB_Options'),
    section('UpdModel_DBParams'),
    section('UpdModel_Options', indexChoices),
    section('AltModel_Options'),
    section('UpdDB_DBParams'),
    section('UpdDB_Options', indexChoices),
    section('CompVer_DBParams'),
    section('CompVer_Options'),
    section('Merge_Settings'),
    section('Rep_Settings'),
    section('MiscSettings', leaves([['RULESFORHIDINGATTRIBUTES', ''], ['CONGENDIRECTIVES', ''], ['FILTERS', '']])),
  ].join('\n')
  const dictionary = [`<DBID>${database}</DBID>`, ...['DOMAINS', 'ENTITIES', 'SUBCATEGORIES', 'TEXTAREAS', 'GROUPBOXES', 'STAMPS', 'SEQUENCES', 'PROCEDURES', 'VIEWS', 'RELATIONSHIPS', 'SUBCATEGORYCONNECTIONS', 'VIEWCONNECTIONS', 'USERDEFINEDPROPERTIES'].map((tag) => section(tag))].join('\n')
  const controls = ['ENTITYCONTROLS', 'SUBCATEGORYCONTROLS', 'TEXTAREACONTROLS', 'STAMPCONTROLS', 'GROUPBOXESCONTROLS', 'VIEWCONTROLS', 'RELATIONSHIPCONNECTORS', 'SUBCATEGORYCONNECTORS', 'VIEWCONNECTORS'].map((tag) => section(tag)).join('\n')
  const diagrams = [section('DisplayPreferences', display), section('DIAGRAM', diagram), section('CONTROLS', controls)].join('\n')
  return `<?xml version="1.0" encoding="iso-8859-1"?><dezign>\n${section('VERSION', [section('PROJECTSETTINGS', settings), section('DATADICT', dictionary), section('DIAGRAMS', diagrams), section('LABELS')].join('\n'))}\n</dezign>\n`
}

export interface NewDezignOptions {
  database?: DezignDatabase
  /** Diagram positions keyed `schema.table`; tables without one are laid out in a grid. */
  positions?: Record<string, { x: number; y: number }>
  /** Ids for the project's objects (default: random GUIDs). */
  newId?: () => string
  /** The date written as created and modified (default: today). */
  today?: string
}

/** The content of a new `.dez` file (a binary string, one char per byte) holding `tables`. */
export function newDezignProject(tables: TableInfo[], options: NewDezignOptions = {}): string {
  const database = options.database ?? 'postgres'
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID().toUpperCase())
  const real = translateTables(tables.filter((t) => t.type === 'table'), database)
  // Tables nobody has placed go on a grid, wide enough for a table and tall enough for the longest in its row.
  const positions: Record<string, { x: number; y: number }> = {}
  const columns = Math.max(1, Math.ceil(Math.sqrt(real.length)))
  let y = 40
  for (let row = 0; row * columns < real.length; row++) {
    const inRow = real.slice(row * columns, (row + 1) * columns)
    inRow.forEach((t, i) => {
      const key = `${t.schema ?? ''}.${t.name}`
      positions[key] = options.positions?.[key] ?? { x: 40 + i * 320, y }
    })
    y += 80 + 18 * Math.max(...inRow.map((t) => t.columns.length))
  }
  // Text is written in the Central European code page only when it needs letters the Western one lacks.
  const all = JSON.stringify(real)
  const western = new TextDecoder('windows-1252')
  const inWestern = new Set(Array.from({ length: 128 }, (_, i) => western.decode(Uint8Array.of(i + 128))))
  const encoding = [...all].some((ch) => ch.codePointAt(0)! > 127 && !inWestern.has(ch)) ? 'windows-1250' : 'windows-1252'
  const empty = emptyProject(DEZIGN_DATABASES[database], newId(), newId(), options.today ?? new Date().toISOString().slice(0, 10))
  const saved = saveToDezign([{ path: 'model.dez', text: empty }], [], real, { positions, encoding, newId })
  return saved.files[0]?.text ?? empty
}
