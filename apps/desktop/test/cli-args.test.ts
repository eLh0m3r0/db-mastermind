import { describe, expect, it } from 'vitest'
import { cmdArg } from '../src/main/ai/cli'

describe('cmdArg (Windows: the agent CLIs run through cmd.exe)', () => {
  it('keeps each argument one argument', () => {
    expect(cmdArg('')).toBe('""')
    expect(cmdArg('--verbose')).toBe('--verbose')
    expect(cmdArg('C:\\Users\\Jan Novák\\AppData\\Local\\Temp\\dbm-agent-x\\system.md')).toBe('"C:\\Users\\Jan Novák\\AppData\\Local\\Temp\\dbm-agent-x\\system.md"')
    expect(cmdArg('a"b')).toBe('"a""b"')
    expect(cmdArg('x&y')).toBe('"x&y"')
  })
})
