import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import {
  aspectRatio,
  blobCells,
  blobThreshold,
  BLOB_MEAN,
  type BodyWeather,
  type ClimateCoefficients,
  type CloudGenus,
  bodyWeather,
  CLIMATE_REGIME,
  CLOUD_GENERA,
  type CloudExtents,
  cloudExtents,
  cloudsServed,
  commonPeriod,
  driftOffset,
  type Extent,
  type FieldClock,
  fieldClock,
  GENUS_TABLE,
  genusProfileMean,
  levelProfile,
  PROFILE_HEIGHTS,
  PROFILE_ROWS,
  readLevelProfile,
  horizonBasis,
  latticeOrigin,
  mesoscalePhases,
  type Lens,
  type LevelProfile,
  type LevelSpec,
  type LevelUpdate,
  levelFrames,
  MIE_DROPLETS,
  periodIndex,
  reducePoint,
  reduceTurns,
  regimeWeather,
  type RenderBody,
  type RenderPlacement,
  type RenderScene,
  type ShellHeights,
  shellHeights,
  shellUnion,
  terminatorSines,
  turnBack,
  verticalFov,
  WEATHER_SCENARIOS,
  type WeatherScenario,
} from '@inertialref/rendering'
// Types only: this module reaches no Three at runtime, as `bodyUniforms.ts`.
import type { AtmosphereScattering } from './atmosphereLuts.ts'
import {
  cloudFieldKey,
  type CloudLevers,
  cloudResetKey,
  type CloudWeather,
} from './cloudLevers.ts'

/*
 * A frame's cloud state, built on the CPU from what the engine holds inside
 * `sensor.render()`: the body the trace serves, its heights and sun in
 * float64, every eye-anchored cache's frame, the regime and why it reset.
 * Three-free, so every rule a frame depends on is testable in Node; the
 * uniform bundle copies the result into the GPU's numbers mechanically
 * (`cloudUniforms.ts`).
 */

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Everything the frame is built from, read off the engine inside `sensor.render()`. */
export interface CloudFrameInputs {
  readonly levers: CloudLevers
  /** `engine.scene()`. */
  readonly scene: RenderScene
  /** `engine.bodyFor`: `rotationPeriod`, for the sun under a synthetic clock. */
  readonly record: (address: string) => Body | null
  /** `scatteringOf(engine, body)`. */
  readonly scattering: (body: RenderBody) => AtmosphereScattering | null
  /** `engine.snapshot.renderTime` (rule 38). */
  readonly renderTime: number
  /** `engine.visibilityProcessing`: sunlight staged to 1. */
  readonly visibility: boolean
  /** This frame's processing is 'enhanced'. */
  readonly enhanced: boolean
  readonly pictureEpoch: number
  /** The sensor's own. */
  readonly historyKey: string
  /** Render space, unjittered. */
  readonly camera: { readonly position: Vec3; readonly quaternion: Quat }
  readonly lens: Lens
  readonly css: Extent
  readonly render: Extent
  /** This render call's seconds. */
  readonly delta: number
  /**
   * The world clock's own rate, seconds of world time a second of the wall's
   * (`WorldSnapshot.timeScale`): what a call's step of the field's time is
   * expected to be, times `delta`. 1 where a caller has no clock.
   */
  readonly rate: number
}

/** One level of a body's weather, as the uniforms copy it: every number float64-formed. */
export interface CloudLevelFrame {
  /** Meters over the datum. An absent level has no thickness, at the union's top. */
  readonly base: number
  readonly top: number
  /** Reference in-cloud extinction, 1/m. */
  readonly sigma: number
  /** Reference effective radius, µm, and the level's least and greatest. */
  readonly radius: number
  readonly radiusRange: readonly [least: number, greatest: number]
  /** 1/(1 − f_δ) and 1 − g′ at the reference radius. */
  readonly gain: number
  readonly transport: number
  /** One cell of the base noise, meters, and how far the detail eats the edge. */
  readonly cell: number
  readonly erosion: number
  /** The level's first row in the profile table. */
  readonly profileRow: number
  /** The class's first row in the phase atlas, its row count, and its first row's radius, µm. */
  readonly phaseRow: number
  readonly phaseRows: number
  readonly phaseRadius: number
  /** The level's turn about the spin axis, R_y(−ω·t), row-major, and ω itself, rad/s. */
  readonly turn: readonly number[]
  readonly turnRate: number
  /** The noises' origins for the level, reduced in float64, meters. */
  readonly noiseOrigin: Vec3
  readonly detailOrigin: Vec3
  /** The level's mean in-cloud optical depth where it is stratiform, and where it is cumuliform. */
  readonly meanDepth: readonly [stratiform: number, cumuliform: number]
  /**
   * Each of the mesoscale displacement's six waves' phase at the eye,
   * radians in [0, 2π), float64 (`mesoscalePhases`): what the clipmap's bake
   * adds `k·M·offset` to. Absent, every phase is zero: a frame written by
   * hand still types, and draws the waves about its eye.
   */
  readonly mesoscale?: readonly number[]
}

