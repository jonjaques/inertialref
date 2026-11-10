import { SCENARIO_IDS, type ScenarioId } from '@inertialref/rendering'

/*
 * The cloud system's levers: what a script sets on `engine.clouds` to choose
 * a candidate, force a path, or drive a measurement. Read by the chain every
 * render call, so a change lands on the next frame with no rebuild; the ones
 * that change what the history means are named by `cloudResetKey`.
 *
 * Off by default, and nothing exists without `?clouds=1` at all: a lever is
 * presentation, never a canonical value.
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

const LIGHT_TAP_COUNTS = [0, 2, 4] as const
const TRACE_SCALES = [0.5, 1, 2] as const
const DECKS = ['auto', 'hidden'] as const

/** Read by the chain every render call. Scripts write `engine.clouds = { ...engine.clouds, … }`. */
export interface CloudLevers {
  readonly on: boolean
  readonly scenario: ScenarioId
  /** Meters a trace texel spans where a ray hands over to the far march. */
  readonly farFootprint: number
  readonly lightTaps: (typeof LIGHT_TAP_COUNTS)[number]
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
}

/*
 * `farFootprint` 400 puts the handover where a trace texel spans under half
 * the smallest cell any scenario draws (1,000 m), so detail the fine march
 * resolves is never handed to a representation that cannot hold it.
 * `maxSteps` 192 is a guess the sweep replaces: the plan's schedule covers
 * about 13 km in 128 out-of-cloud steps. `flySpeed` 250 is a fast aircraft;
 * the orbit stances set 7,700.
 */
export const DEFAULT_CLOUD_LEVERS: CloudLevers = Object.freeze({
  on: false,
  scenario: 'fair-cumulus',
  farFootprint: 400,
  lightTaps: 2,
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
})

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
    scenario: oneOf(SCENARIO_IDS),
    farFootprint: (value) => finite(value) && value > 0,
    lightTaps: oneOf(LIGHT_TAP_COUNTS),
    composite: oneOf(CLOUD_COMPOSITES),
    force: oneOf(CLOUD_FORCES),
    warp: (value) => finite(value) && value > 0,
    scrubSeconds: finite,
    flySpeed: (value) => finite(value) && value >= 0,
    traceScale: oneOf(TRACE_SCALES),
    maxSteps: (value) => Number.isSafeInteger(value) && (value as number) > 0,
    jitterFrame: (value) =>
      value === null || (Number.isSafeInteger(value) && (value as number) >= 0),
    served: address,
    second: address,
    deck: oneOf(DECKS),
    stats: (value) => typeof value === 'boolean',
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
    levers.scenario,
    levers.farFootprint,
    levers.composite,
    levers.traceScale,
    levers.served,
    levers.second,
  ])
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
