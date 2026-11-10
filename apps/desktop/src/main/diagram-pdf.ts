import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { DiagramPdfRequest } from '@shared/api'

// A4 landscape at 96 px per inch, inside 10 mm margins.
const PAGE = { width: 1047, height: 718 }

/** How a diagram of `width` × `height` CSS pixels goes on paper: shrunk to one page, or at full size on a grid of pages. */
export function pdfLayout(width: number, height: number, pages: 'one' | 'many'): { scale: number; columns: number; rows: number } {
  if (pages === 'one') return { scale: Math.min(1, PAGE.width / width, PAGE.height / height), columns: 1, rows: 1 }
  return { scale: 1, columns: Math.max(1, Math.ceil(width / PAGE.width)), rows: Math.max(1, Math.ceil(height / PAGE.height)) }
}

export function pdfHtml(request: Pick<DiagramPdfRequest, 'width' | 'height' | 'pages' | 'name'>, image: string): string {
  const { scale, columns, rows } = pdfLayout(request.width, request.height, request.pages)
  const [w, h] = [Math.round(request.width * scale), Math.round(request.height * scale)]
  const pages: string[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      // The page's place in the grid, so the sheets can be laid out again.
      const label = columns * rows > 1 ? `<span>${row + 1} · ${column + 1}</span>` : ''
      pages.push(`<div class="page"><img src="${image}" style="width:${w}px;height:${h}px;left:${-column * PAGE.width}px;top:${-row * PAGE.height}px">${label}</div>`)
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${request.name.replace(/[<>&"]/g, '')}</title><style>
@page { size: A4 landscape; margin: 10mm }
html, body { margin: 0; padding: 0; background: #fff }
.page { position: relative; width: ${PAGE.width}px; height: ${PAGE.height}px; overflow: hidden; break-after: page }
.page:last-child { break-after: auto }
.page img { position: absolute }
.page span { position: absolute; right: 2px; bottom: 0; font: 9px sans-serif; color: #999 }
</style></head><body>${pages.join('')}</body></html>`
}

/**
 * Prints the diagram (an SVG picture from the window) to a PDF: on one page, or at readable size on as many A4
 * pages as it needs. The page is rendered by a hidden window that runs no scripts.
 */
export async function saveDiagramPdf(request: DiagramPdfRequest): Promise<string | null> {
  const comma = request.svg.indexOf(',')
  if (!request.svg.startsWith('data:image/svg+xml') || comma === -1) throw new Error('The diagram picture is not an SVG')
  const parent = BrowserWindow.getFocusedWindow()
  const options = { title: 'Save diagram as PDF', defaultPath: `${request.name.replace(/[\\/:*?"<>|]/g, '_')}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] }
  const chosen = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
  if (chosen.canceled || !chosen.filePath) return null

  const dir = await mkdtemp(join(tmpdir(), 'dbm-pdf-'))
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false, contextIsolation: true, nodeIntegration: false } })
  try {
    const meta = request.svg.slice(0, comma)
    const body = request.svg.slice(comma + 1)
    // Files instead of a data: URL, which Chromium refuses to navigate to beyond about 2 MB.
    await writeFile(join(dir, 'diagram.svg'), meta.endsWith(';base64') ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8'))
    await writeFile(join(dir, 'print.html'), pdfHtml(request, 'diagram.svg'), 'utf8')
    await printer.loadFile(join(dir, 'print.html'))
    const pdf = await printer.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, preferCSSPageSize: true })
    await writeFile(chosen.filePath, pdf)
    return chosen.filePath
  } finally {
    printer.destroy()
    await rm(dir, { recursive: true, force: true })
  }
}
