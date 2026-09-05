import { formatDuration, formatReading } from '@inertialref/shared'
import type { EntityInspection } from '@inertialref/devtools'

/*
 * The navigation cluster's readings, as arithmetic and strings.
 *
 * Its own module for the reason `controls.ts` gives: a `.tsx` file that
 * exports anything besides components is a file Fast Refresh gives up on, and
 * here a full reload rebuilds the renderer. It also makes the readings a test
 * can hold — which speed the cluster shows when, where a needle sits for a
 * rate of climb, what a lap of an orbit prints — without a DOM.
 */

/** Which speed the cluster reads out: against the ground, or in the frame. */
export type SpeedMode = 'auto' | 'surface' | 'orbit'

/** The modes a press on the readout cycles through, in order. */
export const SPEED_MODES: readonly SpeedMode[] = ['auto', 'surface', 'orbit']

export const nextSpeedMode = (mode: SpeedMode): SpeedMode =>
  SPEED_MODES[(SPEED_MODES.indexOf(mode) + 1) % SPEED_MODES.length] ?? 'auto'

/**
 * What `auto` settles on: the ground speed while there is ground to be near,
 * the orbital speed once there is only an orbit.
 *
 * Ten kilometers rather than the atmosphere's ceiling, because the question
 * is what a pilot is flying against. Low enough to land, the ground is the
 * reference and the orbital figure is a number about a planet's rotation;
 * high enough to orbit, the reverse. Ten kilometers is inside the band on
 * every body that has air and well under any orbit that survives a lap.
 */
export const SURFACE_BELOW_METRES = 10_000

export interface SpeedReading {
  /** Which figure is showing, resolved from `auto`. */
  readonly mode: 'surface' | 'orbit'
  /** Meters per second, or null when the mode has nothing to measure. */
  readonly value: number | null
}

export function speedReading(
  player: EntityInspection,
  mode: SpeedMode,
): SpeedReading {
  const surface =
    player.surfaceSpeed !== null &&
    (player.landed ||
      (player.altitude !== null && player.altitude < SURFACE_BELOW_METRES))
  const resolved = mode === 'auto' ? (surface ? 'surface' : 'orbit') : mode
  if (resolved === 'surface')
    return { mode: 'surface', value: player.surfaceSpeed }
  return { mode: 'orbit', value: player.localSpeed }
}

/**
 * A speed, written for a readout.
 *
 * Meters per second to a tenth up to a kilometer a second, kilometers per
 * second to a hundredth after that: the unit changes where the next digit
 * would stop meaning anything on the way to a system crossing.
 */
export function formatSpeed(mps: number | null): string {
  if (mps === null || !Number.isFinite(mps)) return '—'
  const a = Math.abs(mps)
  if (a >= 1e3) return `${(mps / 1e3).toFixed(2)} km/s`
  return `${mps.toFixed(1)} m/s`
}

/** A rate of climb, signed, so a descent reads as one at a glance. */
export function formatClimb(mps: number | null): string {
  if (mps === null || !Number.isFinite(mps)) return '—'
  const sign = mps > 0 ? '+' : mps < 0 ? '−' : ''
  return `${sign}${formatSpeed(Math.abs(mps))}`
}

/** The fastest climb the gauge can show, m/s; past it the needle is pinned. */
export const CLIMB_FULL_SCALE = 1_000

/**
 * Where a rate of climb sits on the gauge, −1..1.
 *
 * Symmetric and logarithmic, so the needle moves as much for the first meter
 * a second as for the last hundred: a descent onto a pad is read in single
 * meters a second and a re-entry in hundreds, and a linear scale spends all
 * of its travel on the second. `log(1 + v)` keeps zero at the centre without
 * a singularity beside it.
 */
export function climbGauge(mps: number | null): number {
  if (mps === null || !Number.isFinite(mps)) return 0
  const scaled =
    Math.log(1 + Math.min(Math.abs(mps), CLIMB_FULL_SCALE)) /
    Math.log(1 + CLIMB_FULL_SCALE)
  return Math.sign(mps) * scaled
}

