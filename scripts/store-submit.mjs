// Submits a release to the Microsoft Store through the Store submission API (no msstore CLI: its configuration test
// refuses credentials the API accepts). Texts and screenshots come from the repository at the release's tag
// (docs/store-listing.md, docs/screenshots/), the package is the release's DB-Mastermind-<version>-store.appx.
// Everything else (title, privacy policy, website, support contact, hardware, pricing, properties) stays as the last
// published submission has it.
//
//   node scripts/store-submit.mjs plan   --tag v1.5.4 --repo <checkout>   what would change; sends nothing
//   node scripts/store-submit.mjs submit --tag v1.5.4 --repo <checkout>   creates, uploads, commits
// <checkout> is the repository at the tag, or at a later commit when the Store texts were finished after tagging.
//
// Environment: MSSTORE_TENANT_ID, MSSTORE_CLIENT_ID, MSSTORE_CLIENT_SECRET (Microsoft Entra app with Partner Center
// access), MSSTORE_IDENTITY_NAME and MSSTORE_PUBLISHER (the package identity the Store expects), GITHUB_REPOSITORY and
// GH_TOKEN (to download the release asset). Never prints a token or the upload URL (it carries a signature).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PRODUCT_ID = '9P0GRD7BZ4NF'
const API = 'https://manage.devcenter.microsoft.com/v1.0/my'
const LANGUAGES = ['en-us', 'cs-cz']

/**
 * The Store's limits (learn.microsoft.com, MSIX: "Add and edit Store listing info", "Add additional information"
 * (keywords, copyright), "App screenshots, images, and trailers").
 */
export const LIMITS = {
  description: 10_000,
  shortDescription: 1_000,
  features: { count: 20, length: 200 },
  keywords: { count: 7, length: 40, words: 21 },
  releaseNotes: 1_500,
  copyrightAndTrademarkInfo: 200,
  screenshots: { count: 10, minLong: 1366, minShort: 768, maxBytes: 50 * 1024 * 1024 },
  caption: 200,
}

// ---------------------------------------------------------------------------------------------------------------
// docs/store-listing.md

/** Text of a `> …` quote block starting at `lines[i]` (a lone `>` is an empty line). */
function quote(lines, i) {
  const out = []
  for (; i < lines.length && /^>( |$)/.test(lines[i]); i++) out.push(lines[i].replace(/^> ?/, ''))
  return out.join('\n').trim()
}

