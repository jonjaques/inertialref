import { invariant, LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import { derivePath, deriveSeed, Rng, type Seed } from '@inertialref/procedural'
import { UV, vec3, type UniverseVector } from '@inertialref/spatial'
import { systemId, type SystemId } from '../address.ts'
import { CELL_SIZE, cellKey, type GalacticCell } from '../cells.ts'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import {
  blackbodyColour,
  luminosityFromAbsoluteMagnitude,
  mainSequenceMass,
  radiusFromLuminosity,
} from '../catalog/photometry.ts'
import type { StarCatalog } from '../catalog/starCatalog.ts'
import type { SystemStub } from '../galaxy.ts'
import {
  GALAXY_POPULATIONS,
  POPULATION_NAMES,
  type GalaxyField,
  type GalaxyPopulation,
  type GalaxySample,
} from './field.ts'
import { GALAXY_SOLAR_V_MAGNITUDE } from './photometry.ts'

/** Log-uniform luminosity bins. Doubling the cell edge matches four times the V luminosity. */
export const LUMINOSITY_BANDS = Object.freeze(
  Array.from({ length: 9 }, (_, level) => {
    const minSolarV = level === 0 ? 0.00001 : 0.01 * 4 ** level
    const maxSolarV = 0.04 * 4 ** level
    return Object.freeze({
      level,
      minSolarV,
      maxSolarV,
      meanSolarV: (maxSolarV - minSolarV) / Math.log(maxSolarV / minSolarV),
    })
  }),
)

// A dwarf-dominated luminosity shape is an explicit model assumption. Its
// exponential tilt fits number and V-light moments without changing calibration.
const BASE_WEIGHTS = [
  0.82, 0.1, 0.05, 0.02, 0.008, 0.0018, 0.00018, 0.000018, 0.000002,
]
function luminosityWeights(mean: number): readonly number[] {
  const weightsAt = (tilt: number) => {
    const weights = LUMINOSITY_BANDS.map(
      (band, i) => BASE_WEIGHTS[i]! * band.meanSolarV ** tilt,
    )
    const total = weights.reduce((sum, value) => sum + value, 0)
    return weights.map((weight) => weight / total)
  }
  let lo = -4,
    hi = 4
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    const moment = weightsAt(mid).reduce(
      (sum, weight, j) => sum + weight * LUMINOSITY_BANDS[j]!.meanSolarV,
      0,
    )
    if (moment < mean) lo = mid
    else hi = mid
  }
  return Object.freeze(weightsAt((lo + hi) / 2))
}
export const POPULATION_LUMINOSITY_WEIGHTS: Readonly<
  Record<GalaxyPopulation, readonly number[]>
> = Object.freeze(
  Object.fromEntries(
    POPULATION_NAMES.map((name) => [
      name,
      luminosityWeights(GALAXY_POPULATIONS[name].meanSolarLuminosities),
    ]),
  ) as Record<GalaxyPopulation, readonly number[]>,
)

export interface PopulationCoverage {
  readonly radiusParsecs: number
  readonly innerMagnitude: number
  readonly outerMagnitude: number
  readonly completeRadiusParsecs: number
  /** Known stars outside the complete magnitude envelope, by owning level and cell. */
  readonly cataloguedByCell?: Readonly<Record<string, number>>
}

/**
 * ESA SP-1200, volume 1: Hipparcos is largely complete to V 7.3
 * or deeper, depending on latitude and spectral class. 7.3 uses the shallowest
 * limit. Outside the volume the shipped asset only admits V 6.5. The nearby
 * volume exclusion also protects known faint neighbors missing from that survey.
 * https://www.cosmos.esa.int/documents/532822/552851/vol1_all.pdf
 */
