import { describe, expect, it } from 'vitest'
import { matchedColumns, searchedValueKind, valueSearchConditions, type TableInfo } from '../src/index.js'

const col = (name: string, dataType: string) => ({ name, dataType, ordinal: 0, nullable: true, isPrimaryKey: false, isIdentity: false })
const table: Pick<TableInfo, 'columns'> = {
  columns: [col('id', 'integer'), col('code', 'character varying(20)'), col('ref', 'uuid'), col('status', 'order_status'), col('meta', 'jsonb'), col('created', 'timestamp without time zone'), col('due', 'date'), col('total', 'numeric(12,2)'), col('note', 'text')],
}
const plan = (text: string, mode: 'exact' | 'contains' = 'exact', driver: 'postgres' | 'mssql' = 'postgres') =>
  valueSearchConditions(table, text, mode, driver).map((c) => `${c.column} ${c.operator}${c.value2 ? ` ${c.value}..${c.value2}` : ''}`)

describe('value search', () => {
  it('tells numbers, dates, UUIDs and text apart', () => {
    expect(searchedValueKind(' 1042 ')).toBe('number')
    expect(searchedValueKind('12.5')).toBe('number')
    expect(searchedValueKind('2026-01-05')).toBe('date')
    expect(searchedValueKind('2026-13-45')).toBe('text')
    expect(searchedValueKind('0b6c1e5e-2f0b-4c8e-9a51-1d2f3a4b5c6d')).toBe('uuid')
    expect(searchedValueKind('Alice')).toBe('text')
  })

  it('a number is looked for in number and text columns; never in uuid, enum or JSON columns', () => {
    expect(plan('1042')).toEqual(['id eq', 'code eq', 'total eq', 'note eq'])
  })

  it('text goes to text columns only, as = or as contains', () => {
    expect(plan('Alice')).toEqual(['code eq', 'note eq'])
    expect(plan('lic', 'contains')).toEqual(['code contains', 'note contains'])
  })

  it('a date matches date columns and the whole day of timestamps', () => {
    expect(plan('2026-01-05')).toEqual(['code eq', 'created between 2026-01-05 00:00:00..2026-01-05 23:59:59.999', 'due eq', 'note eq'])
  })

  it('a UUID matches uuid columns too; SQL Server text/ntext columns are skipped', () => {
    expect(plan('0b6c1e5e-2f0b-4c8e-9a51-1d2f3a4b5c6d')).toEqual(['code eq', 'ref eq', 'note eq'])
    expect(plan('Alice', 'exact', 'mssql')).toEqual(['code eq'])
  })

  it('names the columns that hold the value in the rows found', () => {
    const conditions = valueSearchConditions(table, '1042', 'exact', 'postgres')
    const fields = table.columns.map((c) => ({ name: c.name }))
    const rows = [
      [1042, 'X', null, null, null, null, null, '7.00', 'n'],
      [5, '1042', null, null, null, null, null, '1042.00', null],
    ]
    expect(matchedColumns(fields, rows, conditions, '1042')).toEqual(['id', 'code', 'total'])
  })
})
