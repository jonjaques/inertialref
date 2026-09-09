import {
  invariant,
  type Kelvin,
  type Meters,
  PARSEC,
} from '@inertialref/shared'
import { deriveSeed, derivePath, Rng, type Seed } from '@inertialref/procedural'
import { UV, type UniverseVector, vec3 } from '@inertialref/spatial'
import {
  type GalaxyId,
  galaxyId,
  type SystemId,
  systemId,
  systemAddress,
} from './address.ts'
import {
  CELL_SIZE,
  cellCentre,
  cellKey,
  cellOf,
  cellOrigin,
  cellsWithin,
  type GalacticCell,
} from './cells.ts'
import {
  SUN_GALACTOCENTRIC_RADIUS,
  SUN_POSITION,
} from './catalog/astrometry.ts'
import { blackbodyColour, type LinearRgb } from './catalog/photometry.ts'
import type {
  CatalogPlanet,
  CatalogStar,
  StarCatalog,
} from './catalog/starCatalog.ts'
import { LOCAL_DENSITY } from './galaxy/constants.ts'
import { createGalaxyField } from './galaxy/field.ts'
import { GALAXY_SOLAR_V_MAGNITUDE } from './galaxy/photometry.ts'
import {
  createPopulationGenerator,
  LUMINOSITY_BANDS,
  parsePopulationSystemId,
  populationCellsWithin,
  populationCoverage,
  type PopulationCoverage,
} from './galaxy/population.ts'

// Seeds and catalogs stay explicit inputs. Each immutable seed owns one
// field and the generator's bounded cell-plan cache, released with the seed.
const generators = new WeakMap<
  Seed,
  ReturnType<typeof createPopulationGenerator>
>()
function populationGenerator(seed: Seed) {
  let generator = generators.get(seed)
  if (generator === undefined) {
    generator = createPopulationGenerator(createGalaxyField(seed))
    generators.set(seed, generator)
  }
  return generator
}

/*
 * Catalog identities and deterministic luminosity populations share one address
 * resolver. Q addresses own a luminosity level and spatial cell; P addresses
 * retain their historical generator so existing saves keep their destinations.
 * The catalog and its coverage are explicit inputs to every canonical query.
 */

export const MILKY_WAY: GalaxyId = galaxyId('milky-way')

/** Stellar number density in the solar neighborhood, stars per cubic meter. */
export { LOCAL_DENSITY }
/** Exponential disk scale length and height (kpc-scale structure). */
const DISK_SCALE_LENGTH: Meters = 2_600 * PARSEC
const DISK_SCALE_HEIGHT: Meters = 300 * PARSEC

export interface SystemStub {
  readonly id: SystemId
  readonly name: string
  readonly position: UniverseVector
  readonly spectralType: string
  readonly solarMasses: number
  readonly solarRadii: number
  /** Bolometric, in solar units. */
  readonly solarLuminosities: number
  /** Johnson V luminosity in solar V units; catalog records derive it from measured M_V. */
  readonly visualLuminosities?: number
  readonly temperature: Kelvin
  /** Linear sRGB of a blackbody at `temperature`. */
  readonly colour: LinearRgb
  /** Number of stellar components; >1 means the system is being simplified. */
  readonly components: number
  readonly catalogued: boolean
  /** Confirmed planets. Empty for anything the catalog does not know. */
  readonly planets: readonly CatalogPlanet[]
}

export { CELL_SIZE, cellCentre, cellKey, cellOf, cellOrigin }
export type { GalacticCell }

/** Zigzag encoding, so negative cell coordinates survive the id character set. */
const encodeCoordinate = (value: number): string =>
  (value < 0 ? -2 * value - 1 : 2 * value).toString(36)

const decodeCoordinate = (text: string): number => {
  const n = Number.parseInt(text, 36)
  invariant(Number.isInteger(n) && n >= 0, `Bad cell coordinate ${text}`)
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2
}

export const proceduralSystemId = (
  cell: GalacticCell,
  index: number,
): SystemId =>
  systemId(
    `P${encodeCoordinate(cell.x)}_${encodeCoordinate(cell.y)}_${encodeCoordinate(cell.z)}_${index.toString(36)}`,
  )

export interface ProceduralSystemRef {
  readonly cell: GalacticCell
  readonly index: number
}

