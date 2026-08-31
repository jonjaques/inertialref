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
  type SurfaceGrammar,
  surfaceDetailFloor,
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

export interface HeightfieldRequestPayload {
  /** Terrain seed of the body's surface, hex. */
  readonly surfaceSeed: string
  readonly maxElevation: number
  readonly roughness: number
  readonly seaLevel: number | null
  /**
   * Which bands this body's terrain has and how loud each is.
   *
   * Plain data by construction — numbers, one string and one nested record of
   * numbers — so it crosses a structured clone unchanged. It is on the payload
   * rather than looked up because a worker has no system, no star and no parent
   * planet to derive it from, and shipping the *sketch* instead would be
   * kilobytes per patch of something each worker can rebuild once and keep.
   */
  readonly grammar: SurfaceGrammar
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
  /** Four bytes of surface cover per vertex, unbordered. See `cover.ts`. */
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
   */
  version: 4,
  run(payload) {
    const seed: Seed = parseSeed(payload.surfaceSeed)
    const field: Heightfield = generateHeightfield(
      {
        seed,
        maxElevation: payload.maxElevation,
        roughness: payload.roughness,
        seaLevel: payload.seaLevel,
        grammar: payload.grammar,
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
  submit(payload: HeightfieldRequestPayload): JobHandle<HeightfieldResponse>
}

/** The pool, as a source: `generateHeightfieldTask` on a worker. */
export const poolHeightfieldSource = (pool: WorkerPool): HeightfieldSource => ({
  kind: 'pool',
  available: true,
  submit: (payload) => pool.submit(generateHeightfieldTask, payload),
})

/**
 * The fields of a `SurfaceParameters` that cross a structured clone.
 *
 * Derived from the heightfield request rather than retyped beside it, because
 * "the two payloads describe a surface the same way" is the property that lets
 * a worker parse it once — and retyped, that property is a sentence in a
 * comment rather than something the compiler checks. Everything a *region*
 * needs is what is subtracted.
 */
export type SurfaceDetailFloorRequest = Omit<
  HeightfieldRequestPayload,
  'region' | 'border'
>

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
  version: 1,
  run(payload) {
    return {
      level: surfaceDetailFloor(
        {
          seed: parseSeed(payload.surfaceSeed),
          maxElevation: payload.maxElevation,
          roughness: payload.roughness,
          seaLevel: payload.seaLevel,
          grammar: payload.grammar,
        },
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
