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

describe('UI coverage', () => {
  it('every literal passed to t() has a Czech translation', () => {
    const root = new URL('../src/renderer/src', import.meta.url).pathname
    const missing = new Set<string>()
    for (const file of files(root)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
        const key = unescape(m[2]!)
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
    const renderer = files(root).map((f) => readFileSync(f, 'utf8')).join('\n')
    const sent = [...menu.matchAll(/cmd\(m\('(?:[^'\\]|\\.)*'\), '([\w-]+)'/g)].map((m) => m[1]!)
    expect(sent.length).toBeGreaterThan(10)
    expect(sent.filter((command) => !renderer.includes(`case '${command}'`) && !renderer.includes(`=== '${command}'`))).toEqual([])
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
