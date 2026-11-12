import { describe, expect, it } from 'vitest'
import { parseDbml, splitModelLayout, withModelLayout } from '../src/index.js'

const model = 'Table shop.customer {\n  id bigint [pk]\n}\n'

describe('model layout in a DBML file', () => {
  it('goes at the end as a comment that DBML skips, and comes back out', () => {
    const layout = {
      positions: { 'shop.customer': { x: 10, y: 20 } },
      diagrams: [{ id: 'd1', name: 'Sales', tables: ['shop.customer'], positions: {} }],
      notes: [],
    }
    const file = withModelLayout(model, layout)
    expect(file).toMatch(/\n\/\/ dbmastermind-layout: \{"positions"/)
    expect(file).not.toContain('"notes"')
    expect(parseDbml(file).errors).toEqual([])
    expect(parseDbml(file).tables.map((t) => t.name)).toEqual(['customer'])
    const back = splitModelLayout(file)
    expect(back.text).toBe(model)
    expect(back.layout).toEqual({ positions: layout.positions, diagrams: layout.diagrams })
    // Saved again: one layout, the new one.
    const again = withModelLayout(file, { positions: { 'shop.customer': { x: 1, y: 2 } } })
    expect(again.match(/dbmastermind-layout/g)).toHaveLength(1)
    expect(splitModelLayout(again).layout).toEqual({ positions: { 'shop.customer': { x: 1, y: 2 } } })
  })

  it('leaves a file without one (or with a broken one) as it is', () => {
    expect(splitModelLayout(model)).toEqual({ text: model })
    expect(withModelLayout(model, {})).toBe(model)
    const broken = `${model}// dbmastermind-layout: {oops\n`
    expect(splitModelLayout(broken)).toEqual({ text: broken })
  })
})
