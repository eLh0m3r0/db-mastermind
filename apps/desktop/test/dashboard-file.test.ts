import { describe, expect, it } from 'vitest'
import { DASHBOARD_EXAMPLE } from '../../../packages/core/src/ai-tools'
import { dashboardFileName, MAX_TILES, parseDashboard, writeDashboard } from '../src/main/dashboard-file'


/** A dashboard in a knowledge base: Markdown a person reads and edits, parsed and written back without noise. */

const SAMPLE = `---
dashboard: true
refresh: 60
---
# Sales overview

Numbers for the Monday meeting.

## Orders per month

Paid and open orders together.

\`\`\`sql chart=line x=month y=orders,"open orders" wide
select date_trunc('month', ordered_at) as month, count(*) as orders, count(*) filter (where status = 'open') as "open orders"
from orders group by 1 order by 1
\`\`\`

Ask Jana before changing this.

## Customers

\`\`\`sql
select count(*) as customers from customers
\`\`\`
`

describe('dashboard files', () => {
  it('reads tiles, charts by column name, refresh, and the text around them', () => {
    const d = parseDashboard(SAMPLE, 'fallback')
    expect(d.name).toBe('Sales overview')
    expect(d.refreshSeconds).toBe(60)
    expect(d.intro).toBe('Numbers for the Monday meeting.')
    expect(d.tiles).toHaveLength(2)
    expect(d.tiles[0]).toMatchObject({ title: 'Orders per month', span: 2, before: 'Paid and open orders together.', after: 'Ask Jana before changing this.' })
    expect(d.tiles[0]!.chart).toMatchObject({ kind: 'line', xName: 'month', yNames: ['orders', 'open orders'] })
    expect(d.tiles[0]!.sql).toContain('"open orders"\nfrom orders')
    expect(d.tiles[1]).toMatchObject({ title: 'Customers', chart: null, span: 1 })
  })

  it('writes back byte for byte (Git shows only real changes), and a written file reads back the same', () => {
    expect(writeDashboard(parseDashboard(SAMPLE, 'x'))).toBe(SAMPLE)
    const again = writeDashboard(parseDashboard(writeDashboard(parseDashboard(SAMPLE, 'x')), 'x'))
    expect(again).toBe(SAMPLE)
  })

  it("the system prompt's own example is a valid dashboard (the two can't drift apart)", () => {
    const d = parseDashboard(DASHBOARD_EXAMPLE, 'x')
    expect(d.name).toBe('Sales overview')
    expect(d.refreshSeconds).toBe(300)
    expect(d.tiles.map((t) => t.title)).toEqual(['Orders per month', 'Customers'])
    expect(d.tiles[0]!.chart).toMatchObject({ kind: 'line', xName: 'month', yNames: ['orders'] })
    expect(writeDashboard(d)).toBe(DASHBOARD_EXAMPLE)
  })

  it('hand-written variants: no front matter, tildes, CRLF, a section without SQL, a column without a name', () => {
    const d = parseDashboard('# Ops\r\n\r\n## Errors\r\n~~~sql chart=bar x=#1 y=#2\r\nselect day, count(*) from errors group by 1\r\n~~~\r\n\r\n## Notes\r\nJust text.\r\n', 'ops')
    expect(d.refreshSeconds).toBe(0)
    expect(d.tiles).toHaveLength(1)
    expect(d.tiles[0]!.chart).toEqual({ kind: 'bar', x: 0, ys: [1] })
    // A section without a query stays as text with the tile before it.
    expect(d.tiles[0]!.after).toBe('## Notes\nJust text.')
    expect(writeDashboard(d)).toContain('```sql chart=bar x=#1 y=#2\n')
    expect(parseDashboard('## Only a tile\n```sql\nselect 1\n```\n', 'From the file name').name).toBe('From the file name')
  })

  it('a hostile file: huge, deeply nested fences, a heading that looks like HTML, SQL that writes', () => {
    expect(() => parseDashboard(Array.from({ length: MAX_TILES + 1 }, (_, i) => `## T${i}\n\`\`\`sql\nselect ${i}\n\`\`\``).join('\n'), 'x')).toThrow(/at most/)
    expect(() => parseDashboard('## A\n````sql\nselect 1\n', 'x')).toThrow(/not closed/)
    const nested = parseDashboard(`## Deep\n${'`'.repeat(10)}sql\nselect '\`\`\`' as a\n\`\`\`\nstill sql\n${'`'.repeat(10)}\n`, 'x')
    expect(nested.tiles[0]!.sql).toBe("select '```' as a\n```\nstill sql")
    expect(writeDashboard(nested)).toContain('````sql\n')
    const html = parseDashboard('# <img src=x onerror=alert(1)>\n## <script>alert(1)</script>\n```sql\ndelete from orders\n```\n', 'x')
    // Names and headings are only text; the SQL is kept as written (it runs as a guarded read, which refuses it).
    expect(html.name).toBe('<img src=x onerror=alert(1)>')
    expect(html.tiles[0]).toMatchObject({ title: '<script>alert(1)</script>', sql: 'delete from orders' })
    expect(parseDashboard('x'.repeat(400_000), 'big').tiles).toEqual([])
  })

  it('a chart whose column has no name is written by position; names with spaces are quoted', () => {
    const text = writeDashboard({ name: 'D', refreshSeconds: 0, tiles: [{ title: 'T', sql: 'select 1, 2', span: 1, chart: { kind: 'bar', x: 0, ys: [1, 2], xName: 'day of week', yNames: ['', 'n'] } }] })
    expect(text).toContain('```sql chart=bar x="day of week" y=#2,n\n')
    expect(parseDashboard(text, 'D').tiles[0]!.chart).toMatchObject({ x: 0, ys: [1, 2], xName: 'day of week' })
  })

  it('file names keep the name readable and safe', () => {
    expect(dashboardFileName('Sales: Q1/Q2 "best"')).toBe('Sales- Q1-Q2 -best-.md')
    expect(dashboardFileName('../../etc/passwd')).toBe('etc-passwd.md')
    expect(dashboardFileName('   ')).toBe('Dashboard.md')
  })
})
