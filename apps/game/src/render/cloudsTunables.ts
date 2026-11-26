import { getLogger } from '@inertialref/shared'
import {
  applyCloudTypePreset,
  PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION,
  type CloudsContext,
  cloudTypePresetNames,
  type CloudTypePresetName,
  cirrusDeckDefaults,
  cloudShapeDefaults,
  convectiveProfileDefaults,
  evolvingWeatherDefaults,
  experimentalDefaults,
  type QualityPreset,
  qualityPresets,
  rainShaftDefaults,
} from 'three-clouds-webgpu'
import type { CloudLevers } from './cloudLevers.ts'

/*
 * Every preset and tunable the takram port exposes, as a table, and the one
 * place a page writes them: `engine.cloudTunables`.
 *
 * The port's knobs all live on its `CloudsContext`, and a context dies with
 * the sensor's chain: a picture change builds a new one, beside the one still
 * drawing (`chainHandover.ts`). So the settings are held here, for the page,
 * and written into every context a chain holds. A preset is applied first and
 * the overrides after it, the port's own order; applying a preset drops the
 * overrides of the fields it names, as re-applying one does on the context.
 *
 * r187 builds all five presets from their first frame. Each context takes the
 * page's settings on attachment, before warm-up, and flushes later writes at
 * the start of its own frame.
 *
 * **A write is what changed, and no more.** The port's setters clear its
 * history and rebuild its graph on a change of value, so writing the preset
 * again beside every tunable turns a held `temporalUpscale: false` on and
 * off, and one `coverage` costs two cleared histories.
 *
 * A path is the context's own property path (`clouds.maxIterationCount`,
 * `cloudLayers.0.altitude`), so the table needs no second vocabulary. A
 * vector is written as an array.
 */

const log = getLogger('game.clouds.tunables')

export type CloudsTunableKind =
  'number' | 'integer' | 'boolean' | 'enum' | 'vec2' | 'vec3'

export interface CloudsTunable {
  /** The property path on the port's `CloudsContext`. */
  readonly path: string
  readonly kind: CloudsTunableKind
  /** An enum's values. */
  readonly values?: readonly string[]
  readonly what: string
  /** A change recompiles the port's graph and clears its history. */
  readonly rebuilds: boolean
  /** The lever of `engine.clouds` that does this job in ours, or null. */
  readonly lever: keyof CloudLevers | null
  /** How the two differ, where a lever exists, or what ours does instead. */
  readonly note?: string
}

const row = (
  path: string,
  kind: CloudsTunableKind,
  what: string,
  rebuilds = false,
  lever: keyof CloudLevers | null = null,
  note?: string,
): CloudsTunable => ({
  path,
  kind,
  what,
  rebuilds,
  lever,
  ...(note === undefined ? {} : { note }),
})

