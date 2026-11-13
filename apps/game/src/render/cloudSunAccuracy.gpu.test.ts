import { cloudSunFn } from './cloudSunlight.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
} from 'three/webgpu'
import {
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  length,
  Loop,
  max,
  select,
  storage,
  uint,
  uniform,
} from 'three/tsl'
import {
  type BodyWeather,
  bodyWeather,
  cloudFieldAt,
  fieldClock,
  regimeWeather,
  type ScenarioId,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import {
  type Quat,
  Quaternion as Q,
  type Vec3,
  Vec,
} from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { altitudeAt, shellCrossingFrom, sunMuAt } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget, CloudSample } from './cloudNodes.ts'
import {
  LOOKING_UP,
  RIG_EARTH,
  RIG_EARTH_RADIUS,
  type RigStance,
  rigFrameInputs,
} from './cloudSystemRig.ts'
import landed from './cloudSunAccuracy.landed.json' with { type: 'json' }
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * The sun grid's optical depth against a march through the field (§5.5):
 * T_cloud's error at in-cloud samples, at lightTaps 2, 4, 6 and 8, in seven
 * regimes under three suns.
 *
 * **The population.** A regime is scored at five places, and the places
 * are the field's own. Sixty-four directions are drawn by a seed between
 * 60° S and 60° N (a pole is a special place, where a level's texture stands
 * still under the rigid turn), each is read on the CPU field the frame
 * draws (`cloudFieldAt`, resolved, at a sixth of the samples), and the five
 * that hold cloud at the most of them are taken, in the order they were
 * drawn. A regime's pattern does not say where its cloud is: fair cumulus
 * and the anvil draw one cover over the whole body, and a place chosen
 * "under a blob" of the pattern stood under 2% of cloud. The samples are
 * columns over a disc 22.5 km about the eye, eight heights through each
 * level: the light reads the grid a kilometer sunward of a sample, and that
 * point is inside the grid's weight, which ends 24 km out along its axes,
 * whichever way the disc is turned to them. The columns are 937.5 m apart,
 * and closer in the two regimes whose cloud is a small share of their
 * level, so that every regime's five places hold in-cloud samples in the
 * tens of thousands (`ACROSS`). Every sample the field
 * holds cloud at, and whose sun ray clears the ground, is scored: the
 * light's T_cloud, its taps and then the grid's optical depth beyond them,
 * against exp(−∫σ·f ds) by 256 steps of the same field medium through each
 * stretch of the ray inside a level, f the medium's fraction, as the grid
 * stores σ·f. A ray has up to two stretches a level: down to the level's
 * base, or through the level whole where it never reaches that base, and up
 * from the base to the level's top. Under the horizon a ray leaves a deck
 * through its base and comes back up through it 300 km sunward, and 256
 * steps over that whole chord would put a dozen in the deck. Every sample is
 * resolved, its footprint 0.
 *
 * **The suns** are phase 0's two, 37.5° and 5°, and the dusk cornerstone's,
 * 1.5° under the horizon. `dusk-altocumulus`, the cornerstone's own regime,
 * holds cloud only where the sun is low and is scored under the third alone.
 * Under the horizon a case is scored twice: with the grid's bake stopping
 * where a ray leaves a level downward, as it ships, and with its 32 steps
 * run to the far crossing of the union's top (`toFirstExit`), which is
 * recorded beside it and held to nothing.
 *
 * **A sample is in cloud where the CPU field's extinction there is over
 * 10⁻⁷ per meter,** a depth of a ten-thousandth in a kilometer. The GPU's
 * own field is not asked: where a density comes down to nothing two
 * adapters round it to either side, and a count taken there is a tie.
 * `cloudFieldAt` in float64 says the same on every machine, so a case's
 * count is held exactly. The two fields' disagreements are counted beside
 * it (`fieldsDisagree`: in cloud to one and clear to the other) and held
 * under a fortieth of the in-cloud samples, three times this Mac mini's
 * most (0.83%, altocumulus): a rig whose turn, clock or sun parted from the
 * CPU's would score clear air.
 *
 * **A case is a regime, a sun and a place,** and its figures are its RMS,
 * its bias, its worst sample and its 99th percentile, with the same four by
 * ring: within 4 km of the eye, 4 to 6.4 km, and beyond. A point sample at a
 * cloud's edge takes the far end of the transmittance range against a cell
 * of 400 m, so the worst sample is near one wherever a field is broken; the
 * percentile is the tail a bound can hold.
 *
 * **Every figure is held to the landed one.** `cloudSunAccuracy.landed.json`
 * is this instrument's own document, written by a run under
 * IR_CLOUD_MEASURE=1 on the Mac mini (Mac18,5, Apple M6) and committed. A
 * case's RMS, its bias, its worst sample and its percentile may each pass
 * the landed value by a tenth and no more, or stand under a thousandth of
 * the sun. A few cases run in every `pnpm test:gpu` (`ALWAYS`); every
 * case runs under the flag, which also writes
 * `.data/clouds/sunAccuracy.json`. **Every bar is asserted on every
 * adapter.** The figures are this Mac mini's, and whether CI's hosted
 * adapter reproduces them is not measured: the tenth is what it has to
 * stand inside. Only the rebuild's timing asks for timestamps.
 *
 * **The taps alone** are recorded beside each case under the flag and held
 * to nothing: the
 * march's taps with the reference's own march of the field from where they
 * end, in the cache's place. What that misses is the taps', their widths
 * and the one column they are mixed as; what the case misses beyond it is
 * the cache's, the volume it sums and the crossing under the horizon.
 *
 * **A union of three levels** is scored apart (`UNION`), because no regime
 * above has one: the world's own climate, 0.7 to 11.1 km on Earth, where
 * the grid's 32 heights stand 335 m apart and a climbing ray's 32 steps are
 * a kilometer each under a 15° sun, beside fair cumulus, whose one level
 * gives them 45 m. Under suns of 45° and 15°, by the sample's level, two
 * depths are held against the reference's march: the cache's at the sample
 * itself, and the depth to the sun the march's light reads through four
 * taps, each as a transmittance and as a depth cut at 16. Under the flag
 * the same is recorded with a climbing ray's steps spent inside the levels
 * (`CloudSunGrid.stepsInLevels`) and held to nothing.
 *
 * **The early out's bill** is recorded beside each case and held to
 * nothing: the share of its samples whose cached depth, the grid's at the
 * sample as a march reads it, is past 4, 6 and 8, the share of the case's
 * summed reference transmittance those samples hold, and the most any one
 * of them holds. A march that takes no taps where the cache says dark gives
 * up that share of first order's light.
 *
 * The bounds tighten and are never loosened. A change that moves a figure
 * replaces the landed document in the commit that moves it, so the diff
 * shows the old figure and the new.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
/**
 * The grid's heights (`CloudSunGrid.heights`): 32, as it ships, unless a run
 * under the flag asks for another. A run at another count is a measurement,
 * and its document is not the landed one.
 */
