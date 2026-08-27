import { parseSeed, type Seed } from '@inertialref/procedural'
import {
  encodeUniverseVector,
  type WireUniverseVector,
} from '@inertialref/protocol'
import {
  type CatalogPlanet,
  type CellContext,
  cellKey,
  NO_CATALOGUE,
  type GalacticCell,
  galaxyId,
  generateCell,
  generateHeightfield,
  generateSystem,
  type Heightfield,
  type RegionAddress,
  regionAddress,
  type SystemId,
  type SystemStub,
  walkBodies,
} from '@inertialref/universe'
import { UV } from '@inertialref/spatial'
import { defineTask, TaskRegistry } from './task.ts'

/*
 * The tasks.
 *
 * Payloads are plain JSON-ish values — seeds travel as hex strings, addresses
 * as their text form — so nothing depends on a class surviving structured
 * clone. Results that are large travel as typed arrays and are transferred.
 *
 * These are genuinely expensive: a 65×65 heightfield is 4,225 samples of
 * fourteen octaves of 3D noise, and a 100 ly cell sweep generates tens of
 * thousands of stars. Both would be visible frame hitches on the main thread.
 */

/*
 * The catalog is not shipped to workers.
 *
 * Every task here used to take a system id and resolve it, which now needs the
 * 200 KB star catalog — in every worker, for every pool, to answer questions
 * the caller already knows the answer to. Instead the caller passes what it
 * resolved: a cell's cataloged *count* for generation, and a whole stub for a
 * survey. The count is the only thing procedural generation needs from the
 * catalog (see `proceduralCount`), and passing it makes the dependency an
 * argument rather than an ambient table that has to be kept in sync across a
 * thread boundary.
 */
export interface GenerateCellRequest {
  readonly seed: string
  readonly cell: GalacticCell
  /**
   * What the catalog contributes: how many stars it already has in this cell,
   * and the radius inside which it is complete. Procedural stars fill the
   * difference between the catalog and the density model, so wrong values here
   * give a different galaxy — loudly, not subtly.
   */
  readonly context?: CellContext
}

/** A `SystemStub` in a form that survives structured clone. */
export interface GeneratedStar {
  readonly id: string
  readonly name: string
  readonly position: WireUniverseVector
  readonly spectralType: string
  readonly solarMasses: number
  readonly solarRadii: number
  readonly solarLuminosities: number
  readonly temperature: number
  readonly colour: readonly [number, number, number]
  readonly components: number
  readonly catalogued: boolean
  readonly planets: readonly CatalogPlanet[]
}

export const encodeStub = (stub: SystemStub): GeneratedStar => ({
  id: stub.id as string,
  name: stub.name,
  position: encodeUniverseVector(stub.position),
  spectralType: stub.spectralType,
  solarMasses: stub.solarMasses,
  solarRadii: stub.solarRadii,
  solarLuminosities: stub.solarLuminosities,
  temperature: stub.temperature,
  colour: [stub.colour.r, stub.colour.g, stub.colour.b],
  components: stub.components,
  catalogued: stub.catalogued,
  planets: stub.planets,
})

export const decodeStub = (wire: GeneratedStar): SystemStub => ({
  id: wire.id as SystemId,
  name: wire.name,
  // `UV.universeVector` rather than the protocol's validating decoder: this is
  // a value `encodeStub` produced a moment ago on the other side of a
  // structured clone, not untrusted input, and the decoder returns a Result the
  // caller would have to unwrap for a case that cannot happen.
  position: UV.universeVector(
    wire.position[0],
    wire.position[1],
    wire.position[2],
    wire.position[3],
    wire.position[4],
    wire.position[5],
  ),
  spectralType: wire.spectralType,
  solarMasses: wire.solarMasses,
  solarRadii: wire.solarRadii,
  solarLuminosities: wire.solarLuminosities,
  temperature: wire.temperature,
  colour: { r: wire.colour[0], g: wire.colour[1], b: wire.colour[2] },
  components: wire.components,
  catalogued: wire.catalogued,
  planets: wire.planets,
})

export interface GenerateCellResponse {
  readonly cell: GalacticCell
  readonly stars: readonly GeneratedStar[]
}

export const generateCellTask = defineTask<
  GenerateCellRequest,
  GenerateCellResponse
>({
  name: 'universe.generateCell',
  version: 2,
  run({ seed, cell, context }) {
    return {
      cell,
      stars: generateCell(parseSeed(seed), cell, context ?? NO_CATALOGUE).map(
        encodeStub,
      ),
    }
  },
})

export interface SurveyRegionRequest {
  readonly seed: string
  /** Inclusive cell bounds. */
  readonly min: GalacticCell
  readonly max: GalacticCell
  /** Cataloged star counts by `cellKey`; absent cells are zero. */
  readonly catalogued?: Readonly<Record<string, number>>
  /** Radius inside which the catalog is complete; see `CellContext`. */
  readonly completeRadius?: number
}

export const surveyRegionTask = defineTask<
  SurveyRegionRequest,
  GenerateCellResponse[]