export function populationCoverage(catalog: StarCatalog): PopulationCoverage {
  const coverage = {
    radiusParsecs: catalog.radius / PARSEC,
    innerMagnitude: catalog.radius > 0 ? 7.3 : -Infinity,
    outerMagnitude: catalog.metadata.sky?.apparentMagnitudeLimit ?? -Infinity,
    completeRadiusParsecs: catalog.completeRadius / PARSEC,
  }
  const cataloguedByCell: Record<string, number> = {}
  for (const star of catalog.stars) {
    const absolute = star.physical.absoluteMagnitude
    if (absolute === null) continue
    const luminosity = 10 ** ((GALAXY_SOLAR_V_MAGNITUDE - absolute) / 2.5)
    const distance = UV.distance(star.position, SUN_POSITION) / PARSEC
    if (
      distance < coverage.completeRadiusParsecs ||
      populationApparentMagnitude(luminosity, distance) <=
        (distance < coverage.radiusParsecs
          ? coverage.innerMagnitude
          : coverage.outerMagnitude)
    )
      continue
    const band = LUMINOSITY_BANDS.find(
      (one) => luminosity >= one.minSolarV && luminosity < one.maxSolarV,
    )
    if (band === undefined) continue
    const key = `${band.level}:${cellKey(populationCellOf(star.position, band.level))}`
    cataloguedByCell[key] = (cataloguedByCell[key] ?? 0) + 1
  }
  return { ...coverage, cataloguedByCell }
}

export const populationApparentMagnitude = (
  solarV: number,
  distanceParsecs: number,
): number =>
  GALAXY_SOLAR_V_MAGNITUDE -
  2.5 * Math.log10(solarV) +
  5 * Math.log10(Math.max(1e-12, distanceParsecs) / 10)
export const populationLimitingLuminosity = (
  distanceParsecs: number,
  magnitude: number,
): number =>
  (distanceParsecs / 10) ** 2 *
  10 ** (0.4 * (GALAXY_SOLAR_V_MAGNITUDE - magnitude))

/** Unresolved first luminosity moment, divided by the population's calibrated mean. */
export function unresolvedPopulationFraction(
  population: GalaxyPopulation,
  distanceParsecs: number,
  apparentMagnitudeLimit: number,
  levelMask: number,
): number {
  if (levelMask === 0) return 1
  const threshold = populationLimitingLuminosity(
    distanceParsecs,
    apparentMagnitudeLimit,
  )
  let light = 0
  for (const band of LUMINOSITY_BANDS) {
    const unresolved =
      (levelMask & (1 << band.level)) === 0
        ? 1
        : Math.max(
            0,
            Math.min(
              1,
              (threshold - band.minSolarV) / (band.maxSolarV - band.minSolarV),
            ),
          )
    light +=
      POPULATION_LUMINOSITY_WEIGHTS[population][band.level]! *
      band.meanSolarV *
      unresolved
  }
  return Math.max(
    0,
    Math.min(1, light / GALAXY_POPULATIONS[population].meanSolarLuminosities),
  )
}

const POPULATION_COLOURS = Object.fromEntries(
  POPULATION_NAMES.map((name) => [
    name,
    blackbodyColour(GALAXY_POPULATIONS[name].temperature),
  ]),
) as Record<GalaxyPopulation, ReturnType<typeof blackbodyColour>>

/** The smooth field is an ensemble. This partitions its first moments, not individual realized stars. */
export function partitionGalaxyEmission(
  sample: GalaxySample,
  position: UniverseVector,
  selection: ResolvedPopulationSelection,
) {
  const distance = UV.distance(position, selection.origin) / PARSEC
  const unresolved = { r: 0, g: 0, b: 0 }
  for (const name of POPULATION_NAMES) {
    const fraction = unresolvedPopulationFraction(
      name,
      distance,
      selection.apparentMagnitudeLimit,
      selection.levelMask,
    )
    const colour = POPULATION_COLOURS[name]
    const light =
      (sample.populations[name] *
        GALAXY_POPULATIONS[name].meanSolarLuminosities *
        fraction) /
      colour.g
    unresolved.r += light * colour.r
    unresolved.g += light * colour.g
    unresolved.b += light * colour.b
  }
  return {
    unresolved,
    resolved: {
      r: sample.emissionRgb.r - unresolved.r,
      g: sample.emissionRgb.g - unresolved.g,
      b: sample.emissionRgb.b - unresolved.b,
    },
  }
}

