import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addToMcpClient, mcpClientStatuses, mergeCodexToml, mergeJsonServers } from '../src/main/mcp-clients'

const launch = { command: 'C:\\Apps\\DB Mastermind\\DB Mastermind.exe', args: ['--mcp'] }

describe('mergeJsonServers', () => {
  it('keeps other servers and settings', () => {
    const before = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } })
    const after = JSON.parse(mergeJsonServers(before, 'mcpServers', { command: 'db', args: ['--mcp'] }))
    expect(after).toEqual({ theme: 'dark', mcpServers: { other: { command: 'x' }, dbmastermind: { command: 'db', args: ['--mcp'] } } })
  })
  it('starts an empty file', () => {
    expect(JSON.parse(mergeJsonServers('', 'servers', { command: 'db' }))).toEqual({ servers: { dbmastermind: { command: 'db' } } })
  })
  it('refuses JSON with comments instead of losing them', () => {
    expect(() => mergeJsonServers('// mine\n{}', 'servers', {})).toThrow(/not plain JSON/)
  })
})

describe('mergeCodexToml', () => {
  it('appends a table with escaped Windows paths', () => {
    const out = mergeCodexToml('model = "o3"\n', launch)
    expect(out).toBe('model = "o3"\n\n[mcp_servers.dbmastermind]\ncommand = "C:\\\\Apps\\\\DB Mastermind\\\\DB Mastermind.exe"\nargs = ["--mcp"]\n')
  })
  it('replaces an existing table with its subtables, keeping what follows', () => {
    const before = '[mcp_servers.dbmastermind]\ncommand = "old"\nargs = []\n\n[mcp_servers.dbmastermind.env]\nA = "1"\n\n[mcp_servers.other]\ncommand = "o"\n'
    const out = mergeCodexToml(before, { command: 'new', args: ['--mcp'] })
    expect(out).toBe('[mcp_servers.dbmastermind]\ncommand = "new"\nargs = ["--mcp"]\n\n[mcp_servers.other]\ncommand = "o"\n')
  })
})

describe('config files', () => {
  it('reports and writes client configs with a backup', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dbm-mcp-'))
    mkdirSync(join(home, '.cursor'))
    writeFileSync(join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"a":{"command":"a"}}}')
    const env = { APPDATA: join(home, 'AppData') }
    let cursor = mcpClientStatuses(env, 'win32', home).find((c) => c.id === 'cursor')!
    expect(cursor).toMatchObject({ installed: true, configured: false })
    await addToMcpClient('cursor', launch, env, 'win32', home)
    cursor = mcpClientStatuses(env, 'win32', home).find((c) => c.id === 'cursor')!
    expect(cursor.configured).toBe(true)
    expect(readFileSync(join(home, '.cursor', 'mcp.json.bak'), 'utf8')).toContain('"a"')
    const vscode = await addToMcpClient('vscode', launch, env, 'win32', home)
    expect(vscode.path).toBe(join(home, 'AppData', 'Code', 'User', 'mcp.json'))
    expect(JSON.parse(readFileSync(vscode.path, 'utf8')).servers.dbmastermind.type).toBe('stdio')
    const codex = await addToMcpClient('codex', launch, { CODEX_HOME: join(home, 'cx') }, 'linux', home)
    expect(readFileSync(codex.path, 'utf8')).toContain('[mcp_servers.dbmastermind]')
  })
})
