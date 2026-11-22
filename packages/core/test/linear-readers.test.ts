import { describe, expect, it } from 'vitest'
import { isPlainCheck, isPlainType, modelFormatOf, parseDbml, parseDotenv, plainDefault, plainIndexPart, projectConnections, servicesFromCompose, sqlTextProblem, tablesFromDdl, tablesFromMermaid, tablesFromPrisma } from '../src/index.js'
import { growth, growthAsync, LINEAR } from './growth.js'

/**
 * Review N2/N11: every line-based reader, and the grammars for SQL from other tools, in time linear in their input.
 * The inputs are made from each reader's own constructs (`X` in a template) filled with a repeated unit: runs of
 * whitespace, long tokens and repeated delimiters, the things a regex backtracks over. Asserted on growth from n to
 * 4n (growth.ts), never on milliseconds.
 */
const UNITS = [' ', '\t', '\n', 'a', 'a ', 'a,', '(', '(a', ')', '[', ']', '[a', '"', "'", '`', ':', '.', '-', '--', '{', '}', '@', '#', '=', '$', '${', ',', '|', '\\', ', ', 'x to ', '|o', '--o{', 'PK, ', '"a" ', '/*', '::', 'KEY (']

const SYNC: Record<string, [(s: string) => unknown, string[]]> = {
  Mermaid: [tablesFromMermaid, ['erDiagram\n  AX\n', 'erDiagram\n  A X!\n', 'erDiagram\n  AX||--o{ BX!\n', 'erDiagram\n  A {\n    int xX!\n  }\n', 'erDiagram\n  A {\n    X\n  }\n', 'erDiagram\n  A {\n    int x PKX\n  }\n', 'erDiagram\n  A {\n    int x "X\n  }\n', 'erDiagram\n  A X to B\n', 'erDiagram\n  A ||--o{ B : X\n', 'erDiagram\n  AX{\n', '```mermaid\nerDiagram\n  AX\n```\n']],
  DBML: [(s) => parseDbml(s), ['Table tX {\n}\n', 'Table t {\n  a intX!\n}\n', 'Table t {\n  a int [X\n}\n', 'Table t {\n  a int [\n  b intX!\n}\n', 'Ref: a.bX > c.d\n', 'Table t {\n  id int\n  indexes {\n    X\n  }\n}\n', 'Enum e {\n  aX\n}\n', "Table t {\n  Note: 'X\n}\n", "Table t {\n  Note: '''X'''\n}\n", 'Table t {\n  a int [default: `X`]\n}\n', 'Table t [X] {\n}\n']],
  Prisma: [tablesFromPrisma, ['model AX {\n}\n', 'model A {\n  id Int @id\n  b StringX!\n}\n', 'model A {\n  id Int @id @default(X\n}\n', 'model A {\n  id Int @id\n  @@index([X])\n}\n', 'enum E {\n  aX\n}\n', '/// X\nmodel A {\n  id Int @id\n}\n', 'model A {\n  id String @default("X")\n}\n']],
  '.env': [parseDotenv, ['AX=1\n', 'A=X\n', 'A="X\n', "A='X\n", 'A=${B:-X}\n', 'A=X # c\n']],
  'project .env': [(s) => projectConnections({ '.env': s }, 'p', { folder: true }), ['DATABASE_URL=postgres://X@h/db\n', 'DB_HOST=X\nDB_DATABASE=d\n']],
  'project Prisma': [(s) => projectConnections({ 'prisma/schema.prisma': s }, 'p', { folder: true }), ['datasource db {\n  provider = "postgresql"\n  url = env("X")\n}\n', 'datasource db {X\n']],
  compose: [(s) => servicesFromCompose(s, {}, 'p'), ['services:\n  db:\n    image: postgres:16X\n    ports: ["5432:5432"]\n', 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_PASSWORD: X\n    ports: ["5432:5432"]\n']],
  'format sniff': [(s) => modelFormatOf('a.md', s) ?? modelFormatOf('a.txt', s), ['X', '```mermaid X', 'erDiagramX']],
  'foreign SQL': [(s) => [isPlainCheck(s, { doubleQuotes: true }), isPlainType(s), plainDefault(s), plainIndexPart(s, ['a'])], ['X', 'a X b', '(X)', "'X", 'int X', 'varchar(X)', 'f(X)', "'a'::X"]],
  'SQL guard': [(s) => [sqlTextProblem(s, 'mysql'), sqlTextProblem(s, 'postgres'), sqlTextProblem(s, 'mssql')], ['X', "'X", '(X', '$X', '/*X']],
}

describe('readers grow linearly on adversarial input (review N2, N11)', () => {
  for (const [reader, [run, templates]] of Object.entries(SYNC)) {
    it(reader, { timeout: 300_000 }, () => {
      const report: string[] = []
      let worst = 0
      for (const tpl of templates) {
        for (const unit of UNITS) {
          const prepare = (n: number) => {
            const input = tpl.replace('X', unit.repeat(Math.ceil(n / unit.length)))
            return () => run(input)
          }
          // (A busy machine can slow one run: what looks super-linear is measured once more.)
          let g = growth(prepare, 8000)
          // (Other test files run at the same time: a busy moment is measured again, up to three times.)
          for (let again = 0; again < 3 && g.ratio >= LINEAR; again++) g = growth(prepare, 8000)
          worst = Math.max(worst, g.ratio)
          if (g.ratio >= LINEAR) report.push(`${JSON.stringify(tpl)} × ${JSON.stringify(unit)}: ×${g.ratio.toFixed(1)} (${g.small.toFixed(1)} → ${g.large.toFixed(1)} ms)`)
        }
      }
      console.log(`${reader}: ${templates.length * UNITS.length} inputs, worst growth ×${worst.toFixed(1)} for 4× the input`)
      expect(report).toEqual([])
    })
  }

  // The SQL reader runs DuckDB after its own regexes: fewer, larger inputs (DuckDB's own time is linear here).
  it('SQL script reader', { timeout: 600_000 }, async () => {
    const templates = ['CREATE TABLE tX (a int);', 'CREATE TABLE t (a intX);', 'CREATE TABLE t (a int, KEY k (aX));', 'CREATE TABLE t (a int, CHECK (X));', "COMMENT ON TABLE t IS 'X';", 'ALTER TABLE t ADD CONSTRAINT cX FOREIGN KEY (a) REFERENCES u(b);', 'CREATE INDEX i ON t (X);', 'CREATE TABLE t (a int) X;']
    const units = [' ', '\n', 'a', '[', '(', '/*', '"', '--', 'KEY (', ',']
    const report: string[] = []
    let worst = 0
    for (const tpl of templates) {
      for (const unit of units) {
        const prepare = (n: number) => {
          const input = tpl.replace('X', unit.repeat(Math.ceil(n / unit.length)))
          return () => tablesFromDdl(input)
        }
        let g = await growthAsync(prepare, 8000)
        if (g.ratio >= LINEAR) g = await growthAsync(prepare, 8000)
        worst = Math.max(worst, g.ratio)
        if (g.ratio >= LINEAR) report.push(`${JSON.stringify(tpl)} × ${JSON.stringify(unit)}: ×${g.ratio.toFixed(1)}`)
      }
    }
    console.log(`SQL script reader: ${templates.length * units.length} inputs, worst growth ×${worst.toFixed(1)} for 4× the input`)
    expect(report).toEqual([])
  })
})
