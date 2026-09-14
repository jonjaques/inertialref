import { err, ok, type Result } from '@inertialref/shared'
import type { TourCameraMotion, TourWorldQuery } from './tour.ts'

/*
 * The guide's tool inventory, shared by the Worker that declares it to the
 * backend model and the browser that executes it.
 *
 * Two audiences read one table. The Worker sends `GUIDE_TOOLS` as strict
 * function tools in the session's delegation configuration; the browser
 * decodes each call the data channel delivers through `decodeGuideCall` before
 * anything touches the observatory. Declaring the schema in one place is what
 * keeps the two from drifting: a tool the model can name is a tool the
 * executor can decode, and nothing else is.
 *
 * Arguments name things the way a visitor would — "Titan", "crescent",
 * "summit" — never an address, a coordinate or a script. The executor resolves
 * names through the search index and answers an unknown one with the nearest
 * matches, so the model never learns the addressing scheme and cannot produce
 * one.
 *
 * Strict function schemas require every property in `required`, so an
 * optional argument is a nullable one. That is the shape the decoders check.
 */

export const GUIDE_TOOL_NAMES = [
  'go_to',
  'adjust_view',
  'frame_pair',
  'stand_at',
  'look_around',
  'leave_surface',
  'set_time',
  'hold_view',
  'linger',
  'describe_view',
  'read_subject',
  'list_subjects',
  'find_worlds',
  'resolve_name',
] as const
export type GuideToolName = (typeof GUIDE_TOOL_NAMES)[number]

/**
 * The tools that move the camera or the picture time. The loop runs these one
 * at a time and executes at most one per response, because two moves in one
 * turn is a camera that thrashes; every other tool is a query and may run
 * beside any number of others.
 */
export const GUIDE_CAMERA_TOOLS = [
  'go_to',
  'adjust_view',
  'frame_pair',
  'stand_at',
  'look_around',
  'leave_surface',
  'set_time',
  'hold_view',
] as const
export const isGuideCameraTool = (name: string): boolean =>
  (GUIDE_CAMERA_TOOLS as readonly string[]).includes(name)

export const GUIDE_LIMITS = {
  /** Quiet seconds a beat may declare. */
  lingerSeconds: { min: 3, max: 45 },
  /** Light years a bounded world search may sweep. */
  searchLightYears: 8,
  /** Matches a search or a listing may return. */
  results: 16,
  /** Bytes of the scene block the browser queues on a view change. */
  sceneBytes: 1200,
  /** Characters of any text argument. */
  text: 160,
  /** Longest arguments payload the loop decodes. */
  argumentBytes: 4096,
} as const

export const GUIDE_MOTIONS = [
  'hold',
  'orbit',
  'push-in',
  'pull-back',
  'reveal',
] as const satisfies readonly TourCameraMotion[]
export const GUIDE_TIME_MODES = ['live', 'hold', 'set', 'rate'] as const
export const GUIDE_LIST_SCOPES = ['system', 'moons', 'nearby_stars'] as const
export const GUIDE_WORLD_KINDS = [
  'rocky',
  'ice',
  'gas-giant',
  'ice-giant',
  'moon',
  'dwarf',
  'asteroid',
  'comet',
] as const
export const GUIDE_STAR_CLASSES = [
  'O',
  'B',
  'A',
  'F',
  'G',
  'K',
  'M',
  'L',
  'T',
  'Y',
  'D',
] as const

