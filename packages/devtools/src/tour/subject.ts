import type { SubjectBrief, TourCandidate } from '@inertialref/protocol'
import type { GameHarness } from '../harness.ts'
import type { TravelTarget } from '../travel.ts'
import { subjectBrief, tourCandidate } from './brief.ts'

/*
 * One subject, resolved from the name a visitor said.
 *
 * Every named guide tool — go to, read, stand at, frame a pair, list the
 * moons of — needs the same three things about its subject: which body the
 * name means, the record for it, and the framings and sites it supports. That
 * is a lookup, and it is answered here from the search index and the record
 * for one address.
 *
 * It is its own module because the alternative was measured. Resolving one
 * name through the full `TourContext` — the bounded inventory built for the
 * model's opening picture — assembles sixteen candidates and sixteen briefs,
 * compacts them under the message bound, and then searches the result for
 * the one name asked for: 253 dossier reads and a 43,900-byte record to find
 * Saturn from Earth. The inventory is what a *collection* request wants, and
 * resolving a name was the only thing that ever asked for it — so
 * `createTourContext` in `inventory.ts` has no caller in the game today, and
 * stands on its own tests until a collection request needs it. The lookup
 * rules — the article, the two aliases — live here once, and the inventory
 * builder reads them from here.
 */

/** A subject as the tools use it: identity and framings, and the record. */
export interface ResolvedSubject {
  readonly candidate: TourCandidate
  readonly brief: SubjectBrief
}

export type SubjectLookup =
  | { readonly ok: true; readonly subject: ResolvedSubject }
  | {
      readonly ok: false
      /** What the index has near the name, for the model to offer instead. */
      readonly nearest: readonly TravelTarget[]
    }

/**
 * What a visitor says versus what the index stores.
 *
 * "The moon" is Luna and "the sun" is Sol, in the index and in the record;
 * the article is dropped because the model repeats what it hears.
 */
export function normalizeSubjectName(name: string): string {
  const query = name
    .trim()
    .toLowerCase()
    .replace(/^the\s+/, '')
  if (query === 'moon') return 'luna'
  if (query === 'sun') return 'sol'
  return query
}

/** The subject at an address, or null where the record has nothing. */
export function subjectAt(
  harness: GameHarness,
  address: string,
): ResolvedSubject | null {
  const brief = subjectBrief(harness, address)
  if (brief === null) return null
  return { candidate: tourCandidate(harness, brief), brief }
}

/**
 * Resolve a name to its subject, reading the subject's record and nobody
 * else's.
 *
 * Exact over the index first — every designation of every catalog star and
 * every body of every loaded system — then exact over the catalog's own
 * search, which normalizes designations the index keeps verbatim. A miss
 * carries the nearest rows so the refusal can name what exists.
 */
export function resolveSubject(
  harness: GameHarness,
  name: string,
): SubjectLookup {
  const query = normalizeSubjectName(name)
  const entry = harness
    .searchEntries()
    .find((item) => item.text.toLowerCase() === query)
  if (entry !== undefined) {
    const subject = subjectAt(harness, entry.address)
    if (subject !== null) return { ok: true, subject }
  }
  const nearest = harness.search(query, { origin: 'observer' }).slice(0, 8)
  const exact = nearest.find((match) => match.name.toLowerCase() === query)
  if (exact !== undefined) {
    const subject = subjectAt(harness, exact.address)
    if (subject !== null) return { ok: true, subject }
  }
  return { ok: false, nearest }
}
