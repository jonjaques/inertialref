import { orbitalPeriod } from '@inertialref/physics'
import { CLOUD_ADVECTION_PERIOD } from '@inertialref/rendering'
import type { Radians, Seconds } from '@inertialref/shared'
import {
  type FrameId,
  Quaternion as Q,
  UV,
  type Vec3,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  bodyFixedFrameId,
  compassBasis,
  directionToGeodetic,
  findBody,
  formatAddress,
  parseAddress,
  placementMu,
  stationFrameId,
} from '@inertialref/universe'
import { synodicDay } from './dossier.ts'
import { sunDirection } from './maneuvers.ts'
import { stationAt } from './travel.ts'

/*
 * Where the sun stands over a place, and when it stands somewhere asked for.
 *
 * A picture is a held instant, and the pictures the weather is judged on
 * each need a sun: E1's afternoon cumulus at 50° and falling, G3's deck
 * underlit at 1.5° under the horizon. There is no local solar time to read
 * those off, because a body's spin is uniform from J2000 (`frames.ts`) and
 * the sun's place over a stance is that spin against the orbit. So the
 * instant is solved: the sun as a function of time, sampled through the
 * solar day for a crossing, and bisected.
 *
 * A place can move. The overlay guard stands where a station is, and the
 * station's sub-point crosses the sunlit side every orbit, so its sun is a
 * function of time twice over: the place is sampled at each instant beside
 * the sun, and the search steps through the station's orbit rather than the
 * body's day, because the sun over the sub-point goes round once an orbit.
 *
 * The world half resolves an address and evaluates the frame graph at each
 * instant it tries. That clears the graph's cache (`spatial/frame.ts`), which
 * costs time and nothing else, so a solve runs outside a frame — a capture
 * script, a ledger test, a console. The solve itself takes the sun as a
 * function and knows no world, which is what lets a property hold it against
 * a synthetic body in Node.
 */

/** A place on a body: geodetic, radians, east-positive (`geodeticDirection`). */
export interface Geodetic {
  readonly latitude: Radians
  readonly longitude: Radians
}

/** A place, or a place as a function of time: a station's sub-point. */
export type PlaceAt = Geodetic | ((time: Seconds) => Geodetic)

const placeAt = (place: PlaceAt, time: Seconds): Geodetic =>
  typeof place === 'function' ? place(time) : place

export interface SunAt {
  /** Degrees over the sphere's horizon at the place. */
  readonly elevation: number
  /** Degrees east of north, in [0, 360): a stance's heading toward the sun. */
  readonly azimuth: number
}

export interface SunTarget {
  /** Degrees. `'noon'` is the day's highest sun, whatever the trend says. */
  readonly elevation: number | 'noon'
  readonly trend: 'rising' | 'falling'
  /** The first instant at or after this, seconds from J2000. */
  readonly after: Seconds
}

/** The samples a solar day is searched at: fifteen minutes on Earth. */
export const SUN_SAMPLES_A_DAY = 96
/** How far ahead a solve looks before it answers that the sun never gets there. */
export const SUN_SEARCH_DAYS = 400
/** What a crossing is bisected to, seconds. */
export const SUN_TIME_TOLERANCE = 1e-3

const DEGREES = 180 / Math.PI

/** The sun's elevation and azimuth at a place, from a body-fixed unit sun. */
export function sunOver(sun: Vec3, place: Geodetic): SunAt {
  const { up, east, north } = compassBasis(place.latitude, place.longitude, 0)
  const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
  // Clamped, because a unit dot product can land a rounding past ±1 and the
  // arcsine of that is NaN rather than ±90.
  const elevation = Math.asin(Math.max(-1, Math.min(1, dot(sun, up)))) * DEGREES
  const azimuth = Math.atan2(dot(sun, east), dot(sun, north)) * DEGREES
  return { elevation, azimuth: azimuth < 0 ? azimuth + 360 : azimuth }
}

/**
 * The first instant at or after `target.after` the sun stands at the
 * target, as a function of time alone: `sun(t)` is the body-fixed unit sun,
 * `place` a place or a place that moves, and `day` the period the sun goes
 * round that place in, which the search steps through: the solar day for a
 * place on the ground, the orbit for a station's sub-point.
 *
 * Sampled `SUN_SAMPLES_A_DAY` times a day. Each interior extremum is found
 * by a golden section between the samples either side of it, so the search
 * walks pieces on which the elevation is monotonic, and a crossing that rises
 * and falls back between two samples — a target a few minutes of arc under
 * the day's highest sun — is not passed over. A monotonic piece with the
 * wanted trend that brackets the target is bisected to
 * `SUN_TIME_TOLERANCE`. Noon is the first interior maximum. Null where the
 * sun never reaches the elevation in `SUN_SEARCH_DAYS` solar days.
 */
