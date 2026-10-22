import type { TableInfo } from './types.js'

const alias = (t: { schema?: string; name: string }) => `${t.schema ? `${t.schema}_` : ''}${t.name}`.replace(/\W/g, '_')

/** Mermaid `erDiagram` source: tables with columns and key markers, one line per foreign key. */
export function toMermaid(tables: TableInfo[]): string {
  const lines = ['erDiagram']
  for (const t of tables) {
    lines.push(`  ${t.name.replace(/\W/g, '_')} {`)
    for (const c of t.columns) {
      const key = c.isPrimaryKey ? ' PK' : t.foreignKeys.some((f) => f.columns.includes(c.name)) ? ' FK' : ''
      lines.push(`    ${c.dataType.replace(/\W/g, '_') || 'unknown'} ${c.name.replace(/\W/g, '_')}${key}`)
    }
    lines.push('  }')
  }
  for (const t of tables) for (const fk of t.foreignKeys) lines.push(`  ${fk.refTable.replace(/\W/g, '_')} ||--o{ ${t.name.replace(/\W/g, '_')} : "${fk.columns.join(', ')}"`)
  return lines.join('\n')
}

/** PlantUML entity diagram (IE notation): primary key above the line, `*` for NOT NULL, `<<FK>>` markers. */
export function toPlantUml(tables: TableInfo[]): string {
  const known = new Set(tables.map((t) => alias(t)))
  const lines = ['@startuml', 'hide circle', 'skinparam linetype ortho', '']
  for (const t of tables) {
    lines.push(`entity "${t.schema ? `${t.schema}.` : ''}${t.name}" as ${alias(t)} {`)
    const pk = t.columns.filter((c) => c.isPrimaryKey)
    const rest = t.columns.filter((c) => !c.isPrimaryKey)
    const column = (c: TableInfo['columns'][number]) => {
      const fk = t.foreignKeys.some((f) => f.columns.includes(c.name))
      return `  ${c.nullable ? '' : '* '}${c.name} : ${c.dataType}${c.isPrimaryKey ? ' <<PK>>' : ''}${fk ? ' <<FK>>' : ''}`
    }
    lines.push(...pk.map(column))
    if (pk.length) lines.push('  --')
    lines.push(...rest.map(column), '}', '')
  }
  for (const t of tables) {
    for (const fk of t.foreignKeys) {
      const ref = alias({ schema: fk.refSchema ?? t.schema, name: fk.refTable })
      const target = known.has(ref) ? ref : alias({ name: fk.refTable })
      if (!known.has(target)) continue
      const optional = fk.columns.some((name) => t.columns.find((c) => c.name === name)?.nullable)
      lines.push(`${target} ${optional ? '|o' : '||'}--o{ ${alias(t)}`)
    }
  }
  lines.push('@enduml')
  return lines.join('\n')
}
