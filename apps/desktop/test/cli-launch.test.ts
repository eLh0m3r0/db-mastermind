import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Starts fake `claude` / `codex` CLIs the way the app starts the real ones. On Windows they are npm-style .cmd shims
 * run through cmd.exe, which mangles quotes, `&`, `%` and spaces unless every argument is escaped right; the temporary
 * folder sits under a path like a Czech user name with a space. The fake records the arguments, stdin and the files
 * it was pointed to, and answers like the real CLI.
 */
const root = mkdtempSync(join(tmpdir(), 'dbm-cli-'))
const bin = join(root, 'bin')
const temp = join(root, 'Jan Novák & spol')
const record = join(root, 'record.json')
const saved = { PATH: process.env.PATH, SHELL: process.env.SHELL, TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }

const FAKE = `
const { readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log('9.9.9 (fake)')
  process.exit(0)
}
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
let stdin = ''
process.stdin.on('data', (d) => (stdin += d))
process.stdin.on('end', () => {
  const files = {}
  for (const flag of ['--append-system-prompt-file', '--mcp-config']) if (after(flag)) files[flag] = readFileSync(after(flag), 'utf8')
  writeFileSync(process.env.DBM_FAKE_RECORD, JSON.stringify({ args, stdin, files, token: process.env.DBM_MCP_TOKEN ?? null }))
  if (args[0] === 'exec') console.log(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'codex says hi' } }))
  else {
    console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'claude says hi' }] } }))
    console.log(JSON.stringify({ type: 'result', is_error: false, result: 'ok' }))
  }
})
`

function install(name: string) {
  const pkg = join(bin, 'node_modules', `fake-${name}`)
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(pkg, 'cli.js'), FAKE)
  if (process.platform === 'win32') {
    // What npm's cmd-shim writes for a global package.
    writeFileSync(
      join(bin, `${name}.cmd`),
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        '',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        '  SET PATHEXT=%PATHEXT:;.JS;=;%',
        ')',
        '',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-${name}\\cli.js" %*`,
        '',
      ].join('\r\n'),
    )
  } else {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec node "${join(pkg, 'cli.js')}" "$@"\n`, { mode: 0o755 })
  }
}

let runCli: typeof import('../src/main/ai/cli').runCli
let cliAvailable: typeof import('../src/main/ai/cli').cliAvailable

beforeAll(async () => {
  mkdirSync(temp, { recursive: true })
  install('claude')
  install('codex')
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`
  // Never the real CLIs from the login shell's PATH (macOS/Linux ask the shell for it).
  process.env.SHELL = '/usr/bin/false'
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = temp
  process.env.DBM_FAKE_RECORD = record
  ;({ runCli, cliAvailable } = await import('../src/main/ai/cli'))
})

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const prompt = 'Kolik je "objednávek" za 50 % & víc?\nDruhý řádek: a | b > c ^ (x) !y'
const system = 'Systém: "uvozovky", %PATH%, & a <tagy>\nřádek 2'
const mcp = { url: 'http://127.0.0.1:7337/mcp/chat-1?x=1&y=2', headers: { Authorization: 'Bearer tok"en&%x' } }

async function run(provider: 'claude-code' | 'codex') {
  const events: unknown[] = []
  await runCli({ provider, prompt, system, model: 'sonnet', mcp, signal: new AbortController().signal, onEvent: (e) => events.push(e) })
  return { events, got: JSON.parse(readFileSync(record, 'utf8')) as { args: string[]; stdin: string; files: Record<string, string>; token: string | null } }
}

describe('starting the agent CLIs', () => {
  it('finds them', async () => {
    expect(await cliAvailable('claude-code')).toBe('9.9.9 (fake)')
    expect(await cliAvailable('codex')).toBe('9.9.9 (fake)')
  })

  it('Claude Code gets every argument intact, the prompt on stdin and the files it is pointed to', async () => {
    const { events, got } = await run('claude-code')
    expect(events).toEqual([{ type: 'text', text: 'claude says hi' }])
    expect(got.stdin).toBe(prompt)
    expect(got.files['--append-system-prompt-file']).toBe(system)
    expect(JSON.parse(got.files['--mcp-config']!)).toEqual({ mcpServers: { dbmastermind: { type: 'http', url: mcp.url, headers: mcp.headers } } })
    // `--tools ""` must stay an empty argument: without it Claude Code keeps its own read-only tools.
    expect(got.args.slice(got.args.indexOf('--tools'), got.args.indexOf('--tools') + 3)).toEqual(['--tools', '', '--disallowedTools'])
    expect(got.args).toContain('--strict-mcp-config')
    expect(got.args.slice(-2)).toEqual(['--model', 'sonnet'])
  })

  it('Codex gets its -c settings with quotes intact and the token through the environment', async () => {
    const { events, got } = await run('codex')
    expect(events).toEqual([{ type: 'text', text: 'codex says hi' }])
    expect(got.stdin).toBe(`${system}\n\n---\n\n${prompt}`)
    expect(got.args).toContain(`mcp_servers.dbmastermind.url=${JSON.stringify(mcp.url)}`)
    expect(got.args).toContain('web_search="disabled"')
    expect(got.args).toContain('mcp_servers.dbmastermind.bearer_token_env_var="DBM_MCP_TOKEN"')
    expect(got.args[got.args.indexOf('-C') + 1]).toContain('Jan Novák & spol')
    expect(got.token).toBe('tok"en&%x')
    expect(got.args.at(-1)).toBe('-')
  })
})
