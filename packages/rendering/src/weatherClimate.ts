import { deriveSeed, type Seed } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import { periodIndex, reduceTurns } from './weatherClock.ts'
import { GENUS_TABLE } from './weatherGenus.ts'
import { baseNoiseTexture } from './weatherNoise.ts'
import {
  BLOB_MEAN,
  blobCells,
  blobThreshold,
  type CloudGenus,
  MAX_CLOUD_LAYERS,
  type ScenarioId,
  scenarioCoverage,
  shellUnion,
  terminatorSines,
  WEATHER_SCENARIOS,
  type WeatherScenario,
  wetWorld,
} from './weatherScenario.ts'

/*
 * The weather per body: three levels, a climate that says how much of each
 * is cloud at a place under a sun, and how the texture moves. Derived from a
 * body's record and stored nowhere (rule 17): nothing here is hashed or
 * saved, and the seed is a derivation of the surface's, never a draw from
 * the body's generator, so two bodies generated in either order have one
 * weather each (rule 4).
 *
 * A regime and a climate are one type, so every reader has one path: a
 * scenario's layers are the three levels, and its pattern is the climate's
 * `sample`. `bodyWeather` is the body's own climate, the zonal law of phase
 * 1 design §5.3, on Earth too until its measured climatology lands.
 */

/** A level's envelope over the datum, meters. Three levels: low, middle, high. */
export interface LevelSpec {
  readonly base: number
  readonly top: number
  /** The genus where the level is stratiform, and where it is cumuliform. */
  readonly stratiform: CloudGenus
  readonly cumuliform: CloudGenus
}

export interface ClimateSample {
  /** Each level's cloud fraction, 0..1. */
  readonly cover: readonly [number, number, number]
  /** Each level's cumuliform share, 0..1. */
  readonly convective: readonly [number, number, number]
  /** The middle level's ice share, and the deep-convection rate, 0..1. */
  readonly ice: number
  readonly deep: number
}

export interface BodyClimate {
  readonly kind: 'regime' | 'zonal' | 'measured'
  /**
   * At a body-fixed unit direction, under a body-fixed unit sun. The season
   * is the sub-solar latitude and the local solar time is the sun's
   * longitude there; neither is a calendar's. `time`, seconds from J2000,
   * turns the zonal law's synoptic field with the low level, and nothing
   * else reads it: a climate is a function of the place, the sun and the
   * instant, and of no observer.
   */
  sample(direction: Vec3, sun: Vec3, time: number): ClimateSample
  /**
   * The climate as the frame's uniforms take it, under a sun at an instant:
   * plain numbers to copy into `CloudClimateUniforms`, slot for slot, which
   * the GPU's port of `sample` evaluates at every texel.
   */
  coefficients(sun: Vec3, time: number): ClimateCoefficients
}

/**
 * A climate as numbers, one member a slot of `CloudClimateUniforms`
 * (`render/cloudUniforms.ts`) and of the frame's `CloudClimateFrame`, with
 * the same names. What each kind reads:
 *
 * - **`'regime'`**: the pattern, its scale, cells and period, the
 *   terminator, and each level's cover and convective share; the blob
 *   threshold and floor are formed for a pattern of blobs and no regime's
 *   climate draws one (`drawnPattern`). The law is zeros.
 * - **`'zonal'`**: the law and κ. `law` is §5.3's sixteen coefficients,
 *   row-major as a `mat4` is read: row k (0 low, 1 middle, 2 high) is
 *   `[base_k, itcz_k, dry_k, storm_k]` and row 3 the four shared angles,
 *   `[φ_I, φ_H, φ_S, w]`, radians, with the convergence zone already at
 *   `ι·δ` for the sun given. `convective` holds κ, each level's share at the
 *   zone's center, not a share. The synoptic factor is the base noise at the
 *   direction turned with the low level, times the datum radius over
 *   `SYNOPTIC_CELL`. `cover` is zeros: under this kind the cover is the
 *   law's, at each place.
 */
