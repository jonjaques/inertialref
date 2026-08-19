import { invariant, LIGHT_YEAR, type Meters, PARSEC } from '@inertialref/shared'
import { deriveSeed, derivePath, Rng, type Seed } from '@inertialref/procedural'
import { UV, type UniverseVector, vec3 } from '@inertialref/spatial'
import { type GalaxyId, galaxyId, type SystemId, systemId, systemAddress } from './address.ts'
import {
  CATALOG,
  type CatalogStar,
  catalogStarPosition,
  SUN_GALACTOCENTRIC_RADIUS,
} from './catalog.ts'

/*
 * The galaxy: a catalogue near the player and procedure everywhere else.
 *
 * Procedural stars are generated per *cell* — a fixed cube of space — and a
 * cell's contents depend only on (galaxy seed, cell coordinate). Nothing
 * consults neighbouring cells, so the streaming layer can generate cells in any
 * order, in any number of workers, and get the same galaxy. This is the
 * order-independence requirement made concrete.
 *
 * A procedural star's id encodes the cell it lives in and its index within
 * that cell, which means resolving an id back to a star is a single cell
 * generation rather than a search of a galaxy-wide index that would have to
 * exist somewhere.
 */

export const MILKY_WAY: GalaxyId = galaxyId('milky-way')

/** Edge length of a generation cell. 20 ly holds a couple of dozen stars locally. */
export const CELL_SIZE: Meters = 20 * LIGHT_YEAR

/** Stellar number density in the solar neighbourhood, stars per cubic meter. */
const LOCAL_DENSITY = 0.1 / PARSEC ** 3
/** Exponential disk scale length and height (kpc-scale structure). */
const DISK_SCALE_LENGTH: Meters = 2_600 * PARSEC
const DISK_SCALE_HEIGHT: Meters = 300 * PARSEC

export interface GalacticCell {
  readonly x: number
  readonly y: number
  readonly z: number
}

export interface SystemStub {
  readonly id: SystemId
  readonly name: string
  readonly position: UniverseVector
  readonly spectralType: string
  readonly solarMasses: number
  readonly catalogued: boolean
}

export const cellKey = (cell: GalacticCell): string => `${cell.x},${cell.y},${cell.z}`

export function cellOf(position: UniverseVector): GalacticCell {
  const m = UV.approxMeters(position)
  return {
    x: Math.floor(m.x / CELL_SIZE),
    y: Math.floor(m.y / CELL_SIZE),
    z: Math.floor(m.z / CELL_SIZE),
  }
}

export const cellOrigin = (cell: GalacticCell): UniverseVector =>
  UV.fromMeters(cell.x * CELL_SIZE, cell.y * CELL_SIZE, cell.z * CELL_SIZE)

export const cellCentre = (cell: GalacticCell): UniverseVector =>
  UV.translate(cellOrigin(cell), vec3(CELL_SIZE / 2, CELL_SIZE / 2, CELL_SIZE / 2))

/** Zigzag encoding, so negative cell coordinates survive the id character set. */
const encodeCoordinate = (value: number): string =>
  (value < 0 ? -2 * value - 1 : 2 * value).toString(36)

const decodeCoordinate = (text: string): number => {
  const n = Number.parseInt(text, 36)
  invariant(Number.isInteger(n) && n >= 0, `Bad cell coordinate ${text}`)
  return n % 2 === 0 ? n / 2 : -(n + 1) / 2
}

export const proceduralSystemId = (cell: GalacticCell, index: number): SystemId =>
  systemId(
    `P${encodeCoordinate(cell.x)}_${encodeCoordinate(cell.y)}_${encodeCoordinate(cell.z)}_${index.toString(36)}`,
  )

export interface ProceduralSystemRef {
  readonly cell: GalacticCell
  readonly index: number
}

/** Decode a procedural system id, or null if it is a catalogue designation. */
export function parseProceduralSystemId(id: SystemId): ProceduralSystemRef | null {
  if (!id.startsWith('P')) return null
  const parts = id.slice(1).split('_')
  if (parts.length !== 4) return null
  const [x, y, z, index] = parts as [string, string, string, string]
  return {
    cell: { x: decodeCoordinate(x), y: decodeCoordinate(y), z: decodeCoordinate(z) },
    index: Number.parseInt(index, 36),
  }
}

/**
 * Stellar density at a point, from a standard double-exponential disk.
 *
 * Coarse on purpose: it exists so that leaving the galactic plane visibly
 * empties the sky and heading inward crowds it, which is the structural
 * property the streaming and LOD systems need to cope with. Spiral arms, the
 * bar and the halo are all future work that changes this function and nothing
 * else.
 */