/** Lines after the label `**Name…**` until the next bold label or heading. */
function block(lines, label) {
  const at = lines.findIndex((l) => l.startsWith(`**${label}`))
  if (at < 0) return undefined
  let end = at + 1
  while (end < lines.length && !/^\*\*[^*]+\*\*/.test(lines[end]) && !/^#/.test(lines[end])) end++
  return { first: lines[at], rest: lines.slice(at + 1, end) }
}

/**
 * Reads the Store listing of each language from docs/store-listing.md: the quote blocks after **Short description:**,
 * **Description:**, the line of **What's new in this version**, the numbered **Product features**, the `term` · `term`
 * list of **Search terms**, the line of **Copyright and trademark info:** (optional), and the numbered **Screenshots** (English:
 * `` `file` — caption ``; Czech: the same files, captions only). Throws a sentence naming what is missing.
 */
export function parseListing(markdown) {
  const sections = {}
  const parts = markdown.replace(/\r\n/g, '\n').split(/^## /m)
  for (const part of parts) {
    const m = /^Store listing — .*\(([a-z]{2}-[a-z]{2})\)/.exec(part)
    if (m) sections[m[1]] = part.split('\n')
  }
  const out = {}
  for (const lang of LANGUAGES) {
    const lines = sections[lang]
    if (!lines) throw new Error(`store-listing.md: no "## Store listing — … (${lang})" section`)
    const need = (label, value) => {
      if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) throw new Error(`store-listing.md (${lang}): "${label}" is missing or empty`)
      return value
    }
    const quoted = (label) => {
      const b = block(lines, label)
      if (!b) return undefined
      const start = b.rest.findIndex((l) => l.startsWith('>'))
      return start < 0 ? undefined : quote(b.rest, start)
    }
    const numbered = (label) => block(lines, label)?.rest.map((l) => /^\d+\.\s+(.+)$/.exec(l)?.[1]).filter(Boolean) ?? []
    // What's new is written on its label's line, after an optional note in parentheses; a quote block also works.
    const whatsNew = () => {
      const b = block(lines, "What's new in this version")
      if (!b) return undefined
      const inline = b.first.replace(/^\*\*What's new in this version(?::\*\*|\*\*(?: \((?:[^()]|\([^()]*\))*\))?:)/, '')
      if (inline === b.first) return undefined
      return inline.trim() || quoted("What's new in this version")
    }
    const terms = block(lines, 'Search terms')
    const copyright = block(lines, 'Copyright and trademark info:')
    const shots = numbered('Screenshots')
    out[lang] = {
      shortDescription: need('Short description', quoted('Short description:')),
      description: need('Description', quoted('Description:')),
      features: need('Product features', numbered('Product features')),
      keywords: need('Search terms', [...(terms?.first ?? '').matchAll(/`([^`]+)`/g)].map((x) => x[1].trim())),
      releaseNotes: need("What's new in this version", whatsNew()),
      // Optional: without it the language keeps what the Store has.
      copyrightAndTrademarkInfo: copyright?.first.replace(/^\*\*Copyright and trademark info:\*\*\s*/, '').trim() || undefined,
      screenshots: need('Screenshots', shots.map((s) => {
        const f = /^`([^`]+)`\s+—\s+(.+)$/.exec(s)
        return f ? { file: f[1], caption: f[2].trim() } : { file: undefined, caption: s.trim() }
      })),
    }
  }
  // The Czech list gives captions for the English files, in the same order.
  const en = out['en-us'].screenshots
  en.forEach((s, i) => {
    if (!s.file) throw new Error(`store-listing.md (en-us): screenshot ${i + 1} is not "\`file.png\` — caption": ${s.caption}`)
  })
  const cs = out['cs-cz'].screenshots
  if (cs.length !== en.length) throw new Error(`store-listing.md (cs-cz): ${cs.length} screenshot captions for ${en.length} English screenshots`)
  out['cs-cz'].screenshots = cs.map((s, i) => ({ file: s.file ?? en[i].file, caption: s.caption }))
  return out
}

// ---------------------------------------------------------------------------------------------------------------
// Limits

/** Width and height of a PNG (its IHDR), or undefined for anything else. */
export function pngSize(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 24 || sig.some((b, i) => bytes[i] !== b)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

const chars = (s) => [...s].length

/** Every limit the Store enforces on what is sent, each problem naming its field; empty when all is well. */
export function checkLimits(listing, images = {}) {
  const errors = []
  for (const [lang, l] of Object.entries(listing)) {
    const over = (field, value, max) => chars(value) > max && errors.push(`${lang} ${field}: ${chars(value)} characters, at most ${max}`)
    over('description', l.description, LIMITS.description)
    over('shortDescription', l.shortDescription, LIMITS.shortDescription)
    over('releaseNotes', l.releaseNotes, LIMITS.releaseNotes)
    if (l.copyrightAndTrademarkInfo !== undefined) over('copyrightAndTrademarkInfo', l.copyrightAndTrademarkInfo, LIMITS.copyrightAndTrademarkInfo)
    if (l.features.length > LIMITS.features.count) errors.push(`${lang} features: ${l.features.length} items, at most ${LIMITS.features.count}`)
    l.features.forEach((f, i) => over(`features[${i + 1}]`, f, LIMITS.features.length))
    if (l.keywords.length > LIMITS.keywords.count) errors.push(`${lang} keywords: ${l.keywords.length} search terms, at most ${LIMITS.keywords.count}`)
    l.keywords.forEach((k, i) => over(`keywords[${i + 1}]`, k, LIMITS.keywords.length))
    const words = l.keywords.join(' ').split(/\s+/).filter(Boolean).length
    if (words > LIMITS.keywords.words) errors.push(`${lang} keywords: ${words} words in all, at most ${LIMITS.keywords.words}`)
    if (l.screenshots.length > LIMITS.screenshots.count) errors.push(`${lang} screenshots: ${l.screenshots.length}, at most ${LIMITS.screenshots.count}`)
    l.screenshots.forEach((s, i) => {
      over(`screenshots[${i + 1}] caption`, s.caption, LIMITS.caption)
      if (!/\.png$/i.test(s.file)) errors.push(`${lang} screenshots[${i + 1}] ${s.file}: must be a PNG`)
      const img = images[s.file]
      if (!img) errors.push(`${lang} screenshots[${i + 1}] ${s.file}: file not found in docs/screenshots`)
      else if (!img.size) errors.push(`${lang} screenshots[${i + 1}] ${s.file}: not a readable PNG`)
      else {
        const [long, short] = [Math.max(img.size.width, img.size.height), Math.min(img.size.width, img.size.height)]
        if (long < LIMITS.screenshots.minLong || short < LIMITS.screenshots.minShort) errors.push(`${lang} screenshots[${i + 1}] ${s.file}: ${img.size.width}×${img.size.height}, at least 1366×768`)
        if (img.bytes > LIMITS.screenshots.maxBytes) errors.push(`${lang} screenshots[${i + 1}] ${s.file}: larger than 50 MB`)
      }
    })
  }
  return errors
}

// ---------------------------------------------------------------------------------------------------------------
// Package

/** The Identity of an AppxManifest.xml. */
export function manifestIdentity(xml) {
  const tag = /<Identity\b[^>]*>/.exec(xml)?.[0]
  if (!tag) return undefined
  // electron-builder writes Publisher in single quotes, the rest in double quotes, one attribute a line.
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  const attr = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag)
    return m ? (m[1] ?? m[2]).replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => entities[e]) : undefined
  }
  return { name: attr('Name'), publisher: attr('Publisher'), version: attr('Version') }
}

