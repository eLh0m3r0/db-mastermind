// Website screenshots: turns a folder of 2880×1800 PNGs (a 1440×900 window at 2×) into the AVIF / WebP / PNG
// files the pages' <picture> elements ask for, in docs/screenshots/. Only tools of a Mac are used: `sips` writes
// AVIF, the system Chrome (through Playwright, sandboxed, local data only) resizes, crops and writes WebP and PNG.
//
//   node scripts/site-images.mjs <folder> [--placeholders]
//   node scripts/site-images.mjs <folder> --variants
//                                            the home page's pictures in the other accents and the looks (taken by
//                                            `node e2e/screenshots.mjs <folder> … --variants`): AVIF only, 1440 wide,
//                                            in docs/screenshots/variants/ (site.js swaps them in)
//   node scripts/site-images.mjs --og        renders docs/og.html into docs/og.png (1200×630) and the icon into
//                                            docs/apple-touch-icon.png (180×180, opaque: iOS rounds the corners)
//
// <folder> holds <name>.png and <name>-dark.png for every name below. With --placeholders a missing shot is
// replaced by the nearest existing one (see FALLBACK), so the layout can be judged before the retake.
// The states of the shots are in e2e/screenshots.mjs, which takes them.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SHOTS = ['hero', 'table-filters', 'query', 'chart', 'dashboard', 'modeler', 'migration', 'diagram', 'ai', 'home', 'connect', 'mcp-settings']
// (Phones show the whole window too: the 480×360 crops cut controls in half.)
const FALLBACK = { hero: 'table-filters', dashboard: 'chart', connect: 'home', 'mcp-settings': 'home' }

const args = process.argv.slice(2)
const placeholders = args.includes('--placeholders')
const variants = args.includes('--variants')
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
  // The app icon's drawing (docs/icon.svg) on a full square of its gradient.
  const icon = readFileSync(join(root, 'docs', 'icon.svg'), 'utf8')
  const glyph = icon.slice(icon.indexOf('<ellipse'), icon.lastIndexOf('</g>'))
  const square = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b6dff"/><stop offset="1" stop-color="#4f2fe0"/></linearGradient></defs><rect width="64" height="64" fill="url(#g)"/><g>${glyph}</g></svg>`
  await p.setViewportSize({ width: 180, height: 180 })
  await p.setContent(`<body style="margin:0">${square}</body>`)
  await p.locator('svg').screenshot({ path: join(root, 'docs', 'apple-touch-icon.png') })
  await browser.close()
  console.log('docs/og.png, docs/apple-touch-icon.png')
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
if (variants) {
  // Same names and suffixes as e2e/screenshots.mjs (VARIANT_SHOTS, VARIANT_ACCENTS, VARIANT_LOOKS).
  const shots = ['hero', 'table-filters', 'modeler', 'dashboard', 'ai']
  const accents = ['blue', 'teal', 'green', 'orange', 'rose']
  const looks = ['retro2001', 'terminal', 'halloween', 'christmas', 'medieval', 'fantasy']
  const suffixes = [...accents.flatMap((a) => [`-${a}`, `-${a}-dark`]), ...looks.map((l) => `-${l}`)]
  const dir = join(out, 'variants')
  mkdirSync(dir, { recursive: true })
  let bytes = 0
  for (const name of shots) {
    for (const suffix of suffixes) {
      const file = join(folder, `${name}${suffix}.png`)
      if (!existsSync(file)) {
        console.warn(`missing: ${name}${suffix}.png`)
        continue
      }
      const r = await encode(file, null, 1440)
      const png = join(scratch, `${name}${suffix}.png`)
      writeFileSync(png, r.png)
      const target = join(dir, `${name}${suffix}-1440.avif`)
      avif(png, target)
      bytes += readFileSync(target).length
      written++
    }
  }
  rmSync(scratch, { recursive: true, force: true })
  await browser.close()
  console.log(`${written} files in docs/screenshots/variants/, ${(bytes / 1024 / 1024).toFixed(1)} MB`)
  process.exit(0)
}
for (const name of SHOTS) {
  for (const dark of [false, true]) {
    const file = source(name, dark)
    const base = `${name}${dark ? '-dark' : ''}`
    if (!file) {
      console.warn(`missing: ${base}.png`)
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