export type GuideCall =
  | {
      readonly name: 'go_to'
      readonly subject: string
      readonly framing: string | null
      readonly motion: TourCameraMotion | null
    }
  | {
      readonly name: 'adjust_view'
      readonly azimuth_deg: number | null
      readonly elevation_deg: number | null
      readonly distance_radii: number | null
      readonly zoom_factor: number | null
    }
  | {
      readonly name: 'frame_pair'
      readonly subject: string
      readonly companion: string
    }
  | {
      readonly name: 'stand_at'
      readonly subject: string
      readonly site: string
    }
  | {
      readonly name: 'look_around'
      readonly heading_deg: number
      readonly pitch_deg: number
    }
  | { readonly name: 'leave_surface' }
  | {
      readonly name: 'set_time'
      readonly mode: (typeof GUIDE_TIME_MODES)[number]
      readonly instant: string | null
      readonly rate: number | null
    }
  | { readonly name: 'hold_view' }
  | {
      readonly name: 'linger'
      readonly seconds: number
      readonly reason: string
    }
  | { readonly name: 'describe_view' }
  | {
      readonly name: 'read_subject'
      readonly subject: string
      readonly fields: readonly string[] | null
    }
  | {
      readonly name: 'list_subjects'
      readonly scope: (typeof GUIDE_LIST_SCOPES)[number]
      readonly of: string | null
      readonly limit: number | null
    }
  | {
      readonly name: 'find_worlds'
      readonly query: TourWorldQuery
      readonly radius_light_years: number
      readonly limit: number
    }
  | { readonly name: 'resolve_name'; readonly query: string }

/** What every tool answers with. The model reads it as JSON text. */
export type GuideToolOutput = Readonly<Record<string, unknown>> & {
  readonly status: string
}

const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: 'null' }],
})
// No `maxLength`, `maxItems`, `minimum` or `maximum` anywhere in the schema:
// the provider refused a session whose tool schema carried a fractional bound
// ("Type is not JSON serializable: decimal.Decimal"). Bounds are stated in
// the description for the model and enforced by the decoders below.
const text = (description: string) => ({ type: 'string', description })
const number = (description: string, minimum?: number, maximum?: number) => ({
  type: 'number',
  description:
    minimum === undefined || maximum === undefined
      ? description
      : `${description} Between ${minimum} and ${maximum}.`,
})
const choice = (description: string, values: readonly string[]) => ({
  type: 'string',
  description,
  enum: [...values],
})
const strict = (
  name: GuideToolName,
  description: string,
  properties: Record<string, unknown>,
) => ({
  type: 'function' as const,
  name,
  description,
  strict: true as const,
  parameters: {
    type: 'object' as const,
    properties,
    required: Object.keys(properties),
    additionalProperties: false as const,
  },
})