export function populationCellSize(level: number): number {
  invariant(
    Number.isInteger(level) && level >= 0 && level < LUMINOSITY_BANDS.length,
    'Unknown population level',
  )
  return CELL_SIZE * 2 ** level
}
export function populationCellOf(
  position: UniverseVector,
  level: number,
): GalacticCell {
  const m = UV.approxMeters(position),
    size = populationCellSize(level)
  return {
    x: Math.floor(m.x / size),
    y: Math.floor(m.y / size),
    z: Math.floor(m.z / size),
  }
}
export const populationCellOrigin = (
  cell: GalacticCell,
  level: number,
): UniverseVector => {
  const size = populationCellSize(level)
  return UV.fromMeters(cell.x * size, cell.y * size, cell.z * size)
}

const encode = (value: number) =>
  (value < 0 ? -2 * value - 1 : 2 * value).toString(36)
const decode = (text: string) => {
  const n = parseInt(text, 36)
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2
}
export interface PopulationSystemRef {
  readonly level: number
  readonly cell: GalacticCell
  readonly index: number
}
export const populationSystemId = (
  level: number,
  cell: GalacticCell,
  index: number,
): SystemId =>
  systemId(
    `Q${level}_${encode(cell.x)}_${encode(cell.y)}_${encode(cell.z)}_${index.toString(36)}`,
  )
export function parsePopulationSystemId(
  id: string,
): PopulationSystemRef | null {
  const match =
    /^Q([0-8])_([0-9a-z]+)_([0-9a-z]+)_([0-9a-z]+)_([0-9a-z]+)$/.exec(id)
  if (match === null) return null
  const ref = {
    level: Number(match[1]),
    cell: { x: decode(match[2]!), y: decode(match[3]!), z: decode(match[4]!) },
    index: parseInt(match[5]!, 36),
  }
  return Object.values(ref.cell).every(Number.isSafeInteger) &&
    Number.isSafeInteger(ref.index) &&
    populationSystemId(ref.level, ref.cell, ref.index) === id
    ? ref
    : null
}

export function coveredPopulationStar(
  star: SystemStub,
  coverage?: PopulationCoverage,
): boolean {
  if (coverage === undefined) return false
  const distance = UV.distance(star.position, SUN_POSITION) / PARSEC
  return (
    distance < coverage.completeRadiusParsecs ||
    populationApparentMagnitude(star.visualLuminosities!, distance) <=
      (distance < coverage.radiusParsecs
        ? coverage.innerMagnitude
        : coverage.outerMagnitude)
  )
}

interface CellPlan {
  readonly level: number
  readonly cell: GalacticCell
  readonly counts: readonly number[]
  readonly count: number
  readonly layouts: readonly PopulationLayout[]
  readonly seeds: readonly Seed[]
  readonly origin: UniverseVector
  readonly size: number
}

interface PopulationLayout {
  readonly grid: number
  readonly slots: number
  readonly shift: number
  readonly stride: number
  readonly inverse: number
}
export interface PopulationBox {
  readonly min: UniverseVector
  readonly max: UniverseVector
}

function inverseModulo(value: number, modulus: number): number {
  let oldR = value,
    r = modulus,
    oldT = 1,
    t = 0
  while (r !== 0) {
    const q = Math.floor(oldR / r)
    const nextR = oldR - q * r,
      nextT = oldT - q * t
    oldR = r
    r = nextR
    oldT = t
    t = nextT
  }
  return oldR === 1 ? ((oldT % modulus) + modulus) % modulus : -1
}