export interface ClimateCoefficients {
  readonly kind: BodyClimate['kind']
  readonly law: readonly number[]
  readonly pattern: WeatherScenario['pattern']
  readonly patternScale: number
  readonly patternCells: number
  /** `periodIndex(time, the pattern's period)`: two u32 halves. */
  readonly period: readonly [number, number]
  /** The terminator's sines, full and clear (`terminatorSines`). */
  readonly terminator: readonly [number, number]
  readonly blobThreshold: readonly [number, number, number]
  readonly blobFloor: readonly [number, number, number]
  readonly cover: readonly [number, number, number]
  readonly convective: readonly [number, number, number]
  readonly ice: number
  readonly deep: number
}

export interface BodyWeather {
  /** `deriveSeed(surface.seed, 'weather')`. */
  readonly seed: Seed
  /** The datum the levels stand over, meters: the body's radius. */
  readonly datumRadius: number
  readonly levels: readonly [LevelSpec, LevelSpec, LevelSpec]
  readonly climate: BodyClimate
  /** Each level's turn about the spin axis against the ground, rad/s. */
  readonly turn: readonly [number, number, number]
  /** The texture's drift along the spin axis, m/s. */
  readonly drift: number
}

/**
 * The regime the GPU draws for the `weather` lever's `'climate'` value until
 * the cube bakes the climate itself (`climateNode`, package F). The CPU's
 * `bodyWeather` is the zonal law already; this names what the frame draws
 * in its place, so the two are not mistaken for one.
 */
export const CLIMATE_REGIME: ScenarioId = 'fair-cumulus'

/** The texture's drift along the spin axis, m/s: what changes the slice of noise a level cuts. */
export const WEATHER_AXIAL_DRIFT = 0.25

/**
 * One number a level, low to high. Module-private: an exported signature
 * spells the tuple out, because TypeDoc refuses a public type that refers
 * to a name the documentation does not include.
 */
type Triple = readonly [number, number, number]

/** A regime's law: none. */
const NO_LAW: readonly number[] = /*@__PURE__*/ Object.freeze(
  new Array<number>(16).fill(0),
)

const TURN = 2 * Math.PI

/**
 * `rate·time` as an angle in [0, 2π). The turns are reduced before they are
 * scaled, so ten years of a slow turn keep the float64 of one revolution; a
 * westward rate turns the other way round the same circle.
 */
export function turnAngle(rate: number, time: number): number {
  if (rate === 0 || !Number.isFinite(rate)) return 0
  const turns = reduceTurns(time, TURN / Math.abs(rate))
  const angle = TURN * (rate > 0 || turns === 0 ? turns : 1 - turns)
  return angle < TURN ? angle : 0
}

/** `R_y(−angle)·p`: a body-fixed point in the frame of a lattice turned `angle` east. */
export function unturn(point: Vec3, angle: number): Vec3 {
  if (angle === 0) return point
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return {
    x: c * point.x - s * point.z,
    y: point.y,
    z: s * point.x + c * point.z,
  }
}

/* ------------------------------------------------------------------------- */
/* A regime                                                                   */
/* ------------------------------------------------------------------------- */

/** A level no layer fills: no thickness at the union's top, as `ShellHeights` lays it out. */
function absentLevel(scenario: WeatherScenario): LevelSpec {
  const { top } = shellUnion(scenario)
  return { base: top, top, stratiform: 'stratus', cumuliform: 'stratus' }
}

function levelOf(scenario: WeatherScenario, k: number): LevelSpec {
  const layer = scenario.layers[k]
  if (layer === undefined) return absentLevel(scenario)
  // A regime's layer is one genus, so both ends of the level's blend are it.
  return {
    base: layer.base,
    top: layer.top,
    stratiform: layer.genus,
    cumuliform: layer.genus,
  }
}