/** The inventory as the backend model receives it. */
export const GUIDE_TOOLS = [
  strict(
    'go_to',
    'Move the camera to a named object. Returns at once with "moving"; the developer reports the arrival and what is on screen a few seconds later. A new go_to replaces a move still under way.',
    {
      subject: text('The object by name, as the scene or a listing names it.'),
      framing: nullable(
        text(
          'A framing from the scene block for this subject, such as "portrait", "wide", "crescent", or "preset:the-rings". Null for the default.',
        ),
      ),
      motion: nullable(
        choice(
          'A slow camera gesture that runs after arrival. Null holds still.',
          GUIDE_MOTIONS,
        ),
      ),
    },
  ),
  strict(
    'adjust_view',
    'Change the orbit angle, distance, or zoom around the current subject. Every value is clamped to what the observatory allows. Null leaves a value as it is.',
    {
      azimuth_deg: nullable(number('Orbit angle around the pole, degrees.')),
      elevation_deg: nullable(
        number('Angle above the equatorial plane, degrees.', -88, 88),
      ),
      distance_radii: nullable(
        number('Distance from the center, in subject radii.', 1, 10000),
      ),
      zoom_factor: nullable(
        number(
          'Relative zoom. Above 1 retreats, below 1 approaches.',
          0.05,
          20,
        ),
      ),
    },
  ),
  strict(
    'frame_pair',
    'Frame a subject together with a companion body in the same system, both in view. Returns at once; the arrival follows.',
    {
      subject: text('The body to orbit.'),
      companion: text('The other body to keep in the frame.'),
    },
  ),
  strict(
    'stand_at',
    'Stand on the surface of a solid body at a survey site. Rejected for gas giants, ice giants, and stars. Returns at once; the arrival follows with the horizon, the time of day, and the sky.',
    {
      subject: text('The solid body.'),
      site: text(
        'A site id from the scene block, or "summit", "shore", "basin", or "pole".',
      ),
    },
  ),
  strict('look_around', 'Turn the head while standing on a surface.', {
    heading_deg: number('Compass heading, degrees; 0 is north.', -360, 360),
    pitch_deg: number('Angle above the horizon, degrees.', -88, 88),
  }),
  strict('leave_surface', 'Rise from the surface back to orbit.', {}),
  strict(
    'set_time',
    'Change the photographic instant the picture shows. Never the simulation.',
    {
      mode: choice(
        '"live" follows the simulation; "hold" freezes the picture at its current instant; "set" holds a given instant; "rate" runs the picture at a multiple of real time.',
        GUIDE_TIME_MODES,
      ),
      instant: nullable(
        text('An ISO 8601 instant, required for "set" and otherwise null.'),
      ),
      rate: nullable(
        number(
          'Seconds of picture time per real second, required for "rate" and otherwise null.',
          0.001,
          100000,
        ),
      ),
    },
  ),
  strict('hold_view', 'Stop any camera motion and hold the current view.', {}),
  strict(
    'linger',
    'Declare the quiet look that follows this tour stop. Call it before writing the words for a stop that the tour continues after; the developer prompts you again once the words are spoken and the seconds have passed. Do not call it on the final stop.',
    {
      seconds: number(
        'Quiet seconds after the words, 3 to 45. Three or four for an ordinary stop; longer only for a view worth a long look.',
        GUIDE_LIMITS.lingerSeconds.min,
        GUIDE_LIMITS.lingerSeconds.max,
      ),
      reason: text('One phrase on what the visitor is looking at.'),
    },
  ),
  strict(
    'describe_view',
    'What is on screen right now: the subject, each visible object with its screen position, apparent size and lit fraction, the framing, and the picture time. No image.',
    {},
  ),
  strict(
    'read_subject',
    'The application record for a named object: measurements with units and spoken wording, provenance, the reason for any missing value, and curated notes where they exist.',
    {
      subject: text('The object by name.'),
      fields: nullable({
        type: 'array',
        description:
          'Up to twelve fact labels to return, or null for the whole record.',
        items: { type: 'string' },
      }),
    },
  ),
  strict(
    'list_subjects',
    'Names and one-line summaries: the bodies of the current or a named system, the moons of a body, or the stars within a few light years.',
    {
      scope: choice('What to list.', GUIDE_LIST_SCOPES),
      of: nullable(
        text(
          'The system or body the listing is about; null for the current one.',
        ),
      ),
      limit: nullable(number('At most this many.', 1, GUIDE_LIMITS.results)),
    },
  ),
  strict(
    'find_worlds',
    'Search the nearby galaxy for worlds matching a description. Bounded and slow; results name what was found or say that nothing was, within the searched radius.',
    {
      query: {
        type: 'object',
        description: 'Every field is a filter; null or empty means any.',
        properties: {
          kinds: {
            type: 'array',
            items: { type: 'string', enum: [...GUIDE_WORLD_KINDS] },
          },
          star_classes: {
            type: 'array',
            items: { type: 'string', enum: [...GUIDE_STAR_CLASSES] },
          },
          atmosphere: nullable({ type: 'boolean' }),
          sea: nullable({ type: 'boolean' }),
          rings: nullable({ type: 'boolean' }),
          habitable: nullable({ type: 'boolean' }),
          landable: nullable({ type: 'boolean' }),
          moons: nullable(number('At least this many moons.', 0, 100)),
          min_radius: nullable(number('Earth radii.', 0, 100)),
          max_radius: nullable(number('Earth radii.', 0, 100)),
        },
        required: [
          'kinds',
          'star_classes',
          'atmosphere',
          'sea',
          'rings',
          'habitable',
          'landable',
          'moons',
          'min_radius',
          'max_radius',
        ],
        additionalProperties: false,
      },
      radius_light_years: number(
        'How far to sweep.',
        0.01,
        GUIDE_LIMITS.searchLightYears,
      ),
      limit: number('At most this many matches.', 1, GUIDE_LIMITS.results),
    },
  ),
  strict(
    'resolve_name',
    'Which objects a name could mean, with their kinds and systems.',
    { query: text('The name as heard.') },
  ),
] as const