/** Whole degrees on the compass, zero-padded to three, for a heading. */
export function formatHeading(radians: number): string {
  if (!Number.isFinite(radians)) return '—'
  const degrees = ((Math.round((radians * 180) / Math.PI) % 360) + 360) % 360
  return `${String(degrees).padStart(3, '0')}°`
}

/** Signed whole degrees, for a pitch or a bank. */
export function formatDegrees(radians: number): string {
  if (!Number.isFinite(radians)) return '—'
  const degrees = Math.round((radians * 180) / Math.PI)
  return `${degrees > 0 ? '+' : degrees < 0 ? '−' : ''}${Math.abs(degrees)}°`
}

/** A throttle as a whole percentage. */
export const formatThrottle = (fraction: number): string =>
  `${Math.round(fraction * 100)}%`

/**
 * The orbit line: the highest and lowest altitudes and the lap, or what
 * stands in for each when there is no lap to speak of.
 *
 * A periapsis below the ground is printed as it is rather than clamped —
 * "−212 km" is a ground track, which is the one thing a pilot on a descent
 * wants to read — and an unbound orbit says so in words, because an infinite
 * apoapsis is not a number and "∞" reads as a fault.
 */
export function orbitLine(orbit: EntityInspection['orbit']): {
  readonly apoapsis: string
  readonly periapsis: string
  readonly period: string
} {
  if (orbit === null) return { apoapsis: '—', periapsis: '—', period: '—' }
  return {
    apoapsis:
      orbit.apoapsis === null ? 'escape' : formatReading(orbit.apoapsis),
    periapsis: formatReading(orbit.periapsis),
    period: orbit.period === null ? '—' : formatDuration(orbit.period),
  }
}

/** An arc on a gauge, radians clockwise from twelve o'clock. */
export interface Arc {
  readonly from: number
  readonly to: number
}

const rad = (degrees: number): number => (degrees * Math.PI) / 180

/**
 * The throttle's track: the left side of the ball, from seven o'clock at
 * the bottom up over nine to eleven at the top, so the drive fills upward.
 */
export const THROTTLE_ARC: Arc = Object.freeze({ from: rad(210), to: rad(330) })

/**
 * The climb gauge's track: the right side, mirrored, with its zero at three
 * o'clock so a climb rises from the middle and a descent falls from it.
 */
export const CLIMB_ARC: Arc = Object.freeze({ from: rad(30), to: rad(150) })

export const throttleArc = (fraction: number): Arc => ({
  from: THROTTLE_ARC.from,
  to:
    THROTTLE_ARC.from +
    (THROTTLE_ARC.to - THROTTLE_ARC.from) * Math.max(0, Math.min(1, fraction)),
})

/** The filled part of the climb gauge for a needle position, −1..1. */
export const climbArc = (gauge: number): Arc => {
  const middle = (CLIMB_ARC.from + CLIMB_ARC.to) / 2
  const half = (CLIMB_ARC.to - CLIMB_ARC.from) / 2
  // Up the track is toward twelve o'clock, which on the right side is the
  // smaller angle: a climb runs the fill backwards.
  return { from: middle, to: middle - half * Math.max(-1, Math.min(1, gauge)) }
}

/**
 * An SVG arc from one angle to another about a centre, angles in radians
 * measured clockwise from twelve o'clock, which is how a gauge is read.
 *
 * Both angles are on the same circle, so an arc that spans more than a half
 * turn needs the large-arc flag and one that spans less does not; an empty
 * span returns an empty path rather than a degenerate one, because a
 * zero-length arc with a round cap still draws a dot.
 */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  from: number,
  to: number,
): string {
  if (!(Math.abs(to - from) > 1e-6)) return ''
  const point = (angle: number): readonly [number, number] => [
    cx + r * Math.sin(angle),
    cy - r * Math.cos(angle),
  ]
  const [x0, y0] = point(from)
  const [x1, y1] = point(to)
  const large = Math.abs(to - from) > Math.PI ? 1 : 0
  const sweep = to > from ? 1 : 0
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`
}
