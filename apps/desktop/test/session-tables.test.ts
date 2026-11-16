import { describe, expect, it } from 'vitest'
import { createdTables, inspectSql, type SchemaSnapshot } from '@dbmastermind/core/browser'
import { forgetSessionTables, forgetSessionTablesOf, rememberSessionTables, sessionTablesOf, useSessionTables } from '../src/renderer/src/store/session-tables'
import { objectsAfterEdit } from '../src/renderer/src/features/model/sql-objects'

const schema = { tables: [{ name: 'orders', schema: 'public', type: 'table', columns: [{ name: 'id', dataType: 'int4' }], primaryKey: ['id'], foreignKeys: [], indexes: [] }], schemas: ['public'], defaultSchema: 'public', routines: [], capturedAt: '' } as unknown as SchemaSnapshot
const unknownTables = (sql: string, sessionTables: string[]) => inspectSql(sql, 'postgres', schema, { sessionTables }).filter((w) => w.kind === 'unknown-table')

describe('temporary tables of a query tab', () => {
  it('a table an earlier run created is not underlined later in the same tab', () => {
    const run = 'CREATE TEMP TABLE my_temp AS SELECT * FROM orders'
    rememberSessionTables('tab1', 'c1', createdTables(run, 'postgres'))
    const known = sessionTablesOf(useSessionTables.getState(), 'tab1')
    expect(unknownTables('SELECT * FROM my_temp', [])).toHaveLength(1)
    expect(unknownTables('SELECT * FROM my_temp', known)).toEqual([])
    // Another tab has its own session: not there.
    expect(sessionTablesOf(useSessionTables.getState(), 'tab2')).toEqual([])
  })

  it('are forgotten with the tab’s session or the connection', () => {
    rememberSessionTables('tab1', 'c1', ['a'])
    rememberSessionTables('tab3', 'c2', ['b'])
    forgetSessionTables('tab1')
    expect(sessionTablesOf(useSessionTables.getState(), 'tab1')).toEqual([])
    forgetSessionTablesOf('c2')
    expect(sessionTablesOf(useSessionTables.getState(), 'tab3')).toEqual([])
  })
})

describe('deleting the last trigger, procedure or sequence of a model', () => {
  it('sends an empty list once the tab had the project’s objects, undefined only when it never had', () => {
    expect(objectsAfterEdit([], [{ kind: 'sequence' }])).toEqual([])
    expect(objectsAfterEdit([], [])).toEqual([])
    expect(objectsAfterEdit([], undefined)).toBeUndefined()
    expect(objectsAfterEdit([1], undefined)).toEqual([1])
  })
})
