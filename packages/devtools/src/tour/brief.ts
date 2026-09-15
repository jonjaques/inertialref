import {
  AU,
  GRAVITATIONAL_CONSTANT,
  SECONDS_PER_DAY,
  formatDuration,
  metersToAu,
  metersToKilometers,
} from '@inertialref/shared'
import { COMPOSITIONS, MIN_DISTANCE_RADII } from '@inertialref/rendering'
import {
  walkBodies,
  formatAddress,
  hasSolidSurface,
  volumetricMeanRadius,
} from '@inertialref/universe'
import {
  TOUR_LIMITS,
  type SubjectBrief,
  type TourCandidate,
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

const smallIntegers = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]
const tens = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
]

/** A finite double's scientific exponent fits within three decimal digits. */
function spokenExponent(value: number): string {
  if (value < 0) return `minus ${spokenExponent(-value)}`
  if (value < 20) return smallIntegers[value]!
  if (value < 100)
    return `${tens[Math.floor(value / 10)]}${value % 10 === 0 ? '' : `-${smallIntegers[value % 10]}`}`
  return `${smallIntegers[Math.floor(value / 100)]} hundred${value % 100 === 0 ? '' : ` ${spokenExponent(value % 100)}`}`
}

// A fixed locale makes the same narration independent of the browser's locale.
const speechNumber = new Intl.NumberFormat('en-US', {
  maximumSignificantDigits: 4,
})

function spokenNumber(value: number): string {
  const magnitude = Math.abs(value)
  if (magnitude === 0 || (magnitude >= 1e-3 && magnitude < 1e6))
    return speechNumber.format(value)
  const [mantissa, exponent] = value.toExponential(3).split('e')
  return `${Number(mantissa)} times ten to the power of ${spokenExponent(Number(exponent))}`
}

function spokenMeasurement(
  value: number,
  unit: string,
  unitName: string,
): string {
  if (unit === 'm' && Math.abs(value) >= 1000)
    return `${spokenNumber(metersToKilometers(value))} kilometers`
  if (unit === 'kg/m³')
    return `${spokenNumber(value / 1000)} grams per cubic centimeter`
  if (unit === 'km' && Math.abs(value) >= AU / 1000)
    return `${spokenNumber(metersToAu(value * 1000))} astronomical units`
  if (unit === 'day' || unit === 'h') {
    const [quantity, abbreviation] = formatDuration(
      value * (unit === 'day' ? SECONDS_PER_DAY : 3600),
    ).split(' ')
    const names: Readonly<Record<string, string>> = {
      yr: 'years',
      d: 'days',
      h: 'hours',
      min: 'minutes',
      s: 'seconds',
    }
    const name = names[abbreviation!]!
    return `${Number(quantity)} ${Number(quantity) === 1 ? name.slice(0, -1) : name}`
  }
  return `${spokenNumber(value)} ${unitName}`
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
      speech: `${page.name}'s ${label.toLowerCase()} is about ${spokenMeasurement(quantity, unit, spokenUnit)}.`,
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
