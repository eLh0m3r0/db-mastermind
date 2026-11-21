import { describe, expect, it } from 'vitest'
import { connectionFromPrisma, connectionsFromEnv, databaseImage, detectService, parseDotenv, projectConnections, servicesFromCompose, SUPABASE_POOLER } from '../src/index.js'

describe('services by name', () => {
  it('names the services that run the real engine, from the host', () => {
    expect(detectService('db.abcdefghijkl.supabase.co', 'postgres')).toEqual({ name: 'Supabase', tls: 'require' })
    expect(detectService('aws-0-eu-central-1.pooler.supabase.com', 'postgres', 6543)).toEqual({ name: 'Supabase', tls: 'require', note: SUPABASE_POOLER })
    expect(detectService('aws-0-eu-central-1.pooler.supabase.com', 'postgres', 5432)?.note).toBeUndefined()
    expect(detectService('ep-cool-river-123456.eu-central-1.aws.neon.tech')?.name).toBe('Neon')
    expect(detectService('abc123.xyz.tsdb.cloud.timescale.com')?.name).toBe('Timescale')
    expect(detectService('shop.cluster-c9akcniq1abc.eu-west-1.rds.amazonaws.com', 'mysql')?.name).toBe('Amazon Aurora')
    expect(detectService('shop.cluster-ro-c9akcniq1abc.eu-west-1.rds.amazonaws.com', 'postgres')?.name).toBe('Amazon Aurora')
    expect(detectService('shop.c9akcniq1abc.eu-west-1.rds.amazonaws.com', 'mssql')?.name).toBe('Amazon RDS')
    expect(detectService('shop.postgres.database.azure.com', 'postgres')?.name).toBe('Azure Database for PostgreSQL')
    expect(detectService('shop.mysql.database.azure.com', 'mysql')?.name).toBe('Azure Database for MySQL')
    expect(detectService('shop.database.windows.net', 'mssql')?.name).toBe('Azure SQL')
    expect(detectService('abc.us-central1.sql.goog')?.name).toBe('Google Cloud SQL')
  })

  it('claims nothing it is not sure of', () => {
    expect(detectService('localhost')).toBeUndefined()
    expect(detectService('db.example.com')).toBeUndefined()
    expect(detectService('evil-supabase.co')).toBeUndefined()
    // A host of the service with an engine it doesn't run.
    expect(detectService('db.abc.supabase.co', 'mysql')).toBeUndefined()
    expect(detectService('shop.database.windows.net', 'postgres')).toBeUndefined()
  })
})

describe('.env files', () => {
  it('reads quotes, export, comments and variables', () => {
    const vars = parseDotenv(
      [
        '# local settings',
        'export DB_USER=shop',
        "DB_PASS='p@ss $NOT # kept'",
        'DB_NAME="shop_dev" # the dev database',
        'HOST=${DB_HOST:-localhost}',
        'URL=postgres://${DB_USER}:${DB_PASS}@${HOST}:5432/${DB_NAME}',
        'MULTI="line one\\nline two"',
        'EMPTY=',
        'DOLLAR=a$$b',
      ].join('\n'),
    )
    expect(vars).toEqual({ DB_USER: 'shop', DB_PASS: 'p@ss $NOT # kept', DB_NAME: 'shop_dev', HOST: 'localhost', URL: 'postgres://shop:p@ss $NOT # kept@localhost:5432/shop_dev', MULTI: 'line one\nline two', EMPTY: '', DOLLAR: 'a$$b' })
  })

  it('finds connection URLs in any variable and the DB_*, PG* and MYSQL_* sets', () => {
    const vars = parseDotenv(
      [
        'DATABASE_URL=postgresql://app:secret@db.abc.supabase.co:5432/postgres',
        'ANALYTICS_DSN=mysql://reader:pw@10.0.0.5:3307/stats',
        'ASYNC_URL=postgresql+asyncpg://app:secret@localhost/app',
        'REDIS_URL=redis://localhost:6379',
        'TEMPLATE_URL=postgres://USER:PASSWORD@HOST:PORT/DATABASE',
        'DB_CONNECTION=pgsql',
        'DB_HOST=127.0.0.1',
        'DB_PORT=5433',
        'DB_DATABASE=laravel',
        'DB_USERNAME=sail',
        'DB_PASSWORD=password',
        'PGHOST=pg.internal',
        'PGUSER=me',
        'MYSQL_HOST=my.internal',
        'MYSQL_PASSWORD=x',
      ].join('\n'),
    )
    const found = connectionsFromEnv(vars, 'shop')
    expect(found.map((c) => [c.name, c.driver, c.host, c.port, c.database, c.user, c.password])).toEqual([
      ['shop — DATABASE_URL', 'postgres', 'db.abc.supabase.co', 5432, 'postgres', 'app', 'secret'],
      ['shop — ANALYTICS_DSN', 'mysql', '10.0.0.5', 3307, 'stats', 'reader', 'pw'],
      ['shop — ASYNC_URL', 'postgres', 'localhost', 5432, 'app', 'app', 'secret'],
      ['shop — DB_HOST', 'postgres', '127.0.0.1', 5433, 'laravel', 'sail', 'password'],
      ['shop — PGHOST', 'postgres', 'pg.internal', undefined, undefined, 'me', undefined],
      ['shop — MYSQL_HOST', 'mysql', 'my.internal', undefined, undefined, undefined, 'x'],
    ])
    expect(connectionsFromEnv({ DB_CONNECTION: 'sqlite', DB_DATABASE: '/srv/app/database.sqlite' }, 'app')).toEqual([{ name: 'app — DB_DATABASE', driver: 'sqlite', filePath: '/srv/app/database.sqlite' }])
  })
})

