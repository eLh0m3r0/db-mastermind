import { describe, expect, it } from 'vitest'
import { DatabaseService, type DatabaseDriver } from '../src/index.js'

describe('DatabaseService.connect', () => {
  it('closes a driver whose connect failed (an SSH tunnel up, the login refused) and keeps the error', async () => {
    let closed = 0
    const svc = new DatabaseService(() => ({ connect: async () => Promise.reject(new Error('Login failed')), close: async () => void closed++ }) as unknown as DatabaseDriver)
    await expect(svc.connect({ id: 'x', name: 'x', driver: 'postgres', host: 'h' })).rejects.toThrow('Login failed')
    expect(closed).toBe(1)
    expect(svc.isOpen('x')).toBe(false)
  })
})