/** Decode a legacy P system id; Q ids and catalog designations return null. */
export function parseProceduralSystemId(
  id: SystemId,
): ProceduralSystemRef | null {
  if (!id.startsWith('P')) return null
  const parts = id.slice(1).split('_')
  if (parts.length !== 4) return null
  const [x, y, z, index] = parts as [string, string, string, string]
  return {
    cell: {
      x: decodeCoordinate(x),
      y: decodeCoordinate(y),
      z: decodeCoordinate(z),
    },
    index: Number.parseInt(index, 36),
  }
}

/** The galaxy@2 disk remains solely to regenerate saved P addresses. */
function legacyStellarDensity(position: UniverseVector): number {
  const m = UV.approxMeters(position)
  // Simulation axes: +Y is galactic north, so the disk lies in XZ.
  const radius = Math.hypot(m.x, m.z)
  const height = Math.abs(m.y)
  return (
    LOCAL_DENSITY *
    Math.exp(-(radius - SUN_GALACTOCENTRIC_RADIUS) / DISK_SCALE_LENGTH) *
    Math.exp(-height / DISK_SCALE_HEIGHT)
  )
}

/** The calibrated number field is a generation input, including its seed. */
export function stellarDensity(
  position: UniverseVector,
  galaxySeed: Seed,
): number {
  return (
    createGalaxyField(galaxySeed).sample(position).totalPerCubicParsec /
    PARSEC ** 3
  )
}

const SPECTRAL_CLASSES = ['M', 'K', 'G', 'F', 'A', 'B'] as const
/** Initial mass function, flattened into class frequencies for the main sequence. */
const SPECTRAL_WEIGHTS = [76.45, 12.1, 7.6, 3.0, 0.6, 0.13]
const SPECTRAL_MASS_RANGE: Readonly<Record<string, readonly [number, number]>> =
  {
    M: [0.08, 0.45],
    K: [0.45, 0.8],
    G: [0.8, 1.04],
    F: [1.04, 1.4],
    A: [1.4, 2.1],
    B: [2.1, 16],
  }

/**
 * A main-sequence star's remaining properties from its mass alone.
 *
 * R ∝ M^0.8, L ∝ M^3.5, and the temperature that makes those two consistent
 * under Stefan-Boltzmann. Cataloged stars do not go through here — they have
 * measurements, and `photometry.ts` converts those — but both paths have to
 * produce the same *shape*, or the renderer would need to know which kind of
 * star it was drawing.
 */
export function mainSequenceProperties(solarMasses: number): {
  solarRadii: number
  solarLuminosities: number
  temperature: Kelvin
} {
  const solarRadii = solarMasses ** 0.8
  const solarLuminosities = solarMasses ** 3.5
  return {
    solarRadii,
    solarLuminosities,
    temperature: 5_772 * solarMasses ** 0.475,
  }
}

/**
 * What the catalog contributes to generating one cell.
 *
 * The magnitude envelope and sparse counts are derived from the catalog before
 * crossing into a worker. Legacy addresses also retain their original cell count.
 */
export interface CellContext {
  /** Cataloged stars already in this cell, for legacy P-address generation. */
  readonly catalogued: number
  /**
   * Distance from the Sun inside which the catalog is complete for the kind of
   * star this generator makes, and procedural fill is therefore suppressed.
   *
   * Without it the fill happily invents an M dwarf 3.4 light-years away —
   * closer than Proxima Centauri, and a discovery that would have made the news.
   * The density model is right about how many stars there are and wrong about
   * how many are *unknown*, and near the Sun that difference is the whole
   * quantity.
   *
   * The cost, stated: the volume inside this radius ends up slightly
   * under-populated. RECONS counts 462 objects within 10 parsecs where HYG has
   * 324, and the ~140 missing are brown dwarfs and close companions — real
   * objects this now declines to invent. Under-populating with things that
   * would be L and T dwarfs is a smaller lie than over-populating with things
   * that would be front-page news.
   */
  readonly completeRadius: Meters
  /** The catalog's magnitude coverage, carried explicitly across a worker boundary. */
  readonly magnitudeCoverage?: PopulationCoverage
}

