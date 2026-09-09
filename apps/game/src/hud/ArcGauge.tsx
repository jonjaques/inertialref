import { type Arc, arcPath } from './navCluster.ts'

/**
 * A ring gauge: a track, and the filled part of it.
 *
 * Drawn as two strokes on one circle rather than as a progress element,
 * because the two gauges on the cluster do not share a zero — the throttle
 * fills from one end of its track and the climb from the middle of its — and
 * the caller states both arcs in the gauge's own angles. The square is sized
 * to sit over the navball, so the tracks hug its rim; pointer events pass
 * through it because it is a picture.
 *
 * The fill takes the accent and the track the graphite, so it reads as one
 * of the cluster's readouts rather than as a control: nothing on it can be
 * dragged, and the keys that move the value are named on the buttons beside
 * it.
 */
export function ArcGauge({
  track,
  fill,
  size,
  stroke = 5,
  className = '',
}: {
  track: Arc
  fill: Arc
  /** The square's side in CSS pixels; the ring runs a stroke inside it. */
  size: number
  stroke?: number
  className?: string
}) {
  const centre = size / 2
  const radius = centre - stroke
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={`pointer-events-none ${className}`}
      aria-hidden
    >
      <path
        d={arcPath(centre, centre, radius, track.from, track.to)}
        className="stroke-slate-700/80"
        strokeWidth={stroke}
        fill="none"
      />
      <path
        d={arcPath(centre, centre, radius, fill.from, fill.to)}
        className="stroke-sky-400"
        strokeWidth={stroke}
        fill="none"
      />
    </svg>
  )
}