const CONTEXT: readonly CloudsTunable[] = [
  {
    path: 'qualityPreset',
    kind: 'enum',
    values: Object.keys(qualityPresets),
    what: 'Writes every field a preset names: the march, the shadow maps and five feature switches',
    rebuilds: true,
    lever: null,
    note: 'Ours has no preset: maxSteps, lightTaps and traceScale are set one at a time',
  },
  row(
    'coverage',
    'number',
    'Share of the weather map that becomes cloud, 0 clear to 1 overcast',
    false,
    'weather',
    'Ours takes cover from the regime; a number alone has no lever',
  ),
  row(
    'resolutionScale',
    'number',
    'The cloud buffer as a fraction of the drawing buffer',
    false,
    'traceScale',
    'Ours is 0.5, 1 or 2 of a quarter-height trace',
  ),
  row(
    'temporalUpscale',
    'boolean',
    'March a sixteenth of the pixels a frame and resolve at full size; off marches every pixel',
    true,
    'traceScale',
    'Ours always marches a fraction and has no full-resolution form',
  ),
  row(
    'shapeDetail',
    'boolean',
    'Add the high-frequency detail volume to the shape',
    true,
  ),
  row(
    'turbulence',
    'boolean',
    'Displace the shape noise by the curl noise',
    true,
  ),
  row('haze', 'boolean', 'March a ground haze beside the clouds', true),
  row(
    'lightShafts',
    'boolean',
    'March cloud shadow length for crepuscular rays; read only by the port’s own aerial perspective',
    true,
  ),
  row(
    'lightShaftsHalfResolution',
    'boolean',
    'March the shafts once per 2×2 pixels',
    true,
  ),
  row(
    'scatteringCoefficient',
    'number',
    'Scattering coefficient of the cloud medium',
  ),
  row(
    'absorptionCoefficient',
    'number',
    'Absorption coefficient of the cloud medium',
  ),
  row(
    'scatterAnisotropy1',
    'number',
    'Forward lobe of the two-lobe phase function',
    true,
    'phaseMode',
    'Ours reads a Lorenz–Mie table (ADR-0066)',
  ),
  row(
    'scatterAnisotropy2',
    'number',
    'Backward lobe of the two-lobe phase function',
    true,
    'phaseMode',
    'Ours reads a Lorenz–Mie table (ADR-0066)',
  ),
  row(
    'scatterAnisotropyMix',
    'number',
    'Blend of the two lobes',
    true,
    'phaseMode',
    'Ours reads a Lorenz–Mie table (ADR-0066)',
  ),
  row('skyLightScale', 'number', 'Multiplier on the sky’s light on a cloud'),
  row(
    'groundBounceScale',
    'number',
    'Multiplier on light bounced off the ground into cloud bases; 0 drops the ground march',
    true,
  ),
  row(
    'powderScale',
    'number',
    'Strength of the powder darkening in dense, shadowed cloud',
  ),
  row('powderExponent', 'number', 'Fall-off of the powder darkening'),
  row(
    'turbulenceDisplacement',
    'number',
    'Meters the curl noise displaces the shape noise',
  ),
  row(
    'localWeatherRepeat',
    'vec2',
    'How often the weather map tiles across the globe',
    false,
    'weather',
    'Ours bakes a field round the eye and tiles nothing',
  ),
  row('localWeatherOffset', 'vec2', 'Base offset of the weather map'),
  row(
    'localWeatherVelocity',
    'vec2',
    'Wind on the weather map, offset units a second',
    false,
    'weather',
    'Ours takes the wind from the regime',
  ),
  row('shapeRepeat', 'vec3', 'Tiling of the base shape volume, per meter'),
  row('shapeOffset', 'vec3', 'Base offset of the shape volume'),
  row(
    'shapeVelocity',
    'vec3',
    'Wind on the shape volume, offset units a second',
  ),
  row('shapeDetailRepeat', 'vec3', 'Tiling of the detail volume, per meter'),
  row('shapeDetailOffset', 'vec3', 'Base offset of the detail volume'),
  row(
    'shapeDetailVelocity',
    'vec3',
    'Wind on the detail volume, offset units a second',
  ),
  row('turbulenceRepeat', 'vec2', 'Tiling of the curl noise'),
  row(
    'sunAngularRadius',
    'number',
    'The sun’s angular radius, radians: its disk and the shadows’ penumbra',
  ),
  row(
    'bottomRadius',
    'number',
    'Meters from the planet’s center at which a ray has hit the ground',
  ),
  row(
    'correctAltitude',
    'boolean',
    'Shift the sphere so it meets the ellipsoid under the camera',
  ),
  {
    path: 'debug',
    kind: 'enum',
    values: [
      'none',
      'cascades',
      'shadowMap',
      'uv',
      'sampleCount',
      'frontDepth',
      'shadowLength',
      'velocity',
      'marchIntervals',
    ],
    what: 'A diagnostic view in place of the shaded image',
    rebuilds: true,
    lever: 'stats',
    note: 'Ours counts steps into a report; this draws them',
  },
  row('moonGain', 'number', 'Gain on moonlight, under experimental.moonlight'),
  row('moonColor', 'vec3', 'Color of moonlight, under experimental.moonlight'),
]

