import type { SeriesStats } from '@inertialref/devtools'
import { format } from './perfFormat.ts'
import { Row } from './Row.tsx'

/** min · mean · max for one series, on the panel's own row. */
export function SeriesStatsRow({
  stats,
  unit,
}: {
  stats: SeriesStats
  unit: string
}) {
  const suffix = unit === '' ? '' : ` ${unit}`
  return (
    <Row
      label="Min · Mean · Max"
      value={`${format(stats.min)} · ${format(stats.mean)} · ${format(stats.max)}${suffix}`}
    />
  )
}
