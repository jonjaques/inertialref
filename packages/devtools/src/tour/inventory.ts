import {
  formatAddress,
  GENERATION_VERSIONS,
  isPlanetKind,
} from '@inertialref/universe'
import {
  TOUR_LIMITS,
  TOUR_PROTOCOL_VERSION,
  tourMessageBytes,
  type SubjectBrief,
  type TourContext,
} from '@inertialref/protocol'
import type { GameHarness } from '../harness.ts'
import { subjectBrief, tourCandidate } from './brief.ts'
import { normalizeSubjectName } from './subject.ts'

/*
 * The bounded inventory: what the model can be handed about the bodies in
 * reach when it asks for a collection, under the message bound.
 *
 * Its own file rather than a second export of `brief.ts` because it reads the
 * one-subject lookup — the name rule is `normalizeSubjectName`'s, shared
 * rather than repeated — and the lookup reads the record builders. A named
 * request does not come through here; `subject.ts` says what it costs when
 * it did.
 */
export function createTourContext(
  harness: GameHarness,
  query = '',
  additionalAddresses: readonly string[] = [],
): TourContext {
  const eye = harness.observatory
  const addresses: string[] = []
  const add = (address: string | undefined): void => {
    if (address !== undefined && !addresses.includes(address))
      addresses.push(address)
  }
  const selected = eye.target?.address
  add(selected)
  for (const address of additionalAddresses.slice(0, TOUR_LIMITS.candidates))
    add(address)
  const entries = harness.searchEntries()
  const normalized = normalizeSubjectName(query)
  const found =
    normalized.length === 0
      ? []
      : entries
          .filter((entry) => entry.text.toLowerCase() === normalized)
          .slice(0, 4)
  const matches =
    found.length > 0
      ? harness.rowsFor(
          found.map((entry) => entry.address),
          { origin: 'observer' },
        )
      : normalized.length === 0
        ? []
        : harness.search(query.trim(), { origin: 'observer' }).slice(0, 4)
  for (const match of matches) add(match.address)
  const selectedPage = selected === undefined ? null : harness.dossier(selected)
  const system = harness.world.loadSystem(
    selectedPage?.system.id ?? harness.world.loadedSystems()[0]!.id,
  )
  add(formatAddress(system.address))
  const tourAddresses = new Set<string>()
  // These are returned named subjects, never hand-authored body ordinals.
  if (system.id === 'SOL' || matches.some((match) => match.name === 'Saturn')) {
    for (const name of [
      'Sol',
      'Venus',
      'Luna',
      'Mars',
      'Jupiter',
      'Saturn',
      'Neptune',
      'Earth',
      'Titan',
      'Enceladus',
    ])
      for (const entry of entries.filter((entry) => entry.text === name)) {
        add(entry.address)
        tourAddresses.add(entry.address)
      }
  }
  for (const body of system.planets.filter((body) => isPlanetKind(body.kind)))
    add(formatAddress(body.address))
  for (const address of [...addresses]) {
    const page = harness.dossier(address)
    if (
      address === selected ||
      matches.some((match) => match.address === address)
    )
      for (const moon of page?.satellites ?? []) add(moon.address)
  }
  const fullRecords = new Set([
    selected,
    ...matches.map((match) => match.address),
    ...additionalAddresses,
  ])
  const briefs = addresses
    .slice(0, TOUR_LIMITS.candidates)
    .map((address) => subjectBrief(harness, address))
    .filter((brief): brief is SubjectBrief => brief !== null)
    // The inventory needs identity and a few facts; an explicit read keeps all.
    .map((brief) =>
      fullRecords.has(brief.address)
        ? brief
        : { ...brief, facts: brief.facts.slice(0, 3) },
    )
  const candidates = briefs.map((brief) => tourCandidate(harness, brief))
  // A hash collision must never make one returned ID select a different body.
  const ids = new Set<string>()
  const unique = candidates.filter((candidate) => {
    if (ids.has(candidate.id)) return false
    ids.add(candidate.id)
    return true
  })
  const current =
    selected === undefined
      ? null
      : (briefs.find((brief) => brief.address === selected) ??
        subjectBrief(harness, selected))
  const context: TourContext = {
    protocolVersion: TOUR_PROTOCOL_VERSION,
    manifest: {
      seed: harness.world.seedText,
      catalogVersion: harness.world.catalog.version,
      generation: { ...GENERATION_VERSIONS },
    },
    viewRevision: eye.mutationRevision,
    pictureTime: eye.time,
    subjectId: current?.subjectId ?? null,
    traveling: eye.status().traveling,
    candidates: unique,
    brief: current,
    briefs: briefs.filter((brief) =>
      unique.some((candidate) => candidate.address === brief.address),
    ),
  }
  let bounded = context
  // Admission also carries the manifest, transport, and SDP outside this record.
  const bytes = TOUR_LIMITS.messageBytes - 4096
  while (tourMessageBytes(JSON.stringify(bounded)) > bytes) {
    // Keep the selected record, named query matches, and the newest explicit
    // read complete. Older search results can return their full facts on demand.
    const compactable = [...bounded.briefs]
      .reverse()
      .find(
        (brief) =>
          brief.facts.length > 3 &&
          brief.subjectId !== bounded.subjectId &&
          brief.address !== additionalAddresses[0] &&
          !matches.some((match) => match.address === brief.address),
      )
    if (compactable !== undefined) {
      const facts = compactable.facts.slice(0, 3)
      bounded = {
        ...bounded,
        briefs: bounded.briefs.map((brief) =>
          brief.subjectId === compactable.subjectId
            ? { ...brief, facts }
            : brief,
        ),
        candidates: bounded.candidates.map((candidate) =>
          candidate.id === compactable.subjectId
            ? { ...candidate, factIds: facts.map((fact) => fact.id) }
            : candidate,
        ),
      }
      continue
    }
    const removable = [...bounded.candidates]
      .reverse()
      .find(
        (candidate) =>
          candidate.id !== bounded.subjectId &&
          !fullRecords.has(candidate.address) &&
          !tourAddresses.has(candidate.address),
      )
    if (removable === undefined) break
    bounded = {
      ...bounded,
      candidates: bounded.candidates.filter(
        (candidate) => candidate.id !== removable.id,
      ),
      briefs: bounded.briefs.filter(
        (brief) => brief.subjectId !== removable.id,
      ),
    }
  }
  return bounded
}