/* ------------------------------------------------------------------------- */
/* Decoding a call                                                            */
/* ------------------------------------------------------------------------- */

type Raw = Record<string, unknown>

function record(value: unknown): Raw | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : null
}
function exact(raw: Raw, keys: readonly string[]): string | null {
  const present = Object.keys(raw)
  for (const key of present)
    if (!keys.includes(key)) return `${key}: unknown argument`
  for (const key of keys)
    if (!Object.hasOwn(raw, key)) return `${key}: missing argument`
  return null
}
function str(value: unknown, key: string, max = GUIDE_LIMITS.text) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max
    ? null
    : `${key}: expected text`
}
function num(value: unknown, key: string, min: number, max: number) {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max
    ? null
    : `${key}: expected a number in [${min}, ${max}]`
}
function oneOf(value: unknown, key: string, values: readonly string[]) {
  return typeof value === 'string' && values.includes(value)
    ? null
    : `${key}: expected one of ${values.join(', ')}`
}
const orNull =
  (check: (value: unknown, key: string) => string | null) =>
  (value: unknown, key: string) => (value === null ? null : check(value, key))

function fail(reason: string | null): reason is string {
  return reason !== null
}

/**
 * Decode one function call the data channel delivered.
 *
 * `argumentsText` is the model's own JSON. Everything about it is checked
 * here — the name, the exact key set, every type and bound — because this is
 * the only gate between a model's output and a call into the observatory.
 */
