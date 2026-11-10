import type { Vec3 } from '@inertialref/spatial'
import {
  type BodyWeather,
  type ClimateSample,
  turnAngle,
  unturn,
} from './weatherClimate.ts'
import { reducePoint, reduceSeconds } from './weatherClock.ts'
import {
  type LevelProfile,
  levelProfile,
  readLevelProfile,
} from './weatherGenus.ts'
import {
  BASE_NOISE_PERIOD,
  baseNoiseTexture,
  DETAIL_NOISE_PERIOD,
  detailNoiseTexture,
} from './weatherNoise.ts'

/*
 * The CPU field every medium is held to: a weather evaluated at a body-fixed
 * point and an instant, in float64. The fine march's medium, the far bake's
 * and a second body's are GPU ports of it, and each reference that needs a
 * cloud's density reads it here, so none needs a readback.
 *
 * It reads what the GPU reads: the noise's textures as the bake writes them
 * (`baseNoiseTexture`, `detailNoiseTexture`) and the level's profile table
 * (`levelProfile`), each a byte a texel, filtered as a sampler filters. What
 * is left to differ is float32 against float64 and the sampler's weights.
 *
 * Nothing here is the observer's. Each level's lattice turns rigidly about
 * the spin axis and drifts along it (phase 1 design §5.3): a body-fixed
 * point p is read at `p′ = R_y(−ω_k·t)·p + ŷ·w·t`, with the angle reduced by
 * a turn and the drift by the noise's period in float64, so the field at a
 * place and an instant is the same from every eye and every date.
 */

/** What the field needs of time for one body: nothing unreduced but the drift. */
export interface FieldClock {
  /** Each level's turn about the spin axis, radians in [0, 2π), reduced in float64. */
  readonly turn: readonly [number, number, number]
  /** The drift along the axis, meters, unreduced: every consumer reduces it by its own period. */
  readonly drift: number
  /** Seconds from J2000: what the climate's synoptic field turns by. */
  readonly time: number
}

