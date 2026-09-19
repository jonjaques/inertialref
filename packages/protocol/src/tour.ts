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

/*
 * The guide's record of the scene: what the browser knows about the bodies in
 * view and can hand the backend model on request.
 *
 * Nothing here crosses a wire between the browser and the Worker. The Worker
 * creates the voice session and never sees the scene; the browser executes
 * every tool itself and answers the model with these records serialized as
 * tool output. The decoders remain because a record that reaches a model is a
 * record that must be bounded, and because a fuzz test is the cheapest proof
 * that a hash-derived subject id, a fact, and a source all stay inside their
 * limits.
 */

export const TOUR_PROTOCOL_VERSION = 3
export const TOUR_LIMITS = {
  messageBytes: 65_536,
  candidates: 16,
  facts: 12,
  requestCharacters: 4_000,
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
export type TourCameraMotion =
  'hold' | 'orbit' | 'push-in' | 'pull-back' | 'reveal'
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
  display: nullable(text(768)),
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
  // Six the survey searches for, and the four the drainage graph names on
  // a world that drains: the headwater, the confluence, the mouth, the lake.
  sites: list(strict({ id, name: text(160), detail: text(512) }), 12),
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

/** Count UTF-8 without requiring a host TextEncoder in a portable package. */
export function tourMessageBytes(text: string): number {
  let size = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return size
}

/** Whether a record fits the bound every serialized record is held to. */
export function withinTourBytes(value: unknown): Result<true, string> {
  const text = JSON.stringify(value)
  return text.length > TOUR_LIMITS.messageBytes ||
    tourMessageBytes(text) > TOUR_LIMITS.messageBytes
    ? err('Tour record exceeds 64 KiB.')
    : ok(true)
}
