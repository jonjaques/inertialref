import { err, ok, type Result } from '@inertialref/shared'
import {
  decodeArray,
  decodeBoolean,
  decodeEnum,
  decodeNumber,
  decodeObject,
  decodeString,
  type Decoder,
  type Decoded,
  type Shape,
} from './codec.ts'

export const TOUR_PROTOCOL_VERSION = 1
export const TOUR_LIMITS = {
  messageBytes: 65_536,
  candidates: 16,
  facts: 12,
  stops: 8,
  requestCharacters: 4_000,
  durationSeconds: 600,
  operations: 6,
} as const

export interface TourManifest {
  readonly seed: string
  readonly catalogVersion: string
  readonly generation: Readonly<Record<string, number>>
}
export interface TourSource {
  readonly id: string
  readonly title: string
  readonly url: string | null
  readonly origin: 'application' | 'curated'
}
export interface TourFact {
  readonly id: string
  readonly label: string
  readonly quantity: number | null
  readonly unit: string | null
  readonly display: string | null
  readonly speech: string | null
  readonly reason: string | null
  readonly provenance: 'observed' | 'projected' | 'derived' | 'unknown'
  readonly sourceIds: readonly string[]
}
export interface SubjectBrief {
  readonly subjectId: string
  readonly address: string
  readonly name: string
  readonly provenance: 'observed' | 'projected'
  readonly classification: string
  readonly summary: string
  readonly facts: readonly TourFact[]
  readonly sources: readonly TourSource[]
  readonly observer: {
    readonly pictureTime: number
    readonly altitudeMeters: number | null
    readonly fill: number | null
    readonly arrived: boolean
  }
}
export interface TourCandidate {
  readonly id: string
  readonly address: string
  readonly name: string
  readonly provenance: 'observed' | 'projected'
  readonly kind: string
  readonly parentId: string | null
  readonly framings: readonly string[]
  readonly sites: readonly {
    readonly id: string
    readonly name: string
    readonly detail: string
  }[]
  readonly factIds: readonly string[]
}
export interface TourContext {
  readonly protocolVersion: number
  readonly manifest: TourManifest
  readonly viewRevision: number
  readonly pictureTime: number
  readonly subjectId: string | null
  readonly traveling: boolean
  readonly candidates: readonly TourCandidate[]
  readonly brief: SubjectBrief | null
  readonly briefs: readonly SubjectBrief[]
}
export interface TourStop {
  readonly id: string
  readonly subjectId: string
  readonly framingId: string | null
  readonly siteId: string | null
  readonly objective: string
  readonly factIds: readonly string[]
  readonly minimumViewSeconds: number
}
export interface TourPlan {
  readonly id: string
  readonly goal: string
  readonly durationSeconds: number
  readonly stops: readonly TourStop[]
}
export type TourCommand = 'start' | 'pause' | 'resume' | 'next' | 'back' | 'end'
export interface TourWorldQuery {
  readonly kinds: readonly (
    | 'rocky'
    | 'ice'
    | 'gas-giant'
    | 'ice-giant'
    | 'moon'
    | 'dwarf'
    | 'asteroid'
    | 'comet'
  )[]
  readonly starClasses: readonly (
    'O' | 'B' | 'A' | 'F' | 'G' | 'K' | 'M' | 'L' | 'T' | 'Y' | 'D'
  )[]
  readonly atmosphere: boolean | null
  readonly sea: boolean | null
  readonly rings: boolean | null
  readonly habitable: boolean | null
  readonly landable: boolean | null
  readonly moons: number | null
  readonly minRadius: number | null
  readonly maxRadius: number | null
}
export type TourAction =
  | { readonly tool: 'resolve_subject'; readonly query: string }
  | {
      readonly tool: 'find_worlds'
      readonly query: TourWorldQuery
      readonly radiusLightYears: number
      readonly limit: number
    }
  | { readonly tool: 'show_subject'; readonly subjectId: string }
  | {
      readonly tool: 'compose_view'
      readonly subjectId: string
      readonly framingId: string
    }
  | {
      readonly tool: 'stand_at_site'
      readonly subjectId: string
      readonly siteId: string
    }
  | { readonly tool: 'read_subject'; readonly subjectId: string }
  | {
      readonly tool: 'set_picture_time'
      readonly mode: 'hold' | 'live' | 'pause' | 'resume' | 'set' | 'rate'
      readonly value: number | null
    }
