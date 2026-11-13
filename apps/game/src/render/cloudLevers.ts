import { hashString } from '@inertialref/procedural'
import { SCENARIO_IDS, type ScenarioId } from '@inertialref/rendering'
import { CLOUD_MAX_STEPS_COUNTED } from './cloudMarch.ts'

/*
 * The cloud system's levers: what a script sets on `engine.clouds` to draw
 * the clouds, force a path, or drive a measurement. Read by the chain every
 * render call, so a change lands on the next frame with no rebuild; the ones
 * that change what the history means are named by `cloudResetKey`, and the
 * ones that change the field by `cloudFieldKey`.
 *
 * Off by default, and nothing exists without `?clouds=1` at all: a lever is
 * presentation, never a canonical value.
 *
 * A lever is one of three kinds. A quality step is a setting a player's
 * machine could be given. A measurement control steers a campaign and ships
 * at one value. A measured choice has two or more candidates built side by
 * side, and exists until a campaign's rule picks one: its winner becomes a
 * constant and the lever goes. `CLOUD_LEVER_KINDS` says which each is.
 */

export const CLOUD_COMPOSITES = ['identity', 'thin', 'residual'] as const
export type CloudCompositeMode = (typeof CLOUD_COMPOSITES)[number]

/** The paths a held still loop never takes on its own (§3.3). */
export const CLOUD_FORCES = [
  'none',
  'reset',
  'cut',
  'scrub',
  'warp',
  'fly',
] as const
export type CloudForce = (typeof CLOUD_FORCES)[number]

/**
 * What a body's weather is drawn from: `'climate'`, the body's own, or a
 * regime held over the whole body, by its scenario's id.
 */
export const CLOUD_WEATHERS = ['climate', ...SCENARIO_IDS] as const
export type CloudWeather = 'climate' | ScenarioId

/**
 * The light tap counts a frame may draw with. Exported so a ladder over the
 * lever reads its rungs here and holds no copy: a rung added to one and not
 * the other is a ladder that stops a rung short of the lever.
 */
export const CLOUD_LIGHT_TAPS = [0, 2, 4, 6, 8] as const

/**
 * The step budgets the `maxSteps` ladder climbs (phase 1 design §7.3), and
 * the far footprints, meters, the `farFootprint` ladder climbs. Exported so
 * the runner reads its rungs here and holds no copy. Unlike the taps these
 * are the ladders' rungs, not the levers' values: either lever takes any
 * positive number, so a script may set one between the rungs, and a step
 * budget up to `CLOUD_MAX_STEPS_COUNTED`, the most a ray's counts hold.
 */
export const CLOUD_MAX_STEPS = [96, 128, 192, 256] as const
export const CLOUD_FAR_FOOTPRINTS = [200, 400, 800, 1600] as const

/** How first-order light takes its phase's radius: the ray's mean, a few bins a level, or each sample's own. */
export const CLOUD_PHASE_MODES = ['mean', 'bins', 'sample'] as const
export const CLOUD_PHASE_BINS = [2, 3, 4] as const
/** The trace's jitter: interleaved gradient noise, or the spatiotemporal blue-noise mask. */
export const CLOUD_JITTERS = ['ign', 'stbn'] as const
/** The higher orders' form: the slab's source function, or the fitted octave series. */
export const CLOUD_TRANSPORTS = ['slab', 'octaves'] as const
/**
 * The composite's form: two scene passes always, the second pass storing its
 * samples once, or the composite as a term of the sensor's chain on a frame
 * with nothing drawn over the clouds.
 */
export const CLOUD_OVERS = ['passes', 'lean', 'chain'] as const
/** Slices of the sun grid, and of its source, a frame may bake while one is rebuilt. */
export const CLOUD_SUN_SLICES = [4, 8, 16] as const
/** Frames the sun grid's weight takes to rise once every slice holds the field. */
export const CLOUD_SUN_RAMPS = [8, 16, 32] as const
/** Blocks of the far atlas a frame bakes after an event. */
export const CLOUD_FAR_BLOCKS = [1, 2] as const