export function stellarDensity(position: UniverseVector): number {
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

const SPECTRAL_CLASSES = ['M', 'K', 'G', 'F', 'A', 'B'] as const
/** Initial mass function, flattened into class frequencies for the main sequence. */
const SPECTRAL_WEIGHTS = [76.45, 12.1, 7.6, 3.0, 0.6, 0.13]
const SPECTRAL_MASS_RANGE: Readonly<Record<string, readonly [number, number]>> = {
  M: [0.08, 0.45],
  K: [0.45, 0.8],
  G: [0.8, 1.04],
  F: [1.04, 1.4],
  A: [1.4, 2.1],
  B: [2.1, 16],
}

/**
 * Generate every star in one cell.
 *
 * Pure in (seed, cell). The expected count comes from the density model; the
 * fractional part is resolved by a draw rather than rounded, so a cell with an
 * expectation of 0.3 stars contains one about 30% of the time instead of never.
 */
export function generateCell(galaxySeed: Seed, cell: GalacticCell): readonly SystemStub[] {
  const seed = derivePath(galaxySeed, ['cell', cellKey(cell)])
  const rng = new Rng(seed)
  const volume = CELL_SIZE ** 3
  const expected = stellarDensity(cellCentre(cell)) * volume
  const whole = Math.floor(expected)
  const count = whole + (rng.next() < expected - whole ? 1 : 0)

  const stars: SystemStub[] = []
  for (let index = 0; index < count; index += 1) {
    // Each star draws from its own derived stream, so changing the count of a
    // cell cannot change the properties of the stars that remain.
    const starRng = new Rng(deriveSeed(seed, `star:${index}`))
    const classIndex = starRng.weightedIndex(SPECTRAL_WEIGHTS)
    const spectralClass = SPECTRAL_CLASSES[classIndex] ?? 'M'
    const [minMass, maxMass] = SPECTRAL_MASS_RANGE[spectralClass] ?? [0.08, 0.45]
    const id = proceduralSystemId(cell, index)
    stars.push({
      id,
      name: id,
      position: UV.translate(
        cellOrigin(cell),
        vec3(
          starRng.next() * CELL_SIZE,
          starRng.next() * CELL_SIZE,
          starRng.next() * CELL_SIZE,
        ),
      ),
      spectralType: `${spectralClass}${starRng.int(0, 9)}V`,
      solarMasses: starRng.range(minMass, maxMass),
      catalogued: false,
    })
  }
  return stars
}

export const catalogStub = (star: CatalogStar): SystemStub => ({
  id: star.id,
  name: star.name,
  position: catalogStarPosition(star),
  spectralType: star.spectralType,
  solarMasses: star.solarMasses,
  catalogued: true,
})

/**
 * Resolve any system id to its stub without a global index.
 *
 * Catalogue ids hit the table; procedural ids decode to a cell and regenerate
 * it. Either way the answer does not depend on what is currently loaded, which
 * is what lets a save file reference a system nobody has visited.
 */
export function resolveSystem(galaxySeed: Seed, id: SystemId): SystemStub | undefined {
  const catalogued = CATALOG.find((star) => star.id === id)
  if (catalogued !== undefined) return catalogStub(catalogued)
  const ref = parseProceduralSystemId(id)
  if (ref === null) return undefined
  return generateCell(galaxySeed, ref.cell)[ref.index]
}

/**
 * Every system within `radius` of a point, catalogue and procedural alike.
 *
 * Cost is bounded by the cell grid, not by the size of the galaxy: a 100 ly
 * query touches ~1,000 cells regardless of where in the Milky Way it is asked.
 */
export function systemsWithin(
  galaxySeed: Seed,
  centre: UniverseVector,
  radius: Meters,
): readonly SystemStub[] {
  const found: SystemStub[] = []
  for (const star of CATALOG) {
    const stub = catalogStub(star)
    if (UV.distance(stub.position, centre) <= radius) found.push(stub)
  }

  const min = cellOf(UV.translate(centre, vec3(-radius, -radius, -radius)))
  const max = cellOf(UV.translate(centre, vec3(radius, radius, radius)))
  const cellCount = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1)
  invariant(cellCount <= 200_000, `systemsWithin would generate ${cellCount} cells; narrow the radius`)

  for (let x = min.x; x <= max.x; x += 1) {
    for (let y = min.y; y <= max.y; y += 1) {
      for (let z = min.z; z <= max.z; z += 1) {
        for (const stub of generateCell(galaxySeed, { x, y, z })) {
          if (UV.distance(stub.position, centre) <= radius) found.push(stub)
        }
      }
    }
  }
  // Sorted by id so the result is a pure function of the query, not of
  // iteration order — two clients asking the same question get the same list.
  return found.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export const galaxySeedOf = (rootSeed: Seed, galaxy: GalaxyId = MILKY_WAY): Seed =>
  derivePath(rootSeed, [`g:${galaxy}`])

export const systemSeedOf = (rootSeed: Seed, galaxy: GalaxyId, system: SystemId): Seed =>
  derivePath(rootSeed, [`g:${galaxy}`, `s:${system}`])

export { systemAddress }