describe('docker-compose files', () => {
  const COMPOSE = `
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: shop
      POSTGRES_PASSWORD: \${DB_PASSWORD:-changeme}
      POSTGRES_DB: shop
    ports:
      - "54329:5432"
  mysql:
    image: docker.io/library/mysql:8.4
    environment:
      - MYSQL_ROOT_PASSWORD=rootpw
      - MYSQL_DATABASE=legacy
    ports:
      - target: 3306
        published: 33069
        host_ip: 127.0.0.1
  sqlserver:
    image: mcr.microsoft.com/mssql/server:2022-latest
    environment:
      ACCEPT_EULA: "Y"
      MSSQL_SA_PASSWORD:
    ports: ["127.0.0.1:14339:1433"]
  cache:
    image: redis:7
    ports: ["6379:6379"]
  internal:
    image: mariadb:11
    environment:
      MARIADB_USER: app
      MARIADB_PASSWORD: apppw
`

  it('finds database services with their published port and login', () => {
    const services = servicesFromCompose(COMPOSE, { DB_PASSWORD: 'fromenv', MSSQL_SA_PASSWORD: 'Str0ng!' }, 'shop')
    expect(services.map((s) => [s.service, s.driver, s.published])).toEqual([
      ['db', 'postgres', 54329],
      ['mysql', 'mysql', 33069],
      ['sqlserver', 'mssql', 14339],
      ['internal', 'mariadb', undefined],
    ])
    expect(services[0]!.connection).toMatchObject({ name: 'shop — db', host: 'localhost', port: 54329, user: 'shop', password: 'fromenv', database: 'shop' })
    expect(services[1]!.connection).toMatchObject({ host: '127.0.0.1', user: 'root', password: 'rootpw', database: 'legacy' })
    expect(services[2]!.connection).toMatchObject({ user: 'sa', password: 'Str0ng!', options: { trustServerCertificate: true } })
    // Not published: nothing on this computer reaches it.
    expect(services[3]!.connection).toBeUndefined()
  })

  it('knows the database images by name, whatever registry and tag', () => {
    for (const image of ['postgres', 'postgres:17', 'postgis/postgis:16-3.4', 'timescale/timescaledb:latest-pg16', 'pgvector/pgvector:pg16', 'bitnami/postgresql:16', 'mysql:8', 'mariadb:lts', 'mcr.microsoft.com/mssql/server:2022-latest', 'clickhouse/clickhouse-server:24', 'cockroachdb/cockroach:latest', 'gvenzl/oracle-free:23-slim', 'trinodb/trino:483']) {
      expect(databaseImage(image), image).toBeDefined()
    }
    for (const image of ['redis:7', 'nginx', 'mongo:7', 'postgres-exporter', 'myorg/postgres-backup']) expect(databaseImage(image), image).toBeUndefined()
  })
})

