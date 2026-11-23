import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error: a plain ES module script, without types
import { buildSubmission, checkLimits, checkManifest, describeChanges, LIMITS, parseListing, pngSize } from '../../../scripts/store-submit.mjs'

/**
 * Submitting to the Microsoft Store from GitHub (scripts/store-submit.mjs): the listing is read from
 * docs/store-listing.md, checked against the Store's limits, and laid over the last published submission (a trimmed
 * copy of the real one). Nothing here talks to the Store.
 */
const listingFile = readFileSync(new URL('../../../docs/store-listing.md', import.meta.url), 'utf8')
const last = JSON.parse(readFileSync(new URL('./fixtures/store-last-published.json', import.meta.url), 'utf8'))
const png = (width: number, height: number) => {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return b
}
const imagesOf = (listing: ReturnType<typeof parseListing>, size = { width: 2880, height: 1800 }) =>
  Object.fromEntries(listing['en-us'].screenshots.map((s: { file: string }) => [s.file, { bytes: 1000, size }]))

describe('docs/store-listing.md', () => {
  const listing = parseListing(listingFile)

  it('reads both languages: short description, description, features, search terms, what’s new, copyright, screenshots', () => {
    for (const lang of ['en-us', 'cs-cz']) {
      const l = listing[lang]
      expect(l.shortDescription.length).toBeGreaterThan(50)
      expect(l.description).toMatch(/\n\n/)
      expect(l.description).not.toMatch(/^>/m)
      expect(l.features).toHaveLength(20)
      expect(l.keywords).toHaveLength(7)
      expect(l.releaseNotes.length).toBeGreaterThan(100)
      expect(l.copyrightAndTrademarkInfo).toMatch(/^© \d{4} /)
      expect(l.screenshots).toHaveLength(10)
    }
    expect(listing['en-us'].screenshots[0]).toEqual({ file: 'hero-1440.png', caption: 'Design, query and chart in one app' })
    // Czech captions for the same files, in the same order.
    expect(listing['cs-cz'].screenshots.map((s: { file: string }) => s.file)).toEqual(listing['en-us'].screenshots.map((s: { file: string }) => s.file))
    expect(listing['cs-cz'].screenshots[0].caption).toBe('Návrh, dotaz a graf v jedné aplikaci')
  })

  it('the repository’s listing is within every limit', () => {
    expect(checkLimits(listing, imagesOf(listing))).toEqual([])
  })

  it('a malformed file names what is missing', () => {
    expect(() => parseListing(listingFile.replace(/^## Store listing — Czech \(cs-cz\)$/m, '## Czech'))).toThrow(/no "## Store listing — … \(cs-cz\)" section/)
    expect(() => parseListing(listingFile.replace('**Search terms** (7)', '**Keywords** (7)'))).toThrow(/\(en-us\): "Search terms" is missing/)
    const cs = listingFile.indexOf('## Store listing — Czech')
    const shorter = listingFile.slice(0, cs) + listingFile.slice(cs).replace(/\n10\. Grafy[^\n]*/, '')
    expect(() => parseListing(shorter)).toThrow(/9 screenshot captions for 10 English screenshots/)
    expect(() => parseListing(listingFile.replace('1. `hero-1440.png` —', '1. `hero-1440.png` (or another) —'))).toThrow(/screenshot 1 is not "`file.png` — caption"/)
  })

  it('What\u2019s new is the text on its label\u2019s line, after the note in parentheses', () => {
    expect(listing['en-us'].releaseNotes).toMatch(/^New since 1\.4/)
    expect(listing['cs-cz'].releaseNotes).toMatch(/^Novinky od verze 1\.4/)
  })

  it('a language without copyright keeps what the Store has', () => {
    const cs = listingFile.indexOf('## Store listing — Czech')
    const without = parseListing(listingFile.slice(0, cs) + listingFile.slice(cs).replace(/\*\*Copyright and trademark info:\*\*[^\n]*\n/, ''))
    expect(without['cs-cz'].copyrightAndTrademarkInfo).toBeUndefined()
    const next = buildSubmission(last, without, { packageFile: 'x.appx' })
    expect(next.listings['cs-cz'].baseListing.copyrightAndTrademarkInfo).toBe(last.listings['cs-cz'].baseListing.copyrightAndTrademarkInfo)
    expect(next.listings['en-us'].baseListing.copyrightAndTrademarkInfo).toBe(without['en-us'].copyrightAndTrademarkInfo)
  })

  it('each limit is reported with its field', () => {
    const l = structuredClone(listing)
    l['en-us'].description = 'x'.repeat(LIMITS.description + 1)
    l['en-us'].shortDescription = 'x'.repeat(1001)
    l['en-us'].releaseNotes = 'x'.repeat(1501)
    l['en-us'].features = [...l['en-us'].features, 'one more']
    l['cs-cz'].features[0] = 'x'.repeat(201)
    l['cs-cz'].keywords = [...l['cs-cz'].keywords, 'eight']
    l['cs-cz'].keywords[1] = 'x'.repeat(41)
    l['cs-cz'].screenshots[0] = { file: 'small.png', caption: 'x'.repeat(201) }
    const errors = checkLimits(l, { ...imagesOf(listing), 'small.png': { bytes: 10, size: { width: 1280, height: 720 } } })
    for (const field of ['en-us description: 10001', 'en-us shortDescription: 1001', 'en-us releaseNotes: 1501', 'en-us features: 21 items', 'cs-cz features[1]: 201', 'cs-cz keywords: 8 search terms', 'cs-cz keywords[2]: 41', 'cs-cz screenshots[1] caption: 201', 'cs-cz screenshots[1] small.png: 1280×720']) {
      expect(errors.some((e: string) => e.startsWith(field)), field).toBe(true)
    }
  })

  it('reads a PNG’s size from its header', () => {
    expect(pngSize(png(2880, 1800))).toEqual({ width: 2880, height: 1800 })
    expect(pngSize(new Uint8Array(24))).toBeUndefined()
  })
})

describe('the new submission', () => {
  const listing = parseListing(listingFile)
  const next = buildSubmission(last, listing, { packageFile: 'DB-Mastermind-1.5.4-store.appx' })

  it('replaces the listing texts of both languages and keeps every other field', () => {
    for (const lang of ['en-us', 'cs-cz']) {
      const a = last.listings[lang].baseListing
      const b = next.listings[lang].baseListing
      expect(b.description).toBe(listing[lang].description)
      expect(b.features).toEqual(listing[lang].features)
      expect(b.keywords).toEqual(listing[lang].keywords)
      expect(b.releaseNotes).toBe(listing[lang].releaseNotes)
      for (const kept of ['title', 'privacyPolicy', 'websiteUrl', 'supportContact', 'licenseTerms', 'devStudio']) expect(b[kept], `${lang} ${kept}`).toEqual(a[kept])
      expect(next.listings[lang].platformOverrides).toEqual(last.listings[lang].platformOverrides)
    }
    for (const kept of ['id', 'applicationCategory', 'pricing', 'visibility', 'targetPublishMode', 'allowTargetFutureDeviceFamilies']) expect(next[kept], kept).toEqual(last[kept])
    // The input is not changed.
    expect(last.listings['en-us'].baseListing.images[0].fileStatus).toBe('Uploaded')
  })

  it('old screenshots and package PendingDelete, new ones PendingUpload with their captions; other images untouched', () => {
    const images = next.listings['cs-cz'].baseListing.images
    expect(images.filter((i: { imageType: string }) => i.imageType !== 'Screenshot')).toEqual([{ fileName: 'tile.png', fileStatus: 'Uploaded', id: '1', description: '', imageType: 'StoreLogo300x300' }])
    expect(images.filter((i: { fileStatus: string }) => i.fileStatus === 'PendingDelete').map((i: { id: string }) => i.id)).toEqual(last.listings['cs-cz'].baseListing.images.filter((i: { imageType: string }) => i.imageType === 'Screenshot').map((i: { id: string }) => i.id))
    const uploads = images.filter((i: { fileStatus: string }) => i.fileStatus === 'PendingUpload')
    expect(uploads).toHaveLength(10)
    expect(uploads[0]).toEqual({ fileName: 'images/hero-1440.png', fileStatus: 'PendingUpload', description: 'Návrh, dotaz a graf v jedné aplikaci', imageType: 'Screenshot' })
    expect(next.applicationPackages.map((p: { fileName: string; fileStatus: string }) => [p.fileName, p.fileStatus])).toEqual([
      ['DB-Mastermind-1.4.0-store.appx', 'PendingDelete'],
      ['DB-Mastermind-1.5.4-store.appx', 'PendingUpload'],
    ])
  })

  it('the plan says what changes, per language and for the package', () => {
    const text = describeChanges(last, next)
    expect(text).toMatch(/== en-us\n {2}shortDescription +CHANGED/)
    expect(text).toMatch(/screenshots +2 → 10/)
    expect(text).toMatch(/after +images\/hero-1440.png: Design, query and chart in one app/)
    expect(text).toMatch(/== package {2}DB-Mastermind-1.4.0-store.appx \(1.4.0.0\) {2}→ {2}DB-Mastermind-1.5.4-store.appx/)
  })

  it('a language missing from the last submission is refused, not invented', () => {
    const noCzech = structuredClone(last)
    delete noCzech.listings['cs-cz']
    expect(() => buildSubmission(noCzech, listing, { packageFile: 'x.appx' })).toThrow(/no cs-cz listing/)
  })
})

describe('the package', () => {
  const expected = { version: '1.5.4', name: 'VclavMudra.DBMastermind', publisher: 'CN=A8660A1C-7BE1-41EA-A371-924E1A49FE31' }
  const manifest = (identity: string) => `<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">${identity}<Properties/></Package>`

  it('takes the release’s Store package and nothing else', () => {
    expect(checkManifest(manifest('<Identity Name="VclavMudra.DBMastermind" Publisher="CN=A8660A1C-7BE1-41EA-A371-924E1A49FE31" Version="1.5.4.0" ProcessorArchitecture="x64"/>'), expected)).toEqual([])
    expect(checkManifest(manifest('<Identity Name="VclavMudra.DBMastermind" Publisher="CN=A8660A1C-7BE1-41EA-A371-924E1A49FE31" Version="1.5.3.0"/>'), expected)).toEqual(['AppxManifest.xml Identity Version is 1.5.3.0, expected 1.5.4.0'])
    expect(checkManifest(manifest('<Identity Name="Someone.Else" Publisher="CN=Other" Version="1.5.4.0"/>'), expected)).toHaveLength(2)
    expect(checkManifest(manifest(''), expected)).toEqual(['AppxManifest.xml: no <Identity>'])
  })

  it('reads the identity as electron-builder writes it (Publisher in single quotes, one attribute a line)', () => {
    const identity = `<Identity Name="VclavMudra.DBMastermind"\n    ProcessorArchitecture="x64"\n    Publisher='CN=A8660A1C-7BE1-41EA-A371-924E1A49FE31'\n    Version="1.5.4.0" />`
    expect(checkManifest(manifest(identity), expected)).toEqual([])
  })
})
