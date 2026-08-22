import { useMemo } from 'react'
import type { Series } from '@inertialref/devtools'
import { format } from './perfFormat.ts'

/**
 * An ImGui-style history plot.
 *
 * A filled area rather than a line, because at 240 samples across 200 pixels the
 * line is mostly aliasing and the fill still reads as a shape. The budget, where
 * there is one, is a dashed rule — so "over budget" is something you see rather
 * than something you compute.
 *
 * The vertical scale is the window's own maximum, never a fixed one. A plot
 * pinned to the budget looks identical whether the frame time is 2 ms or 6 ms,
 * which is exactly the range where the interesting changes happen.
 */

/*
 * The plot's three colours, as literals because they are SVG paint attributes
 * chosen per sample rather than classes — but named, so they are findable when
 * the palette moves, and annotated with the step each one is, which is the form
 * `index.css` writes every colour in.
 *
 * `budget` was `#f87171` (red-400), a second red for an idea that already had
 * one. Fault in this system is rose, so the budget rule is rose too.
 */
const CHART = {
  nominal: '#38bdf8', // sky-400
  caution: '#fbbf24', // amber-400
  budget: '#fb7185', // rose-400
} as const

export function SeriesPlot({
  series,
  unit,
  budget,
  warnAbove,
}: {
  series: Series
  unit: string
  /** Drawn as a dashed rule. Where the design says this number should sit. */
  budget?: number
  /** Colours the plot when p95 exceeds it. Defaults to `budget`; see `DROPPED_FRAME_MS`. */
  warnAbove?: number
}) {
  // The series reference is stable and its contents are not, which is the same
  // trap `PerfPanel` describes. The `useMemo` below is the other kind — a stable
  // object, not a memoised computation — and stays.
  'use no memo'

  // Allocated once per mount and written into every read. The panel re-renders
  // eight times a second and the buffer is 240 doubles; making a new one each
  // time is the kind of garbage a performance overlay should be embarrassed by.
  const buffer = useMemo(() => new Float64Array(series.capacity), [series])
  const written = series.drain(buffer)
  const stats = series.summarise()

  const width = 100
  const height = 26
  // An empty ground rather than an empty gap: a series with no samples yet — a
  // paused clock, a metric this browser does not expose — left a 26px hole that
  // read as a layout bug rather than as a plot waiting for data.
  if (written === 0)
    return <div className="my-0.5 h-[26px] rounded-sm bg-slate-900/70" />

  // Headroom above the peak so the tallest sample is not flush with the border,
  // and never a zero-height range — a flat series would divide by zero.
  const ceiling = Math.max(
    stats.max * 1.15,
    budget === undefined ? 0 : budget * 1.1,
    1e-9,
  )
  const step = written > 1 ? width / (written - 1) : width
  let path = `M 0 ${height}`
  for (let i = 0; i < written; i += 1) {
    const value = buffer[i] ?? 0
    path += ` L ${(i * step).toFixed(2)} ${(height - (value / ceiling) * height).toFixed(2)}`
  }
  path += ` L ${width} ${height} Z`

  const threshold = warnAbove ?? budget
  const over = threshold !== undefined && stats.p95 > threshold
  const stroke = over ? CHART.caution : CHART.nominal

  return (
    <div className="relative my-0.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-[26px] w-full rounded-sm bg-slate-900/70"
        role="img"
        aria-label={`${stats.last.toFixed(2)} ${unit}, ${written} samples`}
      >
        <path
          d={path}
          fill={stroke}
          fillOpacity={0.22}
          stroke={stroke}
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
        {budget !== undefined && budget < ceiling && (
          <line
            x1={0}
            x2={width}
            y1={height - (budget / ceiling) * height}
            y2={height - (budget / ceiling) * height}
            stroke={CHART.budget}
            strokeWidth={0.5}
            strokeDasharray="2 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {/* ImGui writes the current value over the plot rather than beside it; it
          costs no height and the eye is already there. */}
      <span className="pointer-events-none absolute top-0 right-1 text-[10px] text-slate-400 tabular-nums">
        {format(stats.last)}
        {unit}
      </span>
    </div>
  )
}
