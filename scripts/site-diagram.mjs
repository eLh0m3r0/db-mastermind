// Recomputes the relationship lines of the home page's product diagram after a table was changed by hand.
//
//   node scripts/site-diagram.mjs
//
// It reads docs/index.html: each table (<details class="node" data-node="…" style="--x:…;--y:…">, its rows in
// order as <li data-col="…">) and each line (<path data-from="table.column" data-to="table.column" d="…">), and
// writes new d="…" values with the route function of docs/site.js (between its [route:start] and [route:end]
// comments), the same one that re-routes the lines while a table is dragged. No dependencies.
import { readFileSync, writeFileSync } from 'node:fs'

const root = new URL('../docs/', import.meta.url)
const file = new URL('index.html', root)
const html = readFileSync(file, 'utf8')
const siteJs = readFileSync(new URL('site.js', root), 'utf8')
const code = siteJs.slice(siteJs.indexOf('// [route:start]'), siteJs.indexOf('// [route:end]'))
const route = new Function(`${code}; return route`)()

const tables = new Map()
for (const m of html.matchAll(/<details class="node" data-node="([\w-]+)" style="--x:(\d+);--y:(\d+)"[^>]*>([\s\S]*?)<\/details>/g)) {
  const rows = [...m[4].matchAll(/<li data-col="([\w-]+)"/g)].map((r) => r[1])
  tables.set(m[1], { x: Number(m[2]), y: Number(m[3]), rows })
}
const at = (ref) => {
  const [name, col] = ref.split('.')
  const t = tables.get(name)
  if (!t) throw new Error(`no table "${name}" (in ${ref})`)
  const i = t.rows.indexOf(col)
  if (i < 0) throw new Error(`table "${name}" has no row "${col}"`)
  return [t, i]
}
let count = 0
const out = html.replace(/<path data-from="([\w.-]+)" data-to="([\w.-]+)" d="[^"]*"/g, (_, from, to) => {
  const [c, ci] = at(from)
  const [p, pi] = at(to)
  count++
  return `<path data-from="${from}" data-to="${to}" d="${route(c, ci, p, pi)}"`
})
writeFileSync(file, out)
console.log(`${tables.size} tables, ${count} lines rewritten in docs/index.html`)