/** A weather's clock at an instant, seconds from J2000. */
export function fieldClock(weather: BodyWeather, time: number): FieldClock {
  return {
    turn: [
      turnAngle(weather.turn[0], time),
      turnAngle(weather.turn[1], time),
      turnAngle(weather.turn[2], time),
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
/** The least a remap divides by: a level with no cover draws nothing rather than 0/0. */
const TINY = 1e-6

/** The level a height over the datum is in, or −1: base ≤ h < top, the first that holds it. */
export function fieldLevel(weather: BodyWeather, height: number): number {
  return weather.levels.findIndex(
    ({ base, top }) => height >= base && height < top,
  )
}

/**
 * Level k's lattice point for a body-fixed point, meters, unreduced:
 * `R_y(−θ_k)·p + ŷ·D`. A feature of the lattice stands where the turn has
 * carried it, east of where it stood by `θ_k` about the axis.
 */
export function levelLattice(
  clock: FieldClock,
  level: number,
  position: Vec3,
): Vec3 {
  const turned = unturn(position, clock.turn[level] ?? 0)
  return { x: turned.x, y: turned.y + clock.drift, z: turned.z }
}

/**
 * Level k's turn as the row-major matrix `M_k = R_y(−θ_k)`: what the GPU
 * multiplies an eye-relative offset by, in float32.
 */
export function levelTurnMatrix(
  clock: FieldClock,
  level: number,
): readonly number[] {
  const angle = clock.turn[level] ?? 0
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [c, 0, -s, 0, 1, 0, s, 0, c]
}

/**
 * A body point's place in level k's noise frame, `R_y(−θ_k)·p + ŷ·D`,
 * reduced into [0, period) on each axis in float64. For an eye it is the
 * level's origin: the GPU's lattice point is this plus `M_k·(p − eye)`,
 * which is `M_k·p + ŷ·D` for any eye, modulo the period, so the eye enters
 * as the point the float32 offset is measured from and nowhere else.
 *
 * The drift is reduced by the period before it is added. Unreduced it is a
 * quarter of a meter a second since J2000, 8 × 10¹¹ m at the far end of
 * `periodIndex`'s range, where a float64 resolves a tenth of a millimeter.
 * This is the arithmetic of the frame's `latticeOrigin` (`weatherClock.ts`,
 * package H) step for step, so the field and the frame place every level's
 * noise alike.
 */
export function levelOrigin(
  clock: FieldClock,
  level: number,
  point: Vec3,
  period: number,
): Vec3 {
  const turned = unturn(point, clock.turn[level] ?? 0)
  return reducePoint(
    {
      x: turned.x,
      y: turned.y + reduceSeconds(clock.drift, period),
      z: turned.z,
    },
    period,
  )
}

/** The base noise's cells at a body point: its place in the level's frame over eight cells, over the cell. */
function baseCells(
  clock: FieldClock,
  level: number,
  point: Vec3,
  cell: number,
): Vec3 {
  const at = levelOrigin(clock, level, point, BASE_NOISE_PERIOD * cell)
  return { x: at.x / cell, y: at.y / cell, z: at.z / cell }
}

/** The detail's cells at a body point: four a base cell, tiling once a base cell. */
function detailCells(
  clock: FieldClock,
  level: number,
  point: Vec3,
  cell: number,
): Vec3 {
  const at = levelOrigin(clock, level, point, cell)
  const scale = DETAIL_NOISE_PERIOD / cell
  return { x: at.x * scale, y: at.y * scale, z: at.z * scale }
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp01((x - edge0) / (edge1 - edge0))
  return t * t * (3 - 2 * t)
}

/**
 * The recipe at one point of a level (§5.6, as phase 0 built it):
 *
 *     d     = saturate(remap(n_b·R, 1 − c, 1, 0, 1)),  d = saturate(remap(d, n_d, 1, 0, 1))
 *     f     = smoothstep(cell/4, cell, footprint)       the unresolved share of a cell
 *     fraction = mix(1, c, f),   fraction·σ′ = σ′_level·mix(d, c·Ḡ, f)
 *
 * with `R` the profile's extinction share at the height and convective
 * share, `Ḡ` its mean over the level, and
 * `n_d = detail·erosion·(1 − smoothstep(cell/16, cell/4, footprint))`, whose
 * read is skipped where that fade is 0. The two pictures of a cell are
 * blended by their mean extinction, so a cell with no cover holds none at
 * any footprint.
 */
function levelSample(
  profile: LevelProfile,
  level: number,
  cover: number,
  convective: number,
  h01: number,
  clock: FieldClock,
  point: Vec3,
  footprint: number,
): FieldSample {
  const [shape, mean, , radius] = readLevelProfile(profile, h01, convective)
  const c = clamp01(cover)
  const { cell } = profile
  const base = baseNoiseTexture(baseCells(clock, level, point, cell))
  const reach = 1 - smoothstep(cell / 16, cell / 4, footprint)
  const erosion =
    reach > 0
      ? detailNoiseTexture(detailCells(clock, level, point, cell)) *
        profile.erosion *
        reach
      : 0
  const shaped = clamp01((base * shape - (1 - c)) / Math.max(c, TINY))
  const eroded = clamp01((shaped - erosion) / Math.max(1 - erosion, TINY))
  const unresolved = smoothstep(cell / 4, cell, footprint)
  const fraction = 1 + (c - 1) * unresolved
  const extinction =
    profile.scaled * (eroded + (c * mean - eroded) * unresolved)
  return {
    fraction,
    sigma: extinction / Math.max(fraction, TINY),
    radius: radius * profile.radius,
    level,
  }
}

const CLEAR = (level: number): FieldSample => ({
  fraction: 0,
  sigma: 0,
  radius: NO_RADIUS,
  level,
})

const unit = (p: Vec3, length: number): Vec3 => ({
  x: p.x / length,
  y: p.y / length,
  z: p.z / length,
})

/**
 * The field at a body-fixed point, meters from the center, under a
 * body-fixed unit sun, for a sample that stands for `footprint` meters.
 * `sigma` is scaled, `σ′`; the extinction a transmittance through the
 * sample is formed from is `fraction·sigma`.
 *
 * Measured on a Mac mini (Mac18,5, Apple M6, Node 26), over 40,000 places
 * in a 20 km square of a low level: 0.5–0.6 µs a call where the noise's
 * texels near it are known, 7–11 µs where the call is the first to need
 * them (3.4 µs a texel), and 0.3–0.4 µs unresolved, where the detail is
 * not read. A column (`columnDepth`) is 145–165 µs.
 */
export function cloudFieldAt(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  position: Vec3,
  footprint: number,
): FieldSample {
  const length = Math.hypot(position.x, position.y, position.z)
  const height = length - weather.datumRadius
  const level = fieldLevel(weather, height)
  if (level < 0 || !(length > 0)) return CLEAR(level)
  const spec = weather.levels[level]!
  const climate = weather.climate.sample(
    unit(position, length),
    sun,
    clock.time,
  )
  return levelSample(
    levelProfile(spec),
    level,
    climate.cover[level]!,
    climate.convective[level]!,
    (height - spec.base) / Math.max(spec.top - spec.base, 1),
    clock,
    position,
    footprint,
  )
}

/**
 * Midpoint steps a column is integrated with. Against 512 it is within a
 * twentieth of one step's full depth on every regime (measured worst 0.021,
 * the anvil's), and within 0.1% of any column deeper than ten steps.
 */
export const COLUMN_STEPS = 256

/**
 * A level's unscaled vertical optical depth at 550 nm in a direction: what
 * ISCCP retrieves. The column is resolved (a footprint of zero), so it is
 * one column of the field, not a pixel's mean: a retrieval's pixel is the
 * calibration's to form from columns.
 */
export function columnDepth(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  direction: Vec3,
  level: number,
): number {
  const spec = weather.levels[level]
  const length = Math.hypot(direction.x, direction.y, direction.z)
  if (spec === undefined || !(spec.top > spec.base) || !(length > 0)) return 0
  const up = unit(direction, length)
  const climate: ClimateSample = weather.climate.sample(up, sun, clock.time)
  const profile = levelProfile(spec)
  const unscale = profile.scaled > 0 ? profile.sigma / profile.scaled : 0
  const thickness = spec.top - spec.base
  let depth = 0
  for (let i = 0; i < COLUMN_STEPS; i += 1) {
    const h01 = (i + 0.5) / COLUMN_STEPS
    const r = weather.datumRadius + spec.base + h01 * thickness
    const position = { x: up.x * r, y: up.y * r, z: up.z * r }
    const at = levelSample(
      profile,
      level,
      climate.cover[level]!,
      climate.convective[level]!,
      h01,
      clock,
      position,
      0,
    )
    depth += at.fraction * at.sigma
  }
  return (depth * unscale * thickness) / COLUMN_STEPS
}

/* ------------------------------------------------------------------------- */
/* The sight count                                                            */
/* ------------------------------------------------------------------------- */

/** A patch of a body to count lines of sight through: a point on the datum and its tangent axes. */
export interface SightPatch {
  /** Unit, body-fixed: the patch's center, and its east and north there. */
  readonly up: Vec3
  readonly east: Vec3
  readonly north: Vec3
  /** Lines a side of the square grid the lines start on, and their spacing, meters. */
  readonly lines: number
  readonly spacing: number
}

/** Below this σ′·fraction a step holds no cloud: a hundredth of a kilometer's depth. */
const CLEAR_EXTINCTION = 1e-5

/**
 * The share of straight lines of sight through level `level` at `zenith`
 * radians, tilted toward east, that meet no cloud, each marched in steps of
 * `step` meters through the level's thickness at a footprint of zero. A
 * line is clear when no step holds `σ′·fraction` over 10⁻⁵ 1/m.
 */
export function clearSightShare(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  patch: SightPatch,
  level: number,
  zenith: number,
  step: number,
): number {
  const spec = weather.levels[level]
  if (spec === undefined || !(spec.top > spec.base)) return 1
  const chord = (spec.top - spec.base) / Math.cos(zenith)
  const steps = Math.max(1, Math.ceil(chord / step))
  const along = {
    x: Math.cos(zenith) * patch.up.x + Math.sin(zenith) * patch.east.x,
    y: Math.cos(zenith) * patch.up.y + Math.sin(zenith) * patch.east.y,
    z: Math.cos(zenith) * patch.up.z + Math.sin(zenith) * patch.east.z,
  }
  const start = weather.datumRadius + spec.base
  const half = (patch.lines - 1) / 2
  let clear = 0
  for (let a = 0; a < patch.lines; a += 1)
    for (let b = 0; b < patch.lines; b += 1) {
      const e = (a - half) * patch.spacing
      const n = (b - half) * patch.spacing
      const origin = {
        x: patch.up.x * start + patch.east.x * e + patch.north.x * n,
        y: patch.up.y * start + patch.east.y * e + patch.north.y * n,
        z: patch.up.z * start + patch.east.z * e + patch.north.z * n,
      }
      let blocked = false
      for (let i = 0; i < steps && !blocked; i += 1) {
        const s = ((i + 0.5) / steps) * chord
        const at = cloudFieldAt(
          weather,
          clock,
          sun,
          {
            x: origin.x + along.x * s,
            y: origin.y + along.y * s,
            z: origin.z + along.z * s,
          },
          0,
        )
        blocked =
          at.level === level && at.fraction * at.sigma > CLEAR_EXTINCTION
      }
      if (!blocked) clear += 1
    }
  return clear / (patch.lines * patch.lines)
}

/**
 * §5.9's clear-line-of-sight form, `P(θ) = P₀^√(1 + (ℓ/c)²)` with
 * `ℓ = thickness·tan θ`, at sight length `c`.
 */
export function sightForm(
  clearAtZenith: number,
  thickness: number,
  zenith: number,
  sight: number,
): number {
  const run = thickness * Math.tan(zenith)
  return clearAtZenith ** Math.sqrt(1 + (run / sight) ** 2)
}

/**
 * The sight length `c` that fits counted shares by zenith angle best, in
 * the least squares of `ln P`, by golden-section search over 10 m to 100 km.
 * The first count is the one at the zenith.
 */
export function fitSightLength(
  counts: readonly { readonly zenith: number; readonly clear: number }[],
  thickness: number,
): number {
  const zenith = counts[0]!.clear
  const error = (logSight: number): number => {
    const sight = Math.exp(logSight)
    let sum = 0
    for (const { zenith: angle, clear } of counts) {
      const model = sightForm(zenith, thickness, angle, sight)
      const d =
        Math.log(Math.max(model, 1e-12)) - Math.log(Math.max(clear, 1e-12))
      sum += d * d
    }
    return sum
  }
  let low = Math.log(10)
  let high = Math.log(100_000)
  const golden = (Math.sqrt(5) - 1) / 2
  for (let i = 0; i < 100; i += 1) {
    const a = high - golden * (high - low)
    const b = low + golden * (high - low)
    if (error(a) < error(b)) high = b
    else low = a
  }
  return Math.exp((low + high) / 2)
}
