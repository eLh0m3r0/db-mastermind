import { lstatSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { COMPOSE_FILE, FILE_LIMITS, NotAFileError, PROJECT_ENV_FILE, projectConnections, readCappedSync, type ImportedConnection } from '@dbmastermind/core'

/** A project's own file that describes connections: a .env file or a docker-compose file. */
export const isProjectFile = (path: string) => PROJECT_ENV_FILE.test(basename(path)) || COMPOSE_FILE.test(basename(path))

/**
 * One file of the project, if it is a plain file of at most 1 MB. A link is not followed: in a folder from a
 * stranger, `.env` may point at ~/.ssh/id_rsa or another project's secrets. A FIFO or a device is skipped, and
 * reading stops at the limit (the size a file reports is not trusted).
 */
function readPlain(path: string): string | undefined {
  try {
    return readCappedSync(path, { limit: FILE_LIMITS.project, what: "a project's settings file", follow: false }).toString('utf8')
  } catch (err) {
    if (err instanceof NotAFileError || (err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
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
