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

  it('says what is wrong', () => {
    expect(() => parseJsonRows('{"a":1}\nnot json')).toThrow(/Line 2/)
    expect(() => parseJsonRows('[1, 2]')).toThrow(/No JSON objects/)
  })
})