export interface ToolRequest {
  readonly sessionId: string
  readonly requestRevision: number
  readonly operationId: string
  readonly expectedViewRevision: number
  readonly expiresAt: number
  readonly action: TourAction
}
export interface ToolReceipt {
  readonly operationId: string
  readonly requestRevision: number
  readonly status: 'accepted' | 'arrived' | 'rejected' | 'canceled'
  readonly viewRevision: number
  readonly pictureTime: number
  readonly subjectId: string | null
  readonly reason: string | null
}
export interface NarrationBrief {
  readonly id: string
  readonly requestRevision: number
  readonly stopId: string | null
  readonly viewRevision: number
  readonly subjectId: string | null
  readonly text: string
  readonly factIds: readonly string[]
  readonly sourceIds: readonly string[]
  readonly sources: readonly TourSource[]
}
export type TourClientMessage =
  | { readonly type: 'context'; readonly context: TourContext }
  | {
      readonly type: 'ask'
      readonly text: string
      readonly requestRevision: number
      readonly viewRevision: number
    }
  | {
      readonly type: 'command'
      readonly command: TourCommand
      readonly requestRevision: number
      readonly viewRevision: number
    }
  | { readonly type: 'receipt'; readonly receipt: ToolReceipt }
  | {
      readonly type: 'live-startup'
      readonly events: readonly TourTranscript[]
    }
  | {
      readonly type: 'narration-ready' | 'narration-ended'
      readonly stopId: string
      readonly requestRevision: number
      readonly viewRevision: number
    }
export type TourServerMessage =
  | {
      readonly type: 'ready'
      readonly sessionId: string
      readonly requestRevision: number
    }
  | {
      readonly type: 'status'
      readonly state: string
      readonly message: string
    }
  | {
      readonly type: 'plan'
      readonly plan: TourPlan
      readonly requestRevision: number
    }
  | { readonly type: 'tool'; readonly request: ToolRequest }
  | { readonly type: 'narration'; readonly brief: NarrationBrief }
  | {
      readonly type: 'error'
      readonly code: string
      readonly message: string
      readonly retryable: boolean
    }
  | { readonly type: 'closed'; readonly reason: string }
  | ({ readonly type: 'transcript' } & TourTranscript)

export interface TourTranscript {
  readonly eventId: string
  readonly text: string
  readonly speaker: 'visitor' | 'guide'
  readonly startMs: number
  readonly endMs: number
}