/** No catalog at all: fill everything, suppress nothing. */
export const NO_CATALOGUE: CellContext = Object.freeze({
  catalogued: 0,
  completeRadius: 0,
})

/** Expected count from the active field, after an explicit catalog contribution. */
export function proceduralCount(
  rng: Rng,
  cell: GalacticCell,
  cataloguedCount: number,
  galaxySeed: Seed,
): number {
  return roundedPopulationCount(
    rng,
    stellarDensity(cellCentre(cell), galaxySeed) * CELL_SIZE ** 3 -
      cataloguedCount,
  )
}

function roundedPopulationCount(rng: Rng, expected: number): number {
  if (expected <= 0) return 0
  const whole = Math.floor(expected)
  return whole + (rng.next() < expected - whole ? 1 : 0)
}

/** The galaxy@2 stream is an address compatibility path, never a source for new surveys. */
function generateLegacyCell(
  galaxySeed: Seed,
  cell: GalacticCell,
  context: CellContext = NO_CATALOGUE,
): readonly SystemStub[] {
  const seed = derivePath(galaxySeed, ['cell', cellKey(cell)])
  const rng = new Rng(seed)
  const count = roundedPopulationCount(
    rng,
    legacyStellarDensity(cellCentre(cell)) * CELL_SIZE ** 3 -
      context.catalogued,
  )

  const stars: SystemStub[] = []
  for (let index = 0; index < count; index += 1) {
    // Each star draws from its own derived stream, so changing the count of a
    // cell cannot change the properties of the stars that remain.
    const starRng = new Rng(deriveSeed(seed, `star:${index}`))
    const classIndex = starRng.weightedIndex(SPECTRAL_WEIGHTS)
    const spectralClass = SPECTRAL_CLASSES[classIndex] ?? 'M'
    const [minMass, maxMass] = SPECTRAL_MASS_RANGE[spectralClass] ?? [
      0.08, 0.45,
    ]
    const id = proceduralSystemId(cell, index)
    const solarMasses = starRng.range(minMass, maxMass)
    const properties = mainSequenceProperties(solarMasses)
    const position = UV.translate(
      cellOrigin(cell),
      vec3(
        starRng.next() * CELL_SIZE,
        starRng.next() * CELL_SIZE,
        starRng.next() * CELL_SIZE,
      ),
    )
    // Drawn and then discarded rather than skipped before the draw, so that a
    // star's properties never depend on how many of its neighbors survived.
    // The id keeps the generation index, which is why `resolveSystem` looks a
    // star up by id instead of by array position.
    if (UV.distance(position, SUN_POSITION) < context.completeRadius) continue
    stars.push({
      id,
      name: id,
      position,
      spectralType: `${spectralClass}${starRng.int(0, 9)}V`,
      solarMasses,
      ...properties,
      colour: blackbodyColour(properties.temperature),
      components: 1,
      catalogued: false,
      planets: [],
    })
  }
  return stars
}

