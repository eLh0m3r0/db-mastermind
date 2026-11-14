import { describe, expect, it } from 'vitest'
import { parseJsonRows } from '../src/index.js'

describe('parseJsonRows', () => {
  it('an array of objects: every key in the order first seen, missing keys and null as null', () => {
    expect(parseJsonRows('[{"id":1,"name":"A"},{"id":2,"vip":true,"name":null}]')).toEqual([
      ['id', 'name', 'vip'],
      ['1', 'A', null],
      ['2', null, 'true'],
    ])
  })

  it('JSON Lines, a BOM, nested values as JSON text', () => {
    expect(parseJsonRows('﻿{"id":1,"tags":["a","b"]}\n\n{"id":2,"meta":{"x":1}}\n')).toEqual([
      ['id', 'tags', 'meta'],
      ['1', '["a","b"]', null],
      ['2', null, '{"x":1}'],
    ])
  })

  it('an object holding the array (an API response), or a single object', () => {
    expect(parseJsonRows('{"data":[{"a":1}],"next":null}')).toEqual([['a'], ['1']])
    expect(parseJsonRows('{"a":1}')).toEqual([['a'], ['1']])
  })

  it('an object with array values is one record; a wrapper only under a known key (review finding)', () => {
    expect(parseJsonRows('{"id":1,"tags":["a"]}')).toEqual([['id', 'tags'], ['1', '["a"]']])
    expect(parseJsonRows('{"items":[{"a":1},{"a":2}],"page":1}')).toEqual([['a'], ['1'], ['2']])
  })

  it('keeps every digit of large numbers and decimals (review finding)', () => {
    expect(parseJsonRows('[{"id":9007199254740993,"price":0.1000000000000000055511}]')).toEqual([['id', 'price'], ['9007199254740993', '0.1000000000000000055511']])
  })

  it('says what is wrong', () => {
    expect(() => parseJsonRows('[{"a":1}, 5]')).toThrow(/Record 2 is not an object/)
    expect(() => parseJsonRows('{"a":1}\nnot json')).toThrow(/Line 2/)
    expect(() => parseJsonRows('[1, 2]')).toThrow(/No JSON objects/)
  })
})
