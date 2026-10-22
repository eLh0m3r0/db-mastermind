import type { DatabaseService } from './engine.js'
import type { QueryResult } from './types.js'
import { cellToText } from './values.js'

export interface Principal {
  name: string
  kind: 'user' | 'role' | 'group'
  canLogin?: boolean
  superuser?: boolean
  /** Roles this principal is a member of. */
  memberOf: string[]
}

export interface Grant {
  /** Object the privilege applies to (`schema.table`, a schema, or `*` for server/database-wide). */
  object: string
  objectType?: string
  privileges: string[]
  grantable?: boolean
}

async function rows(db: DatabaseService, id: string, sql: string): Promise<Record<string, string | null>[]> {
  const [o] = await db.runScript(id, sql, { maxRows: 20_000 })
  if (o?.error) throw new Error(o.error.message)
  const r = o!.results![0] as QueryResult
  return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name.toLowerCase(), row[i] === null || row[i] === undefined ? null : cellToText(row[i]!)])))
}

const lit = (s: string) => `'${s.replaceAll("'", "''")}'`
const truthy = (v: string | null | undefined) => v === 'true' || v === '1' || v === 'Y' || v === 'YES'
const MYSQL_LIKE = new Set(['mysql', 'mariadb'])

/** Users and roles visible to this connection, with their role memberships. */
export async function listPrincipals(db: DatabaseService, id: string): Promise<Principal[]> {
  const driver = db.config(id).driver
  if (driver === 'postgres') {
    const r = await rows(
      db,
      id,
      `SELECT r.rolname AS name, r.rolcanlogin AS login, r.rolsuper AS super,
              (SELECT string_agg(g.rolname, ',' ORDER BY g.rolname) FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid WHERE m.member = r.oid) AS member_of
         FROM pg_roles r WHERE r.rolname !~ '^pg_' ORDER BY r.rolname`,
    )
    return r.map((x) => ({ name: x.name!, kind: truthy(x.login) ? 'user' : 'role', canLogin: truthy(x.login), superuser: truthy(x.super), memberOf: x.member_of?.split(',') ?? [] }))
  }
  if (MYSQL_LIKE.has(driver)) {
    // GRANTEE looks like 'user'@'host'; roles (MySQL 8 / MariaDB) appear as grantees too.
    const users = await rows(db, id, `SELECT DISTINCT GRANTEE AS name FROM information_schema.USER_PRIVILEGES ORDER BY 1`)
    const roles = await rows(db, id, `SELECT FROM_USER AS role_name, FROM_HOST AS role_host, TO_USER AS member, TO_HOST AS member_host FROM mysql.role_edges`).catch(() => [])
    const fmt = (u: string | null | undefined, h: string | null | undefined) => `'${u}'@'${h}'`
    const roleNames = new Set(roles.map((r) => fmt(r.role_name, r.role_host)))
    return users.map((u) => ({
      name: u.name!,
      kind: roleNames.has(u.name!) ? 'role' : 'user',
      memberOf: roles.filter((r) => fmt(r.member, r.member_host) === u.name).map((r) => fmt(r.role_name, r.role_host)),
    }))
  }
  if (driver === 'mssql') {
    const r = await rows(
      db,
      id,
      `SELECT p.name, p.type_desc AS type,
              STUFF((SELECT ',' + rp.name FROM sys.database_role_members m JOIN sys.database_principals rp ON rp.principal_id = m.role_principal_id
                      WHERE m.member_principal_id = p.principal_id ORDER BY rp.name FOR XML PATH('')), 1, 1, '') AS member_of
         FROM sys.database_principals p
        WHERE p.type IN ('S', 'U', 'G', 'R', 'E', 'X') AND p.name NOT IN ('INFORMATION_SCHEMA', 'sys', 'guest')
        ORDER BY p.name`,
    )
    return r.map((x) => ({
      name: x.name!,
      kind: x.type === 'DATABASE_ROLE' ? 'role' : x.type?.includes('GROUP') ? 'group' : 'user',
      superuser: x.name === 'dbo',
      memberOf: x.member_of?.split(',') ?? [],
    }))
  }
  if (driver === 'oracle') {
    const users = await rows(db, id, `SELECT username AS name FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`)
    const mine = await rows(db, id, `SELECT granted_role AS role FROM user_role_privs`).catch(() => [])
    const me = (await rows(db, id, `SELECT USER AS name FROM dual`))[0]?.name
    return users.map((u) => ({ name: u.name!, kind: 'user' as const, canLogin: true, memberOf: u.name === me ? mine.map((m) => m.role!) : [] }))
  }
  throw new Error('Users and roles are not available for this database')
}

