// Collects public models of other tools for the real-file check of the imports (they never go into the repository):
//   node scripts/model-samples.mjs <folder>
// writes <folder>/sakila/{sakila.mwb,sakila-schema.sql} (MySQL's Sakila, from downloads.mysql.com),
// <folder>/drawdb/dNN.{json,ddb} (drawDB exports found on GitHub) and <folder>/mermaid/mNN.{mmd,mermaid,md}
// (Mermaid ER diagrams found on GitHub), with <folder>/sources.txt saying where each came from. Then:
//   DBM_MODEL_SAMPLES=<folder> npx vitest run --project unit packages/core/test/model-samples.test.ts
// The files are only read by the app's own readers: nothing in them is run. Needs the `gh` CLI for GitHub's search.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

const dest = process.argv[2]
if (!dest) throw new Error('Usage: node scripts/model-samples.mjs <folder>')
const gh = (...args) => execFileSync('gh', ['api', ...args], { maxBuffer: 64 * 1024 * 1024 })
const raw = (repo, path) => gh(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, '-H', 'Accept: application/vnd.github.raw')
const search = (q, n) => JSON.parse(gh('-X', 'GET', 'search/code', '-f', `q=${q}`, '-f', `per_page=${n}`).toString()).items

// Sakila: the Workbench model and the script it belongs with, as MySQL ships them.
const zip = new Uint8Array(await (await fetch('https://downloads.mysql.com/docs/sakila-db.zip')).arrayBuffer())
const files = unzipSync(zip)
mkdirSync(join(dest, 'sakila'), { recursive: true })
for (const name of ['sakila.mwb', 'sakila-schema.sql']) {
  const data = files[`sakila-db/${name}`]
  if (!data) throw new Error(`sakila-db.zip has no ${name}`)
  writeFileSync(join(dest, 'sakila', name), data)
}
appendFileSync(join(dest, 'sources.txt'), 'sakila https://downloads.mysql.com/docs/sakila-db.zip\n')

/** Files a search finds, each saved once under its own number if `keep` accepts its content. */
function collect(kind, queries, keep) {
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
      const name = `${kind[0]}${String(++n).padStart(2, '0')}.${item.path.split('.').pop().toLowerCase()}`
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
console.log(`sakila: 2 files | drawDB: ${drawdb} | Mermaid: ${mermaid} | in ${dest}`)
