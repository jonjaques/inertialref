import type { Vec3 } from '@inertialref/spatial'
import { reduceTurns } from './weatherClock.ts'
import type { BodyWeather } from './weatherClimate.ts'

/*
 * The CPU field every medium is held to: a weather evaluated at a body-fixed
 * point and an instant, in float64. The fine march's medium, the far bake's
 * and a second body's are GPU ports of it, and each reference that needs a
 * cloud's density reads it here, so none needs a readback.
 *
 * **The field is a clear sky.** `cloudFieldAt` finds a point's level and
 * answers with no cloud in it, and `columnDepth` with no depth. The clock is
 * whole: a level's turn and the axial drift are reduced here as every reader
 * needs them.
 */

/** What the field needs of time for one body: nothing unreduced. */
export interface FieldClock {
  /** Each level's turn about the spin axis, radians in [0, 2π), reduced in float64. */
  readonly turn: readonly [number, number, number]
  /** The drift along the axis, meters, unreduced: every consumer reduces it by its own period. */
  readonly drift: number
  /** Seconds from J2000, for a regime's pattern period alone. */
  readonly time: number
}

const TURN = 2 * Math.PI

/**
 * `rate·time` as an angle in [0, 2π). The turns are reduced before they are
 * scaled, so ten years of a slow turn keep the float64 of one revolution; a
 * westward rate turns the other way round the same circle.
 */
function turned(rate: number, time: number): number {
  if (rate === 0 || !Number.isFinite(rate)) return 0
  const turns = reduceTurns(time, TURN / Math.abs(rate))
  const angle = TURN * (rate > 0 || turns === 0 ? turns : 1 - turns)
  return angle < TURN ? angle : 0
}

/** A weather's clock at an instant, seconds from J2000. */
export function fieldClock(weather: BodyWeather, time: number): FieldClock {
  return {
    turn: [
      turned(weather.turn[0], time),
      turned(weather.turn[1], time),
      turned(weather.turn[2], time),
    ],
    drift: weather.drift * time,
    time,
  }
}

export interface FieldSample {
  /** The cloudy share of the column the sample stands for; 1 when resolved. */
  readonly fraction: number
  /** Scaled in-cloud extinction σ′, 1/m. */
  readonly sigma: number
  /** Effective radius, µm. */
  readonly radius: number
  /** −1 outside every level. */
  readonly level: number
}

/** µm outside every level, as the analytic media have it. */
const NO_RADIUS = 10

/** The level a height over the datum is in, or −1: base ≤ h < top, the first that holds it. */
export function fieldLevel(weather: BodyWeather, height: number): number {
  return weather.levels.findIndex(
    ({ base, top }) => height >= base && height < top,
  )
}

/**
 * The field at a body-fixed point, meters from the center, for a sample
 * that stands for `footprint` meters.
 */
export function cloudFieldAt(
  weather: BodyWeather,
  _clock: FieldClock,
  _sun: Vec3,
  position: Vec3,
  _footprint: number,
): FieldSample {
  const height =
    Math.hypot(position.x, position.y, position.z) - weather.datumRadius
  return {
    fraction: 0,
    sigma: 0,
    radius: NO_RADIUS,
    level: fieldLevel(weather, height),
  }
}

/** A level's unscaled vertical optical depth at 550 nm in a direction: what ISCCP retrieves. */
export function columnDepth(
  _weather: BodyWeather,
  _clock: FieldClock,
  _sun: Vec3,
  _direction: Vec3,
  _level: number,
): number {
  return 0
}