>({
  name: 'universe.surveyRegion',
  version: 2,
  run({ seed, min, max, catalogued, completeRadius }, context) {
    const parsed = parseSeed(seed)
    const out: GenerateCellResponse[] = []
    for (let x = min.x; x <= max.x; x += 1) {
      for (let y = min.y; y <= max.y; y += 1) {
        for (let z = min.z; z <= max.z; z += 1) {
          // Cancellation is checked per cell rather than per star: a cell is a
          // millisecond, so this bounds the wasted work without the check
          // costing more than the work.
          if (context.cancelled()) return out
          const cell = { x, y, z }
          const stars = generateCell(parsed, cell, {
            catalogued: catalogued?.[cellKey(cell)] ?? 0,
            completeRadius: completeRadius ?? 0,
          })
          if (stars.length === 0) continue
          out.push({ cell, stars: stars.map(encodeStub) })
        }
      }
    }
    return out
  },
})

export interface HeightfieldRequestPayload {
  /** Terrain seed of the body's surface, hex. */
  readonly surfaceSeed: string
  readonly maxElevation: number
  readonly roughness: number
  readonly seaLevel: number | null
  readonly region: RegionAddress
  readonly resolution: number
  /** Rings of samples outside the patch. Omitted means `HEIGHTFIELD_BORDER`. */
  readonly border?: number
}

export interface HeightfieldResponse {
  readonly region: RegionAddress
  readonly resolution: number
  readonly border: number
  readonly elevations: Float32Array
  readonly minElevation: number
  readonly maxElevation: number
}

export const generateHeightfieldTask = defineTask<
  HeightfieldRequestPayload,
  HeightfieldResponse
>({
  name: 'universe.generateHeightfield',
  /*
   * 2: the response carries a border ring and the array is no longer
   * `resolution²`. A worker running version 1 would hand back an array the
   * mesh builder indexes as though the first row were the patch's own edge,
   * which is a patch shifted by one sample rather than a failure — so the
   * version is what makes the mismatch loud.
   */
  version: 2,
  run(payload) {
    const seed: Seed = parseSeed(payload.surfaceSeed)
    const field: Heightfield = generateHeightfield(
      {
        seed,
        maxElevation: payload.maxElevation,
        roughness: payload.roughness,
        seaLevel: payload.seaLevel,
      },
      {
        region: regionAddress(
          payload.region.face,
          payload.region.level,
          payload.region.i,
          payload.region.j,
        ),
        resolution: payload.resolution,
        border: payload.border,
      },
    )
    return {
      region: field.region,
      resolution: field.resolution,
      border: field.border,
      elevations: field.elevations,
      minElevation: field.minElevation,
      maxElevation: field.maxElevation,
    }
  },
  transfers(response) {
    // Transferred, not copied: the main thread hands this straight to a
    // BufferAttribute and the worker has no further use for it.
    return [response.elevations.buffer]
  },
})

export interface SurveySystemRequest {
  readonly seed: string
  readonly galaxy: string
  /**
   * The system to survey, already resolved.
   *
   * An id would be smaller, but resolving one needs the star catalog and this
   * runs where there isn't one. The caller has already resolved it — that is how
   * it knew there was a system worth surveying — so passing the stub also stops
   * the work being done twice.
   */
  readonly stub: GeneratedStar
}

export interface SurveyedBody {
  readonly address: string
  readonly name: string
  readonly kind: string
  /** `observed` came from a catalog; `projected` is the ship's computer. */
  readonly provenance: string
  readonly radius: number
  readonly semiMajorAxis: number
  readonly orbitalPeriod: number
  readonly hasAtmosphere: boolean
  readonly moons: number
}

export interface SurveySystemResponse {
  readonly system: string
  readonly name: string
  readonly star: {
    readonly spectralType: string
    readonly mass: number
    readonly luminosity: number
    readonly temperature: number
  }
  readonly bodies: readonly SurveyedBody[]
}

export const surveySystemTask = defineTask<
  SurveySystemRequest,
  SurveySystemResponse
>({
  name: 'universe.surveySystem',
  version: 2,
  run({ seed, galaxy, stub: wire }) {
    const rootSeed = parseSeed(seed)
    const galaxyName = galaxyId(galaxy)
    const stub = decodeStub(wire)
    const generated = generateSystem(rootSeed, galaxyName, stub)
    return {
      system: stub.id as string,
      name: generated.name,
      star: {
        spectralType: generated.star.spectralType,
        mass: generated.star.mass,
        luminosity: generated.star.luminosity,
        temperature: generated.star.temperature,
      },
      bodies: [...walkBodies(generated)].map((body) => ({
        address: body.id.slice(1),
        name: body.name,
        kind: body.kind,
        provenance: body.provenance,
        radius: body.radius,
        semiMajorAxis: body.elements.semiMajorAxis,
        orbitalPeriod: body.orbitalPeriod,
        hasAtmosphere: body.atmosphere !== null,
        moons: body.moons.length,
      })),
    }
  },
})

/** Everything the worker entry point serves. */
export function createTaskRegistry(): TaskRegistry {
  const registry = new TaskRegistry()
  registry.register(generateCellTask)
  registry.register(surveyRegionTask)
  registry.register(generateHeightfieldTask)
  registry.register(surveySystemTask)
  return registry
}
