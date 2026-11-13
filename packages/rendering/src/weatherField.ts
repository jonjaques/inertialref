import type { Vec3 } from '@inertialref/spatial'
import {
  type BodyWeather,
  type ClimateSample,
  type LevelSpec,
  turnAngle,
  unturn,
} from './weatherClimate.ts'
import { latticeOrigin, turnBack } from './weatherClock.ts'
import {
  GENUS_TABLE,
  type LevelProfile,
  levelProfile,
  PROFILE_ROWS,
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

/**
 * The resolved recipe at one point of a level (§5.6, as phase 0 built it),
 * before the level's gain:
 *
 *     d = saturate(remap(n_b·R, 1 − c, 1, 0, 1)),  d = saturate(remap(d, n_d·erosion, 1, 0, 1))
 *     fraction = 1,  σ′ = σ′_level·d
 *
 * with `R` the profile's extinction share at the height and convective
 * share. The same at every footprint it is read at: the detail is never
 * faded out of it, because a cell with its erosion taken away is a thicker
 * cell, and the crossing it darkens is the one the footprint was meant to
 * keep.
 */
function resolvedSample(
  profile: LevelProfile,
  shape: number,
  cover: number,
  base: number,
  detail: number,
): number {
  const c = clamp01(cover)
  const erosion = detail * profile.erosion
  const shaped = clamp01((base * shape - (1 - c)) / Math.max(c, TINY))
  const eroded = clamp01((shaped - erosion) / Math.max(1 - erosion, TINY))
  return profile.scaled * eroded
}

/**
 * The footprint at which a sample stops reading the resolved field and
 * reads its level's statistics: a quarter of a cell at a dither of 0, a
 * whole cell at 1, log-uniform between. A ray carries one dither, so over
 * rays the switch is a band in footprint, as the handover is; along one ray
 * it is a single footprint, so a crossing at one footprint is wholly one or
 * the other.
 */
export function statisticsFootprint(cell: number, dither: number): number {
  return cell * 4 ** (clamp01(dither) - 1)
}

function levelSample(
  spec: LevelSpec,
  profile: LevelProfile,
  level: number,
  cover: number,
  convective: number,
  h01: number,
  clock: FieldClock,
  point: Vec3,
  footprint: number,
  dither: number,
): FieldSample {
  const [shape, mean, , radius] = readLevelProfile(profile, h01, convective)
  const { cell } = profile
  if (footprint > statisticsFootprint(cell, dither)) {
    // What the footprint stands for: the resolved field's own cloudy share
    // and its cloudy columns' transmittance, never a mean density.
    const stats = readLevelStatistics(levelStatistics(spec), cover, convective)
    const thickness = Math.max(spec.top - spec.base, 1)
    return {
      fraction: stats.fraction,
      sigma:
        stats.fraction > 0 && mean > 0
          ? (stats.depth * shape) / (mean * thickness)
          : 0,
      radius: radius * profile.radius,
      level,
    }
  }
  const w = mesoscaleDisplacement(
    mesoscalePhases(clock, level, point, cell),
    cell,
  )
  const { gain } = readLevelStatistics(levelStatistics(spec), cover, convective)
  return {
    fraction: 1,
    sigma:
      gain *
      resolvedSample(
        profile,
        shape,
        cover,
        baseNoiseTexture(baseCells(clock, level, point, cell, w)),
        detailNoiseTexture(detailCells(clock, level, point, cell, w)),
      ),
    radius: radius * profile.radius,
    level,
  }
}

/* ------------------------------------------------------------------------- */
/* A level's statistics                                                       */
/* ------------------------------------------------------------------------- */

/*
 * What a level at a cover is, read at a footprint that no longer resolves
 * its cells: a cloud fraction and an in-cloud depth, mixed once a crossing,
 * never a mean density (plan §3), with every number taken from the resolved
 * field itself rather than from the cover and the profile's mean.
 *
 * - `fraction`, F: the share of vertical columns through the level that
 *   hold any cloud.
 * - `depth`, τ′: the scaled in-cloud depth whose transmittance is the mean
 *   of the cloudy columns' own, `−ln mean(e^(−τ′))`. With F it makes a
 *   vertical crossing pass exactly what the resolved field passes on
 *   average, in §5.9's form as written; the mean of the depths would pass
 *   less, by Jensen's inequality.
 * - `shape`, k: how spread the cloudy columns' depths are, as a gamma
 *   distribution's shape, matched to the cloudy columns' mean
 *   transmittance at one and at two times their depth. One depth cannot
 *   stand for a spread of depths on a slant: `(mean e^(−τ))^m` is under
 *   `mean e^(−m·τ)` for every path factor m over one, and on a deck the
 *   gap is the picture. Measured over 3,000 rays at two places, §5.9's
 *   form with one depth misses the resolved field by up to 32% on
 *   `overcast`, 19% on `inside` and `fog` and 13% on `stratocumulus` at
 *   0°, 45° and 80° at its best sight length; with the gamma depth, by 9%
 *   at most on any regime or climate.
 * - `sight`, c: §5.9's sight length, fitted so the crossing passes the
 *   resolved field's mean transmittance on rays at 45°, 65° and 80°.
 * - `gain`: what the resolved extinction is multiplied by so its mean
 *   inside cloud is the genus's σ, the plan's measured in-cloud figure
 *   (§5.2). The recipe's density is the noise's excess over its threshold,
 *   which inside a cloud is spread from nothing at the edge to its most at
 *   the core: for a near-uniform noise its mean there is
 *   `(R − 1 + c)/(2c)` of the profile's, about a half, and the erosion
 *   takes more. Measured without it, the in-cloud mean was 0.42 to 0.57 of
 *   each genus's σ at its regimes' covers, and 0.24 on the blend of
 *   Earth's low level at a cover of 0.5. It moves only how dense a cloud
 *   is, never where it is: the threshold reads the noise before it.
 *
 * The crossing these make is `crossingForm`. Each number is measured on a
 * fixed sample of the level's own field: 4,096 vertical columns, 512 rays
 * at 45° and at 65° and 1,024 at 80°, from points spread by an additive
 * recurrence over 256 cells and in directions spread over the sphere, read
 * through the mesoscale displacement as the field is, so the table is a
 * function of the level alone. A deck's grazing transmittance is mostly its
 * clear holes raised to n, so its F is held to a few thousandths, which
 * takes thousands of columns. The displacement keeps area, so it moves no
 * vertical statistic, but it shears cells, which a slant ray meets.
 */

/** Covers the table holds: 0, 1/16, …, 1. */
export const STATISTICS_COVERS = 17
const STATISTICS_COLUMNS = 4096
/** Rays at each slant: twice as many at the steepest, where a deck passes a hundredth. */
const STATISTICS_RAYS = [512, 512, 1024]
/** The slants the sight length is fitted at, radians. */
const STATISTICS_SLANTS = [45, 65, 80].map(
  (degrees) => (degrees * Math.PI) / 180,
)
/** Steps through a level's thickness: a slant ray takes as many per vertical thickness. */
const STATISTICS_STEPS = 32
/** Under this scaled depth a column holds no cloud. */
const CLEAR_DEPTH = 1e-4
/** Under this cloudy share a row's sight length is the next cover's. */
const SPARSE = 0.02

export interface LevelStatistics {
  /** `[cover][row]`, row j at a convective share of j/7, as the profile's rows. */
  readonly fraction: Float64Array
  readonly depth: Float64Array
  readonly shape: Float64Array
  /** Meters. */
  readonly sight: Float64Array
  /**
   * What the resolved extinction is multiplied by so its mean inside cloud
   * is the genus's σ, blended along the row as the profile blends it.
   */
  readonly gain: Float64Array
  /**
   * The mean scaled depth of the cloudy columns, the ones over
   * `CLEAR_DEPTH` that `depth` and `shape` are measured over.
   *
   * **The level's mean, not a place's.** A footprint a few kilometers
   * across holds its own columns, and their mean is half to one and a half
   * times this. And it is not the mean the two beside it imply:
   * `shape·(e^(depth/shape) − 1)` is the mean of the gamma whose
   * transmittance at once and at twice the depth is the columns', and that
   * is 1.3 to 3 times this one (12.1 against 9.2 on a fair cumulus level,
   * 36.7 against 12.0 on an overcast's). A light that weighs a column by
   * its depth reads this; a transmittance reads the other two.
   */
  readonly mean: Float64Array
}

/** The gamma shape that stands for depths that do not spread: `(1 + τ/k)^(−k)` is then `e^(−τ)` to a part in 10⁴ at τ 1. */
export const UNSPREAD_SHAPE = 1e4

/** The additive recurrence of the plastic number's six-dimensional analogue: points spread with no hash and no draw. */
function spread(index: number, dimension: number): number {
  const root = 1.1127756842787055 // x⁷ = x + 1
  const a = 1 / root ** (dimension + 1)
  const x = 0.5 + index * a
  return x - Math.floor(x)
}

interface Paths {
  readonly length: number
  readonly steps: number
  /** Meters a step. */
  readonly step: number
  readonly base: Float32Array
  readonly detail: Float32Array
  /** The profile's R at each sample, at the stratiform end and at the cumuliform. */
  readonly shape: readonly Float32Array[]
}

function samplePaths(
  profile: LevelProfile,
  thickness: number,
  count: number,
  zenith: number,
  offset: number,
): Paths {
  const { cell } = profile
  const step = thickness / STATISTICS_STEPS
  const steps = Math.ceil(STATISTICS_STEPS / Math.cos(zenith))
  const size = count * steps
  const base = new Float32Array(size)
  const detail = new Float32Array(size)
  const shape = Array.from(
    { length: PROFILE_ROWS },
    () => new Float32Array(size),
  )
  for (let p = 0; p < count; p += 1) {
    const n = p + offset
    // Over 256 cells, so the mesoscale displacement, whose waves run 17 to
    // 73 cells, takes every phase across the sample; the noise itself
    // wraps every eight.
    const origin = {
      x: 256 * cell * spread(n, 0),
      y: 256 * cell * spread(n, 1),
      z: 256 * cell * spread(n, 2),
    }
    const y = 2 * spread(n, 3) - 1
    const around = 2 * Math.PI * spread(n, 4)
    const ring = Math.sqrt(1 - y * y)
    const up = { x: ring * Math.cos(around), y, z: ring * Math.sin(around) }
    const seed =
      Math.abs(up.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 }
    const east = normalize(cross(seed, up))
    const north = cross(up, east)
    const turn = 2 * Math.PI * spread(n, 5)
    const across = {
      x: Math.cos(turn) * east.x + Math.sin(turn) * north.x,
      y: Math.cos(turn) * east.y + Math.sin(turn) * north.y,
      z: Math.cos(turn) * east.z + Math.sin(turn) * north.z,
    }
    const along = {
      x: Math.cos(zenith) * up.x + Math.sin(zenith) * across.x,
      y: Math.cos(zenith) * up.y + Math.sin(zenith) * across.y,
      z: Math.cos(zenith) * up.z + Math.sin(zenith) * across.z,
    }
    const chord = thickness / Math.cos(zenith)
    for (let i = 0; i < steps; i += 1) {
      const at = p * steps + i
      const distance = Math.min(chord, (i + 0.5) * step)
      const h01 = Math.min(1, (distance * Math.cos(zenith)) / thickness)
      const point = {
        x: origin.x + along.x * distance,
        y: origin.y + along.y * distance,
        z: origin.z + along.z * distance,
      }
      // Read where the field reads: displaced, since the displacement
      // shears cells, and a slant ray meets a sheared cell otherwise.
      const w = mesoscaleDisplacement(
        MESOSCALE_WAVES.map(
          ({ along: k, wavelength }) =>
            ((2 * Math.PI) / (wavelength * cell)) * dot(k, point),
        ),
        cell,
      )
      const q = { x: point.x + w.x, y: point.y + w.y, z: point.z + w.z }
      base[at] = baseNoiseTexture({
        x: q.x / cell,
        y: q.y / cell,
        z: q.z / cell,
      })
      const scale = DETAIL_NOISE_PERIOD / cell
      detail[at] = detailNoiseTexture({
        x: q.x * scale,
        y: q.y * scale,
        z: q.z * scale,
      })
      for (let j = 0; j < PROFILE_ROWS; j += 1)
        shape[j]![at] = readLevelProfile(
          profile,
          h01,
          j / (PROFILE_ROWS - 1),
        )[0]
    }
  }
  return { length: count, steps, step, base, detail, shape }
}

/** Each path's scaled depth through the level at a cover, at one end of the blend. */
function pathDepths(
  profile: LevelProfile,
  paths: Paths,
  cover: number,
  row: number,
  thickness: number,
  zenith: number,
  gain = 1,
): Float64Array {
  const depths = new Float64Array(paths.length)
  const chord = thickness / Math.cos(zenith)
  for (let p = 0; p < paths.length; p += 1) {
    let depth = 0
    for (let i = 0; i < paths.steps; i += 1) {
      const at = p * paths.steps + i
      const length = Math.min(paths.step, chord - i * paths.step)
      if (!(length > 0)) break
      depth +=
        resolvedSample(
          profile,
          paths.shape[row]![at]!,
          cover,
          paths.base[at]!,
          paths.detail[at]!,
        ) * length
    }
    depths[p] = depth * gain
  }
  return depths
}

/**
 * The resolved field's mean unscaled extinction inside cloud on a set of
 * columns, at a cover and a row of the blend: over every sample that holds
 * any, height by height as a volume samples it.
 */
function inCloudMean(
  profile: LevelProfile,
  paths: Paths,
  cover: number,
  row: number,
): number {
  let sum = 0
  let count = 0
  for (let at = 0; at < paths.base.length; at += 1) {
    const sigma = resolvedSample(
      profile,
      paths.shape[row]![at]!,
      cover,
      paths.base[at]!,
      paths.detail[at]!,
    )
    if (sigma > 0) {
      sum += sigma
      count += 1
    }
  }
  const unscale = profile.scaled > 0 ? profile.sigma / profile.scaled : 0
  return count > 0 ? (sum / count) * unscale : 0
}

/**
 * A crossing of a level `thickness` thick at `zenith` by a footprint that
 * reads its statistics: §5.9's `n = √(1 + (ℓ/c)²)` cells crossed, each
 * cloudy with probability F and holding a gamma-distributed share of the
 * crossing's depth,
 *
 *     T = ((1 − F) + F·(1 + τ̄·m/(n·k))^(−k))^n,   τ̄ = k·(e^(τ′/k) − 1),
 *
 * with m the path factor `1/cos θ` and τ′ the vertical depth `depth`, whose
 * own transmittance is the cloudy columns' mean: straight down this is
 * `1 − F + F·e^(−τ′)`, §5.9's form as written, at any shape.
 */
export function crossingForm(
  fraction: number,
  depth: number,
  shape: number,
  sight: number,
  thickness: number,
  zenith: number,
): number {
  if (!(fraction > 0)) return 1
  const n = Math.sqrt(1 + ((thickness * Math.tan(zenith)) / sight) ** 2)
  const mean = shape * Math.expm1(depth / shape)
  const cell = (1 + mean / (Math.cos(zenith) * n * shape)) ** -shape
  return (1 - fraction + fraction * cell) ** n
}

/** The gamma shape whose transmittance at twice the depth is `twice`, where at once it is `once`. */
function gammaShape(once: number, twice: number): number {
  // `twice` lies between once² (depths that do not spread, k → ∞) and once
  // (k → 0); the transmittance at twice the depth falls as k grows.
  if (!(twice > once * once * (1 + 1e-9))) return UNSPREAD_SHAPE
  let low = Math.log(1e-3)
  let high = Math.log(UNSPREAD_SHAPE)
  for (let i = 0; i < 80; i += 1) {
    const k = Math.exp((low + high) / 2)
    const mean = k * (once ** (-1 / k) - 1)
    if ((1 + (2 * mean) / k) ** -k > twice) low = (low + high) / 2
    else high = (low + high) / 2
  }
  return Math.exp((low + high) / 2)
}

function buildStatistics(
  spec: LevelSpec,
  profile: LevelProfile,
): LevelStatistics {
  const thickness = Math.max(spec.top - spec.base, 1)
  const size = STATISTICS_COVERS * PROFILE_ROWS
  const fraction = new Float64Array(size)
  const depth = new Float64Array(size)
  const shape = new Float64Array(size).fill(UNSPREAD_SHAPE)
  const sight = new Float64Array(size).fill(2.5 * profile.cell)
  const gain = new Float64Array(size).fill(1)
  const columnMean = new Float64Array(size)
  const columns = samplePaths(profile, thickness, STATISTICS_COLUMNS, 0, 0)
  const [stratiform, cumuliform] = [
    GENUS_TABLE[spec.stratiform].sigma,
    GENUS_TABLE[spec.cumuliform].sigma,
  ]
  const rays = STATISTICS_SLANTS.map((zenith, j) =>
    samplePaths(
      profile,
      thickness,
      STATISTICS_RAYS[j]!,
      zenith,
      STATISTICS_COLUMNS + j * 1024,
    ),
  )
  for (let i = 0; i < STATISTICS_COVERS; i += 1) {
    const cover = i / (STATISTICS_COVERS - 1)
    for (let row = 0; row < PROFILE_ROWS; row += 1) {
      const at = i * PROFILE_ROWS + row
      const mean = inCloudMean(profile, columns, cover, row)
      const v = row / (PROFILE_ROWS - 1)
      const g =
        mean > 0 ? (stratiform + (cumuliform - stratiform) * v) / mean : 1
      gain[at] = g
      let cloudy = 0
      let once = 0
      let twice = 0
      let total = 0
      for (const d of pathDepths(profile, columns, cover, row, thickness, 0, g))
        if (d > CLEAR_DEPTH) {
          cloudy += 1
          once += Math.exp(-d)
          twice += Math.exp(-2 * d)
          total += d
        }
      if (cloudy === 0) continue
      columnMean[at] = total / cloudy
      const share = cloudy / columns.length
      const k = gammaShape(once / cloudy, twice / cloudy)
      const inCloud = -Math.log(once / cloudy)
      fraction[at] = share
      depth[at] = inCloud
      shape[at] = k
      const targets = STATISTICS_SLANTS.map((zenith, j) => {
        let sum = 0
        for (const d of pathDepths(
          profile,
          rays[j]!,
          cover,
          row,
          thickness,
          zenith,
          g,
        ))
          sum += Math.exp(-d)
        return Math.max(sum / rays[j]!.length, 1e-12)
      })
      const error = (logSight: number): number => {
        let e = 0
        STATISTICS_SLANTS.forEach((zenith, j) => {
          const model = crossingForm(
            share,
            inCloud,
            k,
            Math.exp(logSight),
            thickness,
            zenith,
          )
          e += (Math.log(Math.max(model, 1e-12)) - Math.log(targets[j]!)) ** 2
        })
        return e
      }
      let low = Math.log(0.1 * profile.cell)
      let high = Math.log(100 * profile.cell)
      const golden = (Math.sqrt(5) - 1) / 2
      for (let g = 0; g < 80; g += 1) {
        const a = high - golden * (high - low)
        const b = low + golden * (high - low)
        if (error(a) < error(b)) high = b
        else low = a
      }
      sight[at] = Math.exp((low + high) / 2)
    }
  }
  // A row whose cloud is too sparse to fit a sight length takes the next
  // cover's: under 2% of columns cloudy, a slant ray meets so little cloud
  // that any length fits, and the fit runs to its bound of a hundred cells,
  // which the reader then blends into the rows beside it.
  for (let row = 0; row < PROFILE_ROWS; row += 1)
    for (let i = STATISTICS_COVERS - 2; i >= 0; i -= 1)
      if (fraction[i * PROFILE_ROWS + row]! < SPARSE)
        sight[i * PROFILE_ROWS + row] = sight[(i + 1) * PROFILE_ROWS + row]!
  return { fraction, depth, shape, sight, gain, mean: columnMean }
}

/*
 * Kept by the level's members, as the profile is, and bounded the same way.
 * A table costs 0.3 to 0.5 s to build on this Mac mini, once a level, more
 * the first time a process reads the noise's texels: too long for a frame,
 * so whoever builds the frame builds it off the frame's path.
 */
const STATISTICS = new Map<string, LevelStatistics>()

/** A level's statistics, built once for its members. */
export function levelStatistics(spec: LevelSpec): LevelStatistics {
  const key = `${spec.base}|${spec.top}|${spec.stratiform}|${spec.cumuliform}`
  let stats = STATISTICS.get(key)
  if (stats === undefined) {
    if (STATISTICS.size >= 256) STATISTICS.clear()
    stats = buildStatistics(spec, levelProfile(spec))
    STATISTICS.set(key, stats)
  }
  return stats
}

/** The table at a cover and a convective share: linear in each. */
export function readLevelStatistics(
  stats: LevelStatistics,
  cover: number,
  convective: number,
): {
  readonly fraction: number
  readonly depth: number
  readonly shape: number
  readonly sight: number
  readonly gain: number
  readonly mean: number
} {
  const x = clamp01(cover) * (STATISTICS_COVERS - 1)
  const i = Math.min(STATISTICS_COVERS - 2, Math.floor(x))
  const f = x - i
  const y = clamp01(convective) * (PROFILE_ROWS - 1)
  const j = Math.min(PROFILE_ROWS - 2, Math.floor(y))
  const g = y - j
  const read = (table: Float64Array): number => {
    const at = (k: number, row: number) => table[k * PROFILE_ROWS + row]!
    const low = at(i, j) + (at(i + 1, j) - at(i, j)) * f
    const high = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * f
    return low + (high - low) * g
  }
  return {
    fraction: read(stats.fraction),
    depth: read(stats.depth),
    shape: read(stats.shape),
    sight: read(stats.sight),
    gain: read(stats.gain),
    mean: read(stats.mean),
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
  dither = 0.5,
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
    spec,
    levelProfile(spec),
    level,
    climate.cover[level]!,
    climate.convective[level]!,
    (height - spec.base) / Math.max(spec.top - spec.base, 1),
    clock,
    position,
    footprint,
    dither,
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
      spec,
      profile,
      level,
      climate.cover[level]!,
      climate.convective[level]!,
      h01,
      clock,
      position,
      0,
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