const TRACE_SCALES = [0.5, 1, 2] as const
const DECKS = ['auto', 'hidden'] as const

/** Read by the chain every render call. Scripts write `engine.clouds = { ...engine.clouds, … }`. */
export interface CloudLevers {
  readonly on: boolean
  /** The weather every clouded body draws: its own climate, or one regime. */
  readonly weather: CloudWeather
  /** Meters a trace texel spans where a ray hands over to the far march. */
  readonly farFootprint: number
  readonly lightTaps: (typeof CLOUD_LIGHT_TAPS)[number]
  readonly composite: CloudCompositeMode
  readonly force: CloudForce
  /** Time scale under force 'warp'. */
  readonly warp: number
  /** Seconds a render call under force 'scrub'. */
  readonly scrubSeconds: number
  /** m/s under force 'fly'. */
  readonly flySpeed: number
  readonly traceScale: (typeof TRACE_SCALES)[number]
  readonly maxSteps: number
  /**
   * The trace's jitter held at this frame index; null, the default, steps it
   * with the frame. A measurement lever: held, a held still repeats every
   * four frames, the interleave's cycle, so two images differ by the lever
   * under test alone. In the system's GPU rig two frames four apart differ
   * by 1.7% under the moving jitter, against a ladder's 1% (§8.7).
   */
  readonly jitterFrame: number | null
  /** Force the served body, and a second clouded one, by address. */
  readonly served: string | null
  readonly second: string | null
  /** 'hidden' hides every deck mesh whatever `on` is: Earth's A/B prices its deck (§8.3). */
  readonly deck: (typeof DECKS)[number]
  /** Count steps a ray (one atomic a ray) for the report. */
  readonly stats: boolean
  readonly phaseMode: (typeof CLOUD_PHASE_MODES)[number]
  /** Radius bins a level under `phaseMode: 'bins'`. */
  readonly phaseBins: (typeof CLOUD_PHASE_BINS)[number]
  readonly jitter: (typeof CLOUD_JITTERS)[number]
  readonly transport: (typeof CLOUD_TRANSPORTS)[number]
  /**
   * The handover band's far edge over its near one, in footprint: a ray's
   * handover distance is dithered between `farFootprint` and this many times
   * it. 1 is no band, the handover at one distance.
   */
  readonly handoverBand: number
  /** The history clip's half-width, in standard deviations of the neighborhood. */
  readonly clip: number
  readonly over: (typeof CLOUD_OVERS)[number]
  readonly sunSlices: (typeof CLOUD_SUN_SLICES)[number]
  readonly sunRamp: (typeof CLOUD_SUN_RAMPS)[number]
  readonly farBlocks: (typeof CLOUD_FAR_BLOCKS)[number]
}

/*
 * The quality defaults are read off ladders that each vary one lever, the
 * others at these defaults: the sun's depth from the grid, `lightTaps` 4 and
 * `farFootprint` 800 (§8.7, ADR-0064, at `51c96da4`). `maxSteps` 192 and
 * `farFootprint` 800 are each the smallest value of its ladder whose image
 * differs from the next larger one's by under 1% radiance RMSE in `horizon`
 * and `inside` at 1080p and Retina, the jitter held; the footprint passes
 * from 200 m at 1080p, and Retina alone puts it at 800. `lightTaps` is not
 * set by its ladder: 2 differs from 4 by just over 1%, and that ladder ends
 * at 4, so nothing larger was measured against it. 6 and 8 are the rungs the
 * next ladder takes.
 *
 * The levers meet in the grid: past the grid's ±25.6 km window a fine-march
 * sample is lit by the taps alone, and the footprint sets how far the fine
 * march reaches before the far field takes the ray. No ladder stands in
 * orbit, where both matter most.
 *
 * `flySpeed` 250 is a fast aircraft; the orbit stances set 7,700.
 *
 * `weather` is `'climate'`, the body's own, which `bodyWeather` derives from
 * its record. Each measured choice stands at the candidate the frame draws
 * with: the ray's mean radius, interleaved gradient noise, two scene passes.
 * `transport` names the higher orders' form before either is drawn.
 * `handoverBand` 2, `clip` 1.25, `sunSlices` 8, `sunRamp` 16 and `farBlocks`
 * 1 are phase 1's design values (§4.6), each replaced by its measured one.
 */
