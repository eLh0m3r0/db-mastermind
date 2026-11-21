// Collects public files of other tools and projects for the real-file checks (they never go into the repository):
//   node scripts/model-samples.mjs <folder> [sakila drawdb mermaid env compose dbml]
// writes <folder>/sakila/{sakila.mwb,sakila-schema.sql} (MySQL's Sakila, from downloads.mysql.com),
// <folder>/drawdb/dNN.{json,ddb} (drawDB exports), <folder>/mermaid/mNN.{mmd,mermaid,md} (Mermaid ER diagrams),
// <folder>/env/eNN.env (.env.example files), <folder>/compose/cNN.yml (docker-compose files) and
// <folder>/dbml/dNN.dbml (DBML models), all found on GitHub, with <folder>/sources.txt saying where each came from.
// Without kinds it collects all of them. Then:
//   DBM_MODEL_SAMPLES=<folder> npx vitest run --project unit packages/core/test/model-samples.test.ts packages/core/test/project-samples.test.ts
// The files are only read by the app's own readers: nothing in them is run. Needs the `gh` CLI for GitHub's search.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

const [dest, ...only] = process.argv.slice(2)
if (!dest) throw new Error('Usage: node scripts/model-samples.mjs <folder> [sakila drawdb mermaid env compose dbml]')
const wanted = (kind) => !only.length || only.includes(kind)
const gh = (...args) => execFileSync('gh', ['api', ...args], { maxBuffer: 64 * 1024 * 1024 })
const raw = (repo, path) => gh(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, '-H', 'Accept: application/vnd.github.raw')
const search = (q, n) => JSON.parse(gh('-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', `per_page=${n}`).toString()).items

// Sakila: the Workbench model and the script it belongs with, as MySQL ships them.
if (wanted('sakila')) {
const zip = new Uint8Array(await (await fetch('https://downloads.mysql.com/docs/sakila-db.zip')).arrayBuffer())
const files = unzipSync(zip)
mkdirSync(join(dest, 'sakila'), { recursive: true })
for (const name of ['sakila.mwb', 'sakila-schema.sql']) {
  const data = files[`sakila-db/${name}`]
  if (!data) throw new Error(`sakila-db.zip has no ${name}`)
  writeFileSync(join(dest, 'sakila', name), data)
}
appendFileSync(join(dest, 'sources.txt'), 'sakila https://downloads.mysql.com/docs/sakila-db.zip\n')
}

/** Files a search finds, each saved once under its own number if `keep` accepts its content. */
function collect(kind, queries, keep, extension) {
  if (!wanted(kind)) return 0
  const seen = new Set()
  let n = 0
  for (const [q, count] of queries) {
    for (const item of search(q, count).sort((a, b) => `${a.repository.full_name}/${a.path}`.localeCompare(`${b.repository.full_name}/${b.path}`))) {
      const id = `${item.repository.full_name}/${item.path}`
      if (seen.has(id)) continue
      seen.add(id)
      let data
      try {
        data = raw(item.repository.full_name, item.path)
      } catch {
        continue
      }
      if (!keep(data.toString('utf8'))) continue
      const name = `${kind[0]}${String(++n).padStart(2, '0')}.${extension ?? item.path.split('.').pop().toLowerCase()}`
      mkdirSync(join(dest, kind), { recursive: true })
      writeFileSync(join(dest, kind, name), data)
      appendFileSync(join(dest, 'sources.txt'), `${kind}/${name} ${id}\n`)
    }
  }
  return n
}

const drawdb = collect(
  'drawdb',
  [
    ['startTableId subjectAreas extension:json', 40],
    ['startTableId extension:ddb', 15],
  ],
  (text) => {
    try {
      const d = JSON.parse(text)
      return Array.isArray(d.tables) && (Array.isArray(d.relationships) || Array.isArray(d.references))
    } catch {
      return false
    }
  },
)
const mermaid = collect(
  'mermaid',
  [
    ['erDiagram extension:mmd', 30],
    ['erDiagram extension:mermaid', 10],
    ['erDiagram "||--o{" extension:md', 10],
  ],
  (text) => /\berDiagram\b/.test(text),
)
// .env templates and compose files of public projects (A4), DBML models (the native format's real-world corpus).
const env = collect(
  'env',
  [
    ['filename:.env.example DATABASE_URL', 30],
    ['filename:.env.example DB_HOST', 20],
    ['filename:.env.example PGHOST', 10],
  ],
  (text) => /^\s*(export\s+)?[A-Z_][A-Z0-9_]*\s*=/m.test(text),
  'env',
)
const compose = collect(
  'compose',
  [
    ['filename:docker-compose.yml image postgres', 20],
    ['filename:docker-compose.yml image mysql', 10],
    ['filename:compose.yaml image postgres', 10],
    ['filename:docker-compose.yml image mcr.microsoft.com/mssql', 5],
  ],
  (text) => /\bservices\s*:/.test(text),
  'yml',
)
const dbml = collect(
  'dbml',
  [
    ['extension:dbml Table Ref', 40],
    ['extension:dbml indexes pk', 20],
    ['extension:dbml Enum', 10],
  ],
  (text) => /^\s*Table\s/im.test(text),
)
console.log(`sakila: ${wanted('sakila') ? 2 : 0} files | drawDB: ${drawdb} | Mermaid: ${mermaid} | .env: ${env} | compose: ${compose} | DBML: ${dbml} | in ${dest}`)
