import { DuckDBDriver } from './drivers/duckdb.js'
import { splitStatements } from './sql-split.js'
import type { TableInfo } from './types.js'

export interface DdlImportResult {
  tables: TableInfo[]
  /** Statements DuckDB couldn't run (skipped). */
  skipped: { sql: string; error: string }[]
}

/** Smooths over dialect syntax DuckDB doesn't speak (MySQL, SQL Server, PostgreSQL extras). */
function normalize(sql: string): string {
  return (
    sql
      .replace(/^\s*GO\s*$/gim, ';')
      // Default schemas map to DuckDB's main schema.
      .replace(/(^|[\s(,])(?:"?public"?|"?dbo"?|\[dbo\])\s*\.\s*(?=["\[`\w])/gi, '$1')
      .replace(/`([^`]+)`/g, '"$1"')
      .replace(/\[([^\]\r\n]+)\]/g, '"$1"')
      // SSMS brackets type names too: [int], [nvarchar](max).
      .replace(/"(int|bigint|smallint|tinyint|bit|nvarchar|varchar|nchar|char|datetime2?|smalldatetime|date|time|datetimeoffset|decimal|numeric|float|real|money|smallmoney|uniqueidentifier|varbinary|binary|text|ntext|xml|image|sysname)"/gi, '$1')
      .replace(/\s+(ASC|DESC)(?=\s*[,)])/gi, '')
      .replace(/\b(TEXTIMAGE_ON|ON)\s+"PRIMARY"/gi, '')
      .replace(/\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, '')
      .replace(/\bAUTO_INCREMENT\b(\s*=\s*\d+)?/gi, '')
      .replace(/\b(GENERATED\s+(ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY(\s*\([^)]*\))?)/gi, '')
      // Table options (ENGINE=…, CHARSET=…) always have '='; column COLLATE doesn't.
      .replace(/\)\s*(ENGINE|DEFAULT\s+CHARSET|CHARSET|COLLATE|ROW_FORMAT)\s*=[^;]*;/gi, ');')
      .replace(/\b(CHARACTER\s+SET|CHARSET)\s+\w+/gi, '')
      .replace(/\bCOLLATE\s+"?[\w.]+"?/gi, '')
      .replace(/\bUNSIGNED\b/gi, '')
      .replace(/\bCOMMENT\s+'(?:[^']|'')*'/gi, '')
      .replace(/\b(N?VARCHAR|NCHAR|VARBINARY)\s*\(\s*MAX\s*\)/gi, '$1')
      .replace(/\bON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\d*\))?/gi, '')
      .replace(/\bWITH\s*\((?:[^()]|\([^)]*\))*\)\s*(ON\s+"?PRIMARY"?)?/gi, '')
      .replace(/\bON\s+PRIMARY\b/gi, '')
      .replace(/\bCLUSTERED\b|\bNONCLUSTERED\b/gi, '')
      .replace(/\bDATETIME2\b|\bSMALLDATETIME\b/gi, 'TIMESTAMP')
      .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
      .replace(/\b(TINYTEXT|MEDIUMTEXT|LONGTEXT|NTEXT)\b/gi, 'TEXT')
      .replace(/\bNVARCHAR\b/gi, 'VARCHAR')
      .replace(/\b(MEDIUMINT)\b/gi, 'INTEGER')
      .replace(/\bBIT\b/gi, 'BOOLEAN')
      .replace(/\bTINYINT\s*\(\s*1\s*\)/gi, 'BOOLEAN')
      .replace(/\b(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)\s*\(\s*\d+\s*\)/gi, '$1')
      .replace(/\bJSONB\b/gi, 'JSON')
      .replace(/\bBYTEA\b/gi, 'BLOB')
      .replace(/\b(CITEXT|INET|CIDR|MACADDR|TSVECTOR)\b/gi, 'VARCHAR')
      .replace(/(CREATE\s+SEQUENCE\s+\S+)\s+AS\s+\w+/gi, '$1')
      .replace(/\bUSING\s+(btree|hash|gin|gist|brin)\b/gi, '')
      .replace(/\bSERIAL\b/gi, 'INTEGER')
      .replace(/\bBIGSERIAL\b/gi, 'BIGINT')
  )
}

const RELEVANT = /^\s*(CREATE\s+(TABLE|UNIQUE\s+INDEX|INDEX|VIEW)|COMMENT\s+ON)\b/i
const NAME = String.raw`(?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?`
const tableKey = (name: string) => name.replace(/"/g, '').split('.').pop()!.trim().toLowerCase()

/** Statement text without the comments dumps put in front of it. */
function stripLeadingComments(sql: string): string {
  let s = sql
  for (;;) {
    const t = s.replace(/^\s*--[^\n]*\n?/, '').replace(/^\s*\/\*(?!!)[\s\S]*?\*\//, '')
    if (t === s) return s.trim()
    s = t
  }
}

/** MySQL declares indexes inside CREATE TABLE (`KEY name (cols)`): move them to CREATE INDEX statements. */
function extractInlineIndexes(statement: string): string[] {
  const m = new RegExp(`^\\s*CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})\\s*\\(`, 'i').exec(statement)
  if (!m) return [statement]
  const indexes: string[] = []
  const lines = statement.split('\n')
  const kept: string[] = []
  for (const line of lines) {
    const ix = /^\s*(UNIQUE\s+|FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+("[^"]+"|[\w$]+)\s*(\([^)]*\))\s*,?\s*$/i.exec(line)
    if (!ix) {
      kept.push(line)
      continue
    }
    if (/FULLTEXT|SPATIAL/i.test(ix[1] ?? '')) continue
    const cols = ix[3]!.replace(/\(\d+\)/g, '')
    indexes.push(`CREATE ${ix[1]?.trim().toUpperCase() === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${ix[2]} ON ${m[1]} ${cols}`)
  }
  // Removing lines can leave a dangling comma before the closing parenthesis.
  const body = kept.join('\n').replace(/,(\s*\n\s*\))/, '$1')
  return [body, ...indexes]
}

/**
 * DuckDB can't add keys to an existing table, but dumps declare them with ALTER TABLE … ADD CONSTRAINT after
 * the CREATE TABLE: fold those clauses into the CREATE statements.
 */
function foldConstraints(statements: string[]): string[] {
  const creates = new Map<string, number>()
  statements.forEach((s, i) => {
    const m = new RegExp(`^\\s*CREATE\\s+(?:UNLOGGED\\s+|TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${NAME})`, 'i').exec(s)
    if (m) creates.set(tableKey(m[1]!), i)
  })
  const out = [...statements]
  for (let i = 0; i < out.length; i++) {
    const m = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(?:ONLY\\s+)?(?:IF\\s+EXISTS\\s+)?(${NAME})\\s+ADD\\s+((?:CONSTRAINT\\s+\\S+\\s+)?(?:PRIMARY\\s+KEY|FOREIGN\\s+KEY|UNIQUE)[\\s\\S]*)$`, 'i').exec(out[i]!)
    if (!m) continue
    const target = creates.get(tableKey(m[1]!))
    if (target === undefined) continue
    const create = out[target]!
    const close = create.lastIndexOf(')')
    // Referential actions DuckDB doesn't support are dropped; NOT VALID / DEFERRABLE likewise.
    const clause = m[2]!.replace(/\bON\s+(DELETE|UPDATE)\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi, '').replace(/\b(NOT\s+VALID|(NOT\s+)?DEFERRABLE(\s+INITIALLY\s+\w+)?|USING\s+INDEX\b.*)$/gi, '')
    out[target] = `${create.slice(0, close).trimEnd()},\n  ${clause.trim()}\n${create.slice(close)}`
    out[i] = ''
  }
  return out.filter(Boolean)
}

/**
 * Tables from a SQL DDL script (pg_dump --schema-only, mysqldump --no-data, SSMS "script as CREATE"…), read by
 * running it in a scratch in-memory DuckDB. Statements DuckDB can't run are reported and skipped.
 */
export async function tablesFromDdl(script: string): Promise<DdlImportResult> {
  const driver = new DuckDBDriver({ id: 'ddl-import', name: 'ddl-import', driver: 'duckdb' })
  await driver.connect()
  const skipped: DdlImportResult['skipped'] = []
  try {
    const statements = foldConstraints(splitStatements(normalize(script), 'postgres').flatMap((s) => extractInlineIndexes(stripLeadingComments(s.text))))
      .map((s) => s.replace(/\bON\s+(DELETE|UPDATE)\s+(CASCADE|SET\s+NULL|SET\s+DEFAULT|RESTRICT|NO\s+ACTION)/gi, ''))
    // Other schemas than the default ones become DuckDB schemas.
    // CREATE SCHEMA statements in the script are fine to fail: the schemas are created up front.
    for (const m of statements.join('\n').matchAll(/\bTABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([\w$]+)"?\s*\.\s*"?[\w$]+/gi)) {
      await driver.execute(`CREATE SCHEMA IF NOT EXISTS "${m[1]!.replaceAll('"', '')}"`).catch(() => {})
    }
    // Foreign keys may point at tables created later in the script: retry failed statements until nothing changes.
    let pending = statements.filter((s) => RELEVANT.test(s))
    for (let round = 0; round < 5 && pending.length; round++) {
      const failed: string[] = []
      for (let sql of pending) {
        // A type DuckDB doesn't know (domains, extensions) becomes VARCHAR; the model only needs the column.
        for (let attempt = 0; attempt < 5; attempt++) {
          try {
            await driver.execute(sql)
            sql = ''
            break
          } catch (err) {
            const type = /Type with name "?([\w$.]+)"? does not exist/i.exec(err instanceof Error ? err.message : '')?.[1]
            if (!type) break
            sql = sql.replace(new RegExp(`(?<![\\w$"])${type.replace(/[.$]/g, '\\$&')}(?![\\w$"])(\\s*\\([^)]*\\))?`, 'gi'), 'VARCHAR')
          }
        }
        if (sql) failed.push(sql)
      }
      if (failed.length === pending.length) break
      pending = failed
    }
    for (const sql of pending) {
      try {
        await driver.execute(sql)
      } catch (err) {
        skipped.push({ sql: sql.slice(0, 300), error: err instanceof Error ? err.message.split('\n')[0]! : String(err) })
      }
    }
    const snapshot = await driver.introspect()
    return { tables: snapshot.tables, skipped }
  } finally {
    await driver.close()
  }
}
