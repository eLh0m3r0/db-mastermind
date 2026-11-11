// Collects public DeZign for Databases models for the real-world tests (they never go into the repository):
//   node scripts/dezign-samples.mjs <folder>
// writes <folder>/models/sNN/model.dez (for DBM_DEZ_SAMPLES) and <folder>/pairs/<name>/{model.dez,dezign.sql}
// (for DBM_DEZ_PAIRS: a model with the PostgreSQL script DeZign itself generated from it). Needs the `gh` CLI.
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dest = process.argv[2]
if (!dest) throw new Error('Usage: node scripts/dezign-samples.mjs <folder>')
const gh = (...args) => execFileSync('gh', ['api', ...args], { maxBuffer: 64 * 1024 * 1024 })
const raw = (repo, path) => gh(`repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, '-H', 'Accept: application/vnd.github.raw')

const found = JSON.parse(gh('-X', 'GET', 'search/code', '-f', 'q=extension:dez dezign', '-f', 'per_page=100').toString()).items
let n = 0
for (const item of found.sort((a, b) => `${a.repository.full_name}/${a.path}`.localeCompare(`${b.repository.full_name}/${b.path}`))) {
  const data = raw(item.repository.full_name, item.path)
  if (!data.subarray(0, 400).includes('<dezign')) continue
  const dir = join(dest, 'models', `s${String(++n).padStart(2, '0')}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model.dez'), data)
  appendFileSync(join(dest, 'sources.txt'), `s${String(n).padStart(2, '0')} ${item.repository.full_name} ${item.path}\n`)
}
// Models kept next to the creation script DeZign generated from them.
const PAIRS = [
  ['cts', 'joloortiz/CTS', '_database/_ERD/ERD1.0.dez', '_database/_ERD/create_postgresql.sql'],
  ['openbis6', 'kykrueger/openbis', 'eu_basysbio/source/sql/postgresql/006/schema-006.dez', 'eu_basysbio/source/sql/postgresql/006/schema-006.sql'],
  ['openbis8', 'kykrueger/openbis', 'eu_basysbio/source/sql/postgresql/008/schema-008.dez', 'eu_basysbio/source/sql/postgresql/008/schema-008.sql'],
]
for (const [name, repo, model, script] of PAIRS) {
  const dir = join(dest, 'pairs', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'model.dez'), raw(repo, model))
  writeFileSync(join(dir, 'dezign.sql'), raw(repo, script))
}
console.log(`models: ${n} of ${found.length} hits | pairs: ${PAIRS.length} | in ${dest}`)
