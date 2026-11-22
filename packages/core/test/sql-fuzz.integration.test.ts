import { afterAll, describe, expect, it } from 'vitest'
import { compareSchemas, DatabaseService, generateMigration, getDialect, migrationScript, parseDbml, readModelFile, splitStatements, toDbml, type ConnectionConfig, type DriverId, type TableInfo } from '../src/index.js'
import { engines, skip } from './fixtures.js'
import { asDrawDb, asMermaid, asWorkbench, CANARY, sqlFuzzModel } from './sql-fuzz.js'

/**
 * Review N1 on real databases: scripts made from hostile models (sql-fuzz.ts) run in a scratch database with a
 * table `canary`. Statements may fail (a hostile type is no type), but afterwards `canary` is still there and no
 * table exists that the model didn't mean.
 */
const SEEDS = Number(process.env.DBM_SQL_FUZZ_SEEDS ?? 20)
const SCRATCH = 'dbm_fuzz'

const svc = new DatabaseService()
afterAll(() => svc.disconnectAll())

const one = async (id: string, sql: string) => {
  const [o] = await svc.runScript(id, sql)
  if (o?.error) throw new Error(`${sql}\n→ ${o.error.message}`)
  return (o?.results?.[0]?.rows ?? []) as unknown[][]
}

async function scratch(driver: DriverId, admin: ConnectionConfig): Promise<ConnectionConfig> {
  await svc.connect(admin)
  if (driver === 'mssql') {
    await one(admin.id, `IF DB_ID('${SCRATCH}') IS NOT NULL BEGIN ALTER DATABASE ${SCRATCH} SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE ${SCRATCH} END`)
    await one(admin.id, `CREATE DATABASE ${SCRATCH}`)
  } else if (driver === 'mysql') {
    await one(admin.id, `DROP DATABASE IF EXISTS ${SCRATCH}`)
    await one(admin.id, `CREATE DATABASE ${SCRATCH}`)
  } else {
    await one(admin.id, `DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`)
    await one(admin.id, `CREATE DATABASE ${SCRATCH}`)
  }
  const config = { ...admin, id: `${admin.id}-fuzz`, database: SCRATCH }
  await svc.connect(config)
  return config
}

const LIST: Partial<Record<DriverId, string>> = {
  postgres: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
  mysql: `SELECT table_name FROM information_schema.tables WHERE table_schema = '${SCRATCH}'`,
  mssql: 'SELECT name FROM sys.tables',
}

async function tablesIn(id: string, driver: DriverId): Promise<string[]> {
  return (await one(id, LIST[driver]!)).map((r) => String(Array.isArray(r) ? r[0] : Object.values(r as object)[0]))
}

async function reset(id: string, driver: DriverId) {
  const d = getDialect(driver)
  // Foreign keys between the model's tables: drop until nothing is left (a few rounds at most).
  for (let round = 0; round < 5; round++) {
    const names = await tablesIn(id, driver)
    if (!names.length) break
    const prefix = driver === 'mysql' ? 'SET FOREIGN_KEY_CHECKS = 0;\n' : ''
    await svc.runScript(id, prefix + names.map((n) => `DROP TABLE ${d.quoteIdent(n)}${driver === 'postgres' ? ' CASCADE' : ''}`).join(';\n'))
  }
  await one(id, `CREATE TABLE ${CANARY} (id int)`)
}

for (const engine of engines.filter((e) => ['postgres', 'mysql', 'mssql'].includes(e.id))) {
  describe.skipIf(skip.has(engine.id))(`hostile models on ${engine.id} (review N1)`, () => {
    it('leave the canary alone and create no table the model did not mean', { timeout: 600_000 }, async () => {
      const driver = engine.id as DriverId
      const config = await scratch(driver, engine.config)
      const problems: string[] = []
      let scripts = 0
      let serverChecked = 0
      let made = 0
      let meantTotal = 0
      for (let seed = 0; seed < SEEDS; seed++) {
        const tables = sqlFuzzModel(seed, driver, { runnable: true })
        const paths: [string, TableInfo[]][] = [
          ['model', tables],
          ['DBML', parseDbml(toDbml(tables)).tables],
          ['drawDB', readModelFile('m.json', asDrawDb(tables, driver === 'postgres' ? 'postgresql' : driver)).tables],
          ['Workbench', readModelFile('m.mwb', asWorkbench(tables)).tables],
          ['Mermaid', readModelFile('m.mmd', asMermaid(tables)).tables],
        ]
        for (const [path, model] of paths) {
          await reset(config.id, driver)
          const script = migrationScript(generateMigration(compareSchemas(model, [], { keepExtra: true, model: true }), getDialect(driver)), getDialect(driver))
          await svc.runScript(config.id, script)
          scripts++
          // Property 3 (review round 2): each statement our splitter made of the script is one statement to the
          // server too. PostgreSQL's extended protocol refuses more than one command; SQL Server plans each.
          const entry = (svc as unknown as { get(id: string): { driver: { execute(sql: string, o: object): Promise<{ rows?: unknown[][] }[]> } } }).get(config.id)
          for (const st of splitStatements(script, driver).filter((x) => !/^(BEGIN|COMMIT|SET XACT_ABORT)/i.test(x.text.replace(/^(\s*--[^\n]*\n)+/, '').trim()))) {
            if (driver === 'postgres') {
              await entry.driver.execute(st.text, { unconfirmed: true }).catch((err: Error) => {
                if (/cannot insert multiple commands/i.test(err.message)) problems.push(`seed ${seed} ${path}: the server reads more than one statement in ${JSON.stringify(st.text.slice(0, 120))}`)
              })
              serverChecked++
            }
            if (driver === 'mssql' && !/^\s*(EXEC|DECLARE|IF)\b/i.test(st.text.replace(/^(\s*--[^\n]*\n)+/, ''))) {
              const session = `plan-${seed}`
              try {
                await entry.driver.execute('SET SHOWPLAN_XML ON', { session })
                const plans = await entry.driver.execute(st.text, { session }).catch(() => undefined)
                if (plans) {
                  const n = [...plans.map((r) => String(r.rows?.[0]?.[0] ?? '')).join('\n').matchAll(/<Stmt(Simple|Cond)\b/g)].length
                  if (n > 1) problems.push(`seed ${seed} ${path}: SQL Server plans ${n} statements in ${JSON.stringify(st.text.slice(0, 120))}`)
                  serverChecked++
                }
              } finally {
                await entry.driver.execute('SET SHOWPLAN_XML OFF', { session }).catch(() => {})
                await svc.releaseSession(config.id, session).catch(() => {})
              }
            }
          }
          const now = await tablesIn(config.id, driver)
          const meant = new Set([CANARY, ...model.map((t) => t.name)].map((n) => n.toLowerCase()))
          if (!now.some((n) => n.toLowerCase() === CANARY)) problems.push(`seed ${seed} ${path}: canary dropped`)
          const extra = now.filter((n) => !meant.has(n.toLowerCase()))
          made += now.length - 1 - extra.length
          meantTotal += model.length
          if (extra.length) problems.push(`seed ${seed} ${path}: tables ${JSON.stringify(extra)}`)
        }
      }
      // (Not every table can be made: a hostile type is no type. Most are, or the test would prove nothing.)
      console.log(`SQL fuzz on ${driver}: ${scripts} scripts run, ${made} of ${meantTotal} tables made, ${serverChecked} statements checked by the server`)
      expect(made).toBeGreaterThan(meantTotal / 3)
      expect(problems).toEqual([])
    })
  })
}