const MARCH: readonly CloudsTunable[] = [
  row(
    'clouds.multiScatteringOctaves',
    'integer',
    'Octaves of approximated multiple scattering; 0 is single scattering',
    true,
    'transport',
    'Ours picks a form of the higher orders, not a count',
  ),
  row(
    'clouds.accurateSunSkyLight',
    'boolean',
    'Read the sun’s and sky’s light at each sample, not once a frame',
    true,
  ),
  row(
    'clouds.accuratePhaseFunction',
    'boolean',
    'A closer phase approximation in place of the two lobes',
    true,
    'phaseMode',
  ),
  row(
    'clouds.maxIterationCount',
    'integer',
    'Most steps the primary march takes',
    false,
    'maxSteps',
  ),
  row(
    'clouds.minStepSize',
    'number',
    'Shortest primary step, meters',
    false,
    'maxSteps',
    'Ours has a step budget and no step length',
  ),
  row('clouds.maxStepSize', 'number', 'Longest primary step, meters'),
  row(
    'clouds.maxRayDistance',
    'number',
    'Meters the primary march travels at most',
    false,
    'farFootprint',
    'Ours hands the ray to a far march; this ends it',
  ),
  row(
    'clouds.perspectiveStepScale',
    'number',
    'Growth of the step with distance',
  ),
  row('clouds.minDensity', 'number', 'Density under which a sample is empty'),
  row(
    'clouds.minExtinction',
    'number',
    'Extinction under which a sample adds nothing',
  ),
  row(
    'clouds.minTransmittance',
    'number',
    'Transmittance under which the march stops',
  ),
  row(
    'clouds.maxIterationCountToSun',
    'integer',
    'Steps toward the sun at each sample, beside the shadow maps',
    false,
    'lightTaps',
  ),
  row(
    'clouds.maxIterationCountToGround',
    'integer',
    'Steps toward the ground at each sample, for bounced light',
  ),
  row(
    'clouds.minSecondaryStepSize',
    'number',
    'Shortest step of the sun and ground marches, meters',
  ),
  row(
    'clouds.secondaryStepScale',
    'number',
    'Growth of the sun and ground marches’ step',
  ),
  row(
    'clouds.maxShadowFilterRadius',
    'number',
    'Widest filter the march reads the shadow maps through, texels',
  ),
  row(
    'clouds.maxShadowLengthIterationCount',
    'integer',
    'Most steps of the light-shaft march',
  ),
  row(
    'clouds.minShadowLengthStepSize',
    'number',
    'Shortest step of the light-shaft march, meters',
  ),
  row(
    'clouds.maxShadowLengthRayDistance',
    'number',
    'Meters the light-shaft march travels at most',
  ),
  row('clouds.hazeDensityScale', 'number', 'Density of the haze'),
  row(
    'clouds.hazeExponent',
    'number',
    'Fall-off of the haze with height, per meter',
  ),
  row(
    'clouds.hazeScatteringCoefficient',
    'number',
    'Scattering coefficient of the haze',
  ),
  row(
    'clouds.hazeAbsorptionCoefficient',
    'number',
    'Absorption coefficient of the haze',
  ),
]