/** A body's climate as its uniforms take it: the zonal law, or a regime's pattern. */
export interface CloudClimateFrame {
  readonly kind: 'regime' | 'zonal' | 'measured'
  /** The zonal law's sixteen coefficients, row-major; zeros under a regime. */
  readonly law: readonly number[]
  /** A regime's pattern: how its cover varies, a band's or a blob's angular size, and the blob cells a face edge. */
  readonly pattern: 'uniform' | 'bands' | 'blobs'
  readonly patternScale: number
  readonly patternCells: number
  /** `periodIndex(time, the pattern's period)`: the two u32 halves a blob cell is hashed with. */
  readonly period: readonly [number, number]
  /** The terminator's sines, full and clear (`terminatorSines`). */
  readonly terminator: readonly [number, number]
  /** Each level's u32 blob threshold, and its cover between blobs. */
  readonly blobThreshold: readonly [number, number, number]
  readonly blobFloor: readonly [number, number, number]
  /** Each level's mean cover and cumuliform share under a regime, 0..1. */
  readonly cover: readonly [number, number, number]
  readonly convective: readonly [number, number, number]
  /** The middle level's ice share, and the deep-convection rate, 0..1. */
  readonly ice: number
  readonly deep: number
  /**
   * Each level's two genera, stratiform and cumuliform: what its convective
   * share blends between, and what the profile table's rows of the level are
   * built from (`levelProfile`).
   */
  readonly genera: readonly [
    readonly [CloudGenus, CloudGenus],
    readonly [CloudGenus, CloudGenus],
    readonly [CloudGenus, CloudGenus],
  ]
}

export interface CloudBodyFrame {
  readonly address: string
  /** True meters (`RenderBody.trueRadius`). */
  readonly datumRadius: number
  /** `placement.compression`. */
  readonly compression: number
  /** Render axes → body-fixed: the conjugate of `RenderBody.orientation`. */
  readonly toBodyFixed: Quat
  /**
   * Body-fixed true meters: conj(q)·(eye − center)/compression, float64,
   * plus the synthetic path under force 'fly'.
   */
  readonly eye: Vec3
  /**
   * Body-fixed unit: the true direction from the body's center to the key
   * star (`trueSun`), turned about the spin axis by the synthetic interval
   * under 'scrub' and 'warp'.
   */
  readonly sun: Vec3
  readonly shells: ShellHeights
  readonly scattering: AtmosphereScattering | null
  readonly limb: number
  readonly limbFalloff: number
  /** keyColor × (visibility ? 1 : sunlight), as the ground's. */
  readonly dayColor: Rgb
  /*
   * Phase 0's lookup, which the fine march's medium reads until it reads each
   * level's turn: one origin for every layer, and one drift built in the
   * eye's tangent basis, so the field it draws turns with the eye. Each level
   * carries the body's own turn beside them (`levels`), and the history
   * reprojects by that.
   */
  /** `reducePoint(eye, base period)`. */
  readonly noiseOrigin: Vec3
  /** `reducePoint(eye, detail period)`. */
  readonly detailOrigin: Vec3
  /** `driftOffset(wind, time, base period)`. */
  readonly drift: Vec3
  /** Body-fixed m/s at the eye, in its tangent basis. */
  readonly wind: Vec3
  /** Six levels, 250 m × 2^k. */
  readonly clipmap: LevelUpdate
  /** Levels 50/200/800 m. */
  readonly volume: LevelUpdate
  /**
   * The weather's identity: a regime's id, or 'climate'. Every bake that
   * holds this body's field starts over when it changes, and a change is a
   * `'field'` reset.
   */
  readonly weatherKey: string
  /** The body's own weather's levels, each in its own noise frame (`weatherLevels`). */
  readonly levels: readonly [CloudLevelFrame, CloudLevelFrame, CloudLevelFrame]
  readonly climate: CloudClimateFrame
}

export type CloudRegime = 'converging' | 'immediate'
/**
 * Why the history restarts, a discontinuity each (phase 1 design §4.7):
 *
 * - `'first'`: no previous frame. Every cache is built.
 * - `'field'`: the weather, the served or second body, or a size the caches
 *   are laid out by (`cloudFieldKey`). Every cache is rebuilt from no
 *   previous frame.
 * - `'picture'`: the picture's epoch, the sensor's history key, or a lever
 *   that changes what the history means and not the field. The caches stand:
 *   the field is a function of body, place and time, and a cut that keeps
 *   all three leaves it as it was.
 * - `'jump'`: the field's time moved by a step the clock's rate does not
 *   explain. Each bake reads `jump` and starts over itself.
 * - `'resize'`: the trace's or the history's extent.
 * - `'cut'`, `'force'`: the levers' forced cut and reset. The caches stand.
 *
 * The camera's motion is none of these: the history rejects per pixel what
 * it cannot reproject (`cloudHistory.ts`), so a turn or a descent past a
 * layer's boundary costs the pixels it moves and switches nothing.
 */
export type CloudResetReason =
  'none' | 'first' | 'field' | 'picture' | 'jump' | 'resize' | 'cut' | 'force'

export interface CloudCameraFrame {
  readonly right: Vec3
  readonly up: Vec3
  /** Body-fixed. */
  readonly forward: Vec3
  readonly halfTan: number
  readonly aspect: number
  /** Radians a trace texel subtends vertically. */
  readonly pixelAngle: number
}

