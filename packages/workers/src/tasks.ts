import { invariant } from '@inertialref/shared'
import { parseSeed, type Seed } from '@inertialref/procedural'
import { encodeUniverseVector, type WireUniverseVector } from '@inertialref/protocol'
import {
  type GalacticCell,
  galaxyId,
  galaxySeedOf,
  generateCell,
  generateHeightfield,
  generateSystem,
  type Heightfield,
  levelForSize,
  MILKY_WAY,
  type RegionAddress,
  regionAddress,
  resolveSystem,
  systemId,
  walkBodies,
} from '@inertialref/universe'
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

export interface GenerateCellRequest {
  readonly seed: string
  readonly cell: GalacticCell
}

export interface GeneratedStar {
  readonly id: string
  readonly name: string
  readonly position: WireUniverseVector
  readonly spectralType: string
  readonly solarMasses: number
  readonly catalogued: boolean
}

export interface GenerateCellResponse {
  readonly cell: GalacticCell
  readonly stars: readonly GeneratedStar[]
}

export const generateCellTask = defineTask<GenerateCellRequest, GenerateCellResponse>({
  name: 'universe.generateCell',
  version: 1,
  run({ seed, cell }) {
    const stars = generateCell(parseSeed(seed), cell).map((star) => ({
      id: star.id as string,
      name: star.name,
      position: encodeUniverseVector(star.position),
      spectralType: star.spectralType,
      solarMasses: star.solarMasses,
      catalogued: star.catalogued,
    }))
    return { cell, stars }
  },
})

export interface SurveyRegionRequest {
  readonly seed: string
  /** Inclusive cell bounds. */
  readonly min: GalacticCell
  readonly max: GalacticCell
}

export const surveyRegionTask = defineTask<SurveyRegionRequest, GenerateCellResponse[]>({
  name: 'universe.surveyRegion',
  version: 1,
  run({ seed, min, max }, context) {
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
          const stars = generateCell(parsed, cell)
          if (stars.length === 0) continue
          out.push({
            cell,
            stars: stars.map((star) => ({
              id: star.id as string,
              name: star.name,
              position: encodeUniverseVector(star.position),
              spectralType: star.spectralType,
              solarMasses: star.solarMasses,
              catalogued: star.catalogued,
            })),
          })
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
}

export interface HeightfieldResponse {
  readonly region: RegionAddress
  readonly resolution: number
  readonly elevations: Float32Array
  readonly minElevation: number
  readonly maxElevation: number
}

export const generateHeightfieldTask = defineTask<HeightfieldRequestPayload, HeightfieldResponse>({
  name: 'universe.generateHeightfield',
  version: 1,
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
      },
    )
    return {
      region: field.region,
      resolution: field.resolution,
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
  readonly system: string
}

export interface SurveyedBody {
  readonly address: string
  readonly name: string
  readonly kind: string
  readonly radius: number
  readonly semiMajorAxis: number
  readonly orbitalPeriod: number
  readonly hasAtmosphere: boolean
  readonly moons: number
}

export interface SurveySystemResponse {
  readonly system: string
  readonly name: string
  readonly star: { readonly spectralType: string; readonly mass: number; readonly luminosity: number }
  readonly bodies: readonly SurveyedBody[]
}

export const surveySystemTask = defineTask<SurveySystemRequest, SurveySystemResponse>({
  name: 'universe.surveySystem',
  version: 1,
  run({ seed, galaxy, system }) {
    const rootSeed = parseSeed(seed)
    const galaxyName = galaxyId(galaxy)
    // Derived through the same helper the world uses: a survey has to describe
    // the universe the player is actually flying through, not a parallel one.
    const stub = resolveSystem(galaxySeedOf(rootSeed, galaxyName), systemId(system))
    invariant(stub !== undefined, `Unknown system ${system}`)
    const generated = generateSystem(rootSeed, galaxyName, stub)
    return {
      system,
      name: generated.name,
      star: {
        spectralType: generated.star.spectralType,
        mass: generated.star.mass,
        luminosity: generated.star.luminosity,
      },
      bodies: [...walkBodies(generated)].map((body) => ({
        address: body.id.slice(1),
        name: body.name,
        kind: body.kind,
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

export const DEFAULT_HEIGHTFIELD_RESOLUTION = 65

/** Level whose regions are roughly `target` meters across, clamped for sanity. */
export const heightfieldLevelFor = (radius: number, target: number): number =>
  Math.min(18, levelForSize(radius, target))

export { MILKY_WAY }