const SHADOW: readonly CloudsTunable[] = [
  row(
    'shadow.cascadeCount',
    'integer',
    'Cascades of the cloud shadow map',
    true,
    'sunSlices',
    'Ours sums the sun’s depth in a grid round the eye (ADR-0064)',
  ),
  row('shadow.mapSize', 'vec2', 'Texels of each cascade'),
  row(
    'shadow.maxFar',
    'number',
    'Meters the cascades reach; null takes the camera’s far plane times farScale',
  ),
  row(
    'shadow.farScale',
    'number',
    'Share of the camera’s far plane the cascades cover',
  ),
  row(
    'shadow.splitMode',
    'integer',
    'How the cascades divide the range: uniform, logarithmic or practical',
  ),
  row(
    'shadow.splitLambda',
    'number',
    'Blend of uniform and logarithmic splits',
  ),
  row(
    'shadow.temporalPass',
    'boolean',
    'Resolve the shadow map over frames',
    true,
    'sunRamp',
  ),
  row(
    'shadow.temporalJitter',
    'boolean',
    'Jitter the shadow march from frame to frame',
    true,
  ),
  row('shadow.maxIterationCount', 'integer', 'Most steps of the shadow march'),
  row('shadow.minStepSize', 'number', 'Shortest shadow step, meters'),
  row('shadow.maxStepSize', 'number', 'Longest shadow step, meters'),
  row(
    'shadow.minDensity',
    'number',
    'Density under which a shadow sample is empty',
  ),
  row(
    'shadow.minExtinction',
    'number',
    'Extinction under which a shadow sample adds nothing',
  ),
  row(
    'shadow.minTransmittance',
    'number',
    'Transmittance under which the shadow march stops',
  ),
  row(
    'shadow.opticalDepthTailScale',
    'number',
    'Scale on the optical depth past the march’s end',
  ),
  row(
    'shadow.updateInterval',
    'integer',
    'Frames between shadow map draws; 1 is every frame',
    false,
    'sunSlices',
  ),
]

const LAYER_FIELDS: readonly (readonly [
  string,
  CloudsTunableKind,
  string,
  boolean,
])[] = [
  ['altitude', 'number', 'Meters from the ground to the band’s base', false],
  [
    'height',
    'number',
    'Thickness of the band, meters; 0 empties the slot',
    true,
  ],
  ['densityScale', 'number', 'Weight of the layer’s density', false],
  ['shapeAmount', 'number', 'Weight of the base shape noise', false],
  ['shapeDetailAmount', 'number', 'Weight of the detail noise', false],
  ['weatherExponent', 'number', 'Exponent on the weather channel', true],
  [
    'shapeAlteringBias',
    'number',
    'Moves density toward the band’s middle',
    false,
  ],
  [
    'coverageFilterWidth',
    'number',
    'Width of the ramp where weather crosses the coverage',
    false,
  ],
  ['shadow', 'boolean', 'Whether the layer casts into the shadow map', true],
  ['densityProfile.expTerm', 'number', 'Exponential term of the profile', true],
  ['densityProfile.exponent', 'number', 'Its exponent', false],
  ['densityProfile.linearTerm', 'number', 'Linear term of the profile', false],
  [
    'densityProfile.constantTerm',
    'number',
    'Constant term of the profile',
    false,
  ],
]

const LAYERS: readonly CloudsTunable[] = [0, 1, 2, 3].flatMap((slot) => [
  {
    path: `cloudLayers.${slot}.channel`,
    kind: 'enum' as const,
    values: ['r', 'g', 'b', 'a'],
    what: 'Channel of the weather map the layer reads',
    rebuilds: true,
    lever: null,
  },
  ...LAYER_FIELDS.map(([field, kind, what, rebuilds]) =>
    row(
      `cloudLayers.${slot}.${field}`,
      kind,
      what,
      rebuilds,
      field === 'altitude' || field === 'height' ? 'weather' : null,
      field === 'altitude' || field === 'height'
        ? 'Ours takes its levels from the regime'
        : undefined,
    ),
  ),
])

const kindOf = (value: unknown): CloudsTunableKind =>
  typeof value === 'boolean' ? 'boolean' : 'number'

/** A group of the port's experiments, read off its own defaults so a field it adds is listed. */
const group = (
  prefix: string,
  defaults: object,
  what: string,
): readonly CloudsTunable[] =>
  Object.entries(defaults)
    .filter(([, value]) => value !== null && typeof value !== 'object')
    .map(([key, value]) =>
      row(
        `${prefix}.${key}`,
        kindOf(value),
        `${what}: ${key}`,
        prefix === 'cloudShape',
      ),
    )

