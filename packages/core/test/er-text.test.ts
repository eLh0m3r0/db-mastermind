import { describe, expect, it } from 'vitest'
import { parseDbml, toMermaid, toPlantUml } from '../src/index.js'

const { tables } = parseDbml(`
Table customers {
  id integer [pk]
  name varchar(100) [not null]
}
Table orders {
  id integer [pk]
  customer_id integer [not null, ref: > customers.id]
  coupon_id integer [ref: > coupons.id]
}
Table coupons {
  id integer [pk]
}
`)

describe('toPlantUml', () => {
  it('writes entities with keys and IE relationships', () => {
    const out = toPlantUml(tables)
    expect(out).toContain('entity "customers" as customers {\n  * id : integer <<PK>>\n  --\n  * name : varchar(100)\n}')
    expect(out).toContain('  * customer_id : integer <<FK>>')
    expect(out).toContain('  coupon_id : integer <<FK>>')
    expect(out).toContain('customers ||--o{ orders')
    expect(out).toContain('coupons |o--o{ orders')
    expect(out.startsWith('@startuml') && out.endsWith('@enduml')).toBe(true)
  })
})

describe('toMermaid', () => {
  it('writes an erDiagram', () => {
    const out = toMermaid(tables)
    expect(out).toContain('  orders {\n    integer id PK\n    integer customer_id FK')
    expect(out).toContain('  customers ||--o{ orders : "customer_id"')
  })
})
