// Website screenshots: turns a folder of 2880×1800 PNGs (a 1440×900 window at 2×) into the AVIF / WebP / PNG
// files the pages' <picture> elements ask for, in docs/screenshots/. Only tools of a Mac are used: `sips` writes
// AVIF, the system Chrome (through Playwright, sandboxed, local data only) resizes, crops and writes WebP and PNG.
//
//   node scripts/site-images.mjs <folder> [--placeholders]
//   node scripts/site-images.mjs --og        renders docs/og.html into docs/og.png (1200×630)
//
// <folder> holds <name>.png and <name>-dark.png for every name below. With --placeholders a missing shot is
// replaced by the nearest existing one (see FALLBACK), so the layout can be judged before the retake.
// The shot list with the exact states is tmp/web/shots-needed.md (kept with the launch notes).
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOTS = ['hero', 'hero-phone', 'table-filters', 'query', 'query-file', 'chart', 'dashboard', 'modeler', 'migration', 'diagram', 'ai', 'home', 'connect', 'mcp-settings']
const FALLBACK = { hero: 'table-filters', 'hero-phone': 'table-filters', dashboard: 'chart', connect: 'home', 'mcp-settings': 'home' }
// The phone hero is a crop of a full window (CSS pixels of the 1440×900 window): the filter bar and the first rows.
const PHONE_CROP = { x: 268, y: 70, w: 480, h: 360 }

const args = process.argv.slice(2)
const placeholders = args.includes('--placeholders')
const folder = args.find((a) => !a.startsWith('--'))
const og = args.includes('--og')
if (!folder && !og) {
  console.error('Usage: node scripts/site-images.mjs <folder of PNGs> [--placeholders]')
  process.exit(1)
}
const root = resolve(new URL('..', import.meta.url).pathname)
const out = join(root, 'docs', 'screenshots')
mkdirSync(out, { recursive: true })

const loadPlaywright = () => {
  for (const base of [import.meta.url, join(process.cwd(), 'x.js')]) {
    const req = createRequire(base)
    for (const name of ['playwright', 'playwright-core']) {
      try {
        return req(name)
      } catch {
        // try the next one
      }
    }
  }
  throw new Error('Playwright not found: run npm install in the repository (or run this from a folder that has playwright-core)')
}

const source = (name, dark) => {
  const own = join(folder, `${name}${dark ? '-dark' : ''}.png`)
  if (existsSync(own)) return own
  if (!placeholders) return null
  if (dark && existsSync(join(folder, `${name}.png`))) return join(folder, `${name}.png`)
  const other = FALLBACK[name]
  if (other) return source(other, dark)
  return null
}

const { chromium } = loadPlaywright()
const browser = await chromium.launch({ channel: 'chrome', chromiumSandbox: true })
if (og) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1, colorScheme: 'light' })
  // Local files only.
  await ctx.route('**/*', (route) => (route.request().url().startsWith('file://') ? route.continue() : route.abort()))
  const p = await ctx.newPage()
  await p.goto(`file://${join(root, 'docs', 'og.html')}`)
  await p.evaluate(() => document.fonts.ready)
  await p.screenshot({ path: join(root, 'docs', 'og.png') })
  await browser.close()
  console.log('docs/og.png')
  process.exit(0)
}
const page = await browser.newPage()
// Nothing to load: the page only draws data URLs onto a canvas.
await page.route('**/*', (route) => route.abort())
const scratch = mkdtempSync(join(tmpdir(), 'dbm-site-images-'))

// Draws a region of the PNG at the given width and returns WebP and PNG bytes.
const encode = async (file, region, width) => {
  const data = `data:image/png;base64,${readFileSync(file).toString('base64')}`
  const result = await page.evaluate(
    async ({ data, region, width }) => {
      const img = new Image()
      img.src = data
      await img.decode()
      const r = region ?? { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = Math.round((r.h / r.w) * width)
      const ctx = canvas.getContext('2d')
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
      const bytes = async (type, q) => {
        const blob = await new Promise((done) => canvas.toBlob(done, type, q))
        const buf = new Uint8Array(await blob.arrayBuffer())
        let s = ''
        for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000))
        return btoa(s)
      }
      return { webp: await bytes('image/webp', 0.82), png: await bytes('image/png'), height: canvas.height }
    },
    { data, region, width },
  )
  return { webp: Buffer.from(result.webp, 'base64'), png: Buffer.from(result.png, 'base64') }
}

const avif = (pngFile, target) => execFileSync('sips', ['-s', 'format', 'avif', '-s', 'formatOptions', '70', pngFile, '--out', target], { stdio: 'ignore' })

let written = 0
for (const name of SHOTS) {
  for (const dark of [false, true]) {
    const file = source(name, dark)
    const base = `${name}${dark ? '-dark' : ''}`
    if (!file) {
      console.warn(`missing: ${base}.png`)
      continue
    }
    if (name === 'hero-phone') {
      const region = { x: PHONE_CROP.x * 2, y: PHONE_CROP.y * 2, w: PHONE_CROP.w * 2, h: PHONE_CROP.h * 2 }
      const r = await encode(file, region, 960)
      writeFileSync(join(out, `${base}-960.webp`), r.webp)
      writeFileSync(join(out, `${base}-960.png`), r.png)
      avif(join(out, `${base}-960.png`), join(out, `${base}-960.avif`))
      written += 3
      continue
    }
    const small = await encode(file, null, 1440)
    writeFileSync(join(out, `${base}-1440.webp`), small.webp)
    writeFileSync(join(out, `${base}-1440.png`), small.png)
    avif(join(out, `${base}-1440.png`), join(out, `${base}-1440.avif`))
    const large = await encode(file, null, 2880)
    writeFileSync(join(out, `${base}-2880.webp`), large.webp)
    const tmpPng = join(scratch, `${base}-2880.png`)
    writeFileSync(tmpPng, large.png)
    avif(tmpPng, join(out, `${base}-2880.avif`))
    written += 5
    console.log(`${base}${file.endsWith(`${base}.png`) ? '' : ` (placeholder from ${file.split('/').pop()})`}`)
  }
}
rmSync(scratch, { recursive: true, force: true })
await browser.close()
console.log(`${written} files in docs/screenshots/`)