const EXPERIMENTS: readonly CloudsTunable[] = [
  ...Object.keys(experimentalDefaults).map((key) =>
    row(
      `experimental.${key}`,
      'boolean',
      `The port’s own experiment ${key}`,
      true,
      key === 'shadowRoundRobin' ? 'sunSlices' : null,
    ),
  ),
  ...group('cloudShape', cloudShapeDefaults, 'Shape control'),
  ...group(
    'convectiveProfile',
    convectiveProfileDefaults,
    'Towering convection, under experimental.convectiveProfile',
  ),
  ...group(
    'rainShafts',
    rainShaftDefaults,
    'Rain shafts, under experimental.rainShafts',
  ),
  ...group(
    'cirrusDeck',
    cirrusDeckDefaults,
    'Cirrus deck, under experimental.cirrusDeck',
  ),
  ...group(
    'evolvingWeather',
    evolvingWeatherDefaults,
    'Evolving weather, under experimental.evolvingWeather',
  ),
]

/** Every tunable, in the port's own grouping. */
export const CLOUDS_TUNABLES: readonly CloudsTunable[] = [
  ...CONTEXT,
  ...MARCH,
  ...SHADOW,
  ...LAYERS,
  ...EXPERIMENTS,
]

/* ------------------------------------------------------------------------- */
/* Reading and writing a path                                                 */
/* ------------------------------------------------------------------------- */

type Vector = {
  readonly isVector2?: boolean
  readonly isVector3?: boolean
  toArray(): number[]
  fromArray(values: readonly number[]): unknown
}

const isVector = (value: unknown): value is Vector =>
  typeof value === 'object' &&
  value !== null &&
  ((value as Vector).isVector2 === true || (value as Vector).isVector3 === true)

function parent(root: object, path: string): readonly [object, string] {
  const keys = path.split('.')
  const last = keys.pop()
  if (last === undefined || last === '') throw new Error(`no path: "${path}"`)
  let at: unknown = root
  for (const key of keys) {
    if (typeof at !== 'object' || at === null || !(key in at))
      throw new Error(`no such tunable: "${path}"`)
    at = (at as Record<string, unknown>)[key]
  }
  if (typeof at !== 'object' || at === null || !(last in at))
    throw new Error(`no such tunable: "${path}"`)
  return [at, last]
}

/** A path's value on a context: a vector as an array, anything else as it is. */
export function readTunable(context: CloudsContext, path: string): unknown {
  const [holder, key] = parent(context, path)
  const value = (holder as Record<string, unknown>)[key]
  return isVector(value) ? value.toArray() : value
}

/**
 * Writes one path. A vector takes an array, into the context's own object.
 * An experiment is assigned through the context's partial setter, which is
 * what validates the name and rebuilds the graph.
 */
export function writeTunable(
  context: CloudsContext,
  path: string,
  value: unknown,
): void {
  if (path.startsWith('experimental.')) {
    context.experimental = { [path.slice('experimental.'.length)]: value }
    return
  }
  const [holder, key] = parent(context, path)
  const held = (holder as Record<string, unknown>)[key]
  if (isVector(held)) {
    if (!Array.isArray(value))
      throw new Error(`"${path}" is a vector and takes an array`)
    held.fromArray(value as number[])
    return
  }
  ;(holder as Record<string, unknown>)[key] = value
}

/* ------------------------------------------------------------------------- */
/* The page's settings                                                        */
/* ------------------------------------------------------------------------- */

/** Paths a quality preset names: applying one drops their overrides. */
const presetOwns = (path: string): boolean =>
  path.startsWith('clouds.') ||
  path.startsWith('shadow.') ||
  [
    'resolutionScale',
    'lightShafts',
    'shapeDetail',
    'turbulence',
    'haze',
    'temporalUpscale',
    'lightShaftsHalfResolution',
  ].includes(path)

/** A preset's fields, flat by path, vectors as arrays. */
function flat(values: object, prefix = ''): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const path = prefix === '' ? key : `${prefix}.${key}`
    if (isVector(value)) out[path] = value.toArray()
    else if (typeof value === 'object' && value !== null)
      Object.assign(out, flat(value, path))
    else out[path] = value
  }
  return out
}