function strict<S extends Shape>(shape: S): Decoder<Decoded<S>> {
  const inner = decodeObject(shape)
  return (value, path) => {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of Object.keys(value))
        if (!Object.hasOwn(shape, key))
          return err(`${path}.${key}: unknown field`)
    }
    return inner(value, path)
  }
}
function boundedNumber(
  min: number,
  max: number,
  integer = false,
): Decoder<number> {
  return (value, path) => {
    const result = decodeNumber(value, path)
    return result.ok &&
      (result.value < min ||
        result.value > max ||
        (integer && !Number.isSafeInteger(result.value)))
      ? err(`${path}: number outside bounds`)
      : result
  }
}
function text(max: number, min = 1): Decoder<string> {
  return (value, path) => {
    const result = decodeString(value, path)
    return result.ok && (result.value.length < min || result.value.length > max)
      ? err(`${path}: text outside bounds`)
      : result
  }
}
function nullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null ? ok(null) : inner(value, path))
}
function list<T>(
  inner: Decoder<T>,
  max: number,
  min = 0,
): Decoder<readonly T[]> {
  return (value, path) =>
    Array.isArray(value) && value.length >= min && value.length <= max
      ? decodeArray(inner)(value, path)
      : err(`${path}: array outside bounds`)
}
function union<T>(
  variants: Readonly<Record<string, Decoder<T>>>,
  key = 'type',
): Decoder<T> {
  return (value, path) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return err(`${path}: expected object`)
    const tag = (value as Record<string, unknown>)[key]
    const decoder =
      typeof tag === 'string' && Object.hasOwn(variants, tag)
        ? variants[tag]
        : undefined
    return decoder === undefined
      ? err(`${path}.${key}: unknown variant`)
      : decoder(value, path)
  }
}
const id = text(160)
const revision = boundedNumber(0, Number.MAX_SAFE_INTEGER, true)
const instant = boundedNumber(-3.15576e12, 3.15576e12)
const provenance = decodeEnum('observed', 'projected')
const generation: Decoder<Readonly<Record<string, number>>> = (value, path) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return err(`${path}: expected manifest`)
  const entries = Object.entries(value)
  if (entries.length < 1 || entries.length > 32)
    return err(`${path}: manifest outside bounds`)
  const out: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >
  for (const [key, version] of entries) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key))
      return err(`${path}: invalid algorithm name`)
    const checked = revision(version, path)
    if (!checked.ok) return checked
    out[key] = checked.value
  }
  return ok(out)
}
export const decodeTourManifest: Decoder<TourManifest> = strict({
  seed: text(256),
  catalogVersion: text(256),
  generation,
})
const source: Decoder<TourSource> = strict({
  id,
  title: text(512),
  url: nullable(text(2048)),
  origin: decodeEnum('application', 'curated'),
})
const factShape = strict({
  id,
  label: text(160),
  quantity: nullable(decodeNumber),
  unit: nullable(text(64)),
  display: nullable(text(512)),
  speech: nullable(text(768)),
  reason: nullable(text(768)),
  provenance: decodeEnum('observed', 'projected', 'derived', 'unknown'),
  sourceIds: list(id, 8, 1),
})
export const decodeTourFact: Decoder<TourFact> = (value, path) => {
  const result = factShape(value, path)
  if (!result.ok) return result
  const fact = result.value
  if (
    (fact.display === null) !== (fact.speech === null) ||
    (fact.display === null) !== (fact.reason !== null)
  )
    return err(`${path}: missing facts require a reason`)
  if (fact.quantity !== null && (fact.unit === null || fact.display === null))
    return err(`${path}: quantity requires a unit and wording`)
  return result
}
export const decodeSubjectBrief: Decoder<SubjectBrief> = strict({
  subjectId: id,
  address: text(256),
  name: text(160),
  provenance,
  classification: text(256),
  summary: text(1024),
  facts: list(decodeTourFact, TOUR_LIMITS.facts),
  sources: list(source, 8, 1),
  observer: strict({
    pictureTime: instant,
    altitudeMeters: nullable(boundedNumber(0, 1e30)),
    fill: nullable(boundedNumber(0, 1e6)),
    arrived: decodeBoolean,
  }),
})
export const decodeTourCandidate: Decoder<TourCandidate> = strict({
  id,
  address: text(256),
  name: text(160),
  provenance,
  kind: decodeEnum(
    'star',
    'rocky',
    'ice',
    'gas-giant',
    'ice-giant',
    'moon',
    'dwarf',
    'asteroid',
    'comet',
  ),
  parentId: nullable(id),
  framings: list(id, 32),
  sites: list(strict({ id, name: text(160), detail: text(512) }), 8),
  factIds: list(id, TOUR_LIMITS.facts),
})
export const decodeTourContext: Decoder<TourContext> = strict({
  protocolVersion: boundedNumber(
    TOUR_PROTOCOL_VERSION,
    TOUR_PROTOCOL_VERSION,
    true,
  ),
  manifest: decodeTourManifest,
  viewRevision: revision,
  pictureTime: instant,
  subjectId: nullable(id),
  traveling: decodeBoolean,
  candidates: list(decodeTourCandidate, TOUR_LIMITS.candidates),
  brief: nullable(decodeSubjectBrief),
  briefs: list(decodeSubjectBrief, TOUR_LIMITS.candidates),
})
export const decodeTourStop: Decoder<TourStop> = strict({
  id,
  subjectId: id,
  framingId: nullable(id),
  siteId: nullable(id),
  objective: text(512),
  factIds: list(id, TOUR_LIMITS.facts),
  minimumViewSeconds: boundedNumber(2, 120),
})
export const decodeTourPlan: Decoder<TourPlan> = strict({
  id,
  goal: text(1024),
  durationSeconds: boundedNumber(2, TOUR_LIMITS.durationSeconds),
  stops: list(decodeTourStop, TOUR_LIMITS.stops, 1),
})
const pictureTime = strict({
  tool: decodeEnum('set_picture_time'),
  mode: decodeEnum('hold', 'live', 'pause', 'resume', 'set', 'rate'),
  value: nullable(instant),
})
const queryShape = strict({
  kinds: list(
    decodeEnum(
      'rocky',
      'ice',
      'gas-giant',
      'ice-giant',
      'moon',
      'dwarf',
      'asteroid',
      'comet',
    ),
    8,
  ),
  starClasses: list(
    decodeEnum('O', 'B', 'A', 'F', 'G', 'K', 'M', 'L', 'T', 'Y', 'D'),
    11,
  ),
  atmosphere: nullable(decodeBoolean),
  sea: nullable(decodeBoolean),
  rings: nullable(decodeBoolean),
  habitable: nullable(decodeBoolean),
  landable: nullable(decodeBoolean),
  moons: nullable(boundedNumber(0, 100, true)),
  minRadius: nullable(boundedNumber(0, 100)),
  maxRadius: nullable(boundedNumber(0, 100)),
})
export const decodeTourWorldQuery: Decoder<TourWorldQuery> = (value, path) => {
  const result = queryShape(value, path)
  if (!result.ok) return result
  const query = result.value
  if (
    query.kinds.length === 0 &&
    query.starClasses.length === 0 &&
    Object.values(query).every((item) => item === null || Array.isArray(item))
  )
    return err(`${path}: choose a bounded search predicate`)
  if (
    query.minRadius !== null &&
    query.maxRadius !== null &&
    query.minRadius > query.maxRadius
  )
    return err(`${path}: radius range is reversed`)
  return result
}
export const decodeTourAction: Decoder<TourAction> = union<TourAction>(
  {
    resolve_subject: strict({
      tool: decodeEnum('resolve_subject'),
      query: text(160),
    }),
    find_worlds: strict({
      tool: decodeEnum('find_worlds'),
      query: decodeTourWorldQuery,
      radiusLightYears: boundedNumber(0.01, 8),
      limit: boundedNumber(1, TOUR_LIMITS.candidates, true),
    }),
    show_subject: strict({ tool: decodeEnum('show_subject'), subjectId: id }),
    read_subject: strict({ tool: decodeEnum('read_subject'), subjectId: id }),
    compose_view: strict({
      tool: decodeEnum('compose_view'),
      subjectId: id,
      framingId: id,
    }),
    stand_at_site: strict({
      tool: decodeEnum('stand_at_site'),
      subjectId: id,
      siteId: id,
    }),
    set_picture_time: (value, path) => {
      const result = pictureTime(value, path)
      if (!result.ok) return result
      const action = result.value
      if (
        (action.mode === 'set' || action.mode === 'rate') !==
        (action.value !== null)
      )
        return err(`${path}: time mode/value mismatch`)
      if (
        action.mode === 'rate' &&
        (action.value === null || action.value <= 0 || action.value > 100000)
      )
        return err(`${path}: invalid picture rate`)
      return result
    },
  },
  'tool',
)
export const decodeToolRequest: Decoder<ToolRequest> = strict({
  sessionId: id,
  requestRevision: revision,
  operationId: id,
  expectedViewRevision: revision,
  expiresAt: boundedNumber(0, Number.MAX_SAFE_INTEGER),
  action: decodeTourAction,
})
export const decodeToolReceipt: Decoder<ToolReceipt> = strict({
  operationId: id,
  requestRevision: revision,
  status: decodeEnum('accepted', 'arrived', 'rejected', 'canceled'),
  viewRevision: revision,
  pictureTime: instant,
  subjectId: nullable(id),
  reason: nullable(text(512)),
})
export const decodeNarrationBrief: Decoder<NarrationBrief> = strict({
  id,
  requestRevision: revision,
  stopId: nullable(id),
  viewRevision: revision,
  subjectId: nullable(id),
  text: text(8000),
  factIds: list(id, TOUR_LIMITS.facts),
  sourceIds: list(id, 16),
  sources: list(source, 16),
})
const transcriptFields = {
  eventId: id,
  text: text(8000, 0),
  speaker: decodeEnum('visitor', 'guide'),
  startMs: boundedNumber(0, 1e12),
  endMs: boundedNumber(0, 1e12),
}
export const decodeTourTranscript: Decoder<TourTranscript> =
  strict(transcriptFields)