export interface CloudFrame {
  readonly levers: CloudLevers
  readonly scenario: WeatherScenario
  readonly served: CloudBodyFrame
  readonly second: CloudBodyFrame | null
  /** The instant the field is drawn at; synthetic under force. */
  readonly time: number
  /** time − previous.time: the field's own Δt, which the history turns each level by. */
  readonly frameSeconds: number
  /** `periodIndex(time, scenario.patternPeriod)`. */
  readonly period: readonly [number, number]
  readonly camera: CloudCameraFrame
  readonly previousCamera: CloudCameraFrame | null
  /** Eye − previous eye, body-fixed, float64. */
  readonly translation: Vec3
  readonly enhanced: boolean
  readonly regime: CloudRegime
  readonly reset: CloudResetReason
  /** The field's time moved discontinuously. */
  readonly jump: boolean
  /** +1 a render call: the jitter's and the interleave's. */
  readonly frameIndex: number
  readonly extents: CloudExtents
  /*
   * What the next frame compares against and no other field carries. Each is
   * optional only so a frame written by hand still types; one `cloudFrame`
   * did not build reads as a changed picture and an eye that has flown
   * nowhere.
   */
  /** The picture epoch this frame was built under: a change is a 'picture' reset. */
  readonly pictureEpoch?: number
  /** The sensor's history key this frame was built under: a change is a 'picture' reset. */
  readonly historyKey?: string
  /**
   * The synthetic path force 'fly' has carried the eye, served body-fixed
   * true meters, accumulated a step a call from the call `fly` was set.
   */
  readonly flown?: Vec3
}

/* ------------------------------------------------------------------------- */
/* Layouts                                                                    */
/* ------------------------------------------------------------------------- */

/** The clipmap's levels, 250 m × 2^k, each a toroidal window of 256² texels (`cloudClipmap.ts`). */
export const CLOUD_CLIPMAP_TEXELS = [250, 500, 1000, 2000, 4000, 8000] as const
export const CLOUD_CLIPMAP_SIZE = 256

/*
 * The volume's layout and the base noise's cells a period, restated from
 * `cloudVolume.ts` and `cloudNoise.ts`: those modules reach Three at runtime
 * and this one does not. `cloudFrame.test.ts` holds each copy to its source.
 */
const VOLUME_TEXELS = [50, 200, 800] as const
const VOLUME_SIZE = 256
const BASE_CELLS = 8

/**
 * The base and detail noises' periods for a scenario, meters: the least that
 * each layer's own period divides, so one reduced origin serves every layer
 * (`commonPeriod`). A base period is eight of a layer's cells. The detail
 * noise tiles once a base cell — its 32 texels hold four detail cells, each a
 * quarter of a base cell, which is where §5.6 fades it in.
 */
export function cloudNoisePeriods(scenario: WeatherScenario): {
  readonly base: number
  readonly detail: number
} {
  const cells = scenario.layers.map((layer) => layer.cellMeters)
  return {
    base: commonPeriod(cells.map((cell) => cell * BASE_CELLS)),
    detail: commonPeriod(cells),
  }
}

/* ------------------------------------------------------------------------- */
/* A regime as a body's weather                                               */
/* ------------------------------------------------------------------------- */

/** The regime a lever's weather draws: the one it names, or the climate's own. */
export function weatherScenario(weather: CloudWeather): WeatherScenario {
  return WEATHER_SCENARIOS[weather === 'climate' ? CLIMATE_REGIME : weather]
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1] as const

/** A level's numbers apart from its noise frame. */
type LevelNumbers = Omit<
  CloudLevelFrame,
  'turn' | 'turnRate' | 'noiseOrigin' | 'detailOrigin'
>

/** The droplets' rows of the phase atlas, a gain and a transport of one: the unscaled medium. */
const DROPLETS = {
  gain: 1,
  transport: 1,
  phaseRow: 0,
  phaseRows: MIE_DROPLETS.radii,
  phaseRadius: MIE_DROPLETS.radiusMin,
} as const

/** A level with no thickness at `height` and nothing in it, as `ShellHeights` lays an absent one out. */
const emptyLevel = (height: number): LevelNumbers => ({
  ...DROPLETS,
  base: height,
  top: height,
  sigma: 0,
  radius: 10,
  radiusRange: [10, 10],
  cell: 1,
  erosion: 0,
  profileRow: 0,
  meanDepth: [0, 0],
})

/** A regime's layer `k` as a level's numbers: the layer's own, one radius through it. */
function regimeLevel(scenario: WeatherScenario, k: number): LevelNumbers {
  const layer = scenario.layers[k]
  if (layer === undefined) return emptyLevel(shellUnion(scenario).top)
  const depth =
    layer.sigma * (layer.top - layer.base) * genusProfileMean(layer.genus)
  return {
    ...DROPLETS,
    base: layer.base,
    top: layer.top,
    sigma: layer.sigma,
    radius: layer.radius,
    radiusRange: [layer.radius, layer.radius],
    cell: layer.cellMeters,
    erosion: layer.erosion,
    profileRow: CLOUD_GENERA.indexOf(layer.genus),
    meanDepth: [depth, depth],
  }
}

/**
 * A fitted climate's level as numbers: the CPU field's own (`levelProfile`),
 * so the frame and the oracle the drawn field is held to agree on σ, the
 * radius, the cell and the erosion. The table encodes σ and the radius as
 * shares of its own greatest, so the reference is that greatest, and each
 * end's mean depth is the table's mean channel as the GPU reads its byte.
 */