describe('a project folder', () => {
  it('reads .env, compose and Prisma together, each connection once, service names as this computer reaches them', () => {
    const found = projectConnections(
      {
        '.env': 'DB_PASSWORD=s3cret\nDATABASE_URL=postgresql://shop:${DB_PASSWORD}@db:5432/shop\n',
        '.env.example': 'DATABASE_URL=postgresql://user:pass@localhost:5432/example\n',
        'docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: shop\n      POSTGRES_PASSWORD: ${DB_PASSWORD}\n      POSTGRES_DB: shop\n    ports: ["54329:5432"]\n',
        'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      },
      'shop',
      { folder: true },
    )
    expect(found).toEqual([{ name: 'shop — db', driver: 'postgres', host: 'localhost', port: 54329, database: 'shop', user: 'shop', password: 's3cret', ssl: { mode: 'prefer' } }])
  })

  it('reads a Prisma datasource written as a URL or from the environment', () => {
    expect(connectionFromPrisma('datasource db {\n  provider = "mysql"\n  url = "mysql://root:pw@localhost:3306/app"\n}', {}, 'app')).toMatchObject({ driver: 'mysql', database: 'app', password: 'pw' })
    expect(connectionFromPrisma('datasource db {\n  provider = "postgresql"\n  url = env("MISSING")\n}', {}, 'app')).toBeUndefined()
  })
})

describe('dollar signs, as each format reads them (review L6)', () => {
  it('.env: only ${VAR} is a variable, a password with $ stays, nothing in single quotes', () => {
    const vars = parseDotenv("USER=app\nPASS=pa$word\nTWO=a$$b\nQUOTED='${USER}'\nURL=postgres://${USER}:${PASS}@db/x\nESCAPED=\"\\${USER}\"\n")
    expect(vars).toEqual({ USER: 'app', PASS: 'pa$word', TWO: 'a$$b', QUOTED: '${USER}', URL: 'postgres://app:pa$word@db/x', ESCAPED: '${USER}' })
  })

  it('compose: $VAR and ${VAR} are variables, $$ is a dollar sign', () => {
    const services = servicesFromCompose('services:\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: $USER\n      POSTGRES_PASSWORD: "pa$$word"\n      POSTGRES_DB: ${DB:-shop}\n    ports: ["5432:5432"]\n', { USER: 'app' }, 'p')
    expect(services[0]!.connection).toMatchObject({ user: 'app', password: 'pa$word', database: 'shop' })
  })
})

describe('names an object has of its own (review M4, prototype lookups)', () => {
  it('a variable named after Object.prototype is no variable, and __proto__ is a plain key', () => {
    const vars = parseDotenv('U=${constructor}\nV=${toString:-x}\n__proto__=p\nW=${__proto__}\n')
    expect(Object.entries(vars)).toEqual([['U', ''], ['V', 'x'], ['__proto__', 'p'], ['W', 'p']])
    const services = servicesFromCompose('services:\n  db:\n    image: postgres:16\n    environment:\n      - constructor\n      - POSTGRES_PASSWORD=${hasOwnProperty}\n    ports: ["5432:5432"]\n', {}, 'p')
    expect(services[0]!.connection!.password ?? '').toBe('')
  })
})

describe('YAML aliases anywhere a compose value is read (review N3)', () => {
  it('ports with a list for a target, published port or host are no port; the file is read at once', { timeout: 30_000 }, () => {
    let y = 'x-a0: &a0 ["lol","lol","lol","lol","lol","lol","lol","lol","lol","lol"]\n'
    for (let i = 1; i <= 8; i++) y += `x-a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(',')}]\n`
    for (const port of ['- target: *a8\n        published: 5432', '- target: 5432\n        published: *a8', '- target: 5432\n        published: 5433\n        host_ip: *a8', '- *a8']) {
      const services = servicesFromCompose(`${y}services:\n  db:\n    image: postgres:16\n    ports:\n      ${port}\n`, {}, 'p')
      expect(services.map((s) => s.published)).toEqual([port.includes('host_ip') ? 5433 : undefined])
    }
  })
})
