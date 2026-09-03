import { formatSeed, parseSeed } from '@inertialref/procedural'
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
  type HeightfieldRequest,
  type RegionAddress,
  regionAddress,
  surfaceDetailFloor,
  type SurfaceParameters,
  type SystemId,
  type SystemStub,
  walkBodies,
} from '@inertialref/universe'
import { UV } from '@inertialref/spatial'
import type { JobHandle, WorkerPool } from './pool.ts'
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

/**
 * A `SurfaceParameters` in a form that survives structured clone.
 *
 * The seed is the one field that does not: it is four uint32 lanes and it
 * travels as hex. Everything else is already plain data — the grammar by
 * construction (`SurfaceParameters.grammar`), the rest numbers — and goes as
 * it is, so a field added to the surface crosses the wire without an edit
 * here. The grammar rides along rather than being looked up because a worker
 * has no system, no star and no parent planet to derive it from, and shipping
 * the *sketch* instead would be kilobytes per patch of something each worker
 * can rebuild once and keep.
 */
export interface WireSurface extends Omit<SurfaceParameters, 'seed'> {
  /** Terrain seed of the body's surface, hex. */
  readonly seed: string
}

export const encodeSurface = (surface: SurfaceParameters): WireSurface => ({
  ...surface,
  seed: formatSeed(surface.seed),
})

export const decodeSurface = (wire: WireSurface): SurfaceParameters => ({
  ...wire,
  seed: parseSeed(wire.seed),
})

/**
 * A heightfield request on the wire: `generateHeightfield`'s own request,
 * unchanged, beside the surface it is of.
 *
 * The request is the caller's type rather than a copy of its fields, so a
 * field added to `HeightfieldRequest` reaches the worker without this file
 * knowing. What a caller holds and what crosses the wire differ in the seed
 * alone, and `poolHeightfieldSource` is where that conversion happens.
 */
export interface HeightfieldRequestPayload extends HeightfieldRequest {
  readonly surface: WireSurface
}

export interface HeightfieldResponse {
  readonly region: RegionAddress
  readonly resolution: number
  readonly border: number
  readonly elevations: Float32Array
  /** `COVER_CHANNELS` bytes of surface cover per vertex, unbordered. See `cover.ts`. */
  readonly cover: Uint8Array
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
   *
   * 3: the request carries the body's surface grammar. Without it a worker
   * cannot evaluate the band stack at all, and a version 2 worker handed a
   * version 3 payload would read `undefined` for every band amplitude and
   * return a field of `NaN` — which reaches the mesh as a patch that vanishes
   * rather than as an error.
   *
   * 4: the response carries the surface cover beside the elevations. A version
   * 3 worker's answer has no `cover`, and `buildPatch` reads its length —
   * which is an invariant failure on the first patch rather than a patch that
   * quietly wears the wrong material.
   *
   * 5: the cover record is eight bytes — wet and biota beside the four — and
   * the request says whether the tile is the seabed. A version 4 worker's
   * cover is half the length `buildPatch` checks, which is an invariant
   * failure that names the mesh rather than the worker.
   *
   * 6: the surface travels as one record under `surface`, its seed as hex,
   * rather than as four fields beside the grammar. A version 5 worker reads
   * `surfaceSeed` off a payload that has no such field and `parseSeed`
   * refuses `undefined` — loud, but named for a malformed seed rather than
   * for the mismatch, which is what the version is for.
   */
  version: 6,
  run(payload) {
    const { surface, region, ...request } = payload
    const field: Heightfield = generateHeightfield(decodeSurface(surface), {
      ...request,
      // Rebuilt rather than trusted: `regionAddress` carries the range checks
      // the wire does not, so an address a clone mangled fails here by name.
      region: regionAddress(region.face, region.level, region.i, region.j),
    })
    return {
      region: field.region,
      resolution: field.resolution,
      border: field.border,
      elevations: field.elevations,
      cover: field.cover,
      minElevation: field.minElevation,
      maxElevation: field.maxElevation,
    }
  },
  transfers(response) {
    // Transferred, not copied: the main thread hands this straight to a
    // BufferAttribute and the worker has no further use for it.
    return [response.elevations.buffer, response.cover.buffer]
  },
})

/**
 * Something that turns a heightfield request into a heightfield.
 *
 * The pool is one — `poolHeightfieldSource` below — and a GPU tile producer
 * is another, and the streamer asks whichever it holds without knowing which.
 * The response is the same shape either way: the bordered elevations, the
 * cover, the extremes. What differs is where the arithmetic ran and whether
 * it is the canonical field — the pool's is `generateHeightfield` itself,
 * and a producer's is a port of it held to a stated tolerance.
 *
 * `available` is how a producer says it can no longer answer — a kernel that
 * would not build, a device that was lost — so the streamer routes the next
 * request to the pool rather than queueing behind something that will reject
 * it. A source that is unavailable rejects with `producer unavailable`, which
 * the streamer treats like a cancellation: the producer has already said why.
 *
 * `submit` takes what `generateHeightfield` takes — the surface, and the
 * request — so a caller hands over the object it holds rather than a
 * flattening of it. That is what lets a producer memoize on the surface's
 * identity, which is the identity `surfaceKernel` and `terrainSketch` already
 * key on; the pool is the one source with a wire to cross, and its adapter
 * is where the seed becomes a string.
 */
export interface HeightfieldSource {
  /** `'pool'`, `'gpu'` — what `ir.terrain().producer` reports. */
  readonly kind: string
  readonly available: boolean
  /**
   * The deepest region level this source produces; a request deeper than it
   * goes to the pool instead. Absent means every level — the pool's own
   * answer, and the default for a source that does not say.
   */
  readonly maxLevel?: number
  submit(
    surface: SurfaceParameters,
    request: HeightfieldRequest,
  ): JobHandle<HeightfieldResponse>
}

/** The pool, as a source: `generateHeightfieldTask` on a worker. */
export const poolHeightfieldSource = (pool: WorkerPool): HeightfieldSource => ({
  kind: 'pool',
  available: true,
  submit: (surface, request) =>
    pool.submit(generateHeightfieldTask, {
      ...request,
      surface: encodeSurface(surface),
    }),
})

/** The surface on the wire, and the patch resolution the floor is measured at. */
export interface SurfaceDetailFloorRequest {
  readonly surface: WireSurface
  readonly resolution: number
}

export const surfaceDetailFloorTask = defineTask<
  SurfaceDetailFloorRequest,
  { readonly level: number }
>({
  /*
   * The level floor, off the arrival frame.
   *
   * `surfaceDetailFloor` refines trial fields until the field stops selling
   * detail, which is ~1,500 samples and 33-43 ms cold on the bodies measured
   * here — and it is cold exactly once per body, in the frame the streamer
   * first has that body underfoot. That was 85% of a 40 ms first-contact spike
   * on Earth and of the 114 ms one on Proxima Centauri b, on the one frame a
   * player is watching the ground arrive.
   *
   * Nothing in it needs the main thread; its own docstring said so. It reads
   * only what the heightfield request already carries, and it is a pure
   * function of that, so the answer is the same wherever it runs. The streamer
   * holds the ground back for the frames it takes rather than blocking on it —
   * which is what it already does for the heightfields themselves.
   */
  name: 'universe.surfaceDetailFloor',
  /*
   * 2: the surface travels under `surface` as the heightfield task's does,
   * for the reason given at that task's version 6.
   */
  version: 2,
  run(payload) {
    return {
      level: surfaceDetailFloor(
        decodeSurface(payload.surface),
        payload.resolution,
      ),
    }
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
  registry.register(surfaceDetailFloorTask)
  return registry
}