/** All luminosity levels contributing sources inside one ordinary travel cell. */
export function generateCell(
  galaxySeed: Seed,
  cell: GalacticCell,
  context: CellContext = NO_CATALOGUE,
): readonly SystemStub[] {
  const generator = populationGenerator(galaxySeed)
  const centre = cellCentre(cell)
  const coverage = context.magnitudeCoverage ?? {
    radiusParsecs: 0,
    innerMagnitude: -Infinity,
    outerMagnitude: -Infinity,
    completeRadiusParsecs: context.completeRadius / PARSEC,
  }
  const result: SystemStub[] = []
  const min = cellOrigin(cell),
    max = UV.translate(min, vec3(CELL_SIZE, CELL_SIZE, CELL_SIZE))
  for (const band of LUMINOSITY_BANDS) {
    for (const coarse of populationCellsWithin(
      centre,
      CELL_SIZE / 2,
      band.level,
    )) {
      for (const star of generator.cell(band.level, coarse, coverage, {
        min,
        max,
      })) {
        const owner = cellOf(star.position)
        if (owner.x === cell.x && owner.y === cell.y && owner.z === cell.z)
          result.push(star)
      }
    }
  }
  return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A cataloged star as the generator sees it. */
export const catalogStub = (star: CatalogStar): SystemStub => ({
  id: star.id,
  name: star.name,
  position: star.position,
  spectralType:
    star.spectralSource === '' ? '(unclassified)' : star.spectralSource,
  solarMasses: star.physical.solarMasses,
  solarRadii: star.physical.solarRadii,
  solarLuminosities: star.physical.solarLuminosities,
  visualLuminosities:
    star.physical.absoluteMagnitude === null
      ? undefined
      : 10 **
        ((GALAXY_SOLAR_V_MAGNITUDE - star.physical.absoluteMagnitude) / 2.5),
  temperature: star.physical.temperature,
  colour: star.physical.colour,
  components: star.components,
  catalogued: true,
  planets: star.planets,
})

/**
 * Resolve any system id to its stub without a global index.
 *
 * Catalog ids hit the table; procedural ids decode to a cell and regenerate
 * it. Either way the answer does not depend on what is currently loaded, which
 * is what lets a save file reference a system nobody has visited.
 */
export function resolveSystem(
  galaxySeed: Seed,
  catalog: StarCatalog,
  id: SystemId,
): SystemStub | undefined {
  const catalogued = catalog.get(id)
  if (catalogued !== undefined) return catalogStub(catalogued)
  const population = parsePopulationSystemId(id)
  if (population !== null)
    return populationGenerator(galaxySeed).star(
      population,
      populationCoverage(catalog),
    )
  const ref = parseProceduralSystemId(id)
  if (ref === null) return undefined
  // By id, not by index. A star suppressed inside the catalog's complete
  // radius leaves a gap in the generation indices, and `[ref.index]` would
  // silently return the wrong star rather than none.
  return generateLegacyCell(
    galaxySeed,
    ref.cell,
    cellContext(catalog, ref.cell),
  ).find((stub) => stub.id === id)
}

/** What `generateCell` needs to know about the catalog for one cell. */
export const cellContext = (
  catalog: StarCatalog,
  cell: GalacticCell,
): CellContext => ({
  catalogued: catalog.inCell(cell).length,
  completeRadius: catalog.completeRadius,
  magnitudeCoverage: populationCoverage(catalog),
})

/**
 * Every system within `radius` of a point, catalog and procedural alike.
 *
 * Cost is bounded by the cell grid, not by the size of the galaxy: a 100 ly
 * query touches ~1,000 cells regardless of where in the Milky Way it is asked,
 * and the catalog is indexed by the same cells so it is not a linear scan of
 * 7,529 stars either.
 */
export function systemsWithin(
  galaxySeed: Seed,
  catalog: StarCatalog,
  centre: UniverseVector,
  radius: Meters,
): readonly SystemStub[] {
  const found: SystemStub[] = []
  for (const cell of cellsWithin(centre, radius)) {
    for (const star of catalog.inCell(cell))
      if (UV.distance(star.position, centre) <= radius)
        found.push(catalogStub(star))
  }
  const generator = populationGenerator(galaxySeed)
  const coverage = populationCoverage(catalog)
  const box = {
    min: UV.translate(centre, vec3(-radius, -radius, -radius)),
    max: UV.translate(centre, vec3(radius, radius, radius)),
  }
  for (const band of LUMINOSITY_BANDS) {
    const cells = populationCellsWithin(centre, radius, band.level)
    invariant(
      cells.length > 0,
      `Travel query radius ${radius / PARSEC} pc exceeds the population cell budget at level ${band.level}`,
    )
    for (const cell of cells)
      for (const stub of generator.cell(band.level, cell, coverage, box))
        if (UV.distance(stub.position, centre) <= radius) found.push(stub)
  }
  // The bright catalog is deliberately outside the travel cell index. It still
  // names real destinations when a local query reaches their actual positions.
  for (const star of catalog.sky)
    if (UV.distance(star.position, centre) <= radius)
      found.push(catalogStub(star))
  // Sorted by id so the result is a pure function of the query, not of iteration
  // order — two clients asking the same question get the same list.
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const galaxySeedOf = (
  rootSeed: Seed,
  galaxy: GalaxyId = MILKY_WAY,
): Seed => derivePath(rootSeed, [`g:${galaxy}`])

export const systemSeedOf = (
  rootSeed: Seed,
  galaxy: GalaxyId,
  system: SystemId,
): Seed => derivePath(rootSeed, [`g:${galaxy}`, `s:${system}`])

export { systemAddress }
