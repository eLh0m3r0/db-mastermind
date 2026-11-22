/**
 * The one normalisation in front of the line-based readers (DBML, Mermaid, Prisma): their line regexes are written
 * for lines people write, and a stranger's file can hold a line of a million spaces. So before any regex runs, runs
 * of spaces and tabs outside quotes and comments become one space (inside them the text is the user's and stays),
 * and a line longer than LINE_LIMIT is not read at all: the reader says so on that line. Linear in the text.
 */
export const LINE_LIMIT = 64 * 1024

export interface TextSyntax {
  /** Quote characters whose content is kept as written. */
  quotes: string
  /** DBML's '''multi-line''' strings. */
  tripleQuotes?: boolean
  /** Line comment openers (kept as written to the end of the line). */
  lineComments?: string[]
  /** Block comments (kept as written). */
  blockComments?: boolean
}

export interface NormalizedText {
  text: string
  /** 1-based numbers of the lines left empty because they were longer than LINE_LIMIT. */
  tooLong: number[]
}

export function normalizeText(input: string, syntax: TextSyntax): NormalizedText {
  const tooLong: number[] = []
  // Lines over the limit first (counted on the input, before anything is collapsed).
  const lines = input.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > LINE_LIMIT) {
      tooLong.push(i + 1)
      lines[i] = ''
    }
  }
  const text = tooLong.length ? lines.join('\n') : input
  let out = ''
  let i = 0
  const n = text.length
  while (i < n) {
    const ch = text[i]!
    if (syntax.tripleQuotes && text.startsWith("'''", i)) {
      const end = text.indexOf("'''", i + 3)
      const stop = end === -1 ? n : end + 3
      out += text.slice(i, stop)
      i = stop
      continue
    }
    if (syntax.quotes.includes(ch)) {
      // A quote ends at its partner, an escaping backslash skipped, or at the end of the line (an unclosed one).
      let j = i + 1
      while (j < n && text[j] !== ch && text[j] !== '\n') j += text[j] === '\\' && text[j + 1] !== '\n' ? 2 : 1
      const stop = j < n && text[j] === ch ? j + 1 : j
      out += text.slice(i, stop)
      i = stop
      continue
    }
    const comment = syntax.lineComments?.find((c) => text.startsWith(c, i))
    if (comment) {
      const end = text.indexOf('\n', i)
      const stop = end === -1 ? n : end
      out += text.slice(i, stop)
      i = stop
      continue
    }
    if (syntax.blockComments && ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      out += text.slice(i, stop)
      i = stop
      continue
    }
    if (ch === ' ' || ch === '\t') {
      let j = i + 1
      while (j < n && (text[j] === ' ' || text[j] === '\t')) j++
      // (Leading indentation is kept as one space too: none of the readers counts it.)
      out += ' '
      i = j
      continue
    }
    out += ch
    i++
  }
  return { text: out, tooLong }
}

export const tooLongMessage = `Line longer than ${LINE_LIMIT / 1024} KB: not read`