function genusLevel(spec: LevelSpec): LevelNumbers {
  if (!(spec.top > spec.base)) return emptyLevel(spec.top)
  const profile = levelProfile(spec)
  const thickness = spec.top - spec.base
  const depth = (v: number): number =>
    profile.scaled * thickness * readLevelProfile(profile, 0, v)[1]
  return {
    ...DROPLETS,
    base: spec.base,
    top: spec.top,
    sigma: profile.scaled,
    radius: profile.radius,
    radiusRange: [leastRadius(profile), profile.radius],
    cell: profile.cell,
    erosion: profile.erosion,
    profileRow: CLOUD_GENERA.indexOf(spec.stratiform),
    meanDepth: [depth(0), depth(1)],
  }
}

/** The least radius a profile's table holds where it holds cloud, µm. */
function leastRadius(profile: LevelProfile): number {
  const { texels } = profile
  let least = 255
  for (let at = 0; at < PROFILE_ROWS * PROFILE_HEIGHTS * 4; at += 4)
    if (texels[at]! > 0) least = Math.min(least, texels[at + 3]!)
  return (profile.radius * least) / 255
}

/**
 * A scenario's layers as a body's three levels. Each number is the layer's
 * own: one radius through the level, a gain and a transport of one, no turn,
 * the droplets' rows of the phase atlas for every genus, and the profile's
 * row the genus's index. An absent layer sits at the union's top with no
 * thickness and nothing in it, as `ShellHeights` lays out its boundaries.
 * The stand-in a hand-built frame draws; `cloudFrame` builds each body's
 * levels from its own weather (`weatherLevels`).
 */
export function scenarioLevels(
  scenario: WeatherScenario,
  origins: { readonly noise: Vec3; readonly detail: Vec3 },
): CloudBodyFrame['levels'] {
  const level = (k: number): CloudLevelFrame => ({
    ...regimeLevel(scenario, k),
    turn: IDENTITY,
    turnRate: 0,
    noiseOrigin: origins.noise,
    detailOrigin: origins.detail,
  })
  return [level(0), level(1), level(2)]
}

/**
 * The weather a body draws under the lever, and the regime whose layers give
 * its levels their numbers: null under a fitted climate, whose levels are
 * the genus table's. No record leaves the body a regime with no weather to
 * turn it, and its levels stand still.
 */
export type DrawnWeather =
  | { readonly weather: BodyWeather | null; readonly regime: WeatherScenario }
  | { readonly weather: BodyWeather; readonly regime: null }

/**
 * The lever's weather on a body: a named regime held over it, or its own.
 * A body with no weather of its own (a dry one a lever forces by address)
 * draws its own as the climate regime, as phase 0 drew every body. A wet
 * world's own is its fitted climate (`bodyWeather`), which is no regime:
 * its levels are drawn from the genus table, not from a scenario's layers.
 */
export function drawnWeather(
  lever: CloudWeather,
  record: Body | null,
): DrawnWeather {
  if (record === null) return { weather: null, regime: weatherScenario(lever) }
  if (lever !== 'climate')
    return {
      weather: regimeWeather(record, lever),
      regime: WEATHER_SCENARIOS[lever],
    }
  const own = bodyWeather(record) ?? regimeWeather(record, CLIMATE_REGIME)
  return {
    weather: own,
    regime:
      own.climate.kind === 'regime' ? WEATHER_SCENARIOS[CLIMATE_REGIME] : null,
  }
}

/**
 * A body's levels at an instant, each in its own noise frame: its turn about
 * the spin axis and its drift along it from the weather's clock, and the
 * origins `latticeOrigin` reduces at the eye by the level's own periods. A
 * base period is eight of the level's cells and a detail period one, where
 * each noise tiles.
 *
 * Nothing here is the observer's (phase 1 design §5.3). The eye enters only
 * as the point a float32 offset is measured from, and `origin_k + M_k·(p −
 * eye)` is `M_k·p + ŷ·drift` reduced, for any eye. A drift built in the
 * eye's tangent basis (`horizonBasis`) turns the whole lattice as the eye
 * moves at a held instant; that is the bridge the fine march reads
 * (`CloudBodyFrame.drift`), and no level reads it.
 */
export function weatherLevels(
  drawn: DrawnWeather,
  time: number,
  eye: Vec3,
): CloudBodyFrame['levels'] {
  const { weather } = drawn
  const clock: FieldClock =
    weather === null
      ? { turn: [0, 0, 0], drift: 0, time }
      : fieldClock(weather, time)
  const level = (k: number): CloudLevelFrame => {
    const numbers =
      drawn.regime !== null
        ? regimeLevel(drawn.regime, k)
        : genusLevel(drawn.weather.levels[k]!)
    const angle = clock.turn[k]!
    return {
      ...numbers,
      turn: turnBack(angle),
      turnRate: weather?.turn[k] ?? 0,
      noiseOrigin: latticeOrigin(
        eye,
        angle,
        clock.drift,
        numbers.cell * BASE_CELLS,
      ),
      detailOrigin: latticeOrigin(eye, angle, clock.drift, numbers.cell),
      mesoscale: mesoscalePhases(clock, k, eye, numbers.cell),
    }
  }
  return [level(0), level(1), level(2)]
}

/**
 * A climate's coefficients as the frame carries them, with the genera each
 * level's convective share blends between: what the profile table's rows of
 * the level are built from.
 */