/**
 * The pattern a regime's climate draws: its own, with blobs read as a
 * uniform cover at the layer's coverage.
 *
 * Blobs are 0 or 1 by the cube cell a place falls in. A cell is 96 km on a
 * 3,922 km world, so a stance stands inside one blob or between two and sees
 * a whole sky of cloud or none, never the regime's cover; from orbit the
 * cells are the cube face's grid. A regime is a held weather, and its cover
 * at every place is its layer's: the cumuli themselves are the base noise's
 * cells, 1.2 km across, which is what "scattered" means at a stance.
 */
function drawnPattern(scenario: WeatherScenario): WeatherScenario {
  return scenario.pattern === 'blobs'
    ? { ...scenario, pattern: 'uniform', patternScale: 0, patternPeriod: 0 }
    : scenario
}

function regimeClimate(scenario: WeatherScenario): BodyClimate {
  const drawn = drawnPattern(scenario)
  const genus = (k: number): CloudGenus | undefined => scenario.layers[k]?.genus
  const convective = (k: number): number => {
    const of = genus(k)
    return of !== undefined && GENUS_TABLE[of].cumuliform ? 1 : 0
  }
  const share: ClimateSample['convective'] = [
    convective(0),
    convective(1),
    convective(2),
  ]
  const middle = genus(1)
  const ice = middle !== undefined && GENUS_TABLE[middle].class === 'ice'
  const level = (k: number): number =>
    Math.min(1, Math.max(0, drawn.layers[k]?.coverage ?? 0))
  const covers: Triple = [level(0), level(1), level(2)]
  const floor = (c: number): number =>
    Math.max(0, (c - BLOB_MEAN) / (1 - BLOB_MEAN))
  return {
    kind: 'regime',
    coefficients(_sun, time) {
      return {
        kind: 'regime',
        law: NO_LAW,
        pattern: drawn.pattern,
        patternScale: drawn.patternScale,
        patternCells: blobCells(drawn.patternScale),
        period: periodIndex(time, drawn.patternPeriod),
        terminator: terminatorSines(drawn),
        blobThreshold: [
          blobThreshold(covers[0]),
          blobThreshold(covers[1]),
          blobThreshold(covers[2]),
        ],
        blobFloor: [floor(covers[0]), floor(covers[1]), floor(covers[2])],
        cover: covers,
        convective: share,
        ice: ice ? 1 : 0,
        deep: 0,
      }
    },
    sample(direction, sun, time) {
      const cover = (k: number): number =>
        scenarioCoverage(drawn, k, direction, time, sun)
      return {
        cover: [cover(0), cover(1), cover(2)],
        convective: share,
        ice: ice ? 1 : 0,
        deep: 0,
      }
    },
  }
}

/**
 * A named regime as a weather: the scenario's layers as levels, its pattern
 * as the climate. Every level turns at the regime's eastward wind over the
 * body's radius; its northward wind is not drawn.
 */
export function regimeWeather(body: Body, regime: ScenarioId): BodyWeather {
  const scenario = WEATHER_SCENARIOS[regime]
  if (scenario.layers.length > MAX_CLOUD_LAYERS)
    throw new Error(
      `weatherClimate: ${regime} has ${scenario.layers.length} layers, and a weather has ${MAX_CLOUD_LAYERS} levels`,
    )
  const rate = body.radius > 0 ? scenario.wind.east / body.radius : 0
  return {
    seed: deriveSeed(body.surface.seed, 'weather'),
    datumRadius: body.radius,
    levels: [levelOf(scenario, 0), levelOf(scenario, 1), levelOf(scenario, 2)],
    climate: regimeClimate(scenario),
    turn: [rate, rate, rate],
    drift: WEATHER_AXIAL_DRIFT,
  }
}

/* ------------------------------------------------------------------------- */
/* A world's own: the levels                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The three levels as shares of the air's scale height (§5.3): low
 * 0.08–0.30 H, middle 0.40–0.70 H, high 0.95–1.30 H, which on Earth's
 * 8.5 km are 0.7–2.6, 3.4–6.0 and 8.1–11.1 km.
 */
