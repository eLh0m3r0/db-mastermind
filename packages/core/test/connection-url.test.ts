import { describe, expect, it } from 'vitest'
import { parseConnectionString, parseDataGrip } from '../src/index.js'

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


describe('Oracle thin URLs and DataGrip', () => {
  it('parses the Oracle thin forms', () => {
    expect(parseConnectionString('jdbc:oracle:thin:@db.corp:1521/ORCLPDB1')).toMatchObject({ driver: 'oracle', host: 'db.corp', port: 1521, database: 'ORCLPDB1' })
    expect(parseConnectionString('jdbc:oracle:thin:@//db.corp:1522/svc')).toMatchObject({ host: 'db.corp', port: 1522, database: 'svc' })
    expect(parseConnectionString('jdbc:oracle:thin:scott/tiger@db:1521:XE')).toMatchObject({ user: 'scott', password: 'tiger', database: 'XE' })
    expect(parseConnectionString('jdbc:oracle:thin:@(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=rac1)(PORT=1530))(CONNECT_DATA=(SERVICE_NAME=erp)))')).toMatchObject({ host: 'rac1', port: 1530, database: 'erp' })
  })
  it('reads DataGrip data sources with user names from the local file', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<project version="4">
  <component name="DataSourceManagerImpl" format="xml" multifile-model="true">
    <data-source source="LOCAL" name="shop@localhost" uuid="a1">
      <driver-ref>postgresql</driver-ref>
      <jdbc-driver>org.postgresql.Driver</jdbc-driver>
      <jdbc-url>jdbc:postgresql://localhost:5432/shop?sslmode=require&amp;ApplicationName=x</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="ERP" uuid="b2">
      <jdbc-url>jdbc:sqlserver://sql01:1433;databaseName=ERP</jdbc-url>
    </data-source>
    <data-source source="LOCAL" name="cache" uuid="c3">
      <jdbc-url>jdbc:redis://localhost:6379</jdbc-url>
    </data-source>
  </component>
</project>`
    const local = `<project><component name="dataSourceStorageLocal"><data-source name="shop@localhost" uuid="a1"><user-name>jan</user-name></data-source></component></project>`
    const list = parseDataGrip(xml, local)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'shop@localhost', driver: 'postgres', host: 'localhost', port: 5432, database: 'shop', user: 'jan' })
    expect(list[1]).toMatchObject({ name: 'ERP', driver: 'mssql', host: 'sql01', database: 'ERP' })
  })
})