function climateFrame(
  coefficients: ClimateCoefficients,
  genera: CloudClimateFrame['genera'],
): CloudClimateFrame {
  return {
    kind: coefficients.kind,
    law: coefficients.law,
    pattern: coefficients.pattern,
    patternScale: coefficients.patternScale,
    patternCells: coefficients.patternCells,
    period: coefficients.period,
    terminator: coefficients.terminator,
    blobThreshold: coefficients.blobThreshold,
    blobFloor: coefficients.blobFloor,
    cover: coefficients.cover,
    convective: coefficients.convective,
    ice: coefficients.ice,
    deep: coefficients.deep,
    genera,
  }
}

/**
 * A body's climate as its uniforms take it: the weather's own coefficients
 * under the body's sun at the instant (`BodyClimate.coefficients`), which the
 * cube's climate node evaluates at every texel. A body with no weather draws
 * the lever's regime.
 */
export function weatherClimate(
  drawn: DrawnWeather,
  time: number,
  sun: Vec3,
): CloudClimateFrame {
  if (drawn.weather === null) return scenarioClimate(drawn.regime!, time)
  const { weather } = drawn
  return climateFrame(
    weather.climate.coefficients(sun, time),
    [0, 1, 2].map((k) => {
      const { stratiform, cumuliform } = weather.levels[k]!
      return [stratiform, cumuliform] as const
    }) as unknown as CloudClimateFrame['genera'],
  )
}

/**
 * A scenario as the three members of a body's frame that are its weather:
 * its id as the key, its layers as the levels, its pattern as the climate.
 */
export function scenarioWeather(
  scenario: WeatherScenario,
  origins: { readonly noise: Vec3; readonly detail: Vec3 },
  time: number,
): Pick<CloudBodyFrame, 'weatherKey' | 'levels' | 'climate'> {
  return {
    weatherKey: scenario.id,
    levels: scenarioLevels(scenario, origins),
    climate: scenarioClimate(scenario, time),
  }
}

/**
 * A scenario's pattern as a body's climate, at an instant: what
 * `regimeWeather`'s climate answers to `coefficients`, so a body with no
 * record draws the regime a body with one does. Blobs are drawn as a uniform
 * cover at the layer's coverage, as `regimeWeather` draws them: a blob cell
 * is 96 km, and a stance inside one sees a whole sky of cloud or none.
 */
export function scenarioClimate(
  scenario: WeatherScenario,
  time: number,
): CloudClimateFrame {
  const blobs = scenario.pattern === 'blobs'
  const pattern = blobs ? 'uniform' : scenario.pattern
  const patternScale = blobs ? 0 : scenario.patternScale
  const cover = (k: number): number =>
    Math.min(1, Math.max(0, scenario.layers[k]?.coverage ?? 0))
  const floor = (k: number): number =>
    Math.max(0, (cover(k) - BLOB_MEAN) / (1 - BLOB_MEAN))
  const convective = (k: number): number => {
    const genus = scenario.layers[k]?.genus
    return genus !== undefined && GENUS_TABLE[genus].cumuliform ? 1 : 0
  }
  const genus = (k: number): CloudGenus => scenario.layers[k]?.genus ?? 'stratus'
  const middle = scenario.layers[1]?.genus
  return {
    kind: 'regime',
    law: new Array<number>(16).fill(0),
    pattern,
    patternScale,
    patternCells: blobCells(patternScale),
    period: periodIndex(time, blobs ? 0 : scenario.patternPeriod),
    terminator: terminatorSines(scenario),
    blobThreshold: [
      blobThreshold(cover(0)),
      blobThreshold(cover(1)),
      blobThreshold(cover(2)),
    ],
    blobFloor: [floor(0), floor(1), floor(2)],
    cover: [cover(0), cover(1), cover(2)],
    convective: [convective(0), convective(1), convective(2)],
    ice: middle !== undefined && GENUS_TABLE[middle].class === 'ice' ? 1 : 0,
    deep: 0,
    genera: [
      [genus(0), genus(0)],
      [genus(1), genus(1)],
      [genus(2), genus(2)],
    ],
  }
}

/* ------------------------------------------------------------------------- */
/* The rules' thresholds                                                      */
/* ------------------------------------------------------------------------- */

/**
 * A step of the field's time off the one the clock's rate explains by more
 * than the larger of these is a jump: a second, or four times the explained
 * step. The scale holds a warp's own frame-to-frame jitter at any rate of the
 * dock's ladder; the floor holds a paused or held clock's, where the
 * explained step is nothing.
 */
const JUMP_FLOOR = 1
const JUMP_SCALE = 4
/**
 * Calls a second `fly`'s step is sized for: flySpeed/60 meters a call, so a
 * held loop moves the eye the same amount every frame whatever its rate.
 */
const FLY_RATE = 60

const POLE: Vec3 = { x: 0, y: 1, z: 0 }
const WHITE: Rgb = { r: 1, g: 1, b: 1 }
const NO_LEVELS: LevelUpdate = { frames: [], dirty: [], rebuilt: [] }

/* ------------------------------------------------------------------------- */
/* The bodies                                                                 */
/* ------------------------------------------------------------------------- */

/** True meters from the body's center to `eye`, a render-space point. */
const trueDistance = (body: RenderBody, eye: Vec3): number =>
  Vec.distance(eye, body.placement.position) / body.placement.compression

const larger = (a: RenderBody | null, b: RenderBody): RenderBody =>
  a === null || b.placement.angularRadius > a.placement.angularRadius ? b : a

/**
 * The body the trace serves: the one whose air the eye is inside, else the
 * largest by angular radius among those with weather; `forced` wins.
 *
 * Both of the first two are among the bodies with weather: the eye in a dry
 * world's air serves the largest wet one in its sky, if any. A forced
 * address that is not in the scene serves nothing, so a measurement never
 * silently prices another body.
 */
