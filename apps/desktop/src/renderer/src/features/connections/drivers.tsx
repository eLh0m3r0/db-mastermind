import type { DriverId } from '@dbmastermind/core/browser'

export const DRIVERS: { id: DriverId; label: string; color: string; mark: string }[] = [
  { id: 'postgres', label: 'PostgreSQL', color: '#336791', mark: 'Pg' },
  { id: 'mssql', label: 'SQL Server', color: '#c4262e', mark: 'MS' },
  { id: 'mysql', label: 'MySQL', color: '#00758f', mark: 'My' },
  { id: 'mariadb', label: 'MariaDB', color: '#7d5a3c', mark: 'Ma' },
  { id: 'oracle', label: 'Oracle', color: '#c74634', mark: 'Or' },
  { id: 'sqlite', label: 'SQLite', color: '#0f80cc', mark: 'Lt' },
  { id: 'duckdb', label: 'DuckDB', color: '#8a7a00', mark: 'Dk' },
  { id: 'clickhouse', label: 'ClickHouse', color: '#a8781c', mark: 'CH' },
]

export function driverLabel(id: DriverId): string {
  return DRIVERS.find((d) => d.id === id)?.label ?? id
}

/** Neutral monogram badge (no vendor logos). */
export function DriverIcon({ driver, size = 16 }: { driver: DriverId; size?: number }) {
  const d = DRIVERS.find((x) => x.id === driver) ?? DRIVERS[0]!
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-[4px] font-semibold text-white"
      style={{ width: size, height: size, background: d.color, fontSize: Math.round(size * 0.48), letterSpacing: '-0.02em' }}
      aria-hidden
    >
      {d.mark}
    </span>
  )
}