export const decodeTourClientMessage: Decoder<TourClientMessage> =
  union<TourClientMessage>({
    'live-startup': strict({
      type: decodeEnum('live-startup'),
      events: list(decodeTourTranscript, 64),
    }),
    context: strict({
      type: decodeEnum('context'),
      context: decodeTourContext,
    }),
    ask: strict({
      type: decodeEnum('ask'),
      text: text(TOUR_LIMITS.requestCharacters),
      requestRevision: revision,
      viewRevision: revision,
    }),
    command: strict({
      type: decodeEnum('command'),
      command: decodeEnum('start', 'pause', 'resume', 'next', 'back', 'end'),
      requestRevision: revision,
      viewRevision: revision,
    }),
    receipt: strict({
      type: decodeEnum('receipt'),
      receipt: decodeToolReceipt,
    }),
    'narration-ready': strict({
      type: decodeEnum('narration-ready'),
      stopId: id,
      requestRevision: revision,
      viewRevision: revision,
    }),
    'narration-ended': strict({
      type: decodeEnum('narration-ended'),
      stopId: id,
      requestRevision: revision,
      viewRevision: revision,
    }),
  })
export const decodeTourServerMessage: Decoder<TourServerMessage> =
  union<TourServerMessage>({
    ready: strict({
      type: decodeEnum('ready'),
      sessionId: id,
      requestRevision: revision,
    }),
    status: strict({
      type: decodeEnum('status'),
      state: text(80),
      message: text(1024, 0),
    }),
    plan: strict({
      type: decodeEnum('plan'),
      plan: decodeTourPlan,
      requestRevision: revision,
    }),
    tool: strict({ type: decodeEnum('tool'), request: decodeToolRequest }),
    narration: strict({
      type: decodeEnum('narration'),
      brief: decodeNarrationBrief,
    }),
    error: strict({
      type: decodeEnum('error'),
      code: text(80),
      message: text(1024),
      retryable: decodeBoolean,
    }),
    closed: strict({ type: decodeEnum('closed'), reason: text(512) }),
    transcript: strict({ type: decodeEnum('transcript'), ...transcriptFields }),
  })

