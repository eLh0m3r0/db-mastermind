import type { DriverId } from './types.js'

/**
 * Text a model gives as SQL (a type, a default, a check, an index expression) is written into the DDL as it is: a
 * model is data, and a `.dbml` from a stranger is as untrusted as any other file. Such text may only be one piece
 * of the statement it goes into: every quote and comment closed where the database and our splitter
 * (sql-split.ts) both see it closed, parentheses balanced, and nothing that ends a statement or a batch.
 * `sqlTextProblem` says what is wrong with a piece, or undefined when it is fine; the generators leave out a piece
 * that has a problem and say so (ddl.ts `guardChanges`).
 */
export function sqlTextProblem(text: string, driver: DriverId): string | undefined {
  const mysql = driver === 'mysql' || driver === 'mariadb'
  const pg = driver === 'postgres' || driver === 'duckdb'
  if (text.includes('\u0000')) return 'a NUL character'
  // Lines our splitter (or the database's client) reads as commands of their own, wherever they are.
  for (const line of text.split(/\r\n|[\r\n]/)) {
    if (driver === 'mssql' && /^\s*go\s*$/i.test(line)) return 'a GO line'
    if (driver === 'oracle' && /^\s*\/\s*$/.test(line)) return 'a "/" line'
    if (mysql && /^\s*delimiter\s/i.test(line)) return 'a DELIMITER line'
    if (pg && /^\s*\\/.test(line)) return 'a psql command line'
  }
  if (pg && /\bbegin\s+atomic\b/i.test(text)) return 'BEGIN ATOMIC'
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    const next = text[i + 1]
    // Comments are fine when they are closed inside the piece: a line comment by a line break, a block by its */.
    if ((ch === '-' && next === '-') || (ch === '#' && mysql)) {
      // (MySQL reads `--` as a comment only before a space: `a--1` is a minus minus one there, a comment to us.)
      if (mysql && ch === '-' && !/[ \t\r\n]/.test(text[i + 2] ?? '')) return 'a "--" MySQL reads as two minus signs'
      const end = text.slice(i).search(/[\r\n]/)
      if (end === -1) return 'a line comment that runs to the end'
      i += end
      continue
    }
    if (ch === '/' && next === '*') {
      if (mysql && /[!+]/.test(text[i + 2] ?? '')) return 'a MySQL comment that runs as SQL (/*! or /*+)'
      let nest = 1
      let j = i + 2
      while (j < text.length && nest > 0) {
        if (pg && text[j] === '/' && text[j + 1] === '*') {
          nest++
          j += 2
        } else if (text[j] === '*' && text[j + 1] === '/') {
          nest--
          j += 2
        } else j++
      }
      if (nest > 0) return 'an unclosed /* comment'
      i = j - 1
      continue
    }
    if (ch === '*' && next === '/') return 'a */ without its /*'
    if (ch === ';') return 'a semicolon'
    if (ch === '(') depth++
    else if (ch === ')' && --depth < 0) return 'a ")" without its "("'
    else if (ch === '$' && pg && !/[\w$]/.test(text[i - 1] ?? '') && /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.test(text.slice(i, i + 66))) return 'dollar quoting'
    else if (ch === '`' && !mysql && driver !== 'sqlite') return 'a backtick (not a quote in this database)'
    else if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && driver === 'mssql')) {
      const close = ch === '[' ? ']' : ch
      const escapeString = ch === "'" && pg && /[eE]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i - 2] ?? '')
      // MySQL reads a backslash in a string as an escape unless NO_BACKSLASH_ESCAPES is set: what such a string
      // contains depends on the server's sql_mode, so it is never taken.
      const backslashes = (mysql && ch !== '`') || escapeString
      let j = i + 1
      let closed = false
      while (j < text.length) {
        const c = text[j]!
        if (c === '\\' && (mysql && ch !== '`')) return 'a backslash in a string (MySQL reads it by sql_mode)'
        if (c === '\\' && backslashes) {
          j += 2
          continue
        }
        if (c === close) {
          if (text[j + 1] === close) {
            j += 2
            continue
          }
          closed = true
          break
        }
        j++
      }
      if (!closed) return `an unclosed ${ch}`
      i = j
    }
  }
  return depth ? 'a "(" without its ")"' : undefined
}

/** One line for a comment or a warning: line breaks of every kind become spaces, controls go. */
export function oneLine(text: string): string {
  return text
    .replace(/\r\n|[\r\n\u0085\u2028\u2029]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
}