/** Refuses a package the Store would not take as this app's update. */
export function checkManifest(xml, { version, name, publisher }) {
  const id = manifestIdentity(xml)
  if (!id) return ['AppxManifest.xml: no <Identity>']
  const errors = []
  if (id.version !== `${version}.0`) errors.push(`AppxManifest.xml Identity Version is ${id.version}, expected ${version}.0`)
  if (id.name !== name) errors.push(`AppxManifest.xml Identity Name is ${id.name}, expected ${name} (MSSTORE_IDENTITY_NAME)`)
  if (id.publisher !== publisher) errors.push(`AppxManifest.xml Identity Publisher is ${id.publisher}, expected ${publisher} (MSSTORE_PUBLISHER)`)
  return errors
}

// ---------------------------------------------------------------------------------------------------------------
// The new submission

const TEXT_FIELDS = ['shortDescription', 'description', 'features', 'keywords', 'releaseNotes', 'copyrightAndTrademarkInfo']

/**
 * The submission to PUT, from the one the POST cloned (`base`): the listings' texts of both languages replaced, every
 * existing screenshot and package marked PendingDelete and the new ones PendingUpload (screenshots with their captions
 * as descriptions; file names as in the zip). Everything else is left exactly as it was.
 */
export function buildSubmission(base, listing, { packageFile, imagesDir = 'images' }) {
  const next = structuredClone(base)
  for (const lang of LANGUAGES) {
    const target = next.listings?.[lang]?.baseListing
    if (!target) throw new Error(`The last submission has no ${lang} listing: add the language in Partner Center first`)
    const l = listing[lang]
    for (const field of TEXT_FIELDS) if (l[field] !== undefined) target[field] = structuredClone(l[field])
    const others = (target.images ?? []).filter((img) => img.imageType !== 'Screenshot')
    const old = (target.images ?? []).filter((img) => img.imageType === 'Screenshot').map((img) => ({ ...img, fileStatus: 'PendingDelete' }))
    const fresh = l.screenshots.map((s) => ({ fileName: `${imagesDir}/${s.file}`, fileStatus: 'PendingUpload', description: s.caption, imageType: 'Screenshot' }))
    target.images = [...others, ...old, ...fresh]
  }
  next.applicationPackages = [...(base.applicationPackages ?? []).map((p) => ({ ...p, fileStatus: 'PendingDelete' })), { fileName: packageFile, fileStatus: 'PendingUpload', minimumDirectXVersion: 'None', minimumSystemRam: 'None' }]
  return next
}

