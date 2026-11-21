import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectionsFromEnv, databaseImage, parseDotenv, servicesFromCompose } from '../src/index.js'

/**
 * Connections from projects on real files (docs/specs/launch.md, A4): .env templates and docker-compose files of
 * public projects must read without an error, and a compose file with a database service must have it found.
 * Collect with `node scripts/model-samples.mjs <folder> env compose`, run with DBM_MODEL_SAMPLES=<folder>.
 * Prints counts only: these files may hold what looks like a secret, and nothing of them is shown.
 */
const folder = process.env.DBM_MODEL_SAMPLES
const files = (kind: string) => {
  try {
    return readdirSync(join(folder!, kind)).map((f) => join(folder!, kind, f))
  } catch {
    return []
  }
}

describe.skipIf(!folder)('connections from projects, real files', () => {
  it('reads every .env template', () => {
    const list = files('env')
    let variables = 0
    let connections = 0
    let withConnection = 0
    const failed: string[] = []
    for (const file of list) {
      try {
        const vars = parseDotenv(readFileSync(file, 'utf8'))
        variables += Object.keys(vars).length
        const found = connectionsFromEnv(vars, 'project')
        connections += found.length
        if (found.length) withConnection++
      } catch (err) {
        failed.push(`${file.split('/').pop()}: ${(err as Error).name}`)
      }
    }
    console.log(`.env: ${list.length - failed.length}/${list.length} files read, ${variables} variables, ${connections} connections in ${withConnection} files`)
    expect(list.length).toBeGreaterThanOrEqual(30)
    expect(failed).toEqual([])
  })

  it('reads every compose file and finds its database services', () => {
    const list = files('compose')
    let services = 0
    let published = 0
    const failed: string[] = []
    const invalid: string[] = []
    const missed: string[] = []
    for (const file of list) {
      const text = readFileSync(file, 'utf8')
      // The database images the file names, counted apart from the reader: `image:` lines it would know.
      const images = [...text.matchAll(/^\s*image\s*:\s*["']?([^"'\s#]+)/gm)].map((m) => m[1]!).filter((i) => !i.includes('$') && databaseImage(i))
      try {
        const found = servicesFromCompose(text, {}, 'project')
        services += found.length
        published += found.filter((s) => s.connection).length
        if (found.length < images.length) missed.push(`${file.split('/').pop()}: ${found.length} of ${images.length}`)
      } catch (err) {
        // Not YAML at all (a template, a comment broken over two lines): `docker compose` refuses these too, and the
        // app says so; anything else would be the reader's fault.
        if (/^Not a readable compose file/.test((err as Error).message)) invalid.push(file)
        else failed.push(`${file.split('/').pop()}: ${(err as Error).name}`)
      }
    }
    console.log(`compose: ${list.length - failed.length - invalid.length}/${list.length} files read, ${invalid.length} not valid YAML (refused with a message), ${services} database services found (${published} published to this computer), ${missed.length} files with a database service not found`)
    expect(list.length).toBeGreaterThanOrEqual(30)
    expect(failed).toEqual([])
    expect(missed).toEqual([])
  })
})
