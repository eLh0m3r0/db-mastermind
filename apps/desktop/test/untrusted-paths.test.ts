import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { checkChosenPath, isChosenPath, keepChosenPathsIn, rememberChosenPath } from '../src/main/chosen-paths'
import { readProject } from '../src/main/project-files'

// Files from strangers and paths from the renderer (wave 3): main reads what the user handed to the app, and of a
// project folder only its own plain files.
const dir = mkdtempSync(join(tmpdir(), 'dbm-untrusted-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('paths from the renderer', () => {
  it('are read only when the user handed them to the app (dialog, drop, command line), also after a restart', () => {
    const store = join(dir, 'data', 'chosen-paths.json')
    keepChosenPathsIn(store)
    const model = join(dir, 'shop.mwb')
    expect(isChosenPath(model)).toBe(false)
    expect(() => checkChosenPath(join(dir, '..', '..', '.ssh', 'id_rsa'))).toThrow(/through the app/)
    rememberChosenPath(model)
    expect(checkChosenPath(model)).toBe(model)
    // The same path spelled another way is the same path; a relative one from the renderer is never remembered.
    expect(isChosenPath(join(dir, 'x', '..', 'shop.mwb'))).toBe(true)
    rememberChosenPath('relative/project')
    expect(isChosenPath('relative/project')).toBe(false)
    // After a restart the list is read back from main's data folder.
    keepChosenPathsIn(store)
    expect(isChosenPath(model)).toBe(true)
    expect(JSON.parse(readFileSync(store, 'utf8'))).toEqual([model])
  })
})

describe('a project folder from a stranger', () => {
  const outside = join(dir, 'secrets')
  mkdirSync(outside)
  writeFileSync(join(outside, 'id_rsa'), 'DATABASE_URL=postgres://stolen:key@evil.example/db\n')
  writeFileSync(join(outside, 'schema.prisma'), 'datasource db {\n  provider = "postgresql"\n  url = "postgres://stolen:key@evil.example/db"\n}\n')

  it('reads its own .env and compose files, no link out of it, no env_file, no other path a file names', () => {
    const project = join(dir, 'shop')
    mkdirSync(project)
    writeFileSync(join(project, '.env'), 'DB_PASSWORD=pw\n')
    // Compose names files elsewhere: they are not read.
    writeFileSync(join(project, 'docker-compose.yml'), `services:\n  db:\n    image: postgres:16\n    env_file: ../secrets/id_rsa\n    environment:\n      POSTGRES_PASSWORD: \${DB_PASSWORD}\n    ports: ["5432:5432"]\n`)
    symlinkSync(join(outside, 'id_rsa'), join(project, '.env.local'))
    symlinkSync(outside, join(project, 'prisma'))
    const found = readProject(project)
    expect(found.map((c) => [c.name, c.host, c.password])).toEqual([['shop — db', 'localhost', 'pw']])
    expect(JSON.stringify(found)).not.toMatch(/stolen|evil/)
  })

  it('refuses a linked folder or file itself, and a file over 1 MB', () => {
    const link = join(dir, 'linked')
    symlinkSync(outside, link)
    expect(() => readProject(link)).toThrow(/link/)
    const big = join(dir, 'big')
    mkdirSync(big)
    writeFileSync(join(big, '.env'), `A=${'x'.repeat(1024 * 1024)}\n`)
    expect(() => readProject(big)).toThrow(/\.env is larger than 1 MB/)
  })
})

describe("a project's SQLite file (review L7)", () => {
  it('is the project folder\'s when relative, and not taken when it points out of the folder', () => {
    const project = join(dir, 'laravel')
    mkdirSync(project)
    writeFileSync(join(project, '.env'), 'DB_CONNECTION=sqlite\nDB_DATABASE=database/database.sqlite\n')
    expect(readProject(project).map((c) => c.filePath)).toEqual([join(project, 'database', 'database.sqlite')])
    writeFileSync(join(project, '.env'), 'DB_CONNECTION=sqlite\nDB_DATABASE=../../elsewhere.db\n')
    expect(readProject(project)).toEqual([])
    writeFileSync(join(project, '.env'), 'DB_CONNECTION=sqlite\nDB_DATABASE=/etc/hosts\n')
    expect(readProject(project)).toEqual([])
  })
})

describe.skipIf(process.platform === 'win32')('files that never end or block (review M2)', () => {
  // (A FIFO read would block for ever and /dev/zero never ends: finishing at all is the check.)
  it('a project folder with a FIFO .env and prisma/schema.prisma -> /dev/zero is read', { timeout: 30_000 }, async () => {
    const { execFileSync } = await import('node:child_process')
    const project = join(dir, 'never-ends')
    mkdirSync(join(project, 'prisma'), { recursive: true })
    execFileSync('mkfifo', [join(project, '.env')])
    symlinkSync('/dev/zero', join(project, 'prisma', 'schema.prisma'))
    writeFileSync(join(project, 'docker-compose.yml'), 'services:\n  db:\n    image: postgres:16\n    ports: ["5432:5432"]\n')
    expect(readProject(project).map((c) => c.driver)).toEqual(['postgres'])
    // The FIFO picked itself: refused, not waited on.
    expect(() => readProject(join(project, '.env'))).toThrow()
  })

  it('a model that is a link to /dev/zero, a FIFO, or larger than it says is refused while reading', { timeout: 30_000 }, async () => {
    const { execFileSync } = await import('node:child_process')
    const { readForeignModel, isForeignModel } = await import('../src/main/foreign-model')
    const zero = join(dir, 'zero.prisma')
    symlinkSync('/dev/zero', zero)
    await expect(readForeignModel(zero)).rejects.toThrow(/not a plain file/)
    const fifo = join(dir, 'fifo.mmd')
    execFileSync('mkfifo', [fifo])
    await expect(readForeignModel(fifo)).rejects.toThrow(/not a plain file/)
    const json = join(dir, 'fifo.json')
    execFileSync('mkfifo', [json])
    expect(await isForeignModel(json)).toBe(false)
  })
})