export const DEFAULT_CLOUD_LEVERS: CloudLevers = Object.freeze({
  on: false,
  weather: 'climate',
  farFootprint: 800,
  lightTaps: 4,
  composite: 'identity',
  force: 'none',
  warp: 1000,
  scrubSeconds: 10_800,
  flySpeed: 250,
  traceScale: 1,
  maxSteps: 192,
  jitterFrame: null,
  served: null,
  second: null,
  deck: 'auto',
  stats: false,
  phaseMode: 'mean',
  phaseBins: 4,
  jitter: 'ign',
  transport: 'slab',
  handoverBand: 2,
  clip: 1.25,
  over: 'passes',
  sunSlices: 8,
  sunRamp: 16,
  farBlocks: 1,
})

export type CloudLeverKind = 'quality' | 'control' | 'choice'

/**
 * What each lever is (phase 1 design §4.6, rubric §7): a lever left at a
 * phase's landing is a quality step or a measurement control, and a measured
 * choice is deleted with its losers.
 */
export const CLOUD_LEVER_KINDS: Readonly<
  Record<keyof CloudLevers, CloudLeverKind>
> = {
  on: 'control',
  weather: 'quality',
  farFootprint: 'quality',
  lightTaps: 'quality',
  composite: 'control',
  force: 'control',
  warp: 'control',
  scrubSeconds: 'control',
  flySpeed: 'control',
  traceScale: 'quality',
  maxSteps: 'quality',
  jitterFrame: 'control',
  served: 'control',
  second: 'control',
  deck: 'control',
  stats: 'control',
  phaseMode: 'choice',
  phaseBins: 'choice',
  jitter: 'choice',
  transport: 'choice',
  handoverBand: 'quality',
  clip: 'quality',
  over: 'choice',
  sunSlices: 'choice',
  sunRamp: 'choice',
  farBlocks: 'choice',
}

const oneOf =
  (values: readonly unknown[]) =>
  (value: unknown): boolean =>
    values.includes(value)
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const address = (value: unknown): boolean =>
  value === null || typeof value === 'string'

/** Each field's test; a key not here is a typo a script would otherwise lose silently. */
const FIELDS: Readonly<Record<keyof CloudLevers, (value: unknown) => boolean>> =
  {
    on: (value) => typeof value === 'boolean',
    weather: oneOf(CLOUD_WEATHERS),
    farFootprint: (value) => finite(value) && value > 0,
    lightTaps: oneOf(CLOUD_LIGHT_TAPS),
    composite: oneOf(CLOUD_COMPOSITES),
    force: oneOf(CLOUD_FORCES),
    warp: (value) => finite(value) && value > 0,
    scrubSeconds: finite,
    flySpeed: (value) => finite(value) && value >= 0,
    traceScale: oneOf(TRACE_SCALES),
    maxSteps: (value) =>
      Number.isSafeInteger(value) &&
      (value as number) > 0 &&
      (value as number) <= CLOUD_MAX_STEPS_COUNTED,
    jitterFrame: (value) =>
      value === null || (Number.isSafeInteger(value) && (value as number) >= 0),
    served: address,
    second: address,
    deck: oneOf(DECKS),
    stats: (value) => typeof value === 'boolean',
    phaseMode: oneOf(CLOUD_PHASE_MODES),
    phaseBins: oneOf(CLOUD_PHASE_BINS),
    jitter: oneOf(CLOUD_JITTERS),
    transport: oneOf(CLOUD_TRANSPORTS),
    handoverBand: (value) => finite(value) && value >= 1,
    clip: (value) => finite(value) && value > 0,
    over: oneOf(CLOUD_OVERS),
    sunSlices: oneOf(CLOUD_SUN_SLICES),
    sunRamp: oneOf(CLOUD_SUN_RAMPS),
    farBlocks: oneOf(CLOUD_FAR_BLOCKS),
  }