const HEIGHTS = Number(process.env.IR_CLOUD_SUN_HEIGHTS ?? 32)
const OUT = '.data/clouds/sunAccuracy.json'
const REBUILD_OUT = '.data/clouds/sunRebuild.json'
/** The adapter the landed figures were taken on is a workstation's: it offers timestamps. */
const WORKSTATION = await adapterOffers('timestamp-query')
/** A figure may pass its landed value by a tenth (phase 1 design §6.3). */
const SLACK = 1.1
/**
 * A figure under a thousandth of the sun is held to that and not to its
 * landed value: under the horizon most cases read a transmittance of nothing
 * as nothing, their figures are 10⁻⁶, and a tenth over one of those is the
 * last bit of a float. A thousandth is a quarter of a display step.
 */
const FLOOR = 1e-3

const CSS = { width: 1024, height: 576 } as const
/** Degrees over the eye's horizon: phase 0's two, and the dusk cornerstone's. */
const SUNS = [37.5, 5, -1.5] as const
/** A regime, or the world's own three levels. */
type Weathered = ScenarioId | 'climate'
const POPULATION: readonly {
  readonly scenario: Weathered
  readonly suns: readonly number[]
}[] = [
  { scenario: 'fair-cumulus', suns: SUNS },
  { scenario: 'two-decks', suns: SUNS },
  { scenario: 'anvil', suns: SUNS },
  { scenario: 'overcast', suns: SUNS },
  { scenario: 'cirrus-over-cumulus', suns: SUNS },
  { scenario: 'altocumulus', suns: SUNS },
  // Its cover ends where the local sun clears the horizon: clear at noon.
  { scenario: 'dusk-altocumulus', suns: [-1.5] },
]
/**
 * The cases every run of the suite takes, each at its regime's first place.
 *
 * Cirrus over cumulus follows the grid's depth: its cirrus is thin, so a
 * fifth of the depth lost moves the bias under the 37.5° sun from 0.0035 to
 * 0.0061 at two taps, where a cloud thick enough that 0.8 of its depth still
 * passes nothing hides the loss. Two decks under the high sun are what
 * follows where a shadow falls: the lower deck is lit or not by the upper
 * one's gaps.
 */
const ALWAYS: typeof POPULATION = [
  { scenario: 'cirrus-over-cumulus', suns: SUNS },
  { scenario: 'two-decks', suns: [37.5] },
]

/**
 * The cases the grid's own depth is read at, by level: the world's climate,
 * three levels from 0.7 to 11.1 km on Earth, beside a regime of one, under
 * the suns the light after first order is judged at.
 */
const UNION_SUNS = [45, 15] as const
const UNION: typeof POPULATION = [
  { scenario: 'climate', suns: UNION_SUNS },
  { scenario: 'fair-cumulus', suns: UNION_SUNS },
]
/** The one of them every run of the suite takes, at its first place. */
const UNION_ALWAYS: typeof POPULATION = [{ scenario: 'climate', suns: [15] }]
/** The depth a comparison of depths is cut at: past it nothing of the light after first order's table is left. */
const DEPTH_CUT = 16
/** In optical depth: under it a depth's figure is held to this and not to its tenth. */
const DEPTH_FLOOR = 0.01

/** The rebuild the instrument times: its field, the runs it takes the median of, and the frames it follows. */
const REBUILD = {
  scenario: 'two-decks',
  sunDegrees: 37.5,
  runs: 5,
  frames: 56,
  steady: 60,
  steadyRuns: 4,
} as const

const TAPS = [2, 4, 6, 8] as const
const REFERENCE_STEPS = 256
const PLACES = 5
/** Degrees: the places stand between this latitude south and north. */
const LATITUDE = 60
const PLACE_SEED = 0x5eed
/**
 * Columns across the disc's diameter: 48, 937.5 m apart, and more in the two
 * regimes whose cloud is a small share of their levels, so that each holds
 * the in-cloud samples the others do. Fair cumulus is 6% of its samples in
 * cloud at every place, one cover over the whole body, and no placement
 * finds more.
 */
const ACROSS: Readonly<Partial<Record<ScenarioId, number>>> = {
  'fair-cumulus': 144,
  anvil: 80,
}
const ACROSS_ELSE = 48
const ACROSS_MOST = 144
const acrossOf = (scenario: Weathered): number =>
  (scenario === 'climate' ? undefined : ACROSS[scenario]) ?? ACROSS_ELSE
/** Directions a regime's places are chosen among, and the columns across the disc each is read at. */
const CANDIDATES = 64
const CANDIDATE_ACROSS = 20
/** Per meter: the extinction of the CPU field a sample is in cloud over. */
const IN_CLOUD = 1e-7
/** Of a case's in-cloud samples: the most the GPU's field and the CPU's may disagree at. */
const FIELDS_APART = 1 / 40
/** The cached depths the early out's bill is taken at. */
const EARLY_OUT = [4, 6, 8] as const
/** Meters: the disc's radius about the eye. */
const REACH = 22_500
/** Meters from the eye: the rings' outer edges. Phase 0's reach, the frame's 50 m level's, the disc's. */
const RINGS = [4000, 6400, REACH] as const
const HEIGHTS_A_LAYER = 8
const EYE = 2
const POINTS = ACROSS_MOST * ACROSS_MOST * HEIGHTS_A_LAYER * 3
/** The rig's instant, the frame's time: what the CPU field's clock is read at. */
const TIME = 50_000
/**
 * Frames the maps take to hold a new weather or a new sun whole: the cube's
 * six faces, then one refresh of the clipmap's six levels at an eighth of a
 * level a frame.
 */
const MAPS_FRAMES = 64
/** Frames a settle rests with nothing owed. */
const REST_FRAMES = 8
const SETTLE_MAX = 400

const R = RIG_EARTH_RADIUS
const radians = (d: number): number => (d * Math.PI) / 180