/** Object privileges granted directly to a principal. */
export async function listGrants(db: DatabaseService, id: string, principal: string): Promise<Grant[]> {
  const driver = db.config(id).driver
  let r: Record<string, string | null>[]
  if (driver === 'postgres') {
    r = await rows(
      db,
      id,
      `SELECT table_schema || '.' || table_name AS object, 'table' AS type, privilege_type AS privilege, is_grantable AS grantable
         FROM information_schema.role_table_grants WHERE grantee = ${lit(principal)}
       UNION ALL
       SELECT table_schema || '.' || table_name || '.' || column_name, 'column', privilege_type, is_grantable
         FROM information_schema.column_privileges c
        WHERE grantee = ${lit(principal)}
          AND NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants t
                           WHERE t.grantee = c.grantee AND t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.privilege_type = c.privilege_type)
       UNION ALL
       SELECT n.nspname, 'schema', p.privilege_type, CASE WHEN p.is_grantable THEN 'YES' ELSE 'NO' END
         FROM pg_namespace n, aclexplode(n.nspacl) p, pg_roles r
        WHERE r.oid = p.grantee AND r.rolname = ${lit(principal)}
       UNION ALL
       SELECT current_database(), 'database', p.privilege_type, CASE WHEN p.is_grantable THEN 'YES' ELSE 'NO' END
         FROM pg_database d, aclexplode(d.datacl) p, pg_roles r
        WHERE d.datname = current_database() AND r.oid = p.grantee AND r.rolname = ${lit(principal)}`,
    )
  } else if (MYSQL_LIKE.has(driver)) {
    const g = lit(principal)
    r = await rows(
      db,
      id,
      `SELECT '*' AS object, 'server' AS type, PRIVILEGE_TYPE AS privilege, IS_GRANTABLE AS grantable FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ${g}
       UNION ALL SELECT TABLE_SCHEMA, 'schema', PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ${g}
       UNION ALL SELECT CONCAT(TABLE_SCHEMA, '.', TABLE_NAME), 'table', PRIVILEGE_TYPE, IS_GRANTABLE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ${g}`,
    )
  } else if (driver === 'mssql') {
    r = await rows(
      db,
      id,
      `SELECT CASE WHEN p.class = 0 THEN DB_NAME() WHEN p.class = 3 THEN SCHEMA_NAME(p.major_id) ELSE OBJECT_SCHEMA_NAME(p.major_id) + '.' + OBJECT_NAME(p.major_id) END AS object,
              LOWER(p.class_desc) AS type, p.permission_name AS privilege, CASE WHEN p.state = 'W' THEN 'YES' ELSE 'NO' END AS grantable
         FROM sys.database_permissions p JOIN sys.database_principals pr ON pr.principal_id = p.grantee_principal_id
        WHERE pr.name = ${lit(principal)} AND p.state IN ('G', 'W')`,
    )
  } else if (driver === 'oracle') {
    r = await rows(
      db,
      id,
      `SELECT table_schema || '.' || table_name AS "object", type AS "type", privilege AS "privilege", grantable AS "grantable"
         FROM all_tab_privs WHERE grantee = ${lit(principal)}`,
    )
  } else throw new Error('Users and roles are not available for this database')

  const byObject = new Map<string, Grant>()
  for (const x of r) {
    const key = `${x.type}|${x.object}`
    const g = byObject.get(key) ?? { object: x.object ?? '*', objectType: x.type?.toLowerCase() ?? undefined, privileges: [], grantable: false }
    if (x.privilege && !g.privileges.includes(x.privilege)) g.privileges.push(x.privilege)
    if (truthy(x.grantable)) g.grantable = true
    byObject.set(key, g)
  }
  return [...byObject.values()].sort((a, b) => (a.objectType ?? '').localeCompare(b.objectType ?? '') || a.object.localeCompare(b.object))
}
