/**
 * Text from a model (names, comments, defaults, enum values: a stranger's file, or a database somebody else set up)
 * written into generated code. Everything model-derived goes through one of these, per language, so it can only
 * ever be a comment's text or a string's value: never a line of its own, never code.
 *
 * - comments: one line each, every line terminator of every language removed (\r\n, \r, \n, U+0085, U+2028,
 *   U+2029: JavaScript ends a // comment at all of them, Python and Prisma at \r and \n), control characters and
 *   bidirectional overrides gone, and what would close a block comment (`*\/`) broken;
 * - string literals: backslash, the quote, every control and line-terminator character and the bidirectional
 *   overrides escaped (\uXXXX), so the literal stays one token on one line;
 * - template literals (Drizzle's sql`…`): the same, plus the backtick and `${`.
 */
export type CodeLanguage = 'js' | 'python' | 'prisma'

const BREAKS = /\r\n|[\r\n\u0085\u2028\u2029]/
// C0 and C1 controls (but tab), DEL, line and paragraph separators, bidi controls, the BOM.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** The lines of a text as a comment may show them: no line terminators inside, no control characters. */
export function textLines(text: string | null | undefined): string[] {
  if (!text?.trim()) return []
  const lines = text.split(BREAKS).map((l) => l.replace(/\t/g, ' ').replace(UNSAFE, '').trimEnd())
  while (lines.length && !lines.at(-1)!.trim()) lines.pop()
  while (lines.length && !lines[0]!.trim()) lines.shift()
  return lines
}

/** One comment line's text (several lines of the source joined with spaces). */
export function commentText(text: string | null | undefined, language: CodeLanguage): string {
  const line = textLines(text).join(' ').trim()
  // (A // comment can't be closed early, but the same text also goes into /** … *\/ blocks.)
  return language === 'js' ? line.replaceAll('*/', '* /') : line
}

/** A comment of several lines, each line with its prefix (`// `, `/// `, ` * `, `# `). */
export function commentLines(text: string | null | undefined, prefix: string, language: CodeLanguage): string[] {
  return textLines(text).map((l) => `${prefix}${commentText(l, language)}`.trimEnd())
}

const hex = (c: string, width: number) => c.charCodeAt(0).toString(16).padStart(width, '0')

/** A string literal of the language: `'…'` for JavaScript, `"…"` for Python and Prisma. */
export function stringLiteral(text: string, language: CodeLanguage): string {
  const quote = language === 'js' ? "'" : '"'
  let out = ''
  for (const ch of text) {
    if (ch === '\\') out += '\\\\'
    else if (ch === quote) out += `\\${quote}`
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(ch)) out += `\\u${hex(ch, 4)}`
    else out += ch
  }
  return `${quote}${out}${quote}`
}

/** The inside of a JavaScript template literal (Drizzle's sql`…`): one line, nothing interpolated. */
export function templateText(text: string): string {
  return stringLiteral(text, 'js').slice(1, -1).replaceAll("\\'", "'").replaceAll('`', '\\`').replaceAll('${', '\\${')
}

/** A Python docstring's literal: a string the class starts with (triple-quoted, nothing in it can end it). */
export function docstring(text: string | null | undefined): string {
  const body = textLines(text)
    .map((l) => l.replaceAll('\\', '\\\\').replaceAll('"', '\\"'))
    .join('\n    ')
  return `"""${body}"""`
}
