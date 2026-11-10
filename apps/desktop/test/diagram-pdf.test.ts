import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {}, dialog: {} }))
const { pdfHtml, pdfLayout } = await import('../src/main/diagram-pdf')

describe('diagram on paper', () => {
  it('shrinks to one page, never enlarges', () => {
    expect(pdfLayout(2094, 718, 'one')).toEqual({ scale: 0.5, columns: 1, rows: 1 })
    expect(pdfLayout(400, 300, 'one')).toEqual({ scale: 1, columns: 1, rows: 1 })
  })

  it('tiles a big diagram at full size', () => {
    expect(pdfLayout(2500, 1500, 'many')).toEqual({ scale: 1, columns: 3, rows: 3 })
    const html = pdfHtml({ width: 2500, height: 1500, pages: 'many', name: 'Shop <model>' }, 'diagram.svg')
    expect(html.match(/class="page"/g)).toHaveLength(9)
    expect(html).toContain('<title>Shop model</title>')
    // The last sheet shows the bottom right corner and says where it belongs.
    expect(html).toContain('style="width:2500px;height:1500px;left:-2094px;top:-1436px"><span>3 · 3</span>')
    expect(pdfHtml({ width: 400, height: 300, pages: 'one', name: 'x' }, 'd.svg')).not.toContain('<span>')
  })
})