export function solveSunTime(
  sun: (time: Seconds) => Vec3,
  place: PlaceAt,
  target: SunTarget,
  day: Seconds,
): Seconds | null {
  if (!(day > 0) || !Number.isFinite(day))
    throw new Error(`A solar day of ${day} s has no sunrise to search`)
  const elevation = (time: Seconds): number =>
    sunOver(sun(time), placeAt(place, time)).elevation
  const step = day / SUN_SAMPLES_A_DAY
  const count = SUN_SAMPLES_A_DAY * SUN_SEARCH_DAYS
  const start = target.after
  const at = (k: number): Seconds => start + k * step

  /** A monotonic piece [a, b] with its ends' elevations: the answer in it, or null. */
  const piece = (a: Seconds, ea: number, b: Seconds, eb: number) => {
    if (target.elevation === 'noon') return null
    const wanted = target.elevation
    const rising = eb > ea
    if (rising !== (target.trend === 'rising')) return null
    if (
      rising ? !(ea <= wanted && wanted <= eb) : !(eb <= wanted && wanted <= ea)
    )
      return null
    if (ea === wanted) return a
    let low = a
    let high = b
    while (high - low > SUN_TIME_TOLERANCE) {
      const middle = (low + high) / 2
      const em = elevation(middle)
      if (rising ? em < wanted : em > wanted) low = middle
      else high = middle
    }
    return high
  }

  /** The extremum between a and b, by golden section; `max` for a maximum. */
  const extremum = (a: Seconds, b: Seconds, max: boolean): Seconds => {
    const sign = max ? -1 : 1
    const ratio = (Math.sqrt(5) - 1) / 2
    let low = a
    let high = b
    let x1 = high - ratio * (high - low)
    let x2 = low + ratio * (high - low)
    let f1 = sign * elevation(x1)
    let f2 = sign * elevation(x2)
    while (high - low > SUN_TIME_TOLERANCE) {
      if (f1 < f2) {
        high = x2
        x2 = x1
        f2 = f1
        x1 = high - ratio * (high - low)
        f1 = sign * elevation(x1)
      } else {
        low = x1
        x1 = x2
        f1 = f2
        x2 = low + ratio * (high - low)
        f2 = sign * elevation(x2)
      }
    }
    return (low + high) / 2
  }

  // The piece now being walked begins at `from`; samples k − 1, k and k + 1
  // decide whether an extremum ends it. The walk starts a sample before
  // `after`, because an extremum between `after` and the first sample past
  // it is otherwise seen by no triple, and the piece it splits is bisected
  // as if it were monotonic. One found before `after` splits nothing.
  let from = start
  let eFrom = elevation(start)
  let previous = elevation(at(-1))
  let current = eFrom
  for (let k = 0; k < count; k += 1) {
    const next = elevation(at(k + 1))
    const before = current - previous
    const after = next - current
    if ((before > 0 && after <= 0) || (before < 0 && after >= 0)) {
      const max = before > 0
      const turn = extremum(at(k - 1), at(k + 1), max)
      if (turn > start) {
        if (max && target.elevation === 'noon') return turn
        const eTurn = elevation(turn)
        const found = piece(from, eFrom, turn, eTurn)
        if (found !== null) return found
        from = turn
        eFrom = eTurn
      }
    }
    previous = current
    current = next
  }
  return piece(from, eFrom, at(count), current)
}

/**
 * A body by its address: the sun over it as a function of time, and the
 * solar day that sun turns through. The frame id is formed once, because
 * `bodyFixedFrameId` caches by the address object and a parse per instant
 * would grow that cache by one entry a sample.
 */
function bodySun(
  world: World,
  address: string,
): { readonly sun: (time: Seconds) => Vec3; readonly day: Seconds } {
  const parsed = parseAddress(
    address.startsWith('g:') ? address : `g:milky-way/${address}`,
  )
  if (parsed.kind !== 'body')
    throw new Error(`${address} is not a body; the sun stands over a body`)
  const system = world.loadSystem(parsed.system)
  const body = findBody(system, parsed.body)
  if (body === undefined) throw new Error(`No body at ${address}`)
  // A moon's day is against its planet's year: the moon goes round the star
  // with it, and Luna's own orbit would give it an infinite day.
  const primary =
    parsed.body.length > 1 ? findBody(system, parsed.body.slice(0, 1)) : null
  const day = synodicDay(body.rotationPeriod, (primary ?? body).orbitalPeriod)
  if (day === null)
    throw new Error(`${body.name} keeps one face to its star: no sun moves`)
  const frame = bodyFixedFrameId(parsed)
  return {
    sun: (time) => sunDirection(world, parsed.system, frame, time),
    day,
  }
}

/** The sun over a place on a body at an instant. */
export function sunAt(
  world: World,
  address: string,
  place: Geodetic,
  time: Seconds,
): SunAt {
  return sunOver(bodySun(world, address).sun(time), place)
}

