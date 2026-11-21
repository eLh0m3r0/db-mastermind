/**
 * The shape of generated code, checked without the tools (the unit suite): which lines start a declaration at the
 * top level of the file and inside its blocks, read with a small tokenizer of each language's strings, comments and
 * brackets. A name or a comment that broke out of its string or comment shows up as a line that starts something
 * else. The tools test parses the same code with the real parsers.
 */

/** Characters generated code must never hold raw: everything but `\n` that a language may read as a line end or hide. */
export const RAW_UNSAFE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/

interface Line {
  text: string
  /** Bracket depth and whether the line starts inside a string or comment. */
  depth: number
  inside: boolean
}

/** Lines with the state each starts in. `quotes`: string delimiters; `comment`: line comment opener; `block`: block comment. */
function scan(code: string, options: { quotes: string[]; triple?: boolean; comment: string; block?: [string, string] }): Line[] {
  const out: Line[] = []
  let depth = 0
  let inString: string | null = null
  let inBlock = false
  let i = 0
  let lineStart = true
  while (i < code.length) {
    if (lineStart) {
      const end = code.indexOf('\n', i)
      out.push({ text: code.slice(i, end === -1 ? code.length : end), depth, inside: inString !== null || inBlock })
      lineStart = false
    }
    const ch = code[i]!
    if (ch === '\n') {
      // A single-quoted string never runs over a line end.
      if (inString && inString.length === 1) throw new Error(`a string runs over a line end: ${out.at(-1)?.text.slice(0, 80)}`)
      lineStart = true
      i++
      continue
    }
    if (inBlock) {
      if (code.startsWith(options.block![1], i)) {
        inBlock = false
        i += options.block![1].length
      } else i++
      continue
    }
    if (inString) {
      if (ch === '\\') i += 2
      else if (code.startsWith(inString, i)) {
        i += inString.length
        inString = null
      } else i++
      continue
    }
    if (code.startsWith(options.comment, i)) {
      const end = code.indexOf('\n', i)
      i = end === -1 ? code.length : end
      continue
    }
    if (options.block && code.startsWith(options.block[0], i)) {
      inBlock = true
      i += options.block[0].length
      continue
    }
    if (options.triple && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      inString = code.slice(i, i + 3)
      i += 3
      continue
    }
    if (options.quotes.includes(ch)) {
      inString = ch
      i++
      continue
    }
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
    i++
  }
  if (inString || inBlock) throw new Error('the file ends inside a string or comment')
  if (depth !== 0) throw new Error(`brackets don't balance (${depth})`)
  return out
}

/** Problems with a Prisma schema's shape: top-level blocks other than ours, lines in a model that aren't fields. */
export function prismaShape(code: string, tables: number): string[] {
  const problems: string[] = []
  const lines = scan(code, { quotes: ['"'], comment: '//' })
  const blocks: string[] = []
  for (const l of lines) {
    const t = l.text.trim()
    if (l.inside || !t) continue
    if (l.depth === 0) {
      const head = /^(generator|datasource|model|enum)\s+(\w+)\s*\{$/.exec(t)
      if (head) blocks.push(`${head[1]} ${head[2]}`)
      else if (!t.startsWith('//')) problems.push(`top level: ${t.slice(0, 80)}`)
    } else if (l.depth === 1 && !/^(\w+\s|\w+$|@@|\/\/|\}$)/.test(t)) problems.push(`in a block: ${t.slice(0, 80)}`)
  }
  const kinds = (k: string) => blocks.filter((b) => b.startsWith(`${k} `))
  if (JSON.stringify(kinds('generator')) !== JSON.stringify(['generator client'])) problems.push(`generators: ${kinds('generator').join(', ')}`)
  if (JSON.stringify(kinds('datasource')) !== JSON.stringify(['datasource db'])) problems.push(`datasources: ${kinds('datasource').join(', ')}`)
  if (kinds('model').length !== tables) problems.push(`models: ${kinds('model').length} of ${tables}`)
  return problems
}

/** Problems with a TypeScript file's shape: a top-level line that isn't an import, an export or a const. */
export function typescriptShape(code: string): string[] {
  const problems: string[] = []
  for (const l of scan(code, { quotes: ["'", '"', '`'], comment: '//', block: ['/*', '*/'] })) {
    const t = l.text.trim()
    if (l.inside || !t || l.depth !== 0) continue
    if (!/^(import |export |const |\/\/|\/\*\*|\}|\]\)|\);?$)/.test(t)) problems.push(`top level: ${t.slice(0, 80)}`)
  }
  return problems
}

/** Problems with a Python module's shape: top-level lines other than imports, classes and tables; class lines other than ours. */
export function pythonShape(code: string): string[] {
  const problems: string[] = []
  for (const l of scan(code, { quotes: ['"', "'"], triple: true, comment: '#' })) {
    const t = l.text.trim()
    if (l.inside || !t || l.depth !== 0) continue
    const indent = l.text.length - l.text.trimStart().length
    if (indent === 0 && !/^(from |import |class \w+\((Base|DeclarativeBase|types\.UserDefinedType)\):$|t_\w+ = Table\($|\)$|#)/.test(t)) problems.push(`top level: ${t.slice(0, 80)}`)
    if (indent === 4 && !/^("""|"|__tablename__ = |__table_args__ = \($|\w+: Mapped\[|cache_ok = True$|def \w+\(|pass$|\)$|#)/.test(t)) problems.push(`in a class: ${t.slice(0, 80)}`)
    if (indent > 8) problems.push(`nested deeper than ours: ${t.slice(0, 80)}`)
  }
  return problems
}
