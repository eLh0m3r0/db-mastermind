import { useEffect, useMemo, useRef, useState } from 'react'
import { cellToText, columnFamily, type CellValue, type ResultField } from '@dbmastermind/core/browser'
import { Segmented, Select } from '@/components/ui/Input'
import { cn, formatCount } from '@/lib/utils'
import { useT } from '@/lib/i18n'

export type ChartKind = 'bar' | 'line' | 'scatter'

export interface ChartConfig {
  kind: ChartKind
  x: number
  ys: number[]
}

const MAX_SERIES = 8
const BASE_PAD = { top: 16, right: 16, bottom: 36, left: 56 }

const seriesColor = (i: number) => `var(--series-${(i % MAX_SERIES) + 1})`

function numeric(v: CellValue): number | null {
  if (v === null) return null
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = Number(cellToText(v))
  return Number.isFinite(n) ? n : null
}

function isNumericColumn(field: ResultField, rows: CellValue[][], i: number): boolean {
  if (field.dataType) {
    const family = columnFamily(field.dataType)
    if (family === 'number') return true
    if (family !== 'other') return false
  }
  const sample = rows.slice(0, 50).map((r) => r[i] ?? null).filter((v) => v !== null)
  return sample.length > 0 && sample.every((v) => numeric(v) !== null)
}

/** Picks a sensible chart: first non-numeric (or date) column as X, numeric columns as series. */
export function defaultChartConfig(fields: ResultField[], rows: CellValue[][]): ChartConfig | null {
  const numericCols = fields.map((f, i) => (isNumericColumn(f, rows, i) ? i : -1)).filter((i) => i >= 0)
  const x = fields.findIndex((_, i) => !numericCols.includes(i))
  if (x === -1) {
    if (numericCols.length < 2) return null
    return { kind: 'scatter', x: numericCols[0]!, ys: [numericCols[1]!] }
  }
  if (!numericCols.length) return null
  const looksLikeTime = isTimeColumn(fields[x]!)
  // One axis only: default to series of comparable magnitude; others stay one click away.
  const peak = (col: number) => Math.max(...rows.map((r) => Math.abs(numeric(r[col] ?? null) ?? 0)), 0)
  const firstPeak = peak(numericCols[0]!) || 1
  const comparable = numericCols.filter((col) => {
    const p = peak(col) || 1
    return Math.max(p, firstPeak) / Math.min(p, firstPeak) <= 10
  })
  return { kind: looksLikeTime ? 'line' : 'bar', x, ys: comparable.slice(0, 4) }
}

function isTimeColumn(field: ResultField): boolean {
  return /date|time|year|month|day|week/i.test(`${field.dataType ?? ''} ${field.name}`)
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) {
    max = min + 1
  }
  const span = max - min
  const step0 = span / count
  const mag = 10 ** Math.floor(Math.log10(step0))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? 10 * mag
  const start = Math.floor(min / step) * step
  const ticks: number[] = [start]
  // Always end at or above the maximum so no mark leaves the plot.
  while (ticks.at(-1)! < max) ticks.push(Math.round((ticks.at(-1)! + step) / step) * step)
  return ticks
}

function compactNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`
  return String(Math.round(n * 100) / 100)
}

function useSize() {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 600, height: 300 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return { ref, ...size }
}

export function ResultChart({
  fields,
  rows,
  config,
  onConfigChange,
}: {
  fields: ResultField[]
  rows: CellValue[][]
  config: ChartConfig
  onConfigChange: (c: ChartConfig) => void
}) {
  const { ref, width, height } = useSize()
  const [hover, setHover] = useState<{ index: number; px: number; py: number } | null>(null)
  const numericCols = useMemo(() => fields.map((f, i) => (isNumericColumn(f, rows, i) ? i : -1)).filter((i) => i >= 0), [fields, rows])

  const maxPoints = config.kind === 'bar' ? 200 : 5000
  const ordered = useMemo(() => {
    // Time reads left to right: flip results that came sorted newest first.
    const field = fields[config.x]
    if (!field || !isTimeColumn(field) || rows.length < 2) return rows
    const first = cellToText(rows[0]![config.x] ?? null)
    const last = cellToText(rows.at(-1)![config.x] ?? null)
    return first > last ? [...rows].reverse() : rows
  }, [rows, fields, config.x])
  const data = ordered.slice(0, maxPoints)
  const t = useT()
  const truncated = rows.length > data.length
  const series = config.ys.slice(0, MAX_SERIES)
  // Room above the plot for the legend when there are several series.
  const PAD = { ...BASE_PAD, top: series.length > 1 ? 34 : BASE_PAD.top }
  const plotW = Math.max(50, width - PAD.left - PAD.right)
  const plotH = Math.max(50, height - PAD.top - PAD.bottom)

  const values = series.map((col) => data.map((r) => numeric(r[col] ?? null)))
  const all = values.flat().filter((v): v is number => v !== null)
  const yMin = Math.min(0, ...all)
  const yMax = Math.max(0, ...all)
  const yTicks = niceTicks(yMin, yMax)
  const y0 = yTicks[0] ?? 0
  const y1 = yTicks.at(-1) ?? 1
  const yScale = (v: number) => PAD.top + plotH - ((v - y0) / (y1 - y0 || 1)) * plotH

  // Scatter uses a numeric X; bar/line use categories in result order.
  const xNumeric = config.kind === 'scatter'
  const xValues = data.map((r) => (xNumeric ? numeric(r[config.x] ?? null) : null))
  const xNums = xValues.filter((v): v is number => v !== null)
  const xTicks = xNumeric ? niceTicks(Math.min(...xNums, 0), Math.max(...xNums, 1)) : []
  const xn0 = xTicks[0] ?? 0
  const xn1 = xTicks.at(-1) ?? 1
  const band = plotW / Math.max(1, data.length)
  const xPos = (i: number) => (xNumeric ? PAD.left + (((xValues[i] ?? 0) - xn0) / (xn1 - xn0 || 1)) * plotW : PAD.left + band * i + band / 2)
  const labels = data.map((r) => cellToText(r[config.x] ?? null))
  const labelEvery = Math.max(1, Math.ceil((data.length * 64) / plotW))

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (px < PAD.left || px > PAD.left + plotW || !data.length) return setHover(null)
    let index: number
    if (xNumeric) {
      index = 0
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < data.length; i++) {
        const d = Math.hypot(xPos(i) - px, yScale(values[0]?.[i] ?? 0) - py)
        if (d < best) {
          best = d
          index = i
        }
      }
    } else index = Math.min(data.length - 1, Math.max(0, Math.floor((px - PAD.left) / band)))
    setHover({ index, px, py })
  }

  const barGap = 2
  const groupW = Math.max(1, band * 0.8)
  const barW = Math.max(1, (groupW - barGap * (series.length - 1)) / series.length)
  const baseline = yScale(Math.max(y0, Math.min(0, y1)))

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1.5 text-[12px]">
        <Segmented
          size="xs"
          value={config.kind}
          onChange={(kind) => onConfigChange({ ...config, kind })}
          options={[
            { value: 'bar', label: t('Bar') },
            { value: 'line', label: t('Line') },
            { value: 'scatter', label: t('Scatter') },
          ]}
        />
        <span className="text-fg-faint">X</span>
        <Select inputSize="sm" className="h-6 w-40 text-[12px]" value={config.x} onChange={(e) => onConfigChange({ ...config, x: Number(e.target.value) })}>
          {fields.map((f, i) => (
            <option key={i} value={i}>
              {f.name}
            </option>
          ))}
        </Select>
        <span className="text-fg-faint">Y</span>
        {numericCols.map((col) => {
          const on = config.ys.includes(col)
          const slot = config.ys.indexOf(col)
          return (
            <button
              key={col}
              type="button"
              disabled={!on && config.ys.length >= (config.kind === 'scatter' ? 3 : MAX_SERIES)}
              onClick={() => onConfigChange({ ...config, ys: on ? config.ys.filter((c) => c !== col) : [...config.ys, col] })}
              className={cn('flex h-6 items-center gap-1.5 rounded-md border px-2 disabled:opacity-40', on ? 'border-line-strong bg-elevated' : 'border-transparent text-fg-faint hover:text-fg')}
            >
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: on ? seriesColor(slot) : 'var(--border-strong)' }} />
              {fields[col]?.name}
            </button>
          )
        })}
        {(() => {
          const peaks = series.map((col) => Math.max(...data.map((r) => Math.abs(numeric(r[col] ?? null) ?? 0)), 0) || 1)
          return peaks.length > 1 && Math.max(...peaks) / Math.min(...peaks) > 10 ? (
            <span className="text-warning" title={t('Series with very different magnitudes share one axis; chart them separately to compare shapes.')}>
              {t('Scales differ a lot: chart these separately')}
            </span>
          ) : null
        })()}
        {truncated && <span className="ml-auto text-fg-faint">{t('First {n} rows charted', { n: formatCount(data.length) })}</span>}
      </div>
      <div ref={ref} className="relative min-h-0 flex-1" onMouseLeave={() => setHover(null)}>
        {series.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[12px] text-fg-faint">{t('Pick at least one numeric column for Y.')}</div>
        ) : (
          <svg width={width} height={height} onMouseMove={onMove} className="block select-none" role="img" aria-label={t('Chart of query results')}>
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={PAD.left + plotW} y1={yScale(t)} y2={yScale(t)} stroke="var(--border)" strokeWidth={1} />
                <text x={PAD.left - 8} y={yScale(t)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--text-muted)">
                  {compactNumber(t)}
                </text>
              </g>
            ))}
            {xNumeric
              ? xTicks.map((t) => (
                  <text key={t} x={PAD.left + ((t - xn0) / (xn1 - xn0 || 1)) * plotW} y={PAD.top + plotH + 18} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                    {compactNumber(t)}
                  </text>
                ))
              : labels.map((label, i) =>
                  i % labelEvery === 0 ? (
                    <text key={i} x={xPos(i)} y={PAD.top + plotH + 18} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
                      {label.length > 12 ? `${label.slice(0, 11)}…` : label}
                    </text>
                  ) : null,
                )}
            <line x1={PAD.left} x2={PAD.left + plotW} y1={baseline} y2={baseline} stroke="var(--border-strong)" strokeWidth={1} />

            {config.kind === 'bar' &&
              values.map((vals, s) =>
                vals.map((v, i) => {
                  if (v === null) return null
                  const x = xPos(i) - groupW / 2 + s * (barW + barGap)
                  const top = Math.min(yScale(v), baseline)
                  const h = Math.max(1, Math.abs(baseline - yScale(v)))
                  const r = Math.min(4, barW / 2, h)
                  // Rounded data end, square at the baseline.
                  const d =
                    v >= 0
                      ? `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`
                      : `M${x},${top} V${top + h - r} Q${x},${top + h} ${x + r},${top + h} H${x + barW - r} Q${x + barW},${top + h} ${x + barW},${top + h - r} V${top} Z`
                  return <path key={`${s}-${i}`} d={d} fill={seriesColor(s)} opacity={hover && hover.index !== i ? 0.55 : 1} />
                }),
              )}
            {config.kind === 'line' &&
              values.map((vals, s) => {
                const points = vals.map((v, i) => (v === null ? null : `${xPos(i)},${yScale(v)}`))
                // Gaps for NULLs instead of drawing through them.
                const segments: string[][] = [[]]
                for (const p of points) {
                  if (p) segments.at(-1)!.push(p)
                  else if (segments.at(-1)!.length) segments.push([])
                }
                return segments.map((seg, k) =>
                  seg.length > 1 ? (
                    <polyline key={`${s}-${k}`} points={seg.join(' ')} fill="none" stroke={seriesColor(s)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
                  ) : seg.length === 1 ? (
                    <circle key={`${s}-${k}`} cx={Number(seg[0]!.split(',')[0])} cy={Number(seg[0]!.split(',')[1])} r={3} fill={seriesColor(s)} />
                  ) : null,
                )
              })}
            {config.kind === 'scatter' &&
              values.map((vals, s) =>
                vals.map((v, i) =>
                  v === null || xValues[i] === null ? null : (
                    <circle key={`${s}-${i}`} cx={xPos(i)} cy={yScale(v)} r={4} fill={seriesColor(s)} stroke="var(--bg)" strokeWidth={2} />
                  ),
                ),
              )}

            {hover && (
              <g pointerEvents="none">
                {!xNumeric && <line x1={xPos(hover.index)} x2={xPos(hover.index)} y1={PAD.top} y2={PAD.top + plotH} stroke="var(--text-faint)" strokeDasharray="3 3" />}
                {config.kind !== 'bar' &&
                  values.map((vals, s) => {
                    const v = vals[hover.index]
                    return v === null || v === undefined ? null : <circle key={s} cx={xPos(hover.index)} cy={yScale(v)} r={4.5} fill={seriesColor(s)} stroke="var(--bg)" strokeWidth={2} />
                  })}
              </g>
            )}
          </svg>
        )}
        {series.length > 1 && (
          <div className="pointer-events-none absolute top-2 left-14 flex gap-3 text-[11.5px] text-fg-muted">
            {series.map((col, s) => (
              <span key={col} className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-sm" style={{ background: seriesColor(s) }} />
                {fields[col]?.name}
              </span>
            ))}
          </div>
        )}
        {hover && data[hover.index] && (
          <div
            className="pointer-events-none absolute z-10 min-w-[140px] rounded-md border border-line bg-elevated px-2.5 py-1.5 text-[12px] shadow-pop"
            style={{ left: Math.min(hover.px + 14, width - 200), top: Math.max(4, hover.py - 20) }}
          >
            <div className="mb-1 font-medium">{labels[hover.index]}</div>
            {series.map((col, s) => (
              <div key={col} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-sm" style={{ background: seriesColor(s) }} />
                <span className="text-fg-muted">{fields[col]?.name}</span>
                <span className="ml-auto pl-3 font-mono tabular-nums">
                  {(() => {
                    const v = data[hover.index]![col] ?? null
                    const n = numeric(v)
                    return n === null ? cellToText(v) : n.toLocaleString('en-US', { maximumFractionDigits: 2 }).replaceAll(',', '\u2009')
                  })()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