/**
 * The first instant at or after `target.after` the sun stands where the
 * target asks over a place on a body, with the sun there; null where it
 * never does in `SUN_SEARCH_DAYS` solar days.
 */
export function solveSun(
  world: World,
  address: string,
  place: Geodetic,
  target: SunTarget,
): ({ readonly time: Seconds } & SunAt) | null {
  const { sun, day } = bodySun(world, address)
  const time = solveSunTime(sun, place, target, day)
  if (time === null) return null
  return { time, ...sunOver(sun(time), place) }
}

/**
 * A station's sub-point as a function of time, on the body it goes round,
 * with that body's address and sun and the station's orbital period.
 *
 * The sub-point is the station's position in the body's turning axes, read
 * as a geodetic direction: the point on the ground straight under it, which
 * is where the sun a picture of it is solved for stands.
 */
export function stationSubPoint(
  world: World,
  address: string,
): {
  readonly body: string
  /** The station's frame and the body's turning one. */
  readonly frame: FrameId
  readonly bodyFrame: FrameId
  readonly place: (time: Seconds) => Geodetic
  readonly sun: (time: Seconds) => Vec3
  readonly period: Seconds
} {
  const parsed = parseAddress(
    address.startsWith('g:') ? address : `g:milky-way/${address}`,
  )
  if (parsed.kind !== 'satellite')
    throw new Error(`${address} is not a station`)
  const system = world.loadSystem(parsed.system)
  const station = stationAt(system, parsed)
  if (station === undefined) throw new Error(`No station at ${address}`)
  if (station.parent.kind !== 'body')
    throw new Error(`${station.name} goes round a star, not a body`)
  const bodyFrame = bodyFixedFrameId(station.parent)
  const frame = stationFrameId(station.id)
  return {
    body: formatAddress(station.parent),
    frame,
    bodyFrame,
    place: (time) => {
      const body = world.frames.pose(bodyFrame, time)
      const at = world.frames.pose(frame, time).position
      return directionToGeodetic(
        Q.rotateInverse(body.orientation, UV.difference(at, body.position)),
      )
    },
    sun: (time) => sunDirection(world, parsed.system, bodyFrame, time),
    period: orbitalPeriod(
      placementMu(system, station),
      station.orbit.elements.semiMajorAxis,
    ),
  }
}

/**
 * The first instant at or after `target.after` the sun at a station's
 * sub-point stands where the target asks, with the sub-point and its sun;
 * null where it never does in `SUN_SEARCH_DAYS` orbits.
 */
export function solveStationSun(
  world: World,
  address: string,
  target: SunTarget,
): ({ readonly time: Seconds; readonly place: Geodetic } & SunAt) | null {
  const { place, sun, period } = stationSubPoint(world, address)
  const time = solveSunTime(sun, place, target, period)
  if (time === null) return null
  const where = place(time)
  return { time, place: where, ...sunOver(sun(time), where) }
}

/** The held instant's controls the clock's verb drives: the observatory's. */
export interface RunnableClock {
  setTime(time: number | null): void
  setTimeScale(scale: number): void
  setTimePaused(paused: boolean): void
}

/**
 * Run a picture's held instant from `start` at `warp` simulated seconds a
 * presented second: the body of the harness's `ir.runClock`.
 *
 * Held and released through the observatory's own clock, which the frame
 * loop advances by presented seconds, so the field moves as it does when a
 * player runs the clock: a path that set the instant itself each frame would
 * be a scrub a frame, which resets the history it exists to watch. The
 * instant each frame is read back into the cast's log instead.
 */
export function runClock(
  clock: RunnableClock,
  start: Seconds,
  warp: number,
): { readonly start: Seconds; readonly warp: number } {
  clock.setTime(start)
  clock.setTimeScale(warp)
  clock.setTimePaused(false)
  return { start, warp }
}

/**
 * The instant a clock cast starts at, so the drift's reduction falls in its
 * middle at the nominal 60 Hz: the first multiple of `CLOUD_ADVECTION_PERIOD`
 * at or after `time`, less half the cast's simulated seconds.
 *
 * A reduction is where the field's drift starts over (`weatherClock.ts`), so
 * a cast that never crosses one cannot show the jump C7 looks for. At
 * another rate the cast spans other seconds; the cast's log holds the
 * instant each frame, and the capture checks the reduction fell inside it.
 */
export function clockStart(
  time: Seconds,
  warp: number,
  frames: number,
  rate = 60,
): { readonly start: Seconds; readonly reduction: Seconds } {
  const reduction =
    Math.ceil(time / CLOUD_ADVECTION_PERIOD) * CLOUD_ADVECTION_PERIOD
  return { start: reduction - (frames / 2 / rate) * warp, reduction }
}