export function decodeGuideCall(
  name: string,
  argumentsText: string,
): Result<GuideCall, string> {
  if (argumentsText.length > GUIDE_LIMITS.argumentBytes)
    return err('arguments: too long')
  let raw: Raw | null
  try {
    raw = record(argumentsText.trim() === '' ? {} : JSON.parse(argumentsText))
  } catch {
    return err('arguments: not JSON')
  }
  if (raw === null) return err('arguments: expected an object')
  const shape = (keys: readonly string[]) => exact(raw, keys)
  const motion = orNull((v, k) => oneOf(v, k, GUIDE_MOTIONS))
  const optionalText = orNull((v, k) => str(v, k))
  switch (name) {
    case 'go_to': {
      const reason =
        shape(['subject', 'framing', 'motion']) ??
        str(raw.subject, 'subject') ??
        optionalText(raw.framing, 'framing') ??
        motion(raw.motion, 'motion')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        subject: raw.subject as string,
        framing: raw.framing as string | null,
        motion: raw.motion as TourCameraMotion | null,
      })
    }
    case 'adjust_view': {
      const reason =
        shape([
          'azimuth_deg',
          'elevation_deg',
          'distance_radii',
          'zoom_factor',
        ]) ??
        orNull((v, k) => num(v, k, -3600, 3600))(
          raw.azimuth_deg,
          'azimuth_deg',
        ) ??
        orNull((v, k) => num(v, k, -88, 88))(
          raw.elevation_deg,
          'elevation_deg',
        ) ??
        orNull((v, k) => num(v, k, 1, 10000))(
          raw.distance_radii,
          'distance_radii',
        ) ??
        orNull((v, k) => num(v, k, 0.05, 20))(raw.zoom_factor, 'zoom_factor')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        azimuth_deg: raw.azimuth_deg as number | null,
        elevation_deg: raw.elevation_deg as number | null,
        distance_radii: raw.distance_radii as number | null,
        zoom_factor: raw.zoom_factor as number | null,
      })
    }
    case 'frame_pair': {
      const reason =
        shape(['subject', 'companion']) ??
        str(raw.subject, 'subject') ??
        str(raw.companion, 'companion')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        subject: raw.subject as string,
        companion: raw.companion as string,
      })
    }
    case 'stand_at': {
      const reason =
        shape(['subject', 'site']) ??
        str(raw.subject, 'subject') ??
        str(raw.site, 'site')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        subject: raw.subject as string,
        site: raw.site as string,
      })
    }
    case 'look_around': {
      const reason =
        shape(['heading_deg', 'pitch_deg']) ??
        num(raw.heading_deg, 'heading_deg', -360, 360) ??
        num(raw.pitch_deg, 'pitch_deg', -88, 88)
      if (fail(reason)) return err(reason)
      return ok({
        name,
        heading_deg: raw.heading_deg as number,
        pitch_deg: raw.pitch_deg as number,
      })
    }
    case 'leave_surface':
    case 'hold_view':
    case 'describe_view': {
      const reason = shape([])
      if (fail(reason)) return err(reason)
      return ok({ name })
    }
    case 'set_time': {
      const reason =
        shape(['mode', 'instant', 'rate']) ??
        oneOf(raw.mode, 'mode', GUIDE_TIME_MODES) ??
        optionalText(raw.instant, 'instant') ??
        orNull((v, k) => num(v, k, 0.001, 100000))(raw.rate, 'rate')
      if (fail(reason)) return err(reason)
      const mode = raw.mode as (typeof GUIDE_TIME_MODES)[number]
      if ((mode === 'set') !== (raw.instant !== null))
        return err('instant: required for "set" and otherwise null')
      if ((mode === 'rate') !== (raw.rate !== null))
        return err('rate: required for "rate" and otherwise null')
      if (
        raw.instant !== null &&
        Number.isNaN(Date.parse(raw.instant as string))
      )
        return err('instant: expected an ISO 8601 instant')
      return ok({
        name,
        mode,
        instant: raw.instant as string | null,
        rate: raw.rate as number | null,
      })
    }
    case 'linger': {
      const reason =
        shape(['seconds', 'reason']) ??
        num(
          raw.seconds,
          'seconds',
          GUIDE_LIMITS.lingerSeconds.min,
          GUIDE_LIMITS.lingerSeconds.max,
        ) ??
        str(raw.reason, 'reason')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        seconds: raw.seconds as number,
        reason: raw.reason as string,
      })
    }
    case 'read_subject': {
      const reason =
        shape(['subject', 'fields']) ??
        str(raw.subject, 'subject') ??
        (raw.fields === null
          ? null
          : Array.isArray(raw.fields) &&
              raw.fields.length <= 12 &&
              raw.fields.every((field) => str(field, 'fields') === null)
            ? null
            : 'fields: expected up to twelve labels')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        subject: raw.subject as string,
        fields: raw.fields as readonly string[] | null,
      })
    }
    case 'list_subjects': {
      const reason =
        shape(['scope', 'of', 'limit']) ??
        oneOf(raw.scope, 'scope', GUIDE_LIST_SCOPES) ??
        optionalText(raw.of, 'of') ??
        orNull((v, k) => num(v, k, 1, GUIDE_LIMITS.results))(raw.limit, 'limit')
      if (fail(reason)) return err(reason)
      return ok({
        name,
        scope: raw.scope as (typeof GUIDE_LIST_SCOPES)[number],
        of: raw.of as string | null,
        limit: raw.limit as number | null,
      })
    }
    case 'find_worlds': {
      const reason =
        shape(['query', 'radius_light_years', 'limit']) ??
        num(
          raw.radius_light_years,
          'radius_light_years',
          0.01,
          GUIDE_LIMITS.searchLightYears,
        ) ??
        num(raw.limit, 'limit', 1, GUIDE_LIMITS.results)
      if (fail(reason)) return err(reason)
      const query = decodeWorldQuery(raw.query)
      if (!query.ok) return query
      return ok({
        name,
        query: query.value,
        radius_light_years: raw.radius_light_years as number,
        limit: raw.limit as number,
      })
    }
    case 'resolve_name': {
      const reason = shape(['query']) ?? str(raw.query, 'query')
      if (fail(reason)) return err(reason)
      return ok({ name, query: raw.query as string })
    }
    default:
      return err(`${name}: unknown tool`)
  }
}