export const LEVEL_HEIGHTS: readonly (readonly [number, number])[] = [
  [0.08, 0.3],
  [0.4, 0.7],
  [0.95, 1.3],
]
const LEVEL_GENERA: readonly (readonly [CloudGenus, CloudGenus])[] = [
  ['stratocumulus', 'cumulus'],
  ['altostratus', 'altocumulus'],
  ['cirrus', 'cirrus'],
]
/**
 * A wet world with no air record is given Earth's scale height. No body the
 * universe generates is one; a hand-made record could be.
 */
const FALLBACK_SCALE_HEIGHT = 8500

/** A world's three levels from its air's scale height. */
export function climateLevels(
  body: Body,
): readonly [LevelSpec, LevelSpec, LevelSpec] {
  const height = body.atmosphere?.scaleHeight ?? FALLBACK_SCALE_HEIGHT
  const level = (k: number): LevelSpec => ({
    base: LEVEL_HEIGHTS[k]![0] * height,
    top: LEVEL_HEIGHTS[k]![1] * height,
    stratiform: LEVEL_GENERA[k]![0],
    cumuliform: LEVEL_GENERA[k]![1],
  })
  return [level(0), level(1), level(2)]
}

/**
 * Each level's zonal wind at the equator, m/s: 8, 15 and 25 (§5.3). A
 * level turns at its wind over the body's radius.
 */
export const CLIMATE_WINDS: readonly [number, number, number] = [8, 15, 25]

/* ------------------------------------------------------------------------- */
/* A world's own: the zonal law                                               */
/* ------------------------------------------------------------------------- */

/**
 * The zonal law of §5.3, per level k, at latitude φ under a sub-solar
 * latitude δ:
 *
 *     cover_k = base_k + itcz_k·G(φ − φ_I) − dry_k·[G(φ − φ_H) + G(φ + φ_H)]
 *                      + storm_k·[G(φ − φ_S) + G(φ + φ_S)]
 *     convective_k = saturate(κ_k·G(φ − φ_I))
 *
 * with `G(x) = exp(−x²/2w²)`, `φ_I = ι·δ` and `φ_S = φ_H + 20°`. Angles are
 * radians.
 */
export interface ZonalLaw {
  readonly base: readonly [number, number, number]
  readonly itcz: readonly [number, number, number]
  readonly dry: readonly [number, number, number]
  readonly storm: readonly [number, number, number]
  /** κ: each level's convective share at the convergence zone's center. */
  readonly convective: readonly [number, number, number]
  /** ι: the convergence zone's latitude over the sun's. */
  readonly follow: number
  /** φ_H, the Hadley cell's edge. */
  readonly hadley: number
  /** φ_S, the storm tracks' latitude. */
  readonly storms: number
  /** w, every Gaussian's width. */
  readonly width: number
}

const DEGREE = Math.PI / 180

/** Earth's sidereal day, s: the rotation the law's Hadley edge is quoted at. */
export const EARTH_SIDEREAL_DAY = 86_164.0905
/** φ_H at Earth's rotation. */
export const EARTH_HADLEY_EDGE = 30 * DEGREE
/**
 * How the Hadley edge widens as a body turns slower: φ_H ∝ Ω^−p. The
 * exponent is Held and Hou's (1980) axisymmetric one, φ_H ∝ 1/Ω, which
 * Kaspi and Showman's (2015) sweep of rotation rates is reported to agree
 * with; their own fitted exponent is not transcribed here, and the edge is
 * clamped, so a slow rotator's cell is near-global rather than unbounded.
 */
export const HADLEY_EXPONENT = 1
export const HADLEY_EDGE_RANGE = [12 * DEGREE, 80 * DEGREE] as const
/** φ_S − φ_H. */
export const STORM_OFFSET = 20 * DEGREE