/** Every field one of its values, and no field the levers do not have. */
export function isCloudLevers(value: unknown): value is CloudLevers {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  if (keys.length !== Object.keys(FIELDS).length) return false
  for (const key of keys) {
    // Own keys only: `FIELDS.toString` is Object.prototype's, a function that
    // answers every value with a truthy string, so a lever set carrying
    // `toString` in place of a real field would count right and pass.
    if (!Object.hasOwn(FIELDS, key)) return false
    const test = FIELDS[key as keyof CloudLevers]
    if (!test(record[key])) return false
  }
  return true
}

/**
 * The levers whose change resets the history: what a texel of it means. A
 * force or the stats counter changes how a frame is drawn, not what the
 * history holds, so neither is here.
 */
export function cloudResetKey(levers: CloudLevers): string {
  return JSON.stringify([
    levers.weather,
    levers.farFootprint,
    levers.composite,
    levers.traceScale,
    levers.served,
    levers.second,
  ])
}

/**
 * The levers whose change is a change of the field: what every cache holds.
 * The weather, the bodies it is drawn on, and the two sizes the caches are
 * laid out by. A change is a `'field'` reset, which rebuilds the caches; a
 * cut that changes none of these is a `'picture'` reset, which keeps them.
 * `composite` is a form of the last pass and is in the history's key alone.
 */
export function cloudFieldKey(levers: CloudLevers): string {
  return JSON.stringify([
    levers.weather,
    levers.served,
    levers.second,
    levers.farFootprint,
    levers.traceScale,
  ])
}

/**
 * The levers a frame of this drawing-buffer size and pixel ratio draws with:
 * the one place a default that depends on the size is written. The set's own
 * at every size today, since the one thing that follows the size, the
 * trace's extents, is derived by the frame (`cloudExtents`) and is no lever.
 */
export function resolveCloudLevers(
  levers: CloudLevers,
  _size: {
    readonly width: number
    readonly height: number
    readonly dpr: number
  },
): CloudLevers {
  return levers
}

/**
 * The levers that only steer a measurement along a path: a forced row and
 * its steady row draw one picture's levers and share one hash. A report
 * says which were set beside it.
 */
export const CLOUD_STEERING_LEVERS = [
  'force',
  'warp',
  'scrubSeconds',
  'flySpeed',
  'jitterFrame',
  'stats',
] as const satisfies readonly (keyof CloudLevers)[]

/**
 * Eight hex digits over the resolved levers' canonical JSON, keys sorted,
 * the steering levers left out: what binds a capture or a campaign row to
 * the lever set it was drawn with. Equal for two sets exactly when every
 * lever outside `CLOUD_STEERING_LEVERS` is equal, short of a collision in 32
 * bits.
 */
export function cloudLeversHash(resolved: CloudLevers): string {
  const steering: readonly string[] = CLOUD_STEERING_LEVERS
  const shipped = Object.entries(resolved)
    .filter(([key]) => !steering.includes(key))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return hashString(JSON.stringify(shipped)).toString(16).padStart(8, '0')
}

/**
 * Whether a body's cloud deck hides this frame: every deck under `deck:
 * 'hidden'`, which is how Earth's A/B prices the deck it replaces (§8.3),
 * and the served body's whenever the clouds are on, read off the last
 * frame's report — a frame late, which the volume hides.
 */
export function deckYields(
  levers: CloudLevers,
  served: string | null,
  address: string,
): boolean {
  return levers.deck === 'hidden' || (levers.on && served === address)
}
