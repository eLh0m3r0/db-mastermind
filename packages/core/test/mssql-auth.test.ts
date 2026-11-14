import { describe, expect, it } from 'vitest'
import { mssqlAuthentication, type ConnectionConfig } from '../src/index.js'

const base: ConnectionConfig = { id: 'a', name: 'a', driver: 'mssql', host: 'x.database.windows.net', database: 'db', user: 'u', password: 'p' }

describe('SQL Server sign-in', () => {
  it('a SQL login by default, NTLM with a domain', () => {
    expect(mssqlAuthentication(base)).toEqual({ user: 'u', password: 'p' })
    expect(mssqlAuthentication({ ...base, options: { domain: 'CORP' } })).toEqual({ authentication: { type: 'ntlm', options: { domain: 'CORP', userName: 'u', password: 'p' } } })
  })

  it('Microsoft Entra ID with the signed-in account: no user or password is sent', () => {
    expect(mssqlAuthentication({ ...base, options: { authentication: 'entra' } })).toEqual({ authentication: { type: 'azure-active-directory-default', options: { clientId: undefined } } })
    expect(mssqlAuthentication({ ...base, options: { authentication: 'entra', clientId: 'mi-1' } })).toMatchObject({ authentication: { options: { clientId: 'mi-1' } } })
  })

  it('a service principal: client id, secret and tenant, all required', () => {
    expect(mssqlAuthentication({ ...base, options: { authentication: 'entra-service-principal', tenantId: 't-1' } })).toEqual({
      authentication: { type: 'azure-active-directory-service-principal-secret', options: { clientId: 'u', clientSecret: 'p', tenantId: 't-1' } },
    })
    expect(() => mssqlAuthentication({ ...base, options: { authentication: 'entra-service-principal' } })).toThrow(/tenant ID/)
  })
})
