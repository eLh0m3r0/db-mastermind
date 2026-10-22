import { describe, expect, it } from 'vitest'
import { CODEX_DISABLED_FEATURES, cmdArg, codexArgs } from '../src/main/ai/cli'

describe('cmdArg (Windows: the agent CLIs run through cmd.exe)', () => {
  it('keeps each argument one argument', () => {
    expect(cmdArg('')).toBe('""')
    expect(cmdArg('--verbose')).toBe('--verbose')
    expect(cmdArg('C:\\Users\\Jan Novák\\AppData\\Local\\Temp\\dbm-agent-x\\system.md')).toBe('"C:\\Users\\Jan Novák\\AppData\\Local\\Temp\\dbm-agent-x\\system.md"')
    expect(cmdArg('a"b')).toBe('"a""b"')
    expect(cmdArg('x&y')).toBe('"x&y"')
  })
})

describe('codexArgs', () => {
  it('reads the prompt from stdin, keeps the token off the command line and switches off file and shell access', () => {
    const { args, env } = codexArgs({ mcp: { url: 'http://127.0.0.1:5555/mcp', headers: { Authorization: 'Bearer s3cret' } }, model: 'gpt-5', workdir: '/tmp/x' })
    expect(args.at(-1)).toBe('-')
    expect(args.join(' ')).not.toContain('s3cret')
    expect(env.DBM_MCP_TOKEN).toBe('s3cret')
    expect(args).toEqual(expect.arrayContaining(['--ignore-user-config', '--ephemeral', '--sandbox', 'read-only', 'mcp_servers.dbmastermind.url="http://127.0.0.1:5555/mcp"']))
    for (const feature of ['shell_tool', ...CODEX_DISABLED_FEATURES]) expect(args.join(' ')).toContain(`--disable ${feature}`)
    expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5'])
  })
})
