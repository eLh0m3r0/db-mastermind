import { describe, expect, it } from 'vitest'
import { connectionProposal, proposalDraft } from '../src/index.js'

const now = new Date('2026-11-14T10:00:00Z')

describe('connectionProposal', () => {
  it('takes a URL and drops its password', () => {
    const p = connectionProposal({ name: 'Shop', url: 'postgres://app:s3cret@db.local:5433/shop' }, 'claude-code', now)
    expect(p).toEqual({ name: 'Shop', driver: 'postgres', host: 'db.local', port: 5433, database: 'shop', user: 'app', proposedBy: 'claude-code', proposedAt: '2026-11-14T10:00:00.000Z' })
    expect(JSON.stringify(p)).not.toContain('s3cret')
  })

  it('takes the parts, names the connection when the agent did not, and ignores anything else (passwords, SSH)', () => {
    const p = connectionProposal({ driver: 'mysql', host: 'localhost', database: 'crm', password: 'x', ssh: { host: 'evil' } }, undefined, now)
    expect(p).toEqual({ name: 'localhost/crm', driver: 'mysql', host: 'localhost', database: 'crm', proposedAt: '2026-11-14T10:00:00.000Z' })
  })

  it('a file database needs its file', () => {
    expect(connectionProposal({ driver: 'sqlite', filePath: '/data/app.db' }, undefined, now).name).toBe('app.db')
    expect(() => connectionProposal({ driver: 'sqlite' })).toThrow(/filePath/)
  })

  it('refuses what it can not use, with a message the agent can act on', () => {
    expect(() => connectionProposal({ driver: 'mongodb', host: 'x' })).toThrow(/driver must be one of/)
    expect(() => connectionProposal({ driver: 'postgres' })).toThrow(/host is required/)
    expect(() => connectionProposal({ driver: 'postgres', host: 'x', port: 70000 })).toThrow(/port/)
    expect(() => connectionProposal({ driver: 'postgres', host: 'x', name: 'a\nb' })).toThrow(/Control characters/)
    expect(() => connectionProposal({ driver: 'postgres', host: 'x'.repeat(300) })).toThrow(/Too long/)
  })

  it('the form starts read-only', () => {
    expect(proposalDraft(connectionProposal({ url: 'mysql://root@h/db' }, undefined, now))).toMatchObject({ driver: 'mysql', host: 'h', database: 'db', readOnly: true })
  })
})
