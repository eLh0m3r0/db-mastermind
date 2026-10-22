import { describe, expect, it } from 'vitest'
import {
  heidiSessions,
  navicatSessions,
  parseAzureDataStudio,
  parseDbVisualizer,
  parseHeidiPortable,
  parseMySqlWorkbench,
  parsePgAdminServersJson,
  parsePlist,
  parseRegQuery,
  parseSqlDeveloper,
  parseSqlTools,
  parseSsmsRegisteredServers,
  pgAdminServerRows,
  sequelAceFavorites,
  tablePlusConnections,
} from '../src/index.js'

describe('connection imports from other tools', () => {
  it('pgAdmin servers.json and its config database', () => {
    const json = JSON.stringify({ Servers: { 1: { Name: 'Prod', Group: 'Servers', Host: 'pg.corp', Port: 5432, MaintenanceDB: 'postgres', Username: 'jan', ConnectionParameters: { sslmode: 'require' } } } })
    expect(parsePgAdminServersJson(json)).toEqual([{ name: 'Prod', driver: 'postgres', host: 'pg.corp', port: 5432, database: 'postgres', user: 'jan', group: 'Servers', ssl: { mode: 'require' }, ssh: undefined }])
    expect(pgAdminServerRows([{ name: 'Dev', host: 'localhost', port: 5433, maintenance_db: 'app', username: 'me', connection_params: '{"sslmode":"prefer"}' }])[0]).toMatchObject({ name: 'Dev', port: 5433, database: 'app', ssl: undefined })
  })

  it('MySQL Workbench connections.xml', () => {
    const xml = `<?xml version="1.0"?><data grt_format="2.0"><value _ptr_="0x1" type="list" content-type="object" content-struct-name="db.mgmt.Connection">
<value type="object" struct-name="db.mgmt.Connection" id="a"><link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_sshtun</link>
<value _ptr_="0x2" type="dict" key="parameterValues"><value type="string" key="hostName">db.local</value><value type="int" key="port">3307</value><value type="string" key="schema">shop</value><value type="string" key="sshHost">bastion:2222</value><value type="string" key="sshUserName">ops</value><value type="string" key="userName">root</value></value>
<value type="string" key="name">Shop &amp; co</value></value>
<value type="object" struct-name="db.mgmt.Connection" id="b"><link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native</link>
<value _ptr_="0x3" type="dict" key="parameterValues"><value type="string" key="hostName"></value><value type="int" key="port">3306</value><value type="string" key="userName">app</value></value>
<value type="string" key="name">Local</value></value>
</value></data>`
    expect(parseMySqlWorkbench(xml)).toEqual([
      { name: 'Shop & co', driver: 'mysql', host: 'db.local', port: 3307, user: 'root', database: 'shop', ssh: { enabled: true, authMethod: 'password', host: 'bastion', port: 2222, user: 'ops' } },
      { name: 'Local', driver: 'mysql', host: 'localhost', port: 3306, user: 'app', database: undefined, ssh: undefined },
    ])
  })

  it('HeidiSQL from the registry and portable settings', () => {
    const reg = `
HKEY_CURRENT_USER\\Software\\HeidiSQL\\Servers\\Team\\ERP
    Host    REG_SZ    erp-sql
    NetType    REG_DWORD    0x4
    Port    REG_SZ    1433
    WindowsAuth    REG_DWORD    0x1

HKEY_CURRENT_USER\\Software\\HeidiSQL\\Servers\\Shop
    Host    REG_SZ    127.0.0.1
    NetType    REG_DWORD    0x0
    User    REG_SZ    root
    Databases    REG_SZ    shop;test
`
    const sessions = parseRegQuery(reg, 'Software\\HeidiSQL\\Servers')
    expect(heidiSessions(sessions)).toEqual([
      { name: 'ERP', driver: 'mssql', host: 'erp-sql', port: 1433, user: undefined, database: undefined, group: 'Team', options: { authentication: 'windows' } },
      { name: 'Shop', driver: 'mysql', host: '127.0.0.1', port: undefined, user: 'root', database: 'shop', group: undefined, options: undefined },
    ])
    expect(parseHeidiPortable('Servers\\Pg\\Host<|||>1<|||>pg.local\nServers\\Pg\\NetType<|||>3<|||>8\nServers\\Pg\\Port<|||>1<|||>5432')).toMatchObject([{ name: 'Pg', driver: 'postgres', host: 'pg.local', port: 5432 }])
    expect(navicatSessions({ Prod: { Host: 'db', Port: '3306', UserName: 'u' }, 'Prod\\Profiles': {} }, 'mysql')).toEqual([{ name: 'Prod', driver: 'mysql', host: 'db', port: 3306, user: 'u', database: undefined }])
  })

  it('Azure Data Studio and VS Code SQLTools settings (JSON with comments)', () => {
    const ads = `{
      // comment
      "datasource.connectionGroups": [{ "id": "g1", "name": "Prod" }],
      "datasource.connections": [
        { "options": { "server": "sql01,1444", "database": "ERP", "authenticationType": "Integrated", "connectionName": "ERP prod" }, "groupId": "g1", "providerName": "MSSQL" },
        { "options": { "server": "pg", "database": "dwh", "user": "an", "authenticationType": "SqlLogin" }, "providerName": "PGSQL" },
      ],
    }`
    expect(parseAzureDataStudio(ads)).toEqual([
      { name: 'ERP prod', driver: 'mssql', host: 'sql01', port: 1444, database: 'ERP', user: undefined, group: 'Prod', options: { authentication: 'windows' } },
      { name: 'pg/dwh', driver: 'postgres', host: 'pg', port: undefined, database: 'dwh', user: 'an', group: undefined, options: undefined },
    ])
    const tools = `{ "sqltools.connections": [ { "name": "Local PG", "driver": "PostgreSQL", "server": "localhost", "port": 5432, "database": "app", "username": "me", "password": "pw" }, { "name": "Cache", "driver": "Redis" } ] }`
    expect(parseSqlTools(tools)).toEqual([{ name: 'Local PG', driver: 'postgres', host: 'localhost', port: 5432, database: 'app', user: 'me', password: 'pw', group: undefined }])
  })

  it('SSMS registered servers, SQL Developer and DbVisualizer', () => {
    const ssms = `<RegisteredServers:RegisteredServer><RegisteredServers:Name type="string">ERP</RegisteredServers:Name><RegisteredServers:ConnectionStringWithEncryptedPassword type="string">data source=sql01\\PROD;integrated security=True;initial catalog=ERP;pooling=False</RegisteredServers:ConnectionStringWithEncryptedPassword><RegisteredServers:ServerType type="ServerType">DatabaseEngine</RegisteredServers:ServerType></RegisteredServers:RegisteredServer>`
    expect(parseSsmsRegisteredServers(ssms)[0]).toMatchObject({ name: 'ERP', driver: 'mssql', database: 'ERP' })
    const sqldev = JSON.stringify({ connections: [{ name: 'HR', info: { hostname: 'ora', port: '1521', serviceName: 'XEPDB1', user: 'hr' } }, { name: 'URL', info: { customUrl: 'jdbc:oracle:thin:@//o2:1522/S', user: 'x' } }] })
    expect(parseSqlDeveloper(sqldev)).toEqual([
      { name: 'HR', driver: 'oracle', host: 'ora', port: 1521, database: 'XEPDB1', user: 'hr' },
      expect.objectContaining({ name: 'URL', driver: 'oracle', host: 'o2', port: 1522, database: 'S', user: 'x' }),
    ])
    const dbvis = `<Databases><Database id="1"><Alias>Warehouse</Alias><Url>jdbc:postgresql://dwh:5432/dwh</Url><Userid>bi</Userid></Database></Databases>`
    expect(parseDbVisualizer(dbvis)).toEqual([expect.objectContaining({ name: 'Warehouse', driver: 'postgres', host: 'dwh', database: 'dwh', user: 'bi' })])
  })

  it('TablePlus and Sequel Ace property lists', () => {
    const plist = `<?xml version="1.0"?><plist version="1.0"><array><dict><key>ConnectionName</key><string>Prod PG</string><key>Driver</key><string>PostgreSQL</string><key>DatabaseHost</key><string>pg</string><key>DatabasePort</key><string>5432</string><key>DatabaseUser</key><string>me</string><key>isOverSSH</key><false/></dict></array></plist>`
    expect(tablePlusConnections(parsePlist(plist) as never)).toEqual([{ name: 'Prod PG', driver: 'postgres', host: 'pg', port: 5432, database: undefined, user: 'me', ssh: undefined }])
    const fav = `<plist><dict><key>Favorites Root</key><dict><key>Children</key><array><dict><key>name</key><string>Shop</string><key>host</key><string>db</string><key>user</key><string>root</string><key>type</key><integer>0</integer><key>port</key><string>3306</string></dict></array><key>Name</key><string>FAVORITES</string></dict></dict></plist>`
    expect(sequelAceFavorites(parsePlist(fav))).toEqual([{ name: 'Shop', driver: 'mysql', host: 'db', port: 3306, user: 'root', database: undefined, group: undefined, ssh: undefined }])
  })
})