/** A query owns this bounded memo of quadrature and generated records. */
export function createPopulationGenerator(field: GalaxyField) {
  const plans = new Map<string, CellPlan>()
  const keyOf = (level: number, cell: GalacticCell) =>
    `${level}:${cellKey(cell)}`
  const plan = (
    level: number,
    cell: GalacticCell,
    coverage?: PopulationCoverage,
  ): CellPlan => {
    const catalogued = coverage?.cataloguedByCell?.[keyOf(level, cell)] ?? 0
    const key = `${keyOf(level, cell)}:${catalogued}`
    const held = plans.get(key)
    if (held !== undefined) return held
    const size = populationCellSize(level)
    const origin = populationCellOrigin(cell, level)
    // Large cells straddle arms and the thin plane. Eight fixed midpoints
    // retain those gradients without sampling density at one arbitrary center.
    const divisions = level < 4 ? 1 : 2
    const densities = POPULATION_NAMES.map(() => 0)
    for (let x = 0; x < divisions; x++)
      for (let y = 0; y < divisions; y++)
        for (let z = 0; z < divisions; z++) {
          const point = UV.translate(
            origin,
            vec3(
              ((x + 0.5) * size) / divisions,
              ((y + 0.5) * size) / divisions,
              ((z + 0.5) * size) / divisions,
            ),
          )
          const sampled = field.sample(point)
          POPULATION_NAMES.forEach((name, i) => {
            densities[i]! += sampled.populations[name] / divisions ** 3
          })
        }
    const cellSeed = derivePath(field.seed, [
      'population',
      `level:${level}`,
      cellKey(cell),
    ])
    const expectations = POPULATION_NAMES.map(
      (name, i) =>
        densities[i]! *
        (size / PARSEC) ** 3 *
        POPULATION_LUMINOSITY_WEIGHTS[name][level]!,
    )
    const totalExpected = expectations.reduce((a, b) => a + b, 0)
    const fraction =
      totalExpected === 0 ? 0 : Math.max(0, 1 - catalogued / totalExpected)
    const counts = POPULATION_NAMES.map((name, i) => {
      const expected = expectations[i]! * fraction
      const whole = Math.floor(expected)
      return (
        whole +
        (new Rng(deriveSeed(cellSeed, `count:${name}`)).next() <
        expected - whole
          ? 1
          : 0)
      )
    })
    const result = {
      level,
      cell,
      origin,
      size,
      seeds: POPULATION_NAMES.map((name) => deriveSeed(cellSeed, name)),
      counts,
      count: counts.reduce((a, b) => a + b, 0),
      layouts: counts.map((count, i) => {
        let grid = 1
        while (grid ** 3 < count) grid++
        const slots = grid ** 3
        const rng = new Rng(
          deriveSeed(cellSeed, `layout:${POPULATION_NAMES[i]}`),
        )
        const shift = rng.int(0, slots - 1)
        let stride = rng.int(1, Math.max(1, slots - 1)),
          inverse = slots === 1 ? 0 : inverseModulo(stride, slots)
        while (inverse < 0) {
          stride = (stride % (slots - 1)) + 1
          inverse = inverseModulo(stride, slots)
        }
        return { grid, slots, shift, stride, inverse }
      }),
    }
    if (plans.size >= 4096) plans.delete(plans.keys().next().value!)
    plans.set(key, result)
    return result
  }
  const starAt = (
    one: CellPlan,
    index: number,
    accept?: (position: UniverseVector, solarV: number) => boolean,
  ): SystemStub | undefined => {
    if (index < 0 || index >= one.count) return undefined
    let populationIndex = 0,
      offset = index
    while (offset >= one.counts[populationIndex]!)
      offset -= one.counts[populationIndex++]!
    const population = POPULATION_NAMES[populationIndex]!
    // Population and its own index are the seed, so another population's count
    // cannot move this source. The address stores both without a global index.
    const seed = deriveSeed(one.seeds[populationIndex]!, `star:${offset}`)
    const rng = new Rng(seed)
    const band = LUMINOSITY_BANDS[one.level]!
    const visualLuminosities =
      band.minSolarV * (band.maxSolarV / band.minSolarV) ** rng.next()
    const size = one.size
    const layout = one.layouts[populationIndex]!
    const slot = (layout.stride * offset + layout.shift) % layout.slots
    const gx = Math.floor(slot / layout.grid ** 2),
      gy = Math.floor(slot / layout.grid) % layout.grid,
      gz = slot % layout.grid
    const position = UV.translate(
      one.origin,
      vec3(
        ((gx + rng.next()) * size) / layout.grid,
        ((gy + rng.next()) * size) / layout.grid,
        ((gz + rng.next()) * size) / layout.grid,
      ),
    )
    if (accept !== undefined && !accept(position, visualLuminosities))
      return undefined
    const evolved = one.level >= 5 && population !== 'youngArms'
    const temperature = evolved
      ? GALAXY_POPULATIONS[population].temperature
      : Math.min(
          25000,
          2900 + 2100 * Math.max(0, Math.log10(visualLuminosities) + 2),
        )
    const solarLuminosities = luminosityFromAbsoluteMagnitude(
      GALAXY_SOLAR_V_MAGNITUDE - 2.5 * Math.log10(visualLuminosities),
      temperature,
      evolved,
    )
    const solarMasses = evolved
      ? 1.8
      : Math.max(0.08, Math.min(80, mainSequenceMass(solarLuminosities)))
    const spectralClass =
      temperature < 3900
        ? 'M'
        : temperature < 5300
          ? 'K'
          : temperature < 6100
            ? 'G'
            : temperature < 7500
              ? 'F'
              : temperature < 10500
                ? 'A'
                : 'B'
    const id = populationSystemId(one.level, one.cell, index)
    return {
      id,
      name: id,
      position,
      spectralType: `${spectralClass}${rng.int(0, 9)}${evolved ? 'III' : 'V'}`,
      solarMasses,
      solarLuminosities,
      visualLuminosities,
      solarRadii: radiusFromLuminosity(solarLuminosities, temperature),
      temperature,
      colour: blackbodyColour(temperature),
      components: 1,
      catalogued: false,
      planets: [],
    }
  }
  return {
    plan,
    star(
      ref: PopulationSystemRef,
      coverage?: PopulationCoverage,
    ): SystemStub | undefined {
      const star = starAt(plan(ref.level, ref.cell, coverage), ref.index)
      return star === undefined || coveredPopulationStar(star, coverage)
        ? undefined
        : star
    },
    cell(
      level: number,
      cell: GalacticCell,
      coverage?: PopulationCoverage,
      box?: PopulationBox,
      accept?: (position: UniverseVector, solarV: number) => boolean,
    ): readonly SystemStub[] {
      const one = plan(level, cell, coverage)
      invariant(
        one.count <= 1000000,
        'A population cell exceeds the generation budget',
      )
      const stars: SystemStub[] = []
      const add = (index: number) => {
        const star = starAt(one, index, accept)
        if (star !== undefined && !coveredPopulationStar(star, coverage))
          stars.push(star)
      }
      if (box === undefined)
        for (let index = 0; index < one.count; index++) add(index)
      else {
        const origin = populationCellOrigin(cell, level),
          size = populationCellSize(level)
        const lo = UV.difference(box.min, origin),
          hi = UV.difference(box.max, origin)
        let start = 0
        for (let i = 0; i < one.counts.length; i++) {
          const count = one.counts[i]!,
            layout = one.layouts[i]!
          const lower = (value: number) =>
            Math.max(0, Math.floor((value / size) * layout.grid))
          const upper = (value: number) =>
            Math.min(layout.grid - 1, Math.floor((value / size) * layout.grid))
          for (let x = lower(lo.x); x <= upper(hi.x); x++)
            for (let y = lower(lo.y); y <= upper(hi.y); y++)
              for (let z = lower(lo.z); z <= upper(hi.z); z++) {
                const slot = (x * layout.grid + y) * layout.grid + z
                const index =
                  ((((slot - layout.shift) * layout.inverse) % layout.slots) +
                    layout.slots) %
                  layout.slots
                if (index < count) add(start + index)
              }
          start += count
        }
      }
      return stars
    },
  }
}