/** What would change, readable: per language each text field, features, screenshots; the package. */
export function describeChanges(base, next) {
  const out = []
  for (const lang of LANGUAGES) {
    const a = base.listings[lang].baseListing
    const b = next.listings[lang].baseListing
    out.push(`== ${lang}`)
    for (const field of ['shortDescription', 'description', 'releaseNotes', 'copyrightAndTrademarkInfo']) {
      const same = (a[field] ?? '') === (b[field] ?? '')
      out.push(`  ${field.padEnd(26)} ${same ? 'unchanged' : 'CHANGED  '} ${chars(a[field] ?? '')} → ${chars(b[field] ?? '')} characters`)
    }
    const added = b.features.filter((f) => !(a.features ?? []).includes(f))
    const removed = (a.features ?? []).filter((f) => !b.features.includes(f))
    out.push(`  features                   ${(a.features ?? []).length} → ${b.features.length}${added.length || removed.length ? '' : ', unchanged'}`)
    for (const f of removed) out.push(`    - ${f}`)
    for (const f of added) out.push(`    + ${f}`)
    const sameKeys = JSON.stringify(a.keywords ?? []) === JSON.stringify(b.keywords)
    out.push(`  keywords                   ${sameKeys ? 'unchanged' : `CHANGED: ${(a.keywords ?? []).join(' · ')}  →  ${b.keywords.join(' · ')}`}`)
    const before = (a.images ?? []).filter((i) => i.imageType === 'Screenshot')
    const after = b.images.filter((i) => i.imageType === 'Screenshot' && i.fileStatus === 'PendingUpload')
    out.push(`  screenshots                ${before.length} → ${after.length}`)
    for (const i of before) out.push(`    before  ${i.fileName}: ${i.description ?? ''}`)
    for (const i of after) out.push(`    after   ${i.fileName}: ${i.description}`)
  }
  const pkg = (s, status) => s.applicationPackages.filter((p) => !status || p.fileStatus === status).map((p) => `${p.fileName}${p.version ? ` (${p.version})` : ''}`).join(', ')
  out.push(`== package  ${pkg(base)}  →  ${pkg(next, 'PendingUpload')}`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// Running against the Store (not used by the tests)

function env(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

async function token() {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: env('MSSTORE_CLIENT_ID'), client_secret: env('MSSTORE_CLIENT_SECRET'), resource: 'https://manage.devcenter.microsoft.com' })
  const res = await fetch(`https://login.microsoftonline.com/${env('MSSTORE_TENANT_ID')}/oauth2/token`, { method: 'POST', body })
  const json = await res.json().catch(() => ({}))
  if (!json.access_token) throw new Error(`Microsoft Entra refused the sign-in: ${json.error ?? res.status}`)
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${json.access_token}`)
  return json.access_token
}

function api(bearer) {
  return async (method, path, body) => {
    const res = await fetch(`${API}/${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 600)}`)
    return text ? JSON.parse(text) : {}
  }
}

/** Uploads the zip to the submission's Azure blob (one Put Blob: up to 5000 MiB with this x-ms-version). */
async function uploadZip(sas, zip) {
  const res = await fetch(sas, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'x-ms-version': '2019-12-12', 'Content-Type': 'application/zip' }, body: zip })
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status} ${(await res.text()).replace(/https?:\/\/\S+/g, '<url>').slice(0, 300)}`)
}

async function downloadPackage(tag, file) {
  const repo = env('GITHUB_REPOSITORY')
  const url = `https://github.com/${repo}/releases/download/${tag}/${file}`
  const res = await fetch(url, { headers: process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {} })
  if (!res.ok) throw new Error(`The release ${tag} has no ${file} (HTTP ${res.status})`)
  return new Uint8Array(await res.arrayBuffer())
}

