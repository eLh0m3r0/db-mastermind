import type { TableInfo } from '@dbmastermind/core/browser'

/**
 * The model without the relationships that point at tables dropped on the canvas: a Ref to a table that is gone does
 * not parse ("Unknown table in reference") and blocks Compare and Rename until the next canvas edit.
 */
export function withoutKeysTo(tables: TableInfo[], dropped: { schema?: string; name: string }[]): TableInfo[] {
  if (!dropped.length) return tables
  const gone = (t: TableInfo, f: TableInfo['foreignKeys'][number]) => dropped.some((d) => d.name === f.refTable && (d.schema ?? '') === (f.refSchema ?? t.schema ?? ''))
  return tables.map((t) => (t.foreignKeys.some((f) => gone(t, f)) ? { ...t, foreignKeys: t.foreignKeys.filter((f) => !gone(t, f)) } : t))
}
