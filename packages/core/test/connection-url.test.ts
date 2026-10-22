import { describe, expect, it } from 'vitest'
import { parseConnectionString } from '../src/index.js'

describe('parseConnectionString', () => {
  it('parses postgres URLs with encoded credentials and sslmode', () => {
    expect(parseConnectionString('postgresql://us%40r:p%3Ass@db.example.com:6543/app?sslmode=verify-full')).toEqual({
      driver: 'postgres',
      host: 'db.example.com',
      port: 6543,
      database: 'app',
      user: 'us@r',
      password: 'p:ss',
      ssl: { mode: 'verify-full' },
    })
  })

  it('defaults ports per driver', () => {
    expect(parseConnectionString('mysql://root@localhost/shop').port).toBe(3306)
    expect(parseConnectionString('mariadb://root@localhost/shop').driver).toBe('mariadb')
  })

  it('parses JDBC SQL Server URLs', () => {
    expect(
      parseConnectionString(
        'jdbc:sqlserver://sql01\\PROD;databaseName=Sales;user=report;password=secret;encrypt=false;trustServerCertificate=true',
      ),
    ).toEqual({
      driver: 'mssql',
      host: 'sql01',
      port: undefined,
      database: 'Sales',
      user: 'report',
      password: 'secret',
      ssl: { mode: 'disable' },
      options: { instanceName: 'PROD', trustServerCertificate: true },
    })
  })

  it('parses ADO.NET connection strings', () => {
    expect(parseConnectionString('Server=tcp:myserver,1444;Initial Catalog=Hr;User ID=sa;Password=x;TrustServerCertificate=True')).toEqual({
      driver: 'mssql',
      host: 'myserver',
      port: 1444,
      database: 'Hr',
      user: 'sa',
      password: 'x',
      ssl: undefined,
      options: { trustServerCertificate: true },
    })
  })

  it('parses sqlite paths', () => {
    expect(parseConnectionString('sqlite:///Users/me/app.db')).toEqual({ driver: 'sqlite', filePath: '/Users/me/app.db' })
  })

  it('rejects unknown schemes', () => {
    expect(() => parseConnectionString('mongodb://x')).toThrow(/Unsupported/)
  })
})

describe('pgpass', () => {
  it('reads entries, escapes and wildcards', async () => {
    const { parsePgpass } = await import('../src/index.js')
    const list = parsePgpass('# comment\ndb.example.com:5433:crm:analyst:s3cr\\:et\nlocalhost:*:*:postgres:pw\n*:*:*:*:skip\n')
    expect(list).toEqual([
      { name: 'db.example.com/crm', driver: 'postgres', host: 'db.example.com', port: 5433, database: 'crm', user: 'analyst', password: 's3cr:et' },
      { name: 'localhost', driver: 'postgres', host: 'localhost', port: 5432, database: undefined, user: 'postgres', password: 'pw' },
    ])
  })
})