/** What `engine.cloudTunables` is: the port's presets and tunables, from a page. */
export interface CloudsHandle {
  /** Every tunable: its path, kind, what it does and the lever of ours it answers to. */
  readonly tunables: readonly CloudsTunable[]
  /** Each quality preset's values, flat by path. */
  presets(): Record<string, Record<string, unknown>>
  /** Apply a quality preset, dropping the overrides of the fields it names. */
  preset(name: QualityPreset): void
  /** The port's named skies: its cloud layers and coverage in one write. */
  readonly cloudTypes: readonly string[]
  cloudType(name: CloudTypePresetName): void
  /** Write tunables by path; each lands before the next frame. */
  set(patch: Readonly<Record<string, unknown>>): void
  /** Every tunable's live value, or null with no context built. */
  read(): Record<string, unknown> | null
  /** The preset and the overrides the page holds, and the adapter's own state. */
  state(): CloudsState
}

export interface CloudsState {
  readonly preset: QualityPreset
  readonly cloudType: string | null
  readonly overrides: Readonly<Record<string, unknown>>
  /** The adapter's report of its last frame, or null with no context built. */
  readonly frame: Readonly<Record<string, unknown>> | null
}

export interface CloudsSettings extends CloudsHandle {
  /** Initialize a context before warm-up and follow later page writes. */
  attach(
    context: CloudsContext,
    frame: () => Readonly<Record<string, unknown>>,
  ): void
  /**
   * Write what `context` is owed: called by the system that holds it, before
   * its own frame. A context no longer followed is left alone.
   */
  flush(context: CloudsContext): void
  detach(context: CloudsContext): void
}

/** What one followed context has not been written, and its frame's report. */
interface Follower {
  readonly frame: () => Readonly<Record<string, unknown>>
  /** The quality preset, with the two fields only `lowEnd` names. */
  preset: boolean
  cloudType: boolean
  /** Overrides by path. */
  readonly paths: Set<string>
}

/**
 * Throws for a write that can be refused before a frame: a preset or an
 * experiment the port does not have, and, on `context`, a path it does not
 * hold or a vector given something other than an array.
 */
function checkTunable(
  context: CloudsContext | null,
  path: string,
  value: unknown,
): void {
  if (path === 'qualityPreset') {
    if (typeof value !== 'string' || !Object.hasOwn(qualityPresets, value))
      throw new RangeError(`no such preset: "${String(value)}"`)
    return
  }
  if (path.startsWith('experimental.')) {
    const name = path.slice('experimental.'.length)
    if (!Object.hasOwn(experimentalDefaults, name))
      throw new Error(`no such tunable: "${path}"`)
    if (typeof value !== 'boolean')
      throw new TypeError(`"${path}" is a switch and takes a boolean`)
    return
  }
  if (context === null) return
  const [holder, key] = parent(context, path)
  if (
    isVector((holder as Record<string, unknown>)[key]) &&
    !Array.isArray(value)
  )
    throw new Error(`"${path}" is a vector and takes an array`)
}

/**
 * The page's settings: one for the clouds chunk's lifetime. `initial` is
 * the preset every context is built at, the port's own `high` when absent;
 * a name the port does not have throws before anything is built.
 */
