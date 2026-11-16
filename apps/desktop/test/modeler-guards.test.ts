import { describe, expect, it } from 'vitest'
import { canvasOwnsKey } from '../src/renderer/src/features/diagram/canvas-keys'
import { keepMeasured } from '../src/renderer/src/features/diagram/keep-measured'
import { nameProblem } from '../src/renderer/src/features/diagram/names'
import { remembered, stepTo, type ModelSteps } from '../src/renderer/src/features/model/model-steps'

/** A stand-in for a DOM element: `closest` matches by the selectors it is given. */
const el = (matches: string[] = [], inside = true) => ({ closest: (sel: string) => (matches.some((m) => sel.split(', ').includes(m)) ? {} : null), inside })
const canvas = (shown = true) => ({ isConnected: true, offsetParent: shown ? {} : null, contains: (n: { inside?: boolean }) => !!n.inside })
const body = {}

describe('keys on the model canvas', () => {
  it('act on the shown canvas of the focused pane, when focus is on it or nowhere', () => {
    expect(canvasOwnsKey(el(), canvas(), { focused: true, dialogOpen: false, body })).toBe(true)
    expect(canvasOwnsKey(body as EventTarget, canvas(), { focused: true, dialogOpen: false, body })).toBe(true)
  })

  it('never on a hidden tab, the other pane of a split, or under a dialog', () => {
    expect(canvasOwnsKey(body as EventTarget, canvas(false), { focused: true, dialogOpen: false, body })).toBe(false)
    expect(canvasOwnsKey(body as EventTarget, canvas(), { focused: false, dialogOpen: false, body })).toBe(false)
    expect(canvasOwnsKey(body as EventTarget, canvas(), { focused: true, dialogOpen: true, body })).toBe(false)
  })

  it('a button of the diagram itself (Align, Auto layout) counts as the diagram: ⌘Z after it undoes', () => {
    expect(canvasOwnsKey(el() as unknown as EventTarget, canvas(), { focused: true, dialogOpen: false, body })).toBe(true)
  })

  it('never when focus is in a list, the table panel or a text field, or on anything outside the diagram', () => {
    expect(canvasOwnsKey(el([], false) as unknown as EventTarget, canvas(), { focused: true, dialogOpen: false, body })).toBe(false)
    for (const where of ['input', '.cm-editor', '[role="listbox"]', '[role="tree"]', '[data-testid="table-panel"]'])
      expect(canvasOwnsKey(el([where]) as unknown as EventTarget, canvas(), { focused: true, dialogOpen: false, body })).toBe(false)
  })
})

describe('the panel’s Name field', () => {
  it('refuses an empty name or one another table has, keeps the own one in another case', () => {
    expect(nameProblem('  ', 'orders', ['orders', 'payments'])).toBe('empty')
    expect(nameProblem('Payments', 'orders', ['orders', 'payments'])).toBe('taken')
    expect(nameProblem('Orders', 'orders', ['orders', 'payments'])).toBeUndefined()
    expect(nameProblem('order_items', 'orders', ['orders', 'payments'])).toBeUndefined()
  })
})

describe('model undo', () => {
  type Tab = { sqlDatabase?: string; targetDatabase?: string; tableRenames?: Record<string, string>; dirty?: boolean }

  it('Switch database: undo brings back the text and the project’s database together, redo both again', () => {
    let steps: ModelSteps<Tab> = { past: [], future: [] }
    let tab: Tab = { sqlDatabase: 'pg' }
    let text = 'canvas edit'
    steps = remembered(steps, 'before canvas', tab)
    const patch = { sqlDatabase: 'my', targetDatabase: 'my', dirty: true }
    steps = remembered(steps, text, tab, patch, ['dirty'])
    tab = { ...tab, ...patch }
    text = 'mysql types'

    const back = stepTo(steps, 'undo', text, tab)!
    expect(back).toEqual({ text: 'canvas edit', meta: { sqlDatabase: 'pg', targetDatabase: undefined } })
    tab = { ...tab, ...back.meta }
    text = back.text
    const forward = stepTo(steps, 'redo', text, tab)!
    expect(forward).toEqual({ text: 'mysql types', meta: { sqlDatabase: 'my', targetDatabase: 'my' } })
  })

  it('a canvas step carries no settings', () => {
    const steps = remembered<Tab>({ past: [], future: [] }, 'a', { sqlDatabase: 'pg' })
    expect(stepTo(steps, 'undo', 'b', { sqlDatabase: 'my' })).toEqual({ text: 'a' })
    expect(steps.future).toEqual([{ text: 'b' }])
  })
})

describe('nodes made again by a layout', () => {
  it('keep the size the canvas measured, so a table never stays unmeasured (and invisible)', () => {
    const previous = [
      { id: 'shop.invoice', measured: { width: 240, height: 120 } },
      { id: 'shop.payment', measured: { width: 240, height: 98 } },
      { id: 'shop.half', measured: { width: 240 } },
    ]
    const next = keepMeasured<{ id: string; measured?: { width?: number; height?: number } }>(previous, [
      { id: 'shop.payment' },
      { id: 'shop.customer' },
      { id: 'shop.half' },
      { id: 'shop.invoice', measured: { width: 1, height: 2 } },
    ])
    expect(next).toEqual([
      { id: 'shop.payment', measured: { width: 240, height: 98 } },
      // A new table, and one never fully measured, are measured by the canvas when they appear.
      { id: 'shop.customer' },
      { id: 'shop.half' },
      { id: 'shop.invoice', measured: { width: 1, height: 2 } },
    ])
  })
})
