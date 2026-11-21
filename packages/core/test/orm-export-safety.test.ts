import { describe, expect, it } from 'vitest'
import { codeFormatsFor, commentLines, commentText, docstring, exportCode, readModelFile, stringLiteral, templateText, toDbml, parseDbml, type CodeFormat, type TableInfo } from '../src/index.js'
import { FUZZ_DATABASES, fuzzModel } from './orm-fuzz.js'
import { prismaShape, pythonShape, RAW_UNSAFE, typescriptShape } from './orm-structure.js'

/**
 * Text from a model can never become code (review H1): names, comments, defaults and enum values reach the four
 * generators only as a comment's text or a string's value. The reviewer's cases, then a seeded fuzz of hostile
 * models through every generator and database, checked by shape here and by the real parsers in the tools test.
 */
const col = (name: string, extra: Partial<TableInfo['columns'][number]> = {}) => ({ name, ordinal: 1, dataType: 'integer', nullable: false, defaultValue: null, isPrimaryKey: false, isIdentity: false, comment: null, ...extra })
const pk = (t: string) => [{ name: `${t}_pkey`, columns: ['id'], unique: true, primary: true }]

function shape(format: CodeFormat, code: string, tables: number): string[] {
  const raw = RAW_UNSAFE.exec(code)
  const problems = raw ? [`raw U+${raw[0].charCodeAt(0).toString(16).padStart(4, '0')} at ${raw.index}`] : []
  return [...problems, ...(format === 'prisma' ? prismaShape(code, tables) : format === 'sqlalchemy' ? pythonShape(code) : typescriptShape(code))]
}

describe('the code-text helpers', () => {
  it('make a comment one line with nothing that ends or closes it', () => {
    for (const lang of ['js', 'python', 'prisma'] as const) {
      expect(commentText('a\r\nb\rc\nd\u0085e\u2028f\u2029g\u0000h\u202ei', lang)).toBe('a b c d e f gh' + 'i')
      expect(commentLines('one\rtwo', '// ', lang)).toEqual(['// one', '// two'])
    }
    expect(commentText('x */ y', 'js')).toBe('x * / y')
  })

  it('make a string literal one token on one line in every language', () => {
    expect(stringLiteral('a\'b"c\\d\re\nf\u2028g\u0085h\u202e', 'js')).toBe("'a\\'b\"c\\\\d\\u000de\\nf\\u2028g\\u0085h\\u202e'")
    expect(stringLiteral('a"b\\', 'python')).toBe('"a\\"b\\\\"')
    expect(stringLiteral('a"b\r', 'prisma')).toBe('"a\\"b\\u000d"')
    expect(templateText('`${x}`\\')).toBe('\\`\\${x}\\`\\\\')
    expect(docstring('ends with a backslash \\')).toBe('"""ends with a backslash \\\\"""')
    expect(docstring('"""; import os\r#')).toBe('"""\\"\\"\\"; import os\n    #"""')
  })
})