export function createCloudsSettings(
  initial: string | null = null,
): CloudsSettings {
  if (initial !== null && !Object.hasOwn(qualityPresets, initial))
    throw new RangeError(`no such preset: "${initial}"`)
  let preset: QualityPreset = (initial as QualityPreset | null) ?? 'high'
  let cloudType: CloudTypePresetName | null = null
  const overrides = new Map<string, unknown>()
  /** Every context a chain holds, oldest first: a successor is built beside the one drawing. */
  const followed = new Map<CloudsContext, Follower>()

  /** The newest context: what a read answers from and a write is checked on. */
  const newest = (): readonly [CloudsContext, Follower] | null => {
    let last: readonly [CloudsContext, Follower] | null = null
    for (const entry of followed) last = entry
    return last
  }

  const applyPreset = (name: QualityPreset): void => {
    checkTunable(null, 'qualityPreset', name)
    preset = name
    for (const path of [...overrides.keys()])
      if (presetOwns(path)) overrides.delete(path)
    for (const follower of followed.values()) follower.preset = true
  }

  const settings: CloudsSettings = {
    tunables: CLOUDS_TUNABLES,
    cloudTypes: cloudTypePresetNames,
    presets: () =>
      Object.fromEntries(
        Object.entries(qualityPresets).map(([name, values]) => [
          name,
          flat(values),
        ]),
      ),
    preset: applyPreset,
    cloudType(name) {
      if (!cloudTypePresetNames.includes(name))
        throw new RangeError(`no such cloud type: "${String(name)}"`)
      cloudType = name
      for (const path of [...overrides.keys()])
        if (path === 'coverage' || path.startsWith('cloudLayers.'))
          overrides.delete(path)
      for (const follower of followed.values()) follower.cloudType = true
    },
    set(patch) {
      const entries = Object.entries(patch)
      // Checked whole, on the newest context, before any of it is held: a
      // mistyped path or a value the port refuses throws here, where the
      // caller is, and is never held for every context after this one.
      const context = newest()?.[0] ?? null
      for (const [path, value] of entries) checkTunable(context, path, value)
      for (const [path, value] of entries) {
        if (path === 'qualityPreset') {
          applyPreset(value as QualityPreset)
          continue
        }
        overrides.set(path, value)
        for (const follower of followed.values()) follower.paths.add(path)
      }
    },
    read() {
      const context = newest()?.[0] ?? null
      if (context === null) return null
      return Object.fromEntries(
        CLOUDS_TUNABLES.map(({ path }) => [path, readTunable(context, path)]),
      )
    },
    state: () => ({
      preset,
      cloudType,
      overrides: Object.fromEntries(overrides),
      frame: newest()?.[1].frame() ?? null,
    }),
    attach(context, frame) {
      // r187 compiles every preset on its first frame, including the warm-up.
      followed.set(context, {
        frame,
        preset: true,
        cloudType: cloudType !== null,
        paths: new Set(overrides.keys()),
      })
      settings.flush(context)
    },
    flush(context) {
      const follower = followed.get(context)
      if (follower === undefined) return
      if (follower.preset) {
        follower.preset = false
        // The two fields only `lowEnd` names: back to the port's own before
        // a preset that leaves them alone, or the last one's value would
        // stand. A preset drops their overrides, so none is undone here.
        context.temporalUpscale = true
        context.lightShaftsHalfResolution =
          PORT_DEFAULT_LIGHT_SHAFTS_HALF_RESOLUTION
        context.qualityPreset = preset
        // The game camera reaches 10^10 m. Fit the cascades to the cloud march.
        context.shadow.maxFar = 200_000
      }
      if (follower.cloudType) {
        follower.cloudType = false
        if (cloudType !== null) applyCloudTypePreset(context, cloudType)
      }
      if (follower.paths.size === 0) return
      const paths = [...follower.paths]
      follower.paths.clear()
      for (const path of paths) {
        // Dropped since it was set, by a preset or a cloud type.
        if (!overrides.has(path)) continue
        /*
         * This runs inside the sensor's render call. A path set before any
         * context existed is checked nowhere until here, and a throw would
         * take the frame, and every frame that owes a write after it, with
         * it: the override is dropped and said so.
         */
        try {
          writeTunable(context, path, overrides.get(path))
        } catch (cause) {
          overrides.delete(path)
          log.warn('the port refuses a tunable; its override is dropped', {
            path,
            cause: cause instanceof Error ? cause.message : String(cause),
          })
        }
      }
    },
    detach(context) {
      followed.delete(context)
    },
  }
  return settings
}
