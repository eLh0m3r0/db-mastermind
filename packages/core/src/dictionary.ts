import type { SchemaSnapshot, TableInfo } from './types.js'

export interface DictionaryNote {
  title: string
  /** Markdown body from the knowledge base. */
  body: string
}

export interface DictionaryOptions {
  format: 'markdown' | 'html'
  title?: string
  /** Shown under the title, e.g. "PostgreSQL 17 · shop@prod". */
  subtitle?: string
  /** Limit to these schemas; all when empty. */
  schemas?: string[]
  /** Knowledge base notes keyed by `schema.table` or bare table name (lower case). */
  notes?: Map<string, DictionaryNote[]>
  generatedAt?: Date
}

const TYPE_LABELS: Record<TableInfo['type'], string> = {
  table: 'Table',
  view: 'View',
  materialized_view: 'Materialized view',
  foreign_table: 'Foreign table',
}

const qualified = (t: { schema?: string; name: string }) => (t.schema ? `${t.schema}.${t.name}` : t.name)
const anchor = (t: { schema?: string; name: string }) => `t-${qualified(t).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`

interface Prepared {
  tables: TableInfo[]
  referencedBy: Map<TableInfo, { table: TableInfo; columns: string[]; refColumns: string[] }[]>
  notesFor: (t: TableInfo) => DictionaryNote[]
  findRef: (schema: string | undefined, name: string) => TableInfo | undefined
}

function prepare(snapshot: SchemaSnapshot, options: DictionaryOptions): Prepared {
  const wanted = options.schemas?.length ? new Set(options.schemas) : null
  const tables = snapshot.tables
    .filter((t) => !wanted || wanted.has(t.schema ?? ''))
    .sort((a, b) => (a.schema ?? '').localeCompare(b.schema ?? '') || a.name.localeCompare(b.name))
  const findRef = (schema: string | undefined, name: string) =>
    snapshot.tables.find((t) => t.name === name && (schema === undefined || (t.schema ?? '') === schema)) ??
    snapshot.tables.find((t) => t.name.toLowerCase() === name.toLowerCase())
  const referencedBy: Prepared['referencedBy'] = new Map()
  for (const t of snapshot.tables) {
    for (const fk of t.foreignKeys) {
      const target = findRef(fk.refSchema ?? t.schema, fk.refTable)
      if (!target) continue
      referencedBy.set(target, [...(referencedBy.get(target) ?? []), { table: t, columns: fk.columns, refColumns: fk.refColumns }])
    }
  }
  const notesFor = (t: TableInfo) => {
    const seen = new Set<DictionaryNote>()
    for (const key of [qualified(t).toLowerCase(), t.name.toLowerCase()]) for (const n of options.notes?.get(key) ?? []) seen.add(n)
    return [...seen]
  }
  return { tables, referencedBy, notesFor, findRef }
}

