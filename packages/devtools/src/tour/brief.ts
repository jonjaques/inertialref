import { GRAVITATIONAL_CONSTANT } from '@inertialref/shared'
import { COMPOSITIONS, MIN_DISTANCE_RADII } from '@inertialref/rendering'
import {
  walkBodies,
  formatAddress,
  GENERATION_VERSIONS,
  hasSolidSurface,
  isPlanetKind,
  volumetricMeanRadius,
} from '@inertialref/universe'
import {
  TOUR_LIMITS,
  TOUR_PROTOCOL_VERSION,
  type SubjectBrief,
  type TourCandidate,
  type TourContext,
  type TourFact,
  type TourSource,
} from '@inertialref/protocol'
import type { GameHarness } from '../harness.ts'
import { PICTURES } from '../pictures.ts'
import { resolveDestination } from '../travel.ts'

/** Stable references are issued locally; provider text never becomes an address. */
export function tourSubjectId(address: string): string {
  let hash = 2166136261
  for (let i = 0; i < address.length; i += 1)
    hash = Math.imul(hash ^ address.charCodeAt(i), 16777619)
  return `subject-${(hash >>> 0).toString(36)}`
}

function spokenNumber(value: number): string {
  const rounded = Number(value.toPrecision(4))
  const parts = rounded.toString().split('e')
  return parts.length === 1
    ? parts[0]!
    : `${parts[0]} times ten to the power ${Number(parts[1])}`
}

