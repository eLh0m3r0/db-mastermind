import { describe, expect, it } from 'vitest'
import { isUnreachableError } from '../src/network-errors'

describe('isUnreachableError', () => {
  it('recognises a server that cannot be reached', () => {
    expect(isUnreachableError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 10.0.0.5:5432' })).toBe(true)
    expect(isUnreachableError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.internal' })).toBe(true)
    expect(isUnreachableError({ code: 'ESOCKET', message: 'Failed to connect to db:1433 - Could not connect (sequence)' })).toBe(true)
    expect(isUnreachableError({ message: 'Connection terminated due to connection timeout' })).toBe(true)
    expect(isUnreachableError({ message: 'Timed out while waiting for handshake' })).toBe(true)
    // Node's AggregateError for a refused localhost arrives with the codes in the message only.
    expect(isUnreachableError({ message: 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432' })).toBe(true)
    expect(isUnreachableError(new Error('connect EHOSTUNREACH 192.168.1.10:3306'))).toBe(true)
  })

  it('leaves errors that retrying would not fix', () => {
    expect(isUnreachableError({ code: '28P01', message: 'password authentication failed for user "app"' })).toBe(false)
    expect(isUnreachableError({ code: 'PASSWORD_REQUIRED', message: 'Login failed for user' })).toBe(false)
    expect(isUnreachableError({ code: '3D000', message: 'database "shopx" does not exist' })).toBe(false)
    expect(isUnreachableError({ message: 'Host key mismatch for bastion:22' })).toBe(false)
    expect(isUnreachableError({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self-signed certificate' })).toBe(false)
    expect(isUnreachableError(undefined)).toBe(false)
  })
})
