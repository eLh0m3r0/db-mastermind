import { describe, expect, it } from 'vitest'
import { closeTabsPlan, nextNumberedTitle, reopenIndex, tabsBeside } from '../src/renderer/src/store/tab-order'

describe('new tab names', () => {
  it('takes one more than the highest number in use', () => {
    expect(nextNumberedTitle([], 'Query {n}')).toBe('Query 1')
    expect(nextNumberedTitle(['Q', 'Query 2', 'Query 3'], 'Query {n}')).toBe('Query 4')
  })

  it('never repeats a name after a tab in the middle was closed', () => {
    // Query 1, Query 2, Query 3 → close Query 2 → the next one is Query 4 (counting the tabs gave Query 3 twice).
    expect(nextNumberedTitle(['Query 1', 'Query 3'], 'Query {n}')).toBe('Query 4')
  })

  it('ignores titles that only look alike, and works with the Czech template', () => {
    expect(nextNumberedTitle(['Query 7 draft', 'My Query 9', 'orders'], 'Query {n}')).toBe('Query 1')
    expect(nextNumberedTitle(['Dotaz 1', 'Dotaz 12'], 'Dotaz {n}')).toBe('Dotaz 13')
    expect(nextNumberedTitle(['(1) query'], '({n}) query')).toBe('(2) query')
  })
})

describe('reopening a closed tab', () => {
  it('goes back to its old place', () => {
    expect(reopenIndex(4, 14)).toBe(4)
    expect(reopenIndex(0, 3)).toBe(0)
  })

  it('goes to the end when its place is gone or unknown', () => {
    expect(reopenIndex(9, 3)).toBe(3)
    expect(reopenIndex(undefined, 5)).toBe(5)
    expect(reopenIndex(-2, 5)).toBe(0)
  })
})

describe('closing the tabs to the left or right', () => {
  const order = ['a', 'b', 'c', 'd', 'e', 'f']

  it('finds the tabs on each side of the right-clicked one, none past the ends', () => {
    expect(tabsBeside(order, 'c', 'left')).toEqual(['a', 'b'])
    expect(tabsBeside(order, 'c', 'right')).toEqual(['d', 'e', 'f'])
    expect(tabsBeside(order, 'a', 'left')).toEqual([])
    expect(tabsBeside(order, 'f', 'right')).toEqual([])
    expect(tabsBeside(order, 'x', 'left')).toEqual([])
  })

  it('keeps the selected tab when it stays, selects the right-clicked one when it goes', () => {
    expect(closeTabsPlan(order, ['d', 'e', 'f'], 'b', 'c')).toMatchObject({ remaining: ['a', 'b', 'c'], active: 'b' })
    expect(closeTabsPlan(order, ['d', 'e', 'f'], 'e', 'c')).toMatchObject({ remaining: ['a', 'b', 'c'], active: 'c' })
    expect(closeTabsPlan(order, ['a', 'b'], 'a', 'c')).toMatchObject({ remaining: ['c', 'd', 'e', 'f'], active: 'c' })
  })

  it('records each place so ⇧⌘T brings them back one by one, each where it was', () => {
    const right = closeTabsPlan(order, ['d', 'e', 'f'], 'f', 'c')
    expect(right.closed).toEqual([{ id: 'f', index: 5 }, { id: 'e', index: 4 }, { id: 'd', index: 3 }])
    // The store puts them on the reopen list in reverse: d first, then e, then f.
    let tabs = right.remaining
    for (const { id, index } of [...right.closed].reverse()) {
      tabs = [...tabs.slice(0, reopenIndex(index, tabs.length)), id, ...tabs.slice(reopenIndex(index, tabs.length))]
    }
    expect(tabs).toEqual(order)
    const left = closeTabsPlan(order, ['a', 'b', 'c'], 'd', 'd')
    tabs = left.remaining
    for (const { id, index } of [...left.closed].reverse()) {
      tabs = [...tabs.slice(0, reopenIndex(index, tabs.length)), id, ...tabs.slice(reopenIndex(index, tabs.length))]
    }
    expect(tabs).toEqual(order)
  })

  it('closes nothing it does not know (a cancelled question closes nothing: the store is not called)', () => {
    expect(closeTabsPlan(order, [], 'c', 'c')).toEqual({ remaining: order, closed: [], active: 'c' })
    expect(closeTabsPlan(order, ['zz'], 'c', 'c').remaining).toEqual(order)
  })
})