export function servedBody(
  bodies: readonly RenderBody[],
  eye: Vec3,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null {
  if (forced !== null)
    return bodies.find((body) => body.address === forced) ?? null
  let inside: RenderBody | null = null
  let deepest = 1
  let largest: RenderBody | null = null
  for (const body of bodies) {
    if (!wet(body)) continue
    const depth = trueDistance(body, eye) / (body.airTop * body.trueRadius)
    if (depth < deepest) {
      inside = body
      deepest = depth
    }
    largest = larger(largest, body)
  }
  return inside ?? largest
}

/** The second clouded body: forced, or the largest other one with weather; never the served one. */
function secondBody(
  bodies: readonly RenderBody[],
  served: RenderBody,
  wet: (body: RenderBody) => boolean,
  forced: string | null,
): RenderBody | null {
  if (forced !== null) {
    const found = bodies.find((body) => body.address === forced)
    return found === undefined || found.address === served.address
      ? null
      : found
  }
  let largest: RenderBody | null = null
  for (const body of bodies)
    if (body.address !== served.address && wet(body))
      largest = larger(largest, body)
  return largest
}

/**
 * Where a placed object truly is from the scene's eye, render axes, meters:
 * its direction from the eye, which compression keeps (rule 28), at its true
 * distance, which the placement carries beside its compressed one. Null for
 * an object at the eye, which has no direction.
 */
function trueOffset(placement: RenderPlacement, eye: Vec3): Vec3 | null {
  const offset = Vec.sub(placement.position, eye)
  const length = Vec.length(offset)
  return length === 0 ? null : Vec.scale(offset, placement.distance / length)
}

/**
 * The key star's true direction from the body's center, render axes: the
 * star's true offset from the eye less the body's, which is the difference
 * of the simulation's own positions to float64's rounding.
 *
 * Not the difference of the two render positions. Compression keeps
 * directions from the eye and nothing else, and the star stands at a
 * compressed distance, so from the body's center in render space it carries
 * the parallax of the center's offset from the eye over the star's render
 * distance: 2.04° on P222_1_0_7 III's dusk picture, where the star stands 28
 * radii out, which put a sun 1.5° under the horizon 0.5° over it and cleared
 * a layer that ends at the terminator from the whole frame.
 */
function trueSun(body: RenderBody, scene: RenderScene): Vec3 | null {
  const key = scene.stars[0]
  if (key === undefined) return null
  const eye = scene.camera.position
  const star = trueOffset(key.placement, eye)
  const center = trueOffset(body.placement, eye)
  if (star === null) return null
  const toStar = center === null ? star : Vec.sub(star, center)
  return Vec.length(toStar) === 0 ? null : Vec.normalize(toStar)
}

/**
 * The body-fixed sun: the true one (`trueSun`), turned under a synthetic
 * clock.
 *
 * Under 'scrub' and 'warp' the field's instant runs ahead of the world's,
 * and a body turns under a sun that, over a few hours, holds still: so the
 * sun turns the other way about the body's pole (+Y in its own axes, the
 * spin evaluator's axis) by the interval over the sidereal day, the turn
 * reduced first so a long scrub never asks sin and cos of a large angle.
 * The body's own orbital motion over that interval, 0.12° for Earth over
 * 3 h, is left out.
 */
function bodySun(
  body: RenderBody,
  scene: RenderScene,
  time: number,
  renderTime: number,
): Vec3 {
  const toStar = trueSun(body, scene)
  // A body on its star, or a scene with no star, has no sun to face; a zero
  // vector normalized would be NaN across every sample.
  const sun =
    toStar === null ? POLE : Q.rotate(Q.conjugate(body.orientation), toStar)
  const period = body.rotationPeriod
  const interval = time - renderTime
  if (interval === 0 || !Number.isFinite(period) || period === 0) return sun
  const turns = reduceTurns(interval, Math.abs(period)) * Math.sign(period)
  return Q.rotate(Q.fromAxisAngle(POLE, -2 * Math.PI * turns), sun)
}

/** What every body's frame is built from this call. */
interface Context {
  readonly inputs: CloudFrameInputs
  /** The lever's regime: what the bridged lookup's periods are the least common of. */
  readonly scenario: WeatherScenario
  readonly weatherKey: string
  readonly periods: { readonly base: number; readonly detail: number }
  readonly time: number
}

/**
 * One body's frame. The served body carries its caches' frames, scrolled from
 * `caches` or rebuilt from none; a second body has no eye-anchored caches —
 * it is drawn by its far march alone — and gets empty ones. Each body draws
 * its own weather under the lever (`drawnWeather`): its levels, the shells
 * they bound and its climate.
 */
function bodyFrame(
  context: Context,
  body: RenderBody,
  eye: Vec3,
  caches: CloudBodyFrame | null | 'none',
): CloudBodyFrame {
  const { inputs, scenario, time } = context
  const datumRadius = body.trueRadius
  const sun = bodySun(body, inputs.scene, time, inputs.renderTime)
  const drawn = drawnWeather(inputs.levers.weather, inputs.record(body.address))
  const levels = weatherLevels(drawn, time, eye)
  const shells = shellHeights(
    eye,
    datumRadius,
    levels.flatMap((level) => [level.base, level.top]),
  )
  const { east, north } = horizonBasis(eye)
  const wind = Vec.add(
    Vec.scale(east, scenario.wind.east),
    Vec.scale(north, scenario.wind.north),
  )
  const key = inputs.scene.stars[0]
  const color = key?.color ?? WHITE
  const gain = inputs.visibility ? 1 : body.sunlight
  const served = caches !== 'none'
  return {
    address: body.address,
    datumRadius,
    compression: body.placement.compression,
    toBodyFixed: Q.conjugate(body.orientation),
    eye,
    sun,
    shells,
    scattering: inputs.scattering(body),
    limb: body.limb,
    limbFalloff: body.limbFalloff,
    dayColor: { r: color.r * gain, g: color.g * gain, b: color.b * gain },
    noiseOrigin: reducePoint(eye, context.periods.base),
    detailOrigin: reducePoint(eye, context.periods.detail),
    drift: driftOffset(wind, time, context.periods.base),
    wind,
    clipmap: served
      ? levelFrames(
          eye,
          datumRadius,
          CLOUD_CLIPMAP_TEXELS,
          CLOUD_CLIPMAP_SIZE,
          caches?.clipmap.frames ?? null,
        )
      : NO_LEVELS,
    volume: served
      ? levelFrames(
          eye,
          datumRadius,
          VOLUME_TEXELS,
          VOLUME_SIZE,
          caches?.volume.frames ?? null,
        )
      : NO_LEVELS,
    weatherKey: context.weatherKey,
    levels,
    climate: weatherClimate(drawn, time, sun),
  }
}

/** The eye in a body's own axes, true meters from its center, carried `flown` (render axes). */
function eyeOf(body: RenderBody, eye: Vec3, flown: Vec3): Vec3 {
  const fromCenter = Vec.scale(
    Vec.sub(eye, body.placement.position),
    1 / body.placement.compression,
  )
  return Q.rotate(Q.conjugate(body.orientation), Vec.add(fromCenter, flown))
}

/* ------------------------------------------------------------------------- */
/* Time, the camera and the regime                                            */
/* ------------------------------------------------------------------------- */

/**
 * The instant the field is drawn at. The world's under every force but two:
 * 'scrub' steps the field by `scrubSeconds` a call and 'warp' by
 * `delta·warp`, each from the last frame's instant, and neither touches the
 * world's clock. A first frame starts at the world's.
 */
function frameTime(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
): number {
  if (previous === null) return inputs.renderTime
  const { force, scrubSeconds, warp } = inputs.levers
  if (force === 'scrub') return previous.time + scrubSeconds
  if (force === 'warp') return previous.time + inputs.delta * warp
  return inputs.renderTime
}

/**
 * Whether the field's time moved by a step the clock's rate does not
 * explain: off `rate·delta` by more than a second or four of that step.
 * The rate is the world clock's own (`CloudFrameInputs.rate`), or the
 * lever's under 'warp'; every frame is a jump under 'scrub'. A steady warp
 * at any rate of the dock's ladder is then continuous, and a scrub, a
 * planetarium's held instant moved, or a clock that stepped without its rate
 * saying so is a jump.
 *
 * The expected step is not `delta` alone: under the game's own warp from
 * 100× a 60 Hz frame's step of world time passes `max(1 s, 4·delta)`, and
 * every frame would take the reset path, the immediate regime and every
 * cache rebuilt, at the rates a player warps at (phase 1 design §4.7).
 */
function jumped(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
  time: number,
): boolean {
  if (previous === null) return false
  const { force, warp } = inputs.levers
  if (force === 'scrub') return true
  const rate = force === 'warp' ? warp : inputs.rate
  const expected = rate * inputs.delta
  return (
    Math.abs(time - previous.time - expected) >
    Math.max(JUMP_FLOOR, JUMP_SCALE * Math.abs(expected))
  )
}

/** The camera's basis in the served body's axes, and the trace's ray budget. */
function cameraFrame(
  inputs: CloudFrameInputs,
  toBodyFixed: Quat,
  extents: CloudExtents,
): CloudCameraFrame {
  const turn = Q.multiply(toBodyFixed, inputs.camera.quaternion)
  const halfTan = Math.tan(verticalFov(inputs.lens) / 2)
  return {
    right: Q.rotate(turn, { x: 1, y: 0, z: 0 }),
    up: Q.rotate(turn, { x: 0, y: 1, z: 0 }),
    forward: Q.rotate(turn, { x: 0, y: 0, z: -1 }),
    halfTan,
    aspect: aspectRatio(inputs.css),
    pixelAngle: (2 * Math.atan(halfTan)) / extents.trace.height,
  }
}

/**
 * The synthetic path under 'fly': this call's step along the camera's
 * forward laid flat on the eye's horizontal, added to the path carried from
 * the last call if it was flying the same body too. A camera looking
 * straight up or down has no horizontal heading and takes no step.
 */
function flight(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
  served: RenderBody,
  eye: Vec3,
  forward: Vec3,
): Vec3 {
  if (inputs.levers.force !== 'fly') return Vec.ZERO
  const carried =
    previous !== null &&
    previous.levers.force === 'fly' &&
    previous.served.address === served.address
      ? (previous.flown ?? Vec.ZERO)
      : Vec.ZERO
  const up = Vec.normalize(Vec.add(eye, carried))
  const level = Vec.sub(forward, Vec.scale(up, Vec.dot(forward, up)))
  const length = Vec.length(level)
  if (length < 1e-9) return carried
  return Vec.add(
    carried,
    Vec.scale(level, inputs.levers.flySpeed / FLY_RATE / length),
  )
}

const sameExtent = (a: Extent, b: Extent): boolean =>
  a.width === b.width && a.height === b.height

const sameExtents = (a: CloudExtents, b: CloudExtents): boolean =>
  sameExtent(a.render, b.render) &&
  sameExtent(a.css, b.css) &&
  sameExtent(a.trace, b.trace) &&
  sameExtent(a.history, b.history)

/** Whether the field changed: the weather, a body, or a size the caches are laid out by. */
function fieldChanged(
  inputs: CloudFrameInputs,
  previous: CloudFrame,
  served: RenderBody,
  second: RenderBody | null,
): boolean {
  return (
    cloudFieldKey(inputs.levers) !== cloudFieldKey(previous.levers) ||
    served.address !== previous.served.address ||
    (second?.address ?? null) !== (previous.second?.address ?? null)
  )
}

/** Whether what the history holds changed under the same field: a cut. */
function pictureChanged(
  inputs: CloudFrameInputs,
  previous: CloudFrame,
): boolean {
  return (
    cloudResetKey(inputs.levers) !== cloudResetKey(previous.levers) ||
    inputs.pictureEpoch !== previous.pictureEpoch ||
    inputs.historyKey !== previous.historyKey
  )
}

/** Why the history resets: the first reason that holds, the costliest first. */
function resetReason(
  force: CloudLevers['force'],
  checks: {
    readonly first: boolean
    readonly field: boolean
    readonly picture: boolean
    readonly resize: boolean
    readonly jump: boolean
  },
): CloudResetReason {
  if (checks.first) return 'first'
  if (checks.field) return 'field'
  if (checks.picture) return 'picture'
  if (checks.resize) return 'resize'
  if (checks.jump) return 'jump'
  if (force === 'cut') return 'cut'
  if (force === 'reset' || force === 'scrub') return 'force'
  return 'none'
}

/* ------------------------------------------------------------------------- */
/* The frame                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * The frame, or null when `levers.on` is false or no body is served.
 *
 * On a first frame and a `'field'` reset every eye-anchored level, the
 * clipmap's and the volume's, is built from no previous frame: what the
 * caches hold is another field's. Every other reset keeps them, and a level
 * rebuilds only where its anchor moved (`levelFrames`).
 */
export function cloudFrame(
  inputs: CloudFrameInputs,
  previous: CloudFrame | null,
): CloudFrame | null {
  const { levers } = inputs
  if (!levers.on) return null
  // The served set: wet, and no authored deck to lose. A body outside it is
  // drawn only where a lever forces it by address.
  const wet = (body: RenderBody): boolean => {
    const record = inputs.record(body.address)
    return record !== null && cloudsServed(record)
  }
  const eyeRender = inputs.camera.position
  const servedAt = servedBody(
    inputs.scene.bodies,
    eyeRender,
    wet,
    levers.served,
  )
  if (servedAt === null) return null
  const secondAt = secondBody(inputs.scene.bodies, servedAt, wet, levers.second)
  const scenario = weatherScenario(levers.weather)
  const time = frameTime(inputs, previous)
  const jump = jumped(inputs, previous, time)
  const extents = cloudExtents(inputs.render, inputs.css, levers.traceScale)
  const toBodyFixed = Q.conjugate(servedAt.orientation)
  const camera = cameraFrame(inputs, toBodyFixed, extents)
  const trueEye = eyeOf(servedAt, eyeRender, Vec.ZERO)
  const flown = flight(inputs, previous, servedAt, trueEye, camera.forward)
  const sameServed =
    previous !== null && previous.served.address === servedAt.address
  const field =
    previous !== null && fieldChanged(inputs, previous, servedAt, secondAt)
  const context: Context = {
    inputs,
    scenario,
    weatherKey: levers.weather,
    periods: cloudNoisePeriods(scenario),
    time,
  }
  const rebuild = previous === null || field
  const flownRender = Q.rotate(servedAt.orientation, flown)
  const served = bodyFrame(
    context,
    servedAt,
    Vec.add(trueEye, flown),
    rebuild ? null : previous.served,
  )
  const second =
    secondAt === null
      ? null
      : bodyFrame(
          context,
          secondAt,
          eyeOf(secondAt, eyeRender, flownRender),
          'none',
        )
  const translation = sameServed
    ? Vec.sub(served.eye, previous.served.eye)
    : Vec.ZERO
  const previousCamera = sameServed ? previous.camera : null
  const reset = resetReason(levers.force, {
    first: previous === null,
    field,
    picture: previous !== null && pictureChanged(inputs, previous),
    resize: previous !== null && !sameExtents(previous.extents, extents),
    jump,
  })
  return {
    levers,
    scenario,
    served,
    second,
    time,
    frameSeconds: previous === null ? 0 : time - previous.time,
    period: periodIndex(time, scenario.patternPeriod),
    camera,
    previousCamera,
    translation,
    enhanced: inputs.enhanced,
    regime: reset === 'none' ? 'converging' : 'immediate',
    reset,
    jump,
    frameIndex: previous === null ? 0 : previous.frameIndex + 1,
    extents,
    pictureEpoch: inputs.pictureEpoch,
    historyKey: inputs.historyKey,
    flown,
  }
}