describe("the reviewer's cases (H1)", () => {
  it('a comment with a lone CR or U+2028 stays a comment in Drizzle and TypeScript', () => {
    const tables = [{ name: 'users', type: 'table' as const, comment: 'Users\rconsole.log("PWNED_TABLE_CR")', columns: [col('id', { isPrimaryKey: true, comment: 'key _x: [console.log("PWNED_COL")],\u2028console.log(2)' })], primaryKey: ['id'], foreignKeys: [], indexes: pk('users') }]
    for (const format of ['drizzle', 'typescript'] as const) {
      const code = exportCode(format, tables, { database: 'postgres' })
      expect(shape(format, code, 1), format).toEqual([])
      expect(code.split('\n').filter((l) => /console\.log/.test(l)).every((l) => /^\s*(\/\/|\*|\/\*\*)/.test(l)), format).toBe(true)
    }
  })

  it('a key-less table named with line breaks, an odd constraint name and a CR comment add no generator to a Prisma schema', () => {
    const evil = 'x\ngenerator evil {\n  provider = "touch PWNED_PRISMA"\n}\n//'
    const tables = [
      { name: 'users', type: 'table' as const, comment: 'Accounts\rgenerator evil2 {\r  provider = "touch PWNED_PRISMA_CR"\r}\r//', columns: [col('id', { isPrimaryKey: true })], primaryKey: ['id'], foreignKeys: [], indexes: pk('users') },
      { name: evil, type: 'table' as const, comment: null, columns: [col('uid')], primaryKey: [], foreignKeys: [{ name: 'fk\nconsole.log("PWNED_FKNAME")', columns: ['uid'], refTable: 'users', refColumns: ['id'] }], indexes: [] },
      { name: 'nokey', type: 'table' as const, comment: null, columns: [col('uid')], primaryKey: [], foreignKeys: [{ name: 'f', columns: ['uid'], refTable: 'gone\ngenerator evil3 {\n  provider = "touch PWNED"\n}\n//', refColumns: ['id'] }], indexes: [] },
    ]
    const code = exportCode('prisma', tables, { database: 'postgres' })
    expect(shape('prisma', code, 3)).toEqual([])
  })

  it('a docstring ending in a backslash, then a comment with code, run nothing in SQLAlchemy (also from a drawDB file)', () => {
    const t = (name: string, comment: string) => ({ name, type: 'table' as const, comment, columns: [col('id', { isPrimaryKey: true })], primaryKey: ['id'], foreignKeys: [], indexes: pk(name) })
    const code = exportCode('sqlalchemy', [t('a', 'ends with a backslash \\'), t('b', ';__import__("os").system("echo PWNED_PY_DOC") #'), t('c', 'Log\r__import__("os").system("echo PWNED_PY")')], { database: 'postgres' })
    expect(shape('sqlalchemy', code, 3)).toEqual([])
    const draw = { database: 'postgresql', tables: [
      { id: 0, name: 'a', x: 0, y: 0, comment: 'Accounts \\', fields: [{ id: 0, name: 'id', type: 'INT', primary: true }] },
      { id: 1, name: 'b', x: 300, y: 0, comment: ';__import__("os").system("echo PWNED_FROM_DRAWDB") #', fields: [{ id: 0, name: 'id', type: 'INT', primary: true }] }], relationships: [] }
    const m = readModelFile('diagram.json', new TextEncoder().encode(JSON.stringify(draw)))
    const parsed = parseDbml(toDbml(m.tables, { enums: m.enums }))
    expect(shape('sqlalchemy', exportCode('sqlalchemy', parsed.tables, { database: 'postgres' }), 2)).toEqual([])
  })
})

describe('hostile models through every generator (seeded fuzz)', () => {
  it('declare exactly their tables, whatever their names, comments, defaults, enum values and types', () => {
    const failures: string[] = []
    let files = 0
    const start = performance.now()
    for (let seed = 1; seed <= 300; seed++) {
      for (const format of ['prisma', 'drizzle', 'sqlalchemy', 'typescript'] as const) {
        for (const database of FUZZ_DATABASES[format]) {
          if (!codeFormatsFor(database).includes(format)) continue
          const model = fuzzModel(seed * 7 + database.length, database)
          let code: string
          try {
            code = exportCode(format, model.tables, { database, enums: model.enums })
          } catch (err) {
            failures.push(`seed ${seed} ${format} ${database}: threw ${(err as Error).message}`)
            continue
          }
          files++
          let problems: string[]
          try {
            problems = shape(format, code, model.tables.length)
          } catch (err) {
            problems = [(err as Error).message]
          }
          if (problems.length) failures.push(`seed ${seed} ${format} ${database}: ${problems.slice(0, 3).join(' | ')}`)
        }
      }
    }
    console.log(`fuzz: ${files} files from 300 seeds in ${Math.round(performance.now() - start)} ms`)
    expect(failures.slice(0, 10)).toEqual([])
  })
})
