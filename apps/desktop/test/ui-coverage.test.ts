import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { cs } from '../src/renderer/src/lib/i18n-cs'

// Small things nobody tests by hand: English text in the Czech UI, a menu item whose command nothing handles.
const src = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')
const unescape = (s: string) => s.replace(/\\(.)/g, (_, c: string) => (c === 'n' ? '\n' : c))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : []
  })
}

/** The bodies of the `onCommand((command) => { … })` listeners in a source file (braces counted, strings skipped). */
function commandListeners(source: string): string[] {
  const out: string[] = []
  for (const m of source.matchAll(/onCommand\(\(command\)\s*=>\s*\{/g)) {
    const start = m.index! + m[0].length
    let depth = 1
    let quote: string | undefined
    let i = start
    for (; i < source.length && depth > 0; i++) {
      const c = source[i]!
      if (quote) {
        if (c === '\\') i++
        else if (c === quote) quote = undefined
      } else if (c === "'" || c === '"' || c === '`') quote = c
      else if (c === '{') depth++
      else if (c === '}') depth--
    }
    out.push(source.slice(start, i))
  }
  return out
}

describe('UI coverage', () => {
  it('every literal passed to t() has a Czech translation', () => {
    const root = new URL('../src/renderer/src', import.meta.url).pathname
    const missing = new Set<string>()
    for (const file of files(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
        const key = unescape(m[2]!)
        if (!(key in cs)) missing.add(`${key}  (${file.slice(root.length + 1)})`)
      }
      // Template literals without placeholders are keys too.
      for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*`((?:[^`\\$]|\\.)*)`/g)) {
        const key = unescape(m[1]!)
        if (!(key in cs)) missing.add(`${key}  (${file.slice(root.length + 1)})`)
      }
    }
    expect([...missing]).toEqual([])
  })

  const menu = src('main/menu.ts')
  const dictionary = menu.slice(menu.indexOf('const CS'), menu.indexOf('}', menu.indexOf('const CS')))

  it('every native menu label has a Czech translation', () => {
    const missing = [...menu.matchAll(/\bm\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]!)).filter((label) => !dictionary.includes(`'${label}':`) && !dictionary.includes(`${label}:`))
    expect(missing).toEqual([])
  })

  it('every command the menu sends is handled by the window', () => {
    const root = new URL('../src/renderer/src', import.meta.url).pathname
    // Only the command listeners count (`onCommand((command) => { … })`): a `case 'find'` in an unrelated switch
    // handles nothing the menu sends.
    const listeners = files(root).flatMap((f) => commandListeners(readFileSync(f, 'utf8'))).join('\n')
    const sent = [...menu.matchAll(/cmd\(m\('(?:[^'\\]|\\.)*'\), '([\w-]+)'/g)].map((m) => m[1]!)
    expect(sent.length).toBeGreaterThan(10)
    expect(listeners.length).toBeGreaterThan(1000)
    expect(sent.filter((command) => !listeners.includes(`case '${command}'`) && !listeners.includes(`=== '${command}'`))).toEqual([])
  })

  it('the command listener check sees only what a listener handles', () => {
    const code = "switch (tab) { case 'history': break }\nonCommand((command) => {\n  if (command === 'save') save()\n  switch (command) { case 'find': { find() } }\n})\nconst x = { y: 1 }"
    const bodies = commandListeners(code).join('\n')
    expect(bodies).toContain("command === 'save'")
    expect(bodies).toContain("case 'find'")
    expect(bodies).not.toContain("case 'history'")
  })
})

describe('Keyboard shortcuts', () => {
  it('Help → Keyboard Shortcuts names every command in the keymap', () => {
    const keymap = src('renderer/src/lib/keymap.ts')
    const block = keymap.slice(keymap.indexOf('const KEYMAP'), keymap.indexOf('\n}', keymap.indexOf('const KEYMAP')))
    const commands = [...block.matchAll(/:\s*'([\w-]+)',/g)].map((m) => m[1]!)
    const modal = src('renderer/src/features/shell/ShortcutsModal.tsx')
    expect(commands.length).toBeGreaterThan(10)
    expect(commands.filter((c) => !modal.includes(`'${c}': {`) && !modal.includes(`  ${c}: {`))).toEqual([])
  })

  it('shortcut text goes through keys() (Ctrl+T on Windows and Linux, not "CtrlT")', () => {
    const root = new URL('../src/renderer/src', import.meta.url).pathname
    expect(files(root).filter((f) => /\$\{modKey\}./.test(readFileSync(f, 'utf8')))).toEqual([])
  })
})