export interface ResolvedPopulationSelection {
  readonly origin: UniverseVector
  readonly apparentMagnitudeLimit: number
  /** A bit per completely surveyed band. Omitted bands retain all diffuse light. */
  readonly levelMask: number
}
export interface PopulationSkyOptions {
  readonly spriteCeiling?: number
  readonly candidateCeiling?: number
  readonly cellCeiling?: number
  readonly apparentMagnitudeLimit?: number
  readonly coverage?: PopulationCoverage
  readonly cancelled?: () => boolean
}
export interface PopulationSkySelection extends ResolvedPopulationSelection {
  readonly stars: readonly SystemStub[]
  readonly candidateCount: number
  readonly cellsVisited: number
}

export function populationCellsWithin(
  centre: UniverseVector,
  radius: number,
  level: number,
  ceiling = 200000,
): readonly GalacticCell[] {
  const lo = populationCellOf(
    UV.translate(centre, vec3(-radius, -radius, -radius)),
    level,
  )
  const hi = populationCellOf(
    UV.translate(centre, vec3(radius, radius, radius)),
    level,
  )
  const count = (hi.x - lo.x + 1) * (hi.y - lo.y + 1) * (hi.z - lo.z + 1)
  if (count > ceiling) return []
  const result: GalacticCell[] = []
  for (let x = lo.x; x <= hi.x; x++)
    for (let y = lo.y; y <= hi.y; y++)
      for (let z = lo.z; z <= hi.z; z++) result.push({ x, y, z })
  return result
}

