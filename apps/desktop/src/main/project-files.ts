import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { COMPOSE_FILE, FILE_LIMITS, megabytes, PROJECT_ENV_FILE, projectConnections, type ImportedConnection } from '@dbmastermind/core'

/** A project's own file that describes connections: a .env file or a docker-compose file. */
export const isProjectFile = (path: string) => PROJECT_ENV_FILE.test(basename(path)) || COMPOSE_FILE.test(basename(path))

/**
 * One file of the project, if it is a plain file of at most 1 MB. A link is not followed: in a folder from a
 * stranger, `.env` may point at ~/.ssh/id_rsa or another project's secrets.
 */
function readPlain(path: string): string | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return undefined
  }
  if (!stat.isFile()) return undefined
  if (stat.size > FILE_LIMITS.project) throw new Error(`${basename(path)} is larger than ${megabytes(FILE_LIMITS.project)}: not a project's settings file`)
  return readFileSync(path, 'utf8')
}

/**
 * Connections of a project: a folder (its top-level .env files, compose files and prisma/schema.prisma), a .env
 * file, or a compose file with the .env beside it. Nothing else is read: no env_file, no path a file names, no
 * link, nothing below the folder but prisma/schema.prisma.
 */
export function readProject(path: string): ImportedConnection[] {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('A link to a folder or file is not read: open the folder or the file itself')
  const folder = stat.isDirectory()
  const dir = folder ? path : dirname(path)
  const files: Record<string, string> = {}
  const add = (name: string, relative = name) => {
    const text = readPlain(join(dir, relative))
    if (text !== undefined) files[name] = text
  }
  if (folder) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isFile() && isProjectFile(entry.name)) add(entry.name)
    // (prisma/ itself may be a link out of the folder: only a real folder is looked into.)
    const prisma = join(dir, 'prisma')
    let real = false
    try {
      real = lstatSync(prisma).isDirectory()
    } catch {
      // No prisma folder.
    }
    if (real) add('prisma/schema.prisma', join('prisma', 'schema.prisma'))
  } else {
    if (!stat.isFile()) throw new Error('Not a project folder, .env file or docker-compose file')
    add(basename(path))
    // Compose reads the .env beside it for ${VAR}.
    if (COMPOSE_FILE.test(basename(path))) add('.env')
  }
  // A SQLite file a project names (Laravel's DB_DATABASE=database/database.sqlite) is the project's own: a relative
  // path is the folder's, and a path out of the folder (a stranger's .env naming ~/x.db) is not taken.
  return projectConnections(files, basename(dir), { folder }).flatMap((c) => {
    if (c.driver !== 'sqlite' || !c.filePath) return [c]
    const full = resolve(dir, c.filePath)
    const inside = relative(dir, full)
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? [{ ...c, filePath: full }] : []
  })
}
