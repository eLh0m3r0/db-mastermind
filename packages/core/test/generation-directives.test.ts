import { describe, expect, it } from 'vitest'
import {
  applyGenerationDirectives,
  generationDirectivesIn,
  tablesWithDirectives,
  parseDbml,
} from '../src/index.js'

// As DeZign's manual describes conditional generation (Expert edition).
const code = `CREATE VIEW %viewname% AS
SELECT id,
{$IFDEF SQL2008}
  total,
{$ENDIF SQL2008}
{$IFNOTDEF SQL2008}
  amount AS total,
{$ENDIF SQL2008}
  issued
FROM invoice`

describe('generation directives', () => {
  it('keeps the parts the applied directives ask for, and drops the directives', () => {
    expect(applyGenerationDirectives(code, ['sql2008'])).toBe(
      'CREATE VIEW %viewname% AS\nSELECT id,\n  total,\n  issued\nFROM invoice',
    )
    expect(applyGenerationDirectives(code, [])).toBe(
      'CREATE VIEW %viewname% AS\nSELECT id,\n  amount AS total,\n  issued\nFROM invoice',
    )
    expect(generationDirectivesIn(code, 'x {$IFDEF Audit} y {$ENDIF Audit}')).toEqual(['SQL2008', 'Audit'])
  })

  it('nests, and works inside one line', () => {
    const nested = 'a {$IFDEF A}b {$IFDEF B}c {$ENDIF B}d {$ENDIF A}e'
    expect(applyGenerationDirectives(nested, ['A', 'B'])).toBe('a b c d e')
    expect(applyGenerationDirectives(nested, ['A'])).toBe('a b d e')
    expect(applyGenerationDirectives(nested, ['B'])).toBe('a e')
    expect(applyGenerationDirectives('no directives', ['A'])).toBe('no directives')
  })

  it("applies to a model's check constraints; a check left empty is no check", () => {
    const tables = parseDbml(
      'Table t {\n  total int\n\n  checks {\n    `total >= 0 {$IFDEF Strict}AND total < 1000{$ENDIF Strict}`\n    `{$IFDEF Strict}total <> 13{$ENDIF Strict}`\n  }\n}\n',
    ).tables
    expect(tablesWithDirectives(tables, ['strict'])[0]!.checks!.map((c) => c.expression)).toEqual([
      'total >= 0 AND total < 1000',
      'total <> 13',
    ])
    expect(tablesWithDirectives(tables, [])[0]!.checks!.map((c) => c.expression)).toEqual(['total >= 0'])
  })
})