const mdCell = (s: string | null | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

function toMarkdown(snapshot: SchemaSnapshot, options: DictionaryOptions, p: Prepared): string {
  const out: string[] = [`# ${options.title ?? 'Data dictionary'}`, '']
  if (options.subtitle) out.push(options.subtitle, '')
  out.push(`_Generated ${(options.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')} · ${p.tables.length} objects_`, '')
  out.push('## Contents', '')
  for (const t of p.tables) out.push(`- [${qualified(t)}](#${anchor(t)})${t.comment ? ` — ${mdCell(t.comment)}` : ''}`)
  for (const t of p.tables) {
    out.push('', `<a id="${anchor(t)}"></a>`, '', `## ${qualified(t)}`, '')
    const facts = [TYPE_LABELS[t.type]]
    if (t.rowEstimate != null && t.rowEstimate >= 0) facts.push(`~${t.rowEstimate.toLocaleString('en-US')} rows`)
    out.push(`_${facts.join(' · ')}_`, '')
    if (t.comment) out.push(t.comment, '')
    out.push('| Column | Type | Null | Default | Key | Description |', '|---|---|---|---|---|---|')
    for (const c of t.columns) {
      const fk = t.foreignKeys.find((f) => f.columns.includes(c.name))
      const key = [c.isPrimaryKey ? 'PK' : '', fk ? `FK → ${fk.refTable}.${fk.refColumns[fk.columns.indexOf(c.name)] ?? ''}` : ''].filter(Boolean).join(', ')
      out.push(`| \`${c.name}\` | ${mdCell(c.dataType)} | ${c.nullable ? 'yes' : 'no'} | ${c.defaultValue ? `\`${mdCell(c.defaultValue)}\`` : ''} | ${key} | ${mdCell(c.comment)} |`)
    }
    const refs = p.referencedBy.get(t) ?? []
    if (refs.length) {
      out.push('', '**Referenced by**', '')
      for (const r of refs) out.push(`- [${qualified(r.table)}](#${anchor(r.table)}) (${r.columns.join(', ')})`)
    }
    const indexes = t.indexes.filter((i) => !i.primary)
    if (indexes.length) {
      out.push('', '**Indexes**', '')
      for (const i of indexes) out.push(`- \`${i.name}\` (${i.columns.join(', ')})${i.unique ? ' unique' : ''}`)
    }
    if (t.definition) out.push('', '**Definition**', '', '```sql', t.definition.trim(), '```')
    // Note headings sit below the table's own heading level.
    for (const n of p.notesFor(t)) out.push('', `**Notes: ${n.title}**`, '', n.body.trim().replace(/^(#{1,6})\s/gm, (_, h: string) => `${'#'.repeat(Math.min(6, h.length + 2))} `))
  }
  return `${out.join('\n')}\n`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Minimal, safe Markdown → HTML for knowledge base notes (input is escaped first). */
export function renderMarkdown(md: string): string {
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
  const html: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const flush = () => {
    if (para.length) html.push(`<p>${para.map(inline).join(' ')}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) html.push(`</${list}>`)
    list = null
  }
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (/^```/.test(line)) {
      flush()
      closeList()
      const code: string[] = []
      while (++i < lines.length && !/^```/.test(lines[i]!)) code.push(lines[i]!)
      html.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      closeList()
      const level = Math.min(6, heading[1]!.length + 3)
      html.push(`<h${level}>${inline(heading[2]!)}</h${level}>`)
    } else if (bullet || numbered) {
      flush()
      const kind = bullet ? 'ul' : 'ol'
      if (list !== kind) {
        closeList()
        html.push(`<${kind}>`)
        list = kind
      }
      html.push(`<li>${inline((bullet ?? numbered)![1]!)}</li>`)
    } else if (!line.trim()) {
      flush()
      closeList()
    } else {
      closeList()
      para.push(line.trim())
    }
  }
  flush()
  closeList()
  return html.join('\n')
}

const STYLE = `
:root{--bg:#fff;--fg:#1d2026;--muted:#626a78;--faint:#8a919c;--line:#e4e6ea;--subtle:#f6f7f9;--accent:#5b4fe0;--accent-soft:#eeecfd;--code:#f2f3f5}
@media (prefers-color-scheme:dark){:root{--bg:#16181d;--fg:#e6e8ec;--muted:#a3a9b4;--faint:#7d8490;--line:#2c3038;--subtle:#1d2026;--accent:#9d94ff;--accent-soft:#2a2750;--code:#23262d}}
*{box-sizing:border-box}html{scroll-padding-top:16px}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
.layout{display:flex;min-height:100vh}
nav{position:sticky;top:0;height:100vh;width:280px;flex-shrink:0;overflow:auto;border-right:1px solid var(--line);background:var(--subtle);padding:16px 12px}
nav input{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit;margin-bottom:10px}
nav a{display:block;padding:2px 6px;border-radius:4px;color:var(--fg);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover{background:var(--accent-soft)}nav .schema{margin:12px 6px 4px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--faint)}
main{flex:1;min-width:0;max-width:1100px;padding:24px 32px 80px}
h1{margin:0 0 4px;font-size:24px}.sub{color:var(--muted);margin:0 0 24px}
section{border-top:1px solid var(--line);padding:20px 0}
h2{margin:0 0 2px;font-size:18px}h2 small{font-weight:400;color:var(--faint);font-size:13px;margin-left:8px}
.comment{margin:6px 0 12px;color:var(--muted)}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}
th{text-align:left;font-weight:600;color:var(--muted);font-size:12px;border-bottom:1px solid var(--line);padding:6px 8px}
td{border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px}
td code{background:var(--code);padding:1px 4px;border-radius:4px}
.pk{display:inline-block;font-size:10.5px;font-weight:600;padding:0 5px;border-radius:4px;background:var(--accent-soft);color:var(--accent);margin-right:4px}
.no{color:var(--faint)}a{color:var(--accent)}
h3{font-size:13px;margin:16px 0 4px;color:var(--muted)}
pre{background:var(--code);padding:10px 12px;border-radius:6px;overflow:auto;font-size:12.5px}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 12px;margin:12px 0}.note h4,.note h5,.note h6{margin:8px 0 4px}
@media (max-width:760px){.layout{display:block}nav{position:static;height:auto;width:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:16px}}
@media print{nav{display:none}main{max-width:none;padding:0}section{break-inside:avoid-page}}
`

const SCRIPT = `
const q=document.getElementById('q');q.addEventListener('input',()=>{const v=q.value.toLowerCase();
for(const a of document.querySelectorAll('nav a')){a.style.display=a.dataset.k.includes(v)?'':'none'}
for(const s of document.querySelectorAll('main section')){s.style.display=!v||s.dataset.k.includes(v)?'':'none'}});
`

function toHtml(snapshot: SchemaSnapshot, options: DictionaryOptions, p: Prepared): string {
  const title = options.title ?? 'Data dictionary'
  const nav: string[] = []
  let lastSchema: string | undefined | null = null
  for (const t of p.tables) {
    if ((t.schema ?? '') !== lastSchema) {
      lastSchema = t.schema ?? ''
      if (lastSchema) nav.push(`<div class="schema">${esc(lastSchema)}</div>`)
    }
    nav.push(`<a href="#${anchor(t)}" data-k="${esc(qualified(t).toLowerCase())}">${esc(t.name)}</a>`)
  }
  const link = (t: TableInfo) => `<a href="#${anchor(t)}">${esc(qualified(t))}</a>`
  const sections = p.tables.map((t) => {
    const facts = [TYPE_LABELS[t.type]]
    if (t.rowEstimate != null && t.rowEstimate >= 0) facts.push(`~${t.rowEstimate.toLocaleString('en-US')} rows`)
    const rows = t.columns
      .map((c) => {
        const fk = t.foreignKeys.find((f) => f.columns.includes(c.name))
        const target = fk && p.findRef(fk.refSchema ?? t.schema, fk.refTable)
        const refCol = fk ? (fk.refColumns[fk.columns.indexOf(c.name)] ?? '') : ''
        const key = [
          c.isPrimaryKey ? '<span class="pk">PK</span>' : '',
          fk ? `<span class="pk">FK${fk.virtual ? '*' : ''}</span>${target ? `<a href="#${anchor(target)}">${esc(fk.refTable)}</a>` : esc(fk.refTable)}.${esc(refCol)}` : '',
        ].join('')
        return `<tr><td><code>${esc(c.name)}</code></td><td class="mono">${esc(c.dataType)}</td><td>${c.nullable ? 'yes' : '<span class="no">no</span>'}</td><td>${c.defaultValue ? `<code>${esc(c.defaultValue)}</code>` : ''}</td><td>${key}</td><td>${esc(c.comment ?? '')}</td></tr>`
      })
      .join('\n')
    const refs = p.referencedBy.get(t) ?? []
    const indexes = t.indexes.filter((i) => !i.primary)
    const notes = p.notesFor(t)
    const searchKey = [qualified(t), t.comment ?? '', ...t.columns.map((c) => `${c.name} ${c.comment ?? ''}`)].join(' ').toLowerCase()
    return `<section id="${anchor(t)}" data-k="${esc(searchKey)}">
<h2>${esc(qualified(t))}<small>${esc(facts.join(' · '))}</small></h2>
${t.comment ? `<p class="comment">${esc(t.comment)}</p>` : ''}
<table><thead><tr><th>Column</th><th>Type</th><th>Null</th><th>Default</th><th>Key</th><th>Description</th></tr></thead><tbody>
${rows}
</tbody></table>
${refs.length ? `<h3>Referenced by</h3><p>${refs.map((r) => `${link(r.table)} <span class="no">(${esc(r.columns.join(', '))})</span>`).join(', ')}</p>` : ''}
${indexes.length ? `<h3>Indexes</h3><p>${indexes.map((i) => `<code>${esc(i.name)}</code> (${esc(i.columns.join(', '))})${i.unique ? ' unique' : ''}`).join('<br>')}</p>` : ''}
${t.definition ? `<h3>Definition</h3><pre><code>${esc(t.definition.trim())}</code></pre>` : ''}
${notes.map((n) => `<div class="note"><h3>${esc(n.title)}</h3>${renderMarkdown(n.body)}</div>`).join('\n')}
</section>`
  })
  const generated = (options.generatedAt ?? new Date()).toISOString().slice(0, 16).replace('T', ' ')
  const virtual = p.tables.some((t) => t.foreignKeys.some((f) => f.virtual))
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${STYLE}</style></head>
<body><div class="layout">
<nav><input id="q" type="search" placeholder="Search tables and columns…">${nav.join('\n')}</nav>
<main><h1>${esc(title)}</h1>
<p class="sub">${options.subtitle ? `${esc(options.subtitle)} · ` : ''}${p.tables.length} objects · generated ${generated}${virtual ? ' · FK* = relationship documented in the knowledge base' : ''}</p>
${sections.join('\n')}
</main></div><script>${SCRIPT}</script></body></html>
`
}

/** Documentation of a schema: every table and view with columns, keys, relationships, indexes and notes. */
export function buildDataDictionary(snapshot: SchemaSnapshot, options: DictionaryOptions): string {
  const p = prepare(snapshot, options)
  return options.format === 'html' ? toHtml(snapshot, options, p) : toMarkdown(snapshot, options, p)
}