/**
 * The law's amplitudes, ι and the width, fitted to ISCCP-H's zonal table
 * (`isccpZonal.generated.ts`, 2007–2016): every month of the twelve bands
 * from 60°S to 60°N, each level's cover as a satellite sees it from above
 * (a level under higher ones counts only where they are clear, the three
 * overlapped at random, plan §3) and the total, in least squares weighted
 * by each band's area, the total twice. Each month's sun is the sub-solar
 * latitude on its 15th, and the synoptic factor is integrated over its
 * spread, so the fit is of the cover the field draws, not of the law's
 * mean. `weatherCalibration.test.ts` recomputes the fit's figures and
 * holds them.
 *
 * - The global mean is 0.640 against ISCCP-H's 0.6475; the levels are
 *   0.237, 0.179 and 0.224 against 0.226, 0.190 and 0.232.
 * - No band's annual total from 40°S to 40°N is more than 0.051 off. From
 *   40° to 60° the law is 0.046 to 0.070 under in the south and 0.062 to
 *   0.068 over in the north, because it is symmetric about the equator and the southern
 *   ocean is cloudier than the northern continents. The difference is the
 *   land's, which is phase 3's.
 * - ι is fitted to the bands' seasons, which move with the sun by 0.30 of
 *   the sub-solar latitude; the month by month residual of the total is
 *   0.056 RMS and 0.146 at worst, the northern subtropics' summer, whose
 *   dry season is the continents' again.
 * - The high level has no dry belt (its amplitude fits to zero): ISCCP-H's
 *   high cloud is nearly flat over the subtropics.
 * - Poleward of 60° the law holds what its storm tracks leave and does not
 *   fit the polar bands; those are declared in the rubric's row 16.
 *
 * κ has no source in the table, which counts cover and not convection, and
 * stays a stand-in. The Hadley edge is held at 30° rather than fitted.
 */
export const EARTH_ZONAL_LAW: ZonalLaw = {
  base: [0.2867, 0.1482, 0.0873],
  itcz: [0.0545, 0.0691, 0.2424],
  dry: [0.0308, 0.063, 0],
  storm: [0.3355, 0.2587, 0.1742],
  convective: [2, 1, 0],
  follow: 0.2975,
  hadley: EARTH_HADLEY_EDGE,
  storms: EARTH_HADLEY_EDGE + STORM_OFFSET,
  width: 13.84 * DEGREE,
}

/** φ_H of a body turning once in `rotationPeriod` seconds, either way round. */
export function hadleyEdge(rotationPeriod: number): number {
  const [least, greatest] = HADLEY_EDGE_RANGE
  const period = Math.abs(rotationPeriod)
  if (!(period > 0) || !Number.isFinite(period)) return greatest
  const edge =
    EARTH_HADLEY_EDGE * (period / EARTH_SIDEREAL_DAY) ** HADLEY_EXPONENT
  return Math.min(greatest, Math.max(least, edge))
}

/** A body's zonal law: Earth's amplitudes, its own Hadley edge and storm tracks. */
export function zonalLaw(body: Body): ZonalLaw {
  const hadley = hadleyEdge(body.rotationPeriod)
  return { ...EARTH_ZONAL_LAW, hadley, storms: hadley + STORM_OFFSET }
}

/** `terminatorSines` with no terminator: sines no sun reaches. */
const NO_TERMINATOR: readonly [number, number] = [2, 3]

const gaussian = (x: number, width: number): number =>
  Math.exp((-0.5 * x * x) / (width * width))

const saturate = (x: number): number => Math.min(1, Math.max(0, x))

/** Latitude of a body-fixed direction, radians; +Y is the spin axis. */
const latitudeOf = (direction: Vec3): number => {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  return length > 0
    ? Math.asin(Math.min(1, Math.max(-1, direction.y / length)))
    : 0
}

/** The zonal law's cover and convective share at a latitude under a sub-solar latitude, the synoptic field left out. */
export function zonalClimate(
  law: ZonalLaw,
  latitude: number,
  subsolar: number,
): {
  readonly cover: readonly [number, number, number]
  readonly convective: readonly [number, number, number]
} {
  const convergence = law.follow * subsolar
  const g = (center: number): number => gaussian(latitude - center, law.width)
  const zone = g(convergence)
  const dry = g(law.hadley) + g(-law.hadley)
  const storm = g(law.storms) + g(-law.storms)
  const cover = (k: number): number =>
    law.base[k]! +
    law.itcz[k]! * zone -
    law.dry[k]! * dry +
    law.storm[k]! * storm
  const convective = (k: number): number => saturate(law.convective[k]! * zone)
  return {
    cover: [cover(0), cover(1), cover(2)],
    convective: [convective(0), convective(1), convective(2)],
  }
}

