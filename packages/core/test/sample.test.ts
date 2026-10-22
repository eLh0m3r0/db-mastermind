import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { sampleDatabaseSql } from '../src/index.js'

describe('sample database', () => {
  it('builds a consistent SQLite database', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    for (const sql of sampleDatabaseSql()) db.exec(sql)
    const count = (sql: string) => Number(Object.values(db.prepare(sql).get() as object)[0])
    expect(count('SELECT COUNT(*) FROM customers')).toBe(240)
    expect(count('SELECT COUNT(*) FROM orders')).toBe(1200)
    expect(count('SELECT COUNT(*) FROM order_items')).toBeGreaterThan(1200)
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(count('SELECT COUNT(*) FROM customer_revenue')).toBeGreaterThan(100)
    // Deterministic: same data on every run.
    expect(sampleDatabaseSql().join()).toBe(sampleDatabaseSql().join())
  })
})
