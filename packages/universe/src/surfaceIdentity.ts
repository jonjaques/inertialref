import type { SurfaceParameters } from './system.ts'

/*
 * Which surface this is, stated once.
 *
 * Three caches answer that question for themselves — the drainage memo (which
 * `seedDrainageGraph` shares with the build), the survey, and the heightfield
 * archive — and each holds work measured in tens of milliseconds or more
 * against a key computed in microseconds, so the key is the whole surface
 * rather than the fields its own derivation happens to read today. A list of
 * fields is the obvious key and it fails silently: the field a band starts
 * reading next is the one two surfaces differ in while sharing an entry, and
 * whichever was asked first answers for both. The sketch is the one cache that
 * keys on less, deliberately — it shares one derivation between surfaces that
 * differ only in what it does not read, and `sketch.ts` names the field that
 * list must carry.
 */

/**
 * The complete text of a plain value: two values share it exactly when every
 * field of one is `Object.is` the same field of the other.
 *
 * Keys are sorted, so a record rebuilt from a worker's payload or spread in
 * another order agrees with the one it was built from. Numbers are spelled
 * rather than handed to `JSON.stringify`, which writes `null` for NaN and for
 * either infinity and `0` for −0 — four distinct inputs and an absent one
 * sharing one key, which is the one failure an identity exists to make
 * impossible.
 */
export function identityText(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0'
    return Number.isFinite(value) ? JSON.stringify(value) : String(value)
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(identityText).join(',')}]`
  return `{${Object.entries(value)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${identityText(item)}`)
    .join(',')}}`
}

/*
 * Per object, because `SurfaceParameters` is immutable and its text is about a
 * thousand characters — the grammar's three dozen fields, formatted, at about
 * five microseconds a surface. The archive asks once per tile and the drainage
 * memo once per surface object, and neither should pay that twice for one
 * object. The string caches behind each key on the text, which is what lets a
 * surface a worker rebuilds from its payload find the entry an equal one made.
 */
const IDENTITY = new WeakMap<SurfaceParameters, string>()

/** The surface's identity: every field, the grammar's included, as `identityText`. */
export function surfaceIdentity(surface: SurfaceParameters): string {
  let identity = IDENTITY.get(surface)
  if (identity === undefined) {
    identity = identityText(surface)
    IDENTITY.set(surface, identity)
  }
  return identity
}