/** Count UTF-8 without requiring a host TextEncoder in a portable package. */
export function tourMessageBytes(text: string): number {
  let size = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return size
}
export function decodeTourMessage<T>(
  decoder: Decoder<T>,
  text: string,
): Result<T, string> {
  if (
    text.length > TOUR_LIMITS.messageBytes ||
    tourMessageBytes(text) > TOUR_LIMITS.messageBytes
  )
    return err('Tour message exceeds 64 KiB.')
  try {
    return decoder(JSON.parse(text), '')
  } catch {
    return err('Invalid tour JSON.')
  }
}

export function validateTourPlan(
  plan: TourPlan,
  context: TourContext,
): Result<TourPlan, string> {
  const shape = decodeTourPlan(plan, 'plan')
  if (!shape.ok) return shape
  const ids = new Set<string>()
  let duration = 0
  for (const stop of plan.stops) {
    if (ids.has(stop.id)) return err('A stop ID is repeated.')
    ids.add(stop.id)
    const candidate = context.candidates.find(
      (item) => item.id === stop.subjectId,
    )
    const brief = context.briefs.find(
      (item) => item.subjectId === stop.subjectId,
    )
    if (candidate === undefined || brief === undefined)
      return err('A stop names an unavailable subject.')
    if (stop.framingId !== null && !candidate.framings.includes(stop.framingId))
      return err('A stop names an unavailable framing.')
    if (
      stop.siteId !== null &&
      !candidate.sites.some((site) => site.id === stop.siteId)
    )
      return err('A stop names an unavailable site.')
    if (stop.framingId !== null && stop.siteId !== null)
      return err('A stop chooses both a framing and a site.')
    if (
      new Set(stop.factIds).size !== stop.factIds.length ||
      stop.factIds.some(
        (id) =>
          !candidate.factIds.includes(id) ||
          !brief.facts.some((fact) => fact.id === id),
      )
    )
      return err('A stop names an unsupported fact.')
    duration += stop.minimumViewSeconds
  }
  return duration > plan.durationSeconds
    ? err('The stops exceed the tour duration.')
    : ok(plan)
}