/** A seeded uniform draw, so a population is the same on every run. */
function draws(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The regimes in the order the rendering package lists them: a regime's place seed is its index. */
const WEATHER_SCENARIO_ORDER = Object.keys(WEATHER_SCENARIOS)

/** The rig's Earth as the frame finds it: what a regime's weather is held over. */
const BODY = rigFrameInputs(
  { eye: EYE, looking: LOOKING_UP },
  DEFAULT_CLOUD_LEVERS,
  CSS,
).record(RIG_EARTH)!

const WEATHERS = new Map<Weathered, BodyWeather>()
function weatherOf(scenario: Weathered): BodyWeather {
  let weather = WEATHERS.get(scenario)
  if (weather === undefined) {
    weather =
      scenario === 'climate'
        ? bodyWeather(BODY)!
        : regimeWeather(BODY, scenario)
    WEATHERS.set(scenario, weather)
  }
  return weather
}

/** Toward the sun from the body's center at an elevation over the rig's eye, render axes. */
const sunToward = (elevation: number): Vec3 => ({
  x: 0,
  y: Math.sin(radians(elevation)),
  z: -Math.cos(radians(elevation)),
})

/** The samples of a lattice the CPU field holds cloud at, resolved, under a body-fixed sun. */
function clouded(
  weather: BodyWeather,
  sun: Vec3,
  points: Pick<Lattice, 'fromCenter' | 'count'>,
): number[] {
  const clock = fieldClock(weather, TIME)
  const found: number[] = []
  for (let k = 0; k < points.count; k += 1) {
    const at = cloudFieldAt(
      weather,
      clock,
      sun,
      {
        x: points.fromCenter[3 * k]!,
        y: points.fromCenter[3 * k + 1]!,
        z: points.fromCenter[3 * k + 2]!,
      },
      0,
    )
    if (at.fraction * at.sigma > IN_CLOUD) found.push(k)
  }
  return found
}

const PLACED = new Map<Weathered, readonly Vec3[]>()

/**
 * The body-fixed directions a regime is scored over: of `CANDIDATES` drawn
 * uniformly over the sphere between the two latitudes, the five whose disc
 * holds cloud at the most samples of the CPU field, under the regime's
 * first sun, in the order they were drawn. Float64 on the CPU, so the
 * places are the same on every machine.
 */
function placesOf(scenario: Weathered, elevation: number): readonly Vec3[] {
  const held = PLACED.get(scenario)
  if (held !== undefined) return held
  const weather = weatherOf(scenario)
  const next = draws(PLACE_SEED + WEATHER_SCENARIO_ORDER.indexOf(scenario))
  const band = Math.sin(radians(LATITUDE))
  const candidates = Array.from({ length: CANDIDATES }, (_, order) => {
    const y = (2 * next() - 1) * band
    const longitude = 2 * Math.PI * next()
    const ring = Math.sqrt(1 - y * y)
    const direction = {
      x: Math.cos(longitude) * ring,
      y,
      z: Math.sin(longitude) * ring,
    }
    const turn = turnOnto(direction)
    const sun = Q.rotate(Q.conjugate(turn), sunToward(elevation))
    const points = lattice(weather, turn, CANDIDATE_ACROSS)
    return {
      direction,
      clouded: clouded(weather, sun, points).length,
      order,
    }
  })
  const places = candidates
    .sort((a, b) => b.clouded - a.clouded || a.order - b.order)
    .slice(0, PLACES)
    .sort((a, b) => a.order - b.order)
    .map(({ direction }) => direction)
  PLACED.set(scenario, places)
  return places
}

/** The turn that carries a body-fixed direction onto the render's +Y, over which the rig's eye stands. */
function turnOnto(direction: Vec3): Quat {
  const up = { x: 0, y: 1, z: 0 }
  const axis = Vec.cross(direction, up)
  const sine = Vec.length(axis)
  if (sine < 1e-12) return Q.IDENTITY
  return Q.fromAxisAngle(
    Vec.scale(axis, 1 / sine),
    Math.atan2(sine, Vec.dot(direction, up)),
  )
}

interface Lattice {
  /** Eye-relative and body-fixed, four floats a sample, the fourth unused. */
  readonly offsets: Float32Array
  /** Meters along the ground from the eye to each sample's column. */
  readonly ground: Float64Array
  /** Each sample from the body's center, body-fixed, float64: what a ground test reads. */
  readonly fromCenter: Float64Array
  /** Each sample's level among the weather's three. */
  readonly level: Uint8Array
  readonly count: number
}

/**
 * The samples, float64 then float32: a column `d` meters out along the
 * ground stands on the sphere, its height's point (R + h)·(sin φ, cos φ)
 * from the center at φ = d/R, less the eye's.
 */
function lattice(weather: BodyWeather, turn: Quat, across: number): Lattice {
  const most = across * across * HEIGHTS_A_LAYER * 3
  const offsets = new Float32Array(most * 4)
  const ground = new Float64Array(most)
  const fromCenter = new Float64Array(most * 3)
  const level = new Uint8Array(most)
  const back = Q.conjugate(turn)
  let n = 0
  // The weather's own levels: an absent one has no thickness and no samples.
  const heights = weather.levels.flatMap((spec, index) =>
    spec.top > spec.base
      ? Array.from({ length: HEIGHTS_A_LAYER }, (_, k) => ({
          h: spec.base + ((k + 0.5) / HEIGHTS_A_LAYER) * (spec.top - spec.base),
          index,
        }))
      : [],
  )
  for (const { h, index } of heights)
    for (let j = 0; j < across; j += 1)
      for (let i = 0; i < across; i += 1) {
        const x = REACH * ((2 * (i + 0.5)) / across - 1)
        const z = REACH * ((2 * (j + 0.5)) / across - 1)
        const d = Math.hypot(x, z)
        if (d > REACH) continue
        const phi = d / R
        const out = d === 0 ? 0 : ((R + h) * Math.sin(phi)) / d
        const point: Vec3 = {
          x: x * out,
          y: (R + h) * Math.cos(phi),
          z: z * out,
        }
        const fixed = Q.rotate(back, { ...point, y: point.y - (R + EYE) })
        const center = Q.rotate(back, point)
        offsets.set([fixed.x, fixed.y, fixed.z, 0], 4 * n)
        fromCenter.set([center.x, center.y, center.z], 3 * n)
        ground[n] = d
        level[n] = index
        n += 1
      }
  return {
    offsets: offsets.subarray(0, 4 * n),
    ground,
    fromCenter,
    level,
    count: n,
  }
}

/** Whether the ray from a point toward the sun meets the datum: the planet's own shadow. */
function grounded(at: Float64Array, k: number, sun: Vec3): boolean {
  const x = at[3 * k]!
  const y = at[3 * k + 1]!
  const z = at[3 * k + 2]!
  const along = x * sun.x + y * sun.y + z * sun.z
  return along < 0 && x * x + y * y + z * z - along * along < R * R
}

/* ------------------------------------------------------------------------- */

let gpu: GpuSession
let field: CloudField

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  field.grid.heights = HEIGHTS
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

interface Scored {
  readonly samples: number
  readonly rms: number
  /** Mean signed error: positive where the grid passes more sun. */
  readonly bias: number
  readonly worst: number
  /** The 99th percentile of the error's size. */
  readonly p99: number
}

interface Case {
  readonly scenario: string
  readonly sunDegrees: number
  /** The place's index among the regime's five. */
  readonly place: number
  readonly latitude: number
  readonly longitude: number
  /** Samples in the lattice, those the field holds cloud at, and those of them the planet shadows. */
  readonly samples: number
  readonly inCloud: number
  readonly shadowed: number
  /** Samples the GPU's field and the CPU's disagree at: in cloud to one, clear to the other. */
  readonly fieldsDisagree: number
  readonly meanReference: number
  /** By tap count: every scored sample, then each ring's. */
  readonly grid: Readonly<Record<string, Scored>>
  readonly rings: Readonly<Record<string, readonly Scored[]>>
  /** Under the horizon: the same samples with the bake's steps run to the far crossing of the union's top. */
  readonly farCrossing?: Readonly<Record<string, Scored>>
  /** By tap count: the taps over the reference's own march past them, the cache out of it. Recorded, held to nothing. */
  readonly tapsAlone?: Readonly<Record<string, Scored>>
  /** By cached depth: what a march that takes no taps past it gives up. Recorded, held to nothing. */
  readonly earlyOut: Readonly<Record<string, EarlyOut>>
  /** The grid's depth at the sample itself against the marched one, by the sample's level. */
  readonly byLevel: readonly LevelDepth[]
  /** The depth to the sun the march's light reads at four taps, the taps' own and the grid's past them, against the same. */
  readonly throughTaps: readonly LevelDepth[]
  /** Both again, and the case's four-tap figures, with a climbing ray's steps spent inside the levels. Recorded, held to nothing. */
  readonly inLevels?: {
    readonly byLevel: readonly LevelDepth[]
    readonly throughTaps: readonly LevelDepth[]
    readonly grid: Scored
  }
  /**
   * Both depths again through each of the grid's two channels, by a sun
   * that differs only in the pair it reads: the depth of the cells' mean
   * transmittance, and their mean depth. Neither reads the field beside its
   * step, so the two are one program but for the channel. Recorded, held to
   * nothing.
   */
  readonly channels?: Readonly<Record<'opacity' | 'depth', ByChannel>>
  /**
   * Under the horizon, the reference's march in two parts: `near`, to where
   * the ray leaves the sample's level, and `far`, all it meets after. The
   * mean of `far` over the scored samples, as a description; the one
   * number `c` for the far crossing that leaves the least,
   * Σ near²·far / Σ near²; and the floor, the RMS of `near·(far − c)`, the
   * least any one number for the far crossing leaves at this place.
   * Recorded, held to nothing.
   */
  readonly farFloor?: {
    readonly meanFar: number
    readonly best: number
    readonly floor: number
    /** The RMS of `near·far` against the whole march: the split's own error. */
    readonly split: number
  }
}

/** The depth at the sample and through four taps, as read through one of the grid's channels. */
interface ByChannel {
  readonly byLevel: readonly LevelDepth[]
  readonly throughTaps: readonly LevelDepth[]
}

/** The cache's depth at a level's scored samples, no taps before it, against the reference's march. */
interface LevelDepth {
  readonly level: number
  readonly samples: number
  /** `e^(−τ)` of the two, absolute: RMS, and the mean signed error, positive where the grid passes more. */
  readonly transmittance: { readonly rms: number; readonly bias: number }
  /** The two depths themselves, each cut at 16: RMS, and the mean signed error, positive where the grid is deeper. */
  readonly depth: { readonly rms: number; readonly bias: number }
}

/** The samples of a case, or of a row, whose cached depth to the sun is past a threshold. */
interface EarlyOut {
  /** Their count, and the scored samples they are counted among. */
  readonly past: number
  readonly scored: number
  /** The reference transmittance they sum to, and the sum over every scored sample. */
  readonly passed: number
  readonly light: number
  /** The most any one of them passes in the reference. */
  readonly worst: number
  /** `past / scored` and `passed / light`: the shares a march with no taps there gives up. */
  readonly samplesShare: number
  readonly lightShare: number
}

function earlyOutOf(
  parts: readonly Pick<
    EarlyOut,
    'past' | 'scored' | 'passed' | 'light' | 'worst'
  >[],
): EarlyOut {
  const sum = (of: (part: (typeof parts)[number]) => number): number =>
    parts.reduce((total, part) => total + of(part), 0)
  const past = sum((part) => part.past)
  const scored = sum((part) => part.scored)
  const passed = sum((part) => part.passed)
  const light = sum((part) => part.light)
  return {
    past,
    scored,
    passed,
    light,
    worst: Math.max(0, ...parts.map((part) => part.worst)),
    samplesShare: past / Math.max(scored, 1),
    lightShare: passed / Math.max(light, 1e-30),
  }
}

function score(miss: readonly number[]): Scored {
  const n = Math.max(miss.length, 1)
  const sizes = miss.map(Math.abs).sort((a, b) => a - b)
  return {
    samples: miss.length,
    rms: Math.sqrt(miss.reduce((s, v) => s + v * v, 0) / n),
    bias: miss.reduce((s, v) => s + v, 0) / n,
    worst: sizes[sizes.length - 1] ?? 0,
    p99:
      sizes[Math.min(sizes.length - 1, Math.floor(0.99 * sizes.length))] ?? 0,
  }
}

/** Several places' figures as one population: the gate's row. */
function pooled(parts: readonly Scored[]): Scored {
  const n = parts.reduce((s, one) => s + one.samples, 0)
  const sum = (of: (scored: Scored) => number): number =>
    parts.reduce((s, one) => s + of(one) * one.samples, 0)
  return {
    samples: n,
    rms: Math.sqrt(sum((scored) => scored.rms ** 2) / Math.max(n, 1)),
    bias: sum((scored) => scored.bias) / Math.max(n, 1),
    worst: Math.max(0, ...parts.map((one) => one.worst)),
    // A percentile does not pool from its parts: the largest of the places'.
    p99: Math.max(0, ...parts.map((one) => one.p99)),
  }
}

const same = (a: Case, b: Case): boolean =>
  a.scenario === b.scenario &&
  a.sunDegrees === b.sunDegrees &&
  a.place === b.place

/** A depth to the sun at each scored sample, two floats a sample with the depth second, against the reference's, by level. */
function levelDepths(
  points: Lattice,
  lit: readonly number[],
  truth: Float32Array,
  held: Float32Array,
): LevelDepth[] {
  return [0, 1, 2].flatMap((level) => {
    const here = lit.filter(
      (k) => points.level[k] === level && held[2 * k + 1]! >= 0,
    )
    if (here.length === 0) return []
    let passed = 0
    let passedSquare = 0
    let deeper = 0
    let deeperSquare = 0
    for (const k of here) {
      const want = truth[2 * k + 1]!
      const t = Math.exp(-held[2 * k + 1]!) - want
      const d =
        Math.min(held[2 * k + 1]!, DEPTH_CUT) -
        Math.min(-Math.log(want), DEPTH_CUT)
      passed += t
      passedSquare += t * t
      deeper += d
      deeperSquare += d * d
    }
    const n = here.length
    return [
      {
        level,
        samples: n,
        transmittance: { rms: Math.sqrt(passedSquare / n), bias: passed / n },
        depth: { rms: Math.sqrt(deeperSquare / n), bias: deeper / n },
      },
    ]
  })
}

/** The landed figures of a case, or a failure: a case with no bound is a case that cannot fail. */
function landedCase(found: Case, among: readonly Case[]): Case {
  const pinned = among.find((one) => same(one, found))
  if (pinned === undefined)
    throw new Error(
      `no landed figures for ${found.scenario} at ${found.sunDegrees}°, place ${found.place}`,
    )
  return pinned
}

/** Hold a case's every figure to its landed one, at every tap count. */
function hold(
  found: Case,
  among: readonly Case[] = landed.cases as unknown as readonly Case[],
): Case {
  const what = `${found.scenario} at ${found.sunDegrees}°, place ${found.place}`
  const pinned = landedCase(found, among)
  // The population itself, a count the CPU takes: a case that lost its
  // cloud scores nothing, and one the GPU draws elsewhere scores clear air.
  expect(found.inCloud, what).toBe(pinned.inCloud)
  expect(found.fieldsDisagree, what).toBeLessThanOrEqual(
    found.inCloud * FIELDS_APART,
  )
  for (const taps of TAPS) {
    const now = found.grid[taps]!
    const then = pinned.grid[taps]!
    const figures = [
      ['rms', now.rms, then.rms],
      ['bias', Math.abs(now.bias), Math.abs(then.bias)],
      ['worst', now.worst, then.worst],
      ['p99', now.p99, then.p99],
    ] as const
    for (const [name, figure] of figures)
      expect(Number.isFinite(figure), `${what}, ${taps} taps: ${name}`).toBe(
        true,
      )
    for (const [name, figure, bound] of figures)
      expect(figure, `${what}, ${taps} taps: ${name}`).toBeLessThanOrEqual(
        Math.max(bound * SLACK, FLOOR),
      )
  }
  return pinned
}

/** Hold a case's depth by level, and its tap figures, to the landed ones. */
function holdUnion(found: Case): void {
  const what = `${found.scenario} at ${found.sunDegrees}°, place ${found.place}`
  const pinned = hold(
    found,
    (landed as unknown as { union?: { cases: readonly Case[] } }).union
      ?.cases ?? [],
  )
  const read = [
    ['at the sample', found.byLevel, pinned.byLevel],
    ['through four taps', found.throughTaps, pinned.throughTaps],
  ] as const
  for (const [where, nows, thens] of read) {
    expect(nows.map((one) => [one.level, one.samples])).toEqual(
      thens.map((one) => [one.level, one.samples]),
    )
    for (const [index, now] of nows.entries()) {
      const then = thens[index]!
      const figures = [
        [
          'transmittance RMS',
          now.transmittance.rms,
          then.transmittance.rms,
          FLOOR,
        ],
        [
          'transmittance bias',
          Math.abs(now.transmittance.bias),
          Math.abs(then.transmittance.bias),
          FLOOR,
        ],
        ['depth RMS', now.depth.rms, then.depth.rms, DEPTH_FLOOR],
        [
          'depth bias',
          Math.abs(now.depth.bias),
          Math.abs(then.depth.bias),
          DEPTH_FLOOR,
        ],
      ] as const
      for (const [name, figure, bound, floor] of figures)
        expect(
          figure,
          `${what}, level ${now.level}, ${where}: ${name}`,
        ).toBeLessThanOrEqual(Math.max(bound * SLACK, floor))
    }
  }
}

/**
 * Frames of the system's own field, built as the sensor builds them, and a
 * settle that leaves a case's field its own.
 */
function drive(): {
  frameAt(
    stance: RigStance,
    levers: CloudLevers,
    rebuild?: boolean,
    seconds?: number,
  ): CloudFrame
  settle(stance: RigStance, levers: CloudLevers, maps?: boolean): void
} {
  let previous: CloudFrame | null = null
  /** Seconds the field's clock has run since the rig's instant. */
  let clock = 0
  const frameAt = (
    stance: RigStance,
    levers: CloudLevers,
    rebuild = false,
    seconds = 0,
  ): CloudFrame => {
    clock += seconds
    const inputs = rigFrameInputs(stance, levers, CSS)
    const frame = cloudFrame(
      { ...inputs, renderTime: inputs.renderTime + clock },
      previous,
    )
    if (frame === null) throw new Error('no frame: nothing served')
    previous = frame
    // The system's own budget: the `sunSlices` lever caps both caches.
    const budget: CloudBudget = {
      slices: levers.sunSlices,
      tiles: 1,
      jump: frame.jump || rebuild,
      sunSlices: levers.sunSlices,
    }
    field.write(frame)
    field.render(gpu.renderer, frame, budget)
    return frame
  }
  /*
   * A case's field is its own, whatever case ran before it. The maps owe
   * nothing from the frame their levels are redrawn, while those levels
   * still hold texels drawn from cube faces of the last weather or the
   * last sun, and a slice of the volume baked from them holds that field
   * until it is next redrawn. So the maps are given the frames they take
   * to hold this case whole, and then every cache is rebuilt from them.
   */
  const settle = (
    stance: RigStance,
    levers: CloudLevers,
    maps = true,
  ): void => {
    if (maps) {
      for (let n = 0; n < MAPS_FRAMES; n += 1) frameAt(stance, levers)
      frameAt(stance, levers, true)
    }
    let rest = 0
    for (let n = 0; n < SETTLE_MAX; n += 1) {
      frameAt(stance, levers)
      rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
      if (rest >= REST_FRAMES) return
    }
    throw new Error(`the bakes still owe work after ${SETTLE_MAX} frames`)
  }
  return { frameAt, settle }
}

describe('the sun’s optical depth against the field', () => {
  /** Score the grid at every tap count on the real field: each regime at its places, under each of its suns. */
  async function measure(
    population: typeof POPULATION,
    places: number,
    split = true,
  ): Promise<Case[]> {
    const offsets = new StorageBufferAttribute(new Float32Array(POINTS * 4), 4)
    const out = new StorageBufferAttribute(new Float32Array(POINTS * 2), 1)
    const count = uniform(0, 'uint')
    const body = field.uniforms.served

    const sampleOf = (offset: Node<'vec3'>): CloudSample => ({
      offset,
      distance: length(offset),
      altitude: altitudeAt(body, offset),
      sunMu: sunMuAt(body, offset),
      footprint: float(0),
    })
    const pointKernel = (
      scored: (sample: CloudSample) => Node<'float'>,
    ): ComputeNode => {
      const from = storage(offsets, 'vec4', POINTS)
      const into = storage(out, 'float', POINTS * 2)
      return Fn(() => {
        If(instanceIndex.lessThan(count), () => {
          const offset = from.element(instanceIndex).xyz.toVar()
          const sample = sampleOf(offset)
          const medium = field.medium(sample, body)
          const at = instanceIndex.mul(uint(2))
          into.element(at).assign(medium.sigma.mul(medium.fraction))
          into.element(at.add(uint(1))).assign(scored(sample))
        })
      })().compute(POINTS)
    }
    // exp(−∫σ·f ds) by 256 steps of the field through each stretch of the
    // sun's ray inside a level: on its way down to the level's base, or
    // through the level whole, and on its way up from that base. `near` is
    // the stretch of the point's own level from the point to where the ray
    // leaves it, and `far` everything the ray meets after.
    const marched = (
      offset: Node<'vec3'>,
      part: 'whole' | 'near' | 'far' = 'whole',
    ): Node<'float'> => {
      const { sun, layers } = body
      const altitude = altitudeAt(body, offset)
      const tau = float(0).toVar()
      const stretch = (from: Node<'float'>, span: Node<'float'>): void => {
        const start = from.toVar()
        const step = span.div(REFERENCE_STEPS).toVar()
        Loop(REFERENCE_STEPS, ({ i }: { i: Node<'int'> }) => {
          const point = offset.add(
            sun.mul(start.add(float(i).add(0.5).mul(step))),
          )
          const medium = field.medium(sampleOf(point), body)
          tau.addAssign(medium.sigma.mul(medium.fraction).mul(step))
        })
      }
      const levels = [
        [layers.base.x, layers.top.x],
        [layers.base.y, layers.top.y],
        [layers.base.z, layers.top.z],
      ] as const
      for (const [low, high] of levels) {
        const own = altitude.greaterThanEqual(low).and(altitude.lessThan(high))
        const counted = (near: boolean): Node<'float'> =>
          part === 'whole'
            ? float(1)
            : select(near === (part === 'near') ? own : own.not(), 1, 0)
        const top = shellCrossingFrom(body, offset, sun, high)
        const base = shellCrossingFrom(body, offset, sun, low)
        const reached = top.hit.and(high.greaterThan(low))
        const enter = max(top.near, 0)
        const leave = max(top.far, 0)
        // The base is ahead of the ray, or all round it.
        const ahead = base.hit.and(base.far.greaterThan(0))
        const back = max(base.far, 0)
        stretch(
          enter,
          select(
            reached,
            max(select(ahead, max(base.near, 0), leave).sub(enter), 0),
            float(0),
          ).mul(counted(true)),
        )
        stretch(
          back,
          select(reached.and(ahead), max(leave.sub(back), 0), float(0)).mul(
            part === 'near' ? float(0) : float(1),
          ),
        )
      }
      return tau
    }
    const reference = pointKernel((sample) =>
      exp(marched(sample.offset).negate()),
    )
    const nearOnly = pointKernel((sample) =>
      exp(marched(sample.offset, 'near').negate()),
    )
    const farOnly = pointKernel((sample) =>
      exp(marched(sample.offset, 'far').negate()),
    )
    // The march's own taps over that same march from where they end: what
    // of a case's error is the taps' and none of the cache's.
    const tapsOverMarch = cloudSunFn({
      uniforms: field.uniforms,
      medium: field.medium,
      depth: {
        depths: (offset) => {
          const toSun = marched(offset)
          return { toSun, whole: toSun, weight: float(1), behind: float(0) }
        },
      },
    })
    const tapsAlone = pointKernel(
      (sample) => tapsOverMarch(sample, field.medium(sample, body), body).cloud,
    )
    const grid = pointKernel(
      (sample) => field.sun(sample, field.medium(sample, body), body).cloud,
    )
    // The depth to the sun the march's light reads: the taps' own and the
    // cache's past them.
    const source = pointKernel(
      (sample) => field.sun(sample, field.medium(sample, body), body).depth.x,
    )
    // The cache's depth at the sample itself, as a march with no taps reads
    // it, and nothing where the cache holds nothing of the sample.
    const cache = pointKernel((sample) => {
      const cached = field.grid.depths(sample.offset)
      return select(cached.weight.greaterThan(0), cached.toSun, float(-1))
    })
    // The same, and the depth through the taps, through each channel.
    const cacheMean = pointKernel((sample) => {
      const cached = field.grid.depths(sample.offset)
      return select(
        cached.weight.greaterThan(0),
        cached.meanDepthToSun,
        float(-1),
      )
    })
    const throughChannel = (opacity: boolean): ComputeNode => {
      const sun = cloudSunFn({
        uniforms: field.uniforms,
        medium: field.medium,
        depth: {
          depths: (offset) => {
            const cached = field.grid.depths(offset)
            if (!opacity) return cached
            return {
              toSun: cached.toSun,
              weight: cached.weight,
              get whole() {
                return cached.whole
              },
              get behind() {
                return cached.behind
              },
            }
          },
        },
      })
      return pointKernel(
        (sample) => sun(sample, field.medium(sample, body), body).depth.x,
      )
    }
    const sourceByOpacity = throughChannel(true)
    const sourceByDepth = throughChannel(false)

    const { frameAt, settle } = drive()
    const read = async (kernel: ComputeNode): Promise<Float32Array> => {
      await gpu.compute(kernel)
      return new Float32Array(await gpu.readBuffer(out))
    }

    const results: Case[] = []
    for (const { scenario, suns } of population) {
      const stood = placesOf(scenario, suns[0]!).slice(0, places)
      for (const [index, place] of stood.entries()) {
        const turn = turnOnto(place)
        const points = lattice(weatherOf(scenario), turn, acrossOf(scenario))
        ;(offsets.array as Float32Array).set(points.offsets)
        offsets.needsUpdate = true
        count.value = points.count
        for (const elevation of suns) {
          const toward = sunToward(elevation)
          const stance: RigStance = {
            eye: EYE,
            looking: LOOKING_UP,
            turn,
            air: true,
            sun: toward,
          }
          const sun = Q.rotate(Q.conjugate(turn), toward)
          const levers = (lightTaps: (typeof TAPS)[number]): CloudLevers => ({
            ...DEFAULT_CLOUD_LEVERS,
            on: true,
            weather: scenario,
            lightTaps,
          })
          settle(stance, levers(2))
          const truth = await read(reference)
          const inCloud = clouded(weatherOf(scenario), sun, points)
          const held = new Set(inCloud)
          let fieldsDisagree = 0
          for (let k = 0; k < points.count; k += 1)
            if (truth[2 * k]! > 0 !== held.has(k)) fieldsDisagree += 1
          const lit = inCloud.filter(
            (k) => !grounded(points.fromCenter, k, sun),
          )
          const all: Record<string, Scored> = {}
          const rings: Record<string, Scored[]> = {}
          const alone: Record<string, Scored> = {}
          const scoreAt = async (
            count: (typeof TAPS)[number],
            kernel: ComputeNode,
          ): Promise<(k: number) => number> => {
            // The taps are a uniform: one frame writes it, and builds nothing.
            frameAt(stance, levers(count))
            const got = await read(kernel)
            return (k) => got[2 * k + 1]! - truth[2 * k + 1]!
          }
          for (const taps of TAPS) {
            // 1,536 steps of the field a sample at each count: under the flag.
            if (MEASURE && split)
              alone[taps] = score(lit.map(await scoreAt(taps, tapsAlone)))
            const miss = await scoreAt(taps, grid)
            all[taps] = score(lit.map(miss))
            rings[taps] = RINGS.map((edge, ring) => {
              const from = ring === 0 ? 0 : RINGS[ring - 1]!
              return score(
                lit
                  .filter(
                    (k) =>
                      points.ground[k]! >= from && points.ground[k]! < edge,
                  )
                  .map(miss),
              )
            })
          }
          // The early out's bill, on the cache as it ships.
          const cached = await read(cache)
          const light = lit.reduce((sum, k) => sum + truth[2 * k + 1]!, 0)
          const earlyOut = Object.fromEntries(
            EARLY_OUT.map((depth) => {
              const past = lit.filter((k) => cached[2 * k + 1]! > depth)
              return [
                depth,
                earlyOutOf([
                  {
                    past: past.length,
                    scored: lit.length,
                    passed: past.reduce((sum, k) => sum + truth[2 * k + 1]!, 0),
                    light,
                    worst: Math.max(0, ...past.map((k) => truth[2 * k + 1]!)),
                  },
                ]),
              ]
            }),
          )
          // The cache's depth at the sample itself, and the depth the light
          // after first order reads through four taps, by the sample's level.
          const depthsBy = async (
            held: Float32Array,
          ): Promise<{ byLevel: LevelDepth[]; throughTaps: LevelDepth[] }> => {
            frameAt(stance, levers(4))
            const through = await read(source)
            return {
              byLevel: levelDepths(points, lit, truth, held),
              throughTaps: levelDepths(points, lit, truth, through),
            }
          }
          const { byLevel, throughTaps } = await depthsBy(cached)
          let channels: Case['channels']
          if (MEASURE && !split) {
            frameAt(stance, levers(4))
            const of = async (
              at: Float32Array,
              through: ComputeNode,
            ): Promise<ByChannel> => ({
              byLevel: levelDepths(points, lit, truth, at),
              throughTaps: levelDepths(points, lit, truth, await read(through)),
            })
            channels = {
              opacity: await of(cached, sourceByOpacity),
              depth: await of(await read(cacheMean), sourceByDepth),
            }
          }
          // The same with a climbing ray's steps spent inside the levels.
          let inLevels: Case['inLevels']
          if (MEASURE && !split) {
            field.grid.stepsInLevels = true
            settle(stance, levers(2), false)
            const four = score(lit.map(await scoreAt(4, grid)))
            inLevels = { ...(await depthsBy(await read(cache))), grid: four }
            field.grid.stepsInLevels = false
          }
          // Under the horizon, the other bake on the same field and samples.
          let farCrossing: Record<string, Scored> | undefined
          if (elevation < 0) {
            farCrossing = {}
            field.grid.toFirstExit = false
            settle(stance, levers(2), false)
            for (const taps of TAPS)
              farCrossing[taps] = score(lit.map(await scoreAt(taps, grid)))
            field.grid.toFirstExit = true
          }
          // The far crossing's floor, from the reference alone.
          let farFloor: Case['farFloor']
          if (MEASURE && split && elevation < 0 && lit.length > 0) {
            const near = await read(nearOnly)
            const far = await read(farOnly)
            const at = (got: Float32Array, k: number): number => got[2 * k + 1]!
            const meanFar =
              lit.reduce((sum, k) => sum + at(far, k), 0) / lit.length
            const rms = (of: (k: number) => number): number =>
              Math.sqrt(
                lit.reduce((sum, k) => sum + of(k) ** 2, 0) / lit.length,
              )
            // The one number for the far crossing that leaves the least:
            // the error at a sample is near·(far − c), so its RMS is least
            // at the mean of far weighted by near², not at its plain mean.
            const weight = lit.reduce((sum, k) => sum + at(near, k) ** 2, 0)
            const best =
              weight > 0
                ? lit.reduce(
                    (sum, k) => sum + at(near, k) ** 2 * at(far, k),
                    0,
                  ) / weight
                : meanFar
            farFloor = {
              meanFar,
              best,
              floor: rms((k) => at(near, k) * (at(far, k) - best)),
              split: rms((k) => at(near, k) * at(far, k) - truth[2 * k + 1]!),
            }
          }
          results.push({
            scenario,
            sunDegrees: elevation,
            place: index,
            latitude: (Math.asin(place.y) * 180) / Math.PI,
            longitude: (Math.atan2(place.x, place.z) * 180) / Math.PI,
            samples: points.count,
            inCloud: inCloud.length,
            shadowed: inCloud.length - lit.length,
            fieldsDisagree,
            meanReference:
              lit.reduce((s, k) => s + truth[2 * k + 1]!, 0) /
              Math.max(lit.length, 1),
            grid: all,
            rings,
            ...(farCrossing === undefined ? {} : { farCrossing }),
            ...(MEASURE && split ? { tapsAlone: alone } : {}),
            earlyOut,
            byLevel,
            throughTaps,
            ...(inLevels === undefined ? {} : { inLevels }),
            ...(channels === undefined ? {} : { channels }),
            ...(farFloor === undefined ? {} : { farFloor }),
          })
        }
      }
    }

    for (const kernel of [
      reference,
      grid,
      tapsAlone,
      cache,
      source,
      cacheMean,
      sourceByOpacity,
      sourceByDepth,
      nearOnly,
      farOnly,
    ])
      kernel.dispose()
    offsets.dispose()
    out.dispose()
    return results
  }

  it('holds cirrus over cumulus under the three suns, and two decks under the high one, to the landed figures, in every run of the suite', async () => {
    const found = await measure(ALWAYS, 1)
    expect(found.map((one) => [one.scenario, one.sunDegrees])).toEqual(
      ALWAYS.flatMap(({ scenario, suns }) =>
        suns.map((sun) => [scenario, sun]),
      ),
    )
    for (const one of found) hold(one)
  }, 120_000)

  it('holds the grid’s depth against the marched one on the world’s three levels under a 15° sun, by level, in every run of the suite', async () => {
    const found = await measure(UNION_ALWAYS, 1, false)
    expect(found).toHaveLength(1)
    expect(found[0]!.byLevel.map((one) => one.level)).toEqual([0, 1, 2])
    for (const one of found) holdUnion(one)
  }, 120_000)

  it.skipIf(!MEASURE)(
    'holds every case to its landed figures, and writes them',
    async () => {
      const results = await measure(POPULATION, PLACES)
      const union = await measure(UNION, PLACES, false)
      /** A row's levels pooled over its places. */
      const levelsOf = (
        cases: readonly Case[],
        of: (one: Case) => readonly LevelDepth[] = (one) => one.byLevel,
      ): LevelDepth[] =>
        [0, 1, 2].flatMap((level) => {
          const parts = cases.flatMap((one) =>
            of(one).filter((part) => part.level === level),
          )
          const samples = parts.reduce((sum, part) => sum + part.samples, 0)
          if (samples === 0) return []
          const mean = (of: (part: LevelDepth) => number): number =>
            parts.reduce((sum, part) => sum + of(part) * part.samples, 0) /
            samples
          return [
            {
              level,
              samples,
              transmittance: {
                rms: Math.sqrt(mean((part) => part.transmittance.rms ** 2)),
                bias: mean((part) => part.transmittance.bias),
              },
              depth: {
                rms: Math.sqrt(mean((part) => part.depth.rms ** 2)),
                bias: mean((part) => part.depth.bias),
              },
            },
          ]
        })
      // Written before anything is held, so a figure that moved is on disk
      // beside the failure that names it.
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudSunAccuracy.gpu.test.ts: T_cloud through the sun grid against a 256-step march of the field through each stretch of the sun’s ray inside a level, at in-cloud samples the planet does not shadow (phase 1 design §5.5)',
            body: 'Earth',
            eyeMeters: EYE,
            population: {
              placesARegime: PLACES,
              latitudeDegrees: LATITUDE,
              placeSeed: PLACE_SEED,
              placement: `of ${CANDIDATES} seeded directions, the ${PLACES} whose disc holds cloud at the most samples of the CPU field under the regime's first sun`,
              inCloudOverPerMeter: IN_CLOUD,
              columnsAcross: Object.fromEntries(
                POPULATION.map(({ scenario }) => [
                  scenario,
                  acrossOf(scenario),
                ]),
              ),
              reachMeters: REACH,
              ringEdgesMeters: RINGS,
              heightsALayer: HEIGHTS_A_LAYER,
            },
            referenceSteps: REFERENCE_STEPS,
            ...(HEIGHTS === 32 ? {} : { gridHeights: HEIGHTS }),
            units: 'transmittance, absolute',
            pooled: POPULATION.flatMap(({ scenario, suns }) =>
              suns.map((sunDegrees) => {
                const cases = results.filter(
                  (one) =>
                    one.scenario === scenario && one.sunDegrees === sunDegrees,
                )
                const by = (
                  of: (one: Case) => Readonly<Record<string, Scored>>,
                ): Record<string, Scored> =>
                  Object.fromEntries(
                    TAPS.map((taps) => [
                      taps,
                      pooled(cases.map((one) => of(one)[taps]!)),
                    ]),
                  )
                return {
                  scenario,
                  sunDegrees,
                  grid: by((one) => one.grid),
                  tapsAlone: by((one) => one.tapsAlone!),
                  ...(sunDegrees < 0
                    ? { farCrossing: by((one) => one.farCrossing!) }
                    : {}),
                  earlyOut: Object.fromEntries(
                    EARLY_OUT.map((depth) => [
                      depth,
                      earlyOutOf(cases.map((one) => one.earlyOut[depth]!)),
                    ]),
                  ),
                }
              }),
            ),
            cases: results,
            union: {
              note: 'the grid’s depth at the sample itself, no taps before it, against the same march, by the sample’s level; depths cut at 16',
              pooled: UNION.flatMap(({ scenario, suns }) =>
                suns.map((sunDegrees) => {
                  const cases = union.filter(
                    (one) =>
                      one.scenario === scenario &&
                      one.sunDegrees === sunDegrees,
                  )
                  return {
                    scenario,
                    sunDegrees,
                    byLevel: levelsOf(cases),
                    throughTaps: levelsOf(cases, (one) => one.throughTaps),
                    inLevels: {
                      byLevel: levelsOf(cases, (one) => one.inLevels!.byLevel),
                      throughTaps: levelsOf(
                        cases,
                        (one) => one.inLevels!.throughTaps,
                      ),
                      grid: pooled(cases.map((one) => one.inLevels!.grid)),
                    },
                    channels: Object.fromEntries(
                      (['opacity', 'depth'] as const).map((channel) => [
                        channel,
                        {
                          byLevel: levelsOf(
                            cases,
                            (one) => one.channels![channel].byLevel,
                          ),
                          throughTaps: levelsOf(
                            cases,
                            (one) => one.channels![channel].throughTaps,
                          ),
                        },
                      ]),
                    ),
                    grid: Object.fromEntries(
                      TAPS.map((taps) => [
                        taps,
                        pooled(cases.map((one) => one.grid[taps]!)),
                      ]),
                    ),
                  }
                }),
              ),
              cases: union,
            },
          },
          null,
          2,
        )}\n`,
      )
      expect(results).toHaveLength(landed.cases.length)
      for (const found of results) hold(found)
      for (const found of union) holdUnion(found)
    },
    1_800_000,
  )

  /*
   * What a change of the field costs the sun's depth, frame by frame, and
   * what a running clock costs it: GPU time by pass on the timeline, the
   * median of five rebuilds a frame, on two decks under the high sun. A
   * rebuild is every cache starting over at once, as a jump of the field's
   * time starts them; the frames here are the caches' own, with no trace
   * and no scene, so a figure is a pass's and not a frame's.
   */
  it.skipIf(!MEASURE || !WORKSTATION)(
    'times a rebuild frame by frame and a clock running at 1×, bakes no frame past the cap, and writes both',
    async () => {
      const { frameAt, settle } = drive()
      const [place] = placesOf(
        REBUILD.scenario,
        POPULATION.find(({ scenario }) => scenario === REBUILD.scenario)!
          .suns[0]!,
      )
      const stance: RigStance = {
        eye: EYE,
        looking: LOOKING_UP,
        turn: turnOnto(place!),
        air: true,
        sun: sunToward(REBUILD.sunDegrees),
      }
      const levers: CloudLevers = {
        ...DEFAULT_CLOUD_LEVERS,
        on: true,
        weather: REBUILD.scenario,
      }
      settle(stance, levers)
      const stop = installPassTimeline(gpu.renderer)
      try {
        const timeline = passTimelineOf(gpu.renderer)
        expect(timeline).not.toBeNull()
        type Passes = Record<string, { count: number; ms: number }>
        const timed = async (
          draw: () => void,
          frames: number,
        ): Promise<Passes> => {
          const result = await timeline!.measure(draw, frames)
          expect(result.dropped).toBe(0)
          return Object.fromEntries(
            result.passes.map(({ label, count, ms }) => [label, { count, ms }]),
          )
        }
        const runs: { passes: Passes; weight: number }[][] = []
        for (let run = 0; run < REBUILD.runs; run += 1) {
          settle(stance, levers, false)
          const frames: { passes: Passes; weight: number }[] = []
          for (let n = 0; n < REBUILD.frames; n += 1) {
            const passes = await timed(
              () => frameAt(stance, levers, n === 0),
              1,
            )
            frames.push({
              passes,
              weight: field.uniforms.trace.sunWeight.value,
            })
          }
          runs.push(frames)
        }
        const median = (values: readonly number[]): number =>
          [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0
        const labels = [
          ...new Set(
            runs.flatMap((frames) =>
              frames.flatMap((one) => Object.keys(one.passes)),
            ),
          ),
        ]
        const frames = Array.from({ length: REBUILD.frames }, (_, n) => ({
          frame: n,
          weight: runs[0]![n]!.weight,
          passes: Object.fromEntries(
            labels.map((label) => [
              label,
              {
                count: median(
                  runs.map((one) => one[n]!.passes[label]?.count ?? 0),
                ),
                ms: median(runs.map((one) => one[n]!.passes[label]?.ms ?? 0)),
              },
            ]),
          ),
        }))
        const whole = frames.findIndex((one) => one.weight === 1)
        settle(stance, levers, false)
        // In runs the timeline's query set holds: 2,048 passes a run.
        const steady: Passes = {}
        for (let run = 0; run < REBUILD.steadyRuns; run += 1) {
          const passes = await timed(
            () => frameAt(stance, levers, false, 1 / 60),
            REBUILD.steady,
          )
          for (const [label, { count, ms }] of Object.entries(passes)) {
            const sum = (steady[label] ??= { count: 0, ms: 0 })
            sum.count += count / REBUILD.steadyRuns
            sum.ms += ms / REBUILD.steadyRuns
          }
        }
        mkdirSync('.data/clouds', { recursive: true })
        writeFileSync(
          REBUILD_OUT,
          `${JSON.stringify(
            {
              note: 'cloudSunAccuracy.gpu.test.ts: the caches’ passes after every cache starts over, the median of the runs a frame, and with the clock running at 1× and 60 Hz; GPU ms by pass on the timeline, with no trace and no scene drawn',
              ...REBUILD,
              gridHeights: HEIGHTS,
              sunSlices: levers.sunSlices,
              sunRamp: levers.sunRamp,
              framesToWhole: whole < 0 ? null : whole + 1,
              frames,
              steady,
            },
            null,
            2,
          )}\n`,
        )
        // The rubric's B7: whole within 48 frames, and no frame past the cap.
        expect(whole).toBeGreaterThanOrEqual(0)
        expect(whole + 1).toBeLessThanOrEqual(48)
        for (const one of frames)
          for (const label of ['cloud volume', 'cloud sun grid'])
            expect(one.passes[label]?.count ?? 0).toBeLessThanOrEqual(
              levers.sunSlices,
            )
      } finally {
        stop()
      }
    },
    600_000,
  )
})