export function subjectBrief(
  harness: GameHarness,
  address: string,
): SubjectBrief | null {
  const page = harness.dossier(address)
  if (page === null) return null
  const resolved = resolveDestination(page.address, harness.world.galaxy, null)
  const system = harness.world.loadSystem(resolved.system)
  const body =
    resolved.kind === 'body'
      ? [...walkBodies(system)].find(
          (item) => formatAddress(item.address) === resolved.text,
        )
      : undefined
  const subjectId = tourSubjectId(page.address)
  const source: TourSource = {
    id: `record-${subjectId}`,
    title: `${page.name}: application ${page.provenance} record`,
    url: null,
    origin: 'application',
  }
  const sources = [source]
  const facts: TourFact[] = []
  const numeric = (
    key: string,
    label: string,
    quantity: number,
    unit: string,
    spokenUnit: string,
    basis: TourFact['provenance'] = page.provenance,
  ): void => {
    facts.push({
      id: `${subjectId}.${key}`,
      label,
      quantity,
      unit,
      display: `${Number(quantity.toPrecision(5))} ${unit}`,
      speech: `${page.name}'s ${label.toLowerCase()} is about ${spokenNumber(quantity)} ${spokenUnit}.`,
      reason: null,
      provenance: basis,
      sourceIds: [source.id],
    })
  }
  const radius = body?.radius ?? system.star.radius
  const mass = body?.mass ?? system.star.mass
  const mean = body === undefined ? radius : volumetricMeanRadius(body)
  numeric(
    'radius',
    body === undefined ? 'Radius' : 'Equatorial radius',
    radius,
    'm',
    'meters',
    body?.measurement?.radiusInferred ? 'derived' : page.provenance,
  )
  numeric(
    'mass',
    body?.measurement?.massIsLowerBound ? 'Minimum mass' : 'Mass',
    mass,
    'kg',
    'kilograms',
    body?.measurement?.massInferred ? 'derived' : page.provenance,
  )
  numeric(
    'density',
    'Mean density',
    mass / ((4 / 3) * Math.PI * mean ** 3),
    'kg/m³',
    'kilograms per cubic meter',
    'derived',
  )
  if (body !== undefined) {
    numeric(
      'period',
      'Orbital period',
      body.orbitalPeriod / 86400,
      'day',
      'days',
    )
    numeric(
      'rotation',
      'Sidereal rotation period',
      Math.abs(body.rotationPeriod) / 3600,
      'h',
      'hours',
    )
    numeric(
      'axis',
      'Orbital semi-major axis',
      body.elements.semiMajorAxis / 1000,
      'km',
      'kilometers',
    )
    numeric(
      'gravity',
      'Mean surface gravity',
      (GRAVITATIONAL_CONSTANT * mass) / mean ** 2,
      'm/s²',
      'meters per second squared',
      'derived',
    )
    facts.push({
      id: `${subjectId}.atmosphere`,
      label: 'Atmosphere',
      quantity: null,
      unit: null,
      display: body.atmosphere === null ? 'None' : 'Present',
      speech:
        body.atmosphere === null
          ? `${page.name}'s application record has no atmosphere.`
          : `${page.name}'s application record includes an atmosphere.`,
      reason: null,
      provenance: page.provenance,
      sourceIds: [source.id],
    })
  } else {
    numeric(
      'temperature',
      'Effective temperature',
      system.star.temperature,
      'K',
      'kelvin',
    )
  }
  for (const group of page.groups) {
    for (const fact of group.facts) {
      if (facts.length >= TOUR_LIMITS.facts) break
      if (fact.value !== null || fact.pending === undefined) continue
      const key = `${group.id}-${fact.label}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 96)
      facts.push({
        id: `${subjectId}.${key}`,
        label: fact.label,
        quantity: null,
        unit: null,
        display: null,
        speech: null,
        reason: fact.pending.slice(0, 768),
        provenance: 'unknown',
        sourceIds: [source.id],
      })
    }
  }
  const state = harness.observatory.status()
  const selected = state.target?.address === page.address
  return {
    subjectId,
    address: page.address,
    name: page.name,
    provenance: page.provenance,
    classification: page.classification,
    summary: page.summary,
    facts,
    sources,
    observer: {
      pictureTime: state.time,
      altitudeMeters: selected ? state.altitude : null,
      fill: selected ? state.fill : null,
      arrived: selected && !state.traveling,
    },
  }
}

export function tourCandidate(
  harness: GameHarness,
  brief: SubjectBrief,
): TourCandidate {
  const page = harness.dossier(brief.address)!
  const resolved = resolveDestination(brief.address, harness.world.galaxy, null)
  const system = harness.world.loadSystem(resolved.system)
  const body =
    resolved.kind === 'body'
      ? [...walkBodies(system)].find(
          (item) => formatAddress(item.address) === resolved.text,
        )
      : undefined
  const solid = body !== undefined && hasSolidSurface(body)
  const compositions =
    body === undefined
      ? []
      : COMPOSITIONS.filter(
          (composition) =>
            solid ||
            composition.standoff.kind === 'fill' ||
            composition.standoff.radii >= MIN_DISTANCE_RADII,
        ).map((composition) => composition.id)
  const presets = PICTURES.filter(
    (picture) =>
      picture.seed === harness.world.seedText &&
      harness.dossier(picture.address)?.address === brief.address,
  ).map((picture) => `preset:${picture.id}`)
  return {
    id: brief.subjectId,
    address: brief.address,
    name: brief.name,
    provenance: brief.provenance,
    kind: page.kind,
    parentId:
      page.primary === null ? null : tourSubjectId(page.primary.address),
    framings: [...compositions, ...presets].slice(0, 32),
    sites: solid
      ? harness.sites(brief.address).map(({ id, name, detail }) => ({
          id,
          name,
          detail: detail.slice(0, 512),
        }))
      : [],
    factIds: brief.facts.map((fact) => fact.id),
  }
}

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
  for (const address of additionalAddresses.slice(0, TOUR_LIMITS.candidates))
    add(address)
  add(selected)
  const entries = harness.searchEntries()
  const normalized = query.trim().toLowerCase()
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
  for (const body of system.planets.filter((body) => isPlanetKind(body.kind)))
    add(formatAddress(body.address))
  // These are returned named subjects, never hand-authored body ordinals.
  if (system.id === 'SOL' || matches.some((match) => match.name === 'Saturn')) {
    for (const name of ['Saturn', 'Titan'])
      for (const entry of entries.filter((entry) => entry.text === name))
        add(entry.address)
  }
  for (const address of [...addresses]) {
    const page = harness.dossier(address)
    if (
      address === selected ||
      matches.some((match) => match.address === address)
    )
      for (const moon of page?.satellites ?? []) add(moon.address)
  }
  const briefs = addresses
    .slice(0, TOUR_LIMITS.candidates)
    .map((address) => subjectBrief(harness, address))
    .filter((brief): brief is SubjectBrief => brief !== null)
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
  return {
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
}
