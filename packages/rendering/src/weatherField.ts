import type { Vec3 } from '@inertialref/spatial'
import {
  type BodyWeather,
  type ClimateSample,
  turnAngle,
  unturn,
} from './weatherClimate.ts'
import { latticeOrigin, turnBack } from './weatherClock.ts'
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
 * multiplies an eye-relative offset by, in float32. The frame's own
 * `turnBack`, so the field and the drawn frame turn a level by one matrix.
 */
export function levelTurnMatrix(
  clock: FieldClock,
  level: number,
): readonly number[] {
  return turnBack(clock.turn[level] ?? 0)
}

/**
 * A body point's place in level k's noise frame, `R_y(−θ_k)·p + ŷ·D`,
 * reduced into [0, period) on each axis in float64. For an eye it is the
 * level's origin: the GPU's lattice point is this plus `M_k·(p − eye)`,
 * which is `M_k·p + ŷ·D` for any eye, modulo the period, so the eye enters
 * as the point the float32 offset is measured from and nowhere else.
 *
 * It is the frame's `latticeOrigin`, which reduces the drift by the period
 * before adding it, so the field and the drawn frame place every level's
 * noise by one function rather than two copies that agree today.
 */
export function levelOrigin(
  clock: FieldClock,
  level: number,
  point: Vec3,
  period: number,
): Vec3 {
  return latticeOrigin(point, clock.turn[level] ?? 0, clock.drift, period)
}

/* ------------------------------------------------------------------------- */
/* The mesoscale displacement                                                 */
/* ------------------------------------------------------------------------- */

/*
 * The base noise tiles every eight cells, 9.6 km for cumulus, and a cover
 * that holds over a stance lays that one tile across the whole field: from
 * orbit E1's 80 km frame is the same tile eight times a side, its
 * cloud-or-clear map correlating at 0.88 with itself 23.5 km away. Real
 * cumulus fields are herded by the boundary layer's mesoscale circulation
 * and repeat at no lag.
 *
 * So each level's noise is read displaced by a smooth field that varies over
 * tens of kilometers: six waves along the axes of an icosahedron turned off
 * the lattice's own axes, each displacing across its own direction, with
 * wavelengths of 17 to 73 cells (20 to 88 km for cumulus) that no two share
 * a ratio of small integers. Each wave's displacement is perpendicular to
 * its direction, so the field is divergence-free: it moves the noise and
 * neither makes nor removes cloud, and a stance keeps its regime's cover and
 * share of cloudy columns. Six and not four, because a lag nearly
 * perpendicular to every wave sees no displacement: with four, three of
 * them lay across E1's repeat and it held at 0.48.
 *
 * It is a stand-in for that circulation, not a model of it. Its constants
 * are package G's: each wave steepens the displacement by
 * `MESOSCALE_GRADIENT`, the six by at most 0.66, under the 1 at which the
 * noise would fold over itself. Measured over 80 km at 28 places on Earth
 * and the cornerstones' world, it leaves no cloud-or-clear map correlating
 * at over 0.30 at any lag from 2 to 40 km (`weatherField.test.ts`).
 *
 * The march evaluates it from uniforms: six phases a level at the eye, and
 * a sine a wave a step. No texture is bound or read for it.
 */

/**
 * One wave of a level's mesoscale displacement, in the level's cells: the
 * noise at lattice point p′ is read at `p′ + Σ a·cell·push·sin(k·p′)`, with
 * `k = 2π/(wavelength·cell)·along`.
 */
export interface MesoscaleWave {
  /** Unit, in the level's turned frame: the direction the wave varies along. */
  readonly along: Vec3
  /** Unit and perpendicular to `along`: the direction it displaces the noise. */
  readonly push: Vec3
  /** Cells. */
  readonly wavelength: number
  /** Cells. */
  readonly amplitude: number
}

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})
const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

/** How much each wave steepens the displacement: its amplitude over its wavelength, times 2π. A stand-in for G. */
export const MESOSCALE_GRADIENT = 0.11
/** Each wave's wavelength, cells: incommensurate, 20 to 88 km for cumulus. A stand-in for G. */
export const MESOSCALE_WAVELENGTHS = [17, 23, 31, 41, 55, 73] as const

