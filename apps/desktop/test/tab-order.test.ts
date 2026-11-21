import { describe, expect, it } from 'vitest'
import { nextNumberedTitle, reopenIndex } from '../src/renderer/src/store/tab-order'

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
