import { describe, expect, it } from 'vitest'
import { attributePackages, leavesPackage, packageColumnsFor, parseDbml, toDbml } from '../src/index.js'

const model = parseDbml(`Table a {
  id int [pk]
  created_at timestamp [not null, package: 'Stamp']
  created_by varchar(30) [package: 'Stamp']
}
Table b {
  id int [pk]
  created_at timestamp [not null, package: 'Stamp']
}
Table c {
  id int [pk]
  street text [package: 'Address']
}
`).tables

describe('attribute packages', () => {
  it('are read off the model: each from the table with most of its columns', () => {
    const packages = attributePackages(model)
    expect(packages.map((p) => `${p.name} ${p.tables} ${p.columns.map((c) => c.name).join(',')}`)).toEqual([
      'Address 1 street',
      'Stamp 2 created_at,created_by',
    ])
    expect(packages[1]!.columns[0]).toMatchObject({
      dataType: 'timestamp',
      nullable: false,
      package: 'Stamp',
    })
    // A table gets what it doesn't have yet.
    expect(packageColumnsFor(model[1]!, packages[1]!).map((c) => c.name)).toEqual(['created_by'])
    expect(toDbml(model)).toContain("created_by varchar(30) [package: 'Stamp']")
  })

  it('a column leaves its package when its name or definition changes, not for a comment', () => {
    const c = {
      name: 'created_at',
      dataType: 'timestamp',
      nullable: false,
      package: 'Stamp',
      comment: null as string | null,
    }
    expect(leavesPackage(c, { comment: 'When' })).toBe(false)
    expect(leavesPackage(c, { dataType: 'timestamp' })).toBe(false)
    expect(leavesPackage(c, { dataType: 'date' })).toBe(true)
    expect(leavesPackage(c, { name: 'made_at' })).toBe(true)
    expect(leavesPackage(c, { nullable: true })).toBe(true)
    expect(leavesPackage({ ...c, package: undefined }, { nullable: true })).toBe(false)
  })
})