async function main() {
  const [mode = 'plan', ...rest] = process.argv.slice(2)
  const arg = (name) => rest[rest.indexOf(`--${name}`) + 1]
  if (!['plan', 'submit'].includes(mode)) throw new Error(`Unknown mode ${mode}: plan or submit`)
  const tag = arg('tag')
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('--tag vX.Y.Z is required')
  const repo = arg('repo') ?? '.'
  const version = tag.slice(1)
  const { unzipSync, zipSync } = await import('fflate')

  // The repository's texts and pictures, checked before anything is asked of the Store.
  const listing = parseListing(readFileSync(join(repo, 'docs', 'store-listing.md'), 'utf8'))
  const images = {}
  for (const s of listing['en-us'].screenshots) {
    const path = join(repo, 'docs', 'screenshots', s.file)
    if (!existsSync(path)) continue
    const bytes = new Uint8Array(readFileSync(path))
    images[s.file] = { bytes: bytes.length, size: pngSize(bytes), data: bytes }
  }
  const problems = checkLimits(listing, images)
  // The package: the release's own, with the identity the Store expects.
  const packageFile = `DB-Mastermind-${version}-store.appx`
  const appx = await downloadPackage(tag, packageFile)
  const manifest = unzipSync(appx, { filter: (f) => f.name === 'AppxManifest.xml' })['AppxManifest.xml']
  problems.push(...(manifest ? checkManifest(new TextDecoder().decode(manifest), { version, name: env('MSSTORE_IDENTITY_NAME'), publisher: env('MSSTORE_PUBLISHER') }) : [`${packageFile}: no AppxManifest.xml`]))
  if (problems.length) throw new Error(`Not sent: the Store would refuse it.\n  ${problems.join('\n  ')}`)

  const call = api(await token())
  const app = await call('GET', `applications/${PRODUCT_ID}`)
  const pending = app.pendingApplicationSubmission?.id
  const last = await call('GET', `applications/${PRODUCT_ID}/submissions/${app.lastPublishedApplicationSubmission.id}`)
  delete last.fileUploadUrl
  console.log(`${tag}: plan against the last published submission ${last.id} (${last.status})${pending ? `; a pending submission ${pending} exists` : ''}\n`)
  console.log(describeChanges(last, buildSubmission(last, listing, { packageFile })))
  if (mode === 'plan') {
    console.log(pending ? `\nA submit would refuse: submission ${pending} is still pending in Partner Center.` : '\nNothing was created or uploaded (plan).')
    return
  }

  if (pending) throw new Error(`Not submitted: submission ${pending} is pending in Partner Center. Finish or delete it there first.`)
  const created = await call('POST', `applications/${PRODUCT_ID}/submissions`)
  const sas = created.fileUploadUrl
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${sas}`)
  delete created.fileUploadUrl
  console.log(`\nCreated submission ${created.id}`)
  try {
    const next = buildSubmission(created, listing, { packageFile })
    const files = { [packageFile]: [appx, { level: 0 }] }
    for (const [name, img] of Object.entries(images)) files[`images/${name}`] = [img.data, { level: 0 }]
    const zip = zipSync(files)
    console.log(`Uploading ${(zip.length / 1024 / 1024).toFixed(1)} MB (package and ${Object.keys(images).length} screenshots)…`)
    await uploadZip(sas, zip)
    await call('PUT', `applications/${PRODUCT_ID}/submissions/${created.id}`, next)
    await call('POST', `applications/${PRODUCT_ID}/submissions/${created.id}/commit`)
  } catch (err) {
    // Before the commit: the draft is removed, so nobody finds a half-made submission in Partner Center.
    await call('DELETE', `applications/${PRODUCT_ID}/submissions/${created.id}`).then(
      () => console.log(`Deleted the draft submission ${created.id}.`),
      (e) => console.log(`Could not delete the draft submission ${created.id}: ${e.message}`),
    )
    throw err
  }
  console.log('Committed. Waiting for the Store to take it…')
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 15_000))
    const status = await call('GET', `applications/${PRODUCT_ID}/submissions/${created.id}/status`)
    if (status.status === 'CommitStarted' || status.status === 'PreProcessing') continue
    console.log(`Status: ${status.status}`)
    for (const e of status.statusDetails?.errors ?? []) console.log(`  error ${e.code}: ${e.details}`)
    for (const w of status.statusDetails?.warnings ?? []) console.log(`  warning ${w.code}: ${w.details}`)
    if (/Failed$/.test(status.status)) process.exitCode = 1
    return
  }
  console.log('Still being taken in after 15 minutes: check Partner Center.')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