function decodeWorldQuery(value: unknown): Result<TourWorldQuery, string> {
  const raw = record(value)
  if (raw === null) return err('query: expected an object')
  const keys = [
    'kinds',
    'star_classes',
    'atmosphere',
    'sea',
    'rings',
    'habitable',
    'landable',
    'moons',
    'min_radius',
    'max_radius',
  ]
  const shape = exact(raw, keys)
  if (fail(shape)) return err(`query.${shape}`)
  const list = (
    value: unknown,
    key: string,
    values: readonly string[],
    max: number,
  ) =>
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === 'string' && values.includes(item))
      ? null
      : `query.${key}: expected a list of ${values.join(', ')}`
  const flag = (value: unknown, key: string) =>
    value === null || typeof value === 'boolean'
      ? null
      : `query.${key}: expected true, false, or null`
  const reason =
    list(raw.kinds, 'kinds', GUIDE_WORLD_KINDS, 8) ??
    list(raw.star_classes, 'star_classes', GUIDE_STAR_CLASSES, 11) ??
    flag(raw.atmosphere, 'atmosphere') ??
    flag(raw.sea, 'sea') ??
    flag(raw.rings, 'rings') ??
    flag(raw.habitable, 'habitable') ??
    flag(raw.landable, 'landable') ??
    orNull((v, k) => num(v, k, 0, 100))(raw.moons, 'query.moons') ??
    orNull((v, k) => num(v, k, 0, 100))(raw.min_radius, 'query.min_radius') ??
    orNull((v, k) => num(v, k, 0, 100))(raw.max_radius, 'query.max_radius')
  if (fail(reason)) return err(reason)
  const query: TourWorldQuery = {
    kinds: raw.kinds as TourWorldQuery['kinds'],
    starClasses: raw.star_classes as TourWorldQuery['starClasses'],
    atmosphere: raw.atmosphere as boolean | null,
    sea: raw.sea as boolean | null,
    rings: raw.rings as boolean | null,
    habitable: raw.habitable as boolean | null,
    landable: raw.landable as boolean | null,
    moons: raw.moons as number | null,
    minRadius: raw.min_radius as number | null,
    maxRadius: raw.max_radius as number | null,
  }
  if (
    query.kinds.length === 0 &&
    query.starClasses.length === 0 &&
    Object.values(query).every((item) => item === null || Array.isArray(item))
  )
    return err('query: choose at least one filter')
  if (
    query.minRadius !== null &&
    query.maxRadius !== null &&
    query.minRadius > query.maxRadius
  )
    return err('query: the radius range is reversed')
  return ok(query)
}

/* ------------------------------------------------------------------------- */
/* The data channel                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Exactly the tool loop, the scene, the greeting, mute, and close.
 *
 * `session.update` is absent on purpose: with it the browser could switch the
 * backend model, rewrite its instructions, or enable web search for the life
 * of its session. The provider refuses anything not listed here with
 * `event_not_allowed`; the browser's own sender refuses first, so a bug shows
 * up as a thrown error in a test rather than a provider error in a session.
 */
export const GUIDE_CLIENT_EVENTS = [
  'response.item.create',
  'response.create',
  'session.thinking.append',
  'session.instructions.append',
  'session.commentary.append',
  'session.input_audio.mute',
  'session.input_audio.unmute',
  'session.close',
] as const
export type GuideClientEvent = (typeof GUIDE_CLIENT_EVENTS)[number]

/** Every voice the Live reference lists that the panel offers. */
export const GUIDE_VOICES = [
  'marin',
  'cedar',
  'gleam',
  'meridian',
  'vesper',
  'willow',
  'stone',
  'quartz',
  'ripple',
  'sage',
  'coral',
] as const
export type GuideVoice = (typeof GUIDE_VOICES)[number]
export const isGuideVoice = (value: unknown): value is GuideVoice =>
  typeof value === 'string' &&
  (GUIDE_VOICES as readonly string[]).includes(value)