/**
 * The synoptic field's lattice, meters: one base-noise cell (§5.3). A
 * lattice this coarse may be read from an absolute direction (rule 58
 * binds fine ones).
 */
export const SYNOPTIC_CELL = 1_000_000

/**
 * The synoptic factor at a body-fixed unit direction, `1 + ½·(n − ½)` with
 * `n` the base noise on its 1,000 km lattice turned with the low level: the
 * fronts and highs the zonal law leaves out, a quarter either side of it.
 */
export function synopticFactor(
  direction: Vec3,
  radius: number,
  angle: number,
): number {
  const turned = unturn(direction, angle)
  const scale = radius / SYNOPTIC_CELL
  const n = baseNoiseTexture({
    x: turned.x * scale,
    y: turned.y * scale,
    z: turned.z * scale,
  })
  return 1 + 0.5 * (n - 0.5)
}

/**
 * A zonal law under a sub-solar latitude as `ClimateCoefficients.law`'s
 * sixteen numbers: rows low, middle and high of `[base, itcz, dry, storm]`,
 * then `[φ_I, φ_H, φ_S, w]` with `φ_I = ι·δ`.
 */
export function packZonalLaw(law: ZonalLaw, subsolar: number): number[] {
  const row = (k: number): number[] => [
    law.base[k]!,
    law.itcz[k]!,
    law.dry[k]!,
    law.storm[k]!,
  ]
  return [
    ...row(0),
    ...row(1),
    ...row(2),
    law.follow * subsolar,
    law.hadley,
    law.storms,
    law.width,
  ]
}

function zonalClimateOf(body: Body, lowRate: number): BodyClimate {
  const law = zonalLaw(body)
  const radius = body.radius
  return {
    kind: 'zonal',
    coefficients(sun) {
      return {
        kind: 'zonal',
        law: packZonalLaw(law, latitudeOf(sun)),
        pattern: 'uniform',
        patternScale: 0,
        patternCells: blobCells(0),
        period: [0, 0],
        terminator: NO_TERMINATOR,
        blobThreshold: [0, 0, 0],
        blobFloor: [0, 0, 0],
        cover: [0, 0, 0],
        convective: law.convective,
        ice: 0,
        deep: 0,
      }
    },
    sample(direction, sun, time) {
      const zonal = zonalClimate(law, latitudeOf(direction), latitudeOf(sun))
      const factor = synopticFactor(direction, radius, turnAngle(lowRate, time))
      const cover = (k: number): number => saturate(zonal.cover[k]! * factor)
      return {
        cover: [cover(0), cover(1), cover(2)],
        convective: zonal.convective,
        // No temperature profile until phase 4, so nothing says where the
        // middle level freezes; and no level of the law is cumulonimbus.
        ice: 0,
        deep: 0,
      }
    },
  }
}

/**
 * A body's own weather; null where `wetWorld` is false. Derived, stored
 * nowhere (rule 17). Its levels follow its air's scale height and its
 * climate is the zonal law at its own rotation.
 */
export function bodyWeather(body: Body): BodyWeather | null {
  if (!wetWorld(body)) return null
  const turn = CLIMATE_WINDS.map((wind) =>
    body.radius > 0 ? wind / body.radius : 0,
  ) as unknown as Triple
  return {
    seed: deriveSeed(body.surface.seed, 'weather'),
    datumRadius: body.radius,
    levels: climateLevels(body),
    climate: zonalClimateOf(body, turn[0]),
    turn,
    drift: WEATHER_AXIAL_DRIFT,
  }
}