/** Every admitted band is swept completely before a brightness ceiling is applied. */
export function selectPopulationSky(
  field: GalaxyField,
  origin: UniverseVector,
  options: PopulationSkyOptions = {},
): PopulationSkySelection {
  const spriteCeiling = options.spriteCeiling ?? 20000
  const candidateCeiling = options.candidateCeiling ?? 200000
  const cellCeiling = options.cellCeiling ?? 2000
  let magnitudeLimit = options.apparentMagnitudeLimit ?? 8
  invariant(
    Number.isInteger(spriteCeiling) &&
      spriteCeiling > 0 &&
      spriteCeiling <= 200000,
    'Invalid sky sprite ceiling',
  )
  invariant(
    candidateCeiling > 0 &&
      candidateCeiling <= 1000000 &&
      cellCeiling > 0 &&
      cellCeiling <= 10000,
    'Invalid sky work budget',
  )
  const generator = createPopulationGenerator(field)
  const stars: SystemStub[] = []
  let candidateCount = 0,
    cellsVisited = 0,
    levelMask = 0
  for (const band of LUMINOSITY_BANDS) {
    if (options.cancelled?.())
      return {
        origin,
        stars: [],
        candidateCount,
        cellsVisited,
        levelMask: 0,
        apparentMagnitudeLimit: -Infinity,
      }
    const radius =
      10 *
      PARSEC *
      Math.sqrt(
        band.maxSolarV *
          10 ** (0.4 * (magnitudeLimit - GALAXY_SOLAR_V_MAGNITUDE)),
      )
    const cells = populationCellsWithin(
      origin,
      radius,
      band.level,
      cellCeiling - cellsVisited,
    )
    if (cells.length === 0) continue
    const plans = cells.map((cell) =>
      generator.plan(band.level, cell, options.coverage),
    )
    cellsVisited += cells.length
    const candidates = plans.reduce((sum, one) => sum + one.count, 0)
    if (candidateCount + candidates > candidateCeiling) continue
    candidateCount += candidates
    levelMask |= 1 << band.level
    for (const cell of cells) {
      if (options.cancelled?.())
        return {
          origin,
          stars: [],
          candidateCount,
          cellsVisited,
          levelMask: 0,
          apparentMagnitudeLimit: -Infinity,
        }
      for (const star of generator.cell(
        band.level,
        cell,
        options.coverage,
        undefined,
        (position, luminosity) =>
          populationApparentMagnitude(
            luminosity,
            UV.distance(position, origin) / PARSEC,
          ) <= magnitudeLimit,
      ))
        stars.push(star)
    }
  }
  const magnitudes = new Map(
    stars.map((star) => [
      star.id,
      populationApparentMagnitude(
        star.visualLuminosities!,
        UV.distance(star.position, origin) / PARSEC,
      ),
    ]),
  )
  stars.sort(
    (a, b) =>
      magnitudes.get(a.id)! - magnitudes.get(b.id)! ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  if (stars.length > spriteCeiling)
    magnitudeLimit = magnitudes.get(stars[spriteCeiling]!.id)! - 1e-10
  return {
    origin,
    stars: stars.filter((star) => magnitudes.get(star.id)! <= magnitudeLimit),
    candidateCount,
    cellsVisited,
    levelMask,
    apparentMagnitudeLimit: magnitudeLimit,
  }
}

export const POPULATION_COVERAGE_REFERENCE = Object.freeze({
  source: 'ESA SP-1200 volume 1',
  url: 'https://www.cosmos.esa.int/documents/532822/552851/vol1_all.pdf',
  volumeMagnitude: 7.3,
  volumeRadiusLightYears: 150,
  skyMagnitude: 6.5,
  nearRadiusLightYears: 25,
  parsecsPerLightYear: LIGHT_YEAR / PARSEC,
})