const GOLDEN = (1 + Math.sqrt(5)) / 2
/** A rotation by 0.613 rad about the pole and 1.137 rad about y: no axis of the icosahedron on the lattice's axes, whose period would then line up with a wave. */
const offAxis = (v: Vec3): Vec3 => {
  const [a, b] = [0.613, 1.137]
  const x = Math.cos(a) * v.x - Math.sin(a) * v.y
  const y = Math.sin(a) * v.x + Math.cos(a) * v.y
  return {
    x: Math.cos(b) * x + Math.sin(b) * v.z,
    y,
    z: -Math.sin(b) * x + Math.cos(b) * v.z,
  }
}
/** The icosahedron's six axes through opposite vertices, and for each a direction its push is made perpendicular from. */
const AXES: readonly Vec3[] = [
  { x: 0, y: 1, z: GOLDEN },
  { x: 0, y: 1, z: -GOLDEN },
  { x: 1, y: GOLDEN, z: 0 },
  { x: 1, y: -GOLDEN, z: 0 },
  { x: GOLDEN, y: 0, z: 1 },
  { x: -GOLDEN, y: 0, z: 1 },
]
const ACROSS: readonly Vec3[] = [
  { x: 0.3, y: 0.8, z: 0.5 },
  { x: 0.9, y: -0.2, z: 0.4 },
  { x: -0.5, y: 0.3, z: 0.8 },
  { x: 0.2, y: 0.4, z: -0.9 },
  { x: 0.7, y: 0.7, z: -0.1 },
  { x: -0.4, y: 0.9, z: 0.2 },
]

export const MESOSCALE_WAVES: readonly MesoscaleWave[] = AXES.map((axis, j) => {
  const along = normalize(offAxis(axis))
  const wavelength = MESOSCALE_WAVELENGTHS[j]!
  return {
    along,
    push: normalize(cross(along, ACROSS[j]!)),
    wavelength,
    amplitude: (MESOSCALE_GRADIENT * wavelength) / (2 * Math.PI),
  }
})

const TAU = 2 * Math.PI
const angleOf = (x: number): number => x - TAU * Math.floor(x / TAU)

/**
 * Each wave's phase at a body point in level k's frame, `k·p′` in
 * [0, 2π), float64: the turned point's term and the drift's reduced apart,
 * as the lattice's origin is, so ten years of drift keep the phase's
 * precision. For an eye it is what the frame uploads; the GPU adds
 * `k·M_k·(p − eye)` in float32.
 */
export function mesoscalePhases(
  clock: FieldClock,
  level: number,
  point: Vec3,
  cell: number,
): number[] {
  const turned = unturn(point, clock.turn[level] ?? 0)
  return MESOSCALE_WAVES.map(({ along, wavelength }) => {
    const k = TAU / (wavelength * cell)
    return angleOf(
      angleOf(k * dot(along, turned)) + angleOf(k * along.y * clock.drift),
    )
  })
}

/** The displacement the phases give, meters, in the level's turned frame. */
export function mesoscaleDisplacement(
  phases: readonly number[],
  cell: number,
): Vec3 {
  let x = 0
  let y = 0
  let z = 0
  MESOSCALE_WAVES.forEach(({ push, amplitude }, j) => {
    const a = amplitude * cell * Math.sin(phases[j]!)
    x += push.x * a
    y += push.y * a
    z += push.z * a
  })
  return { x, y, z }
}

/** The base noise's cells at a body point displaced by `w`: its place in the level's frame over eight cells, over the cell. */
function baseCells(
  clock: FieldClock,
  level: number,
  point: Vec3,
  cell: number,
  w: Vec3,
): Vec3 {
  const at = levelOrigin(clock, level, point, BASE_NOISE_PERIOD * cell)
  return {
    x: (at.x + w.x) / cell,
    y: (at.y + w.y) / cell,
    z: (at.z + w.z) / cell,
  }
}

/** The detail's cells at a body point displaced by `w`: four a base cell, tiling once a base cell. */
function detailCells(
  clock: FieldClock,
  level: number,
  point: Vec3,
  cell: number,
  w: Vec3,
): Vec3 {
  const at = levelOrigin(clock, level, point, cell)
  const scale = DETAIL_NOISE_PERIOD / cell
  return {
    x: (at.x + w.x) * scale,
    y: (at.y + w.y) * scale,
    z: (at.z + w.z) * scale,
  }
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
  const w = mesoscaleDisplacement(
    mesoscalePhases(clock, level, point, cell),
    cell,
  )
  const base = baseNoiseTexture(baseCells(clock, level, point, cell, w))
  const reach = 1 - smoothstep(cell / 16, cell / 4, footprint)
  const erosion =
    reach > 0
      ? detailNoiseTexture(detailCells(clock, level, point, cell, w)) *
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
 * Measured on a Mac mini (Mac18,5, Apple M6, Node 26) shared with other
 * builds, over 40,000 places in a 20 km square of a low level: 0.8–1.0 µs a
 * call where the noise's texels near it are known, 10–15 µs where the call
 * is the first to need them (3.4 µs a texel), and 0.6–1.0 µs unresolved,
 * where the detail is not read. The mesoscale displacement's six sines are
 * about a third of a known call. A column (`columnDepth`) is 220–280 µs.
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
