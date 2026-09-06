import { invariant, PARSEC } from '@inertialref/shared'
import { UV, vec3, type UniverseVector, type Vec3 } from '@inertialref/spatial'
import {
  createGalaxyField,
  GALAXY_FIELD_VERSIONS,
  GALAXY_DUST_SETTLED_STEP_PARSECS,
  GENERATION_VERSIONS,
  integrateGalaxyCount,
  integrateGalaxyRay,
  GALAXY_ARMS,
  armTangencies,
  SUN_POSITION,
  type GalaxyCountOptions,
  type GalaxyField,
  type GalaxyPopulation,
  type GalaxyRayOptions,
} from '@inertialref/universe'
import type { Lens, Exposure } from '@inertialref/rendering'
import type { Quat } from '@inertialref/spatial'
import type { GalaxyJourneyStatus } from './observatory.ts'
import type { World } from '@inertialref/simulation'

export type GalaxyPlateView = 'face-on' | 'edge-on' | 'observer'
export interface GalaxyPlateOptions {
  readonly population?: GalaxyPopulation
  readonly view?: GalaxyPlateView
  readonly width?: number
  readonly height?: number
  readonly maxStepParsecs?: number
  readonly observer?: UniverseVector
  readonly dustScale?: number
}
export interface GalaxyPlate {
  readonly population: GalaxyPopulation | null
  readonly view: GalaxyPlateView
  readonly width: number
  readonly height: number
  readonly fieldVersions: typeof GALAXY_FIELD_VERSIONS
  readonly seed: string
  readonly units: 'bolometric nW m^-2 sr^-1'
  readonly emissionOnly: boolean
  readonly dustScale: number
  readonly maxStepParsecs: number
  /** Interleaved linear RGB. Its sum is the pixel's bolometric radiance. */
  readonly rgb: Float64Array
  readonly maxRadiance: number
  readonly samples: number
}

export interface GalaxyRenderReport {
  readonly coordinateFrame: 'galactocentric'
  readonly orientation: Quat | null
  readonly lens: Lens | null
  readonly sampling: 'observer' | 'settled'
  readonly exposure: Exposure | null
  readonly instrument: boolean
  readonly journey: GalaxyJourneyStatus | null
  readonly survey: {
    readonly radiusCells: number
    readonly cellCeiling: number
    readonly spriteCount: number
    readonly spriteCeiling: number
    readonly pending: boolean
    readonly center: UniverseVector | null
  } | null
  readonly active: boolean
  readonly ready: boolean
  readonly fieldVersions: typeof GALAXY_FIELD_VERSIONS
  readonly kernelVersion: string
  readonly normalization: number
  readonly width: number
  readonly height: number
  readonly targetBytes: number
  readonly resolutionDivisor: number
  readonly maxStepParsecs: number
  readonly settled: boolean
  readonly dustStepParsecs: number | null
  readonly maxSteps: number
  /** Scene submissions the volume was asked in, drawn or not. */
  readonly submissions: number
  /** Volume draws. Less than `submissions` once the target is being reused. */
  readonly draws: number
  /** Whether the last submission reused the target rather than drawing. */
  readonly held: boolean
  /** The angle one target texel subtends, radians; what the dust filter and the interval floor are keyed to. */
  readonly pixelAngle: number
  readonly emissionOnly: boolean
  readonly dustScale: number
  readonly dustNormalization: number
  readonly resolvedStarExtinction: false
  readonly originParsecs: readonly number[]
}

/** Read-only diagnostics derive from the current world, including after a save load. */
export class GalaxyInspector {
  readonly field: GalaxyField
  readonly #seed: string
  readonly render: () => GalaxyRenderReport | null
  constructor(
    world: World,
    render: () => GalaxyRenderReport | null = () => null,
  ) {
    this.render = render
    this.field = createGalaxyField(world.galaxySeed)
    this.#seed = world.seedText
  }
  sample(position: UniverseVector = SUN_POSITION) {
    return {
      fieldVersions: GALAXY_FIELD_VERSIONS,
      generationVersions: GENERATION_VERSIONS,
      seed: this.#seed,
      normalization: this.field.normalization,
      ...this.field.sample(position),
    }
  }
  count(options: GalaxyCountOptions = {}) {
    return integrateGalaxyCount(this.field, options)
  }
  ray(direction: Vec3, options: GalaxyRayOptions = {}, origin = SUN_POSITION) {
    return integrateGalaxyRay(this.field, origin, direction, options)
  }
  tangencies() {
    return GALAXY_ARMS.map((arm) => ({
      arm: arm.id,
      longitudes: armTangencies(arm),
    }))
  }
  plate(options: GalaxyPlateOptions = {}): GalaxyPlate {
    const view = options.view ?? 'face-on',
      width = options.width ?? 192,
      height =
        options.height ?? (view === 'face-on' ? width : Math.round(width / 2))
    invariant(
      ['face-on', 'edge-on', 'observer'].includes(view),
      'Unknown galaxy plate view',
    )
    invariant(
      Number.isInteger(width) &&
        width > 0 &&
        width <= 2048 &&
        Number.isInteger(height) &&
        height > 0 &&
        height <= 2048,
      'Galaxy plate dimensions must be integers from 1 through 2048',
    )
    const field =
      options.dustScale === undefined
        ? this.field
        : createGalaxyField(this.field.seed, { dustScale: options.dustScale })
    const maxStepParsecs =
      options.maxStepParsecs ??
      (field.dustScale === 0 ? 100 : GALAXY_DUST_SETTLED_STEP_PARSECS)
    const rgb = new Float64Array(width * height * 3)
    let maxRadiance = 0,
      samples = 0
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const u = (x + 0.5) / width,
          v = (y + 0.5) / height
        let origin: UniverseVector, direction
        if (view === 'observer') {
          // Galactic center at the middle, longitude increases to the left.
          const l = (0.5 - u) * 2 * Math.PI,
            b = (0.5 - v) * Math.PI
          origin = options.observer ?? SUN_POSITION
          direction = vec3(
            Math.cos(b) * Math.cos(l),
            Math.sin(b),
            -Math.cos(b) * Math.sin(l),
          )
        } else if (view === 'face-on') {
          origin = UV.fromMeters(
            (u - 0.5) * 60000 * PARSEC,
            12000 * PARSEC,
            (v - 0.5) * 60000 * PARSEC,
          )
          direction = vec3(0, -1, 0)
        } else {
          origin = UV.fromMeters(
            (u - 0.5) * 60000 * PARSEC,
            (0.5 - v) * 16000 * PARSEC,
            32000 * PARSEC,
          )
          direction = vec3(0, 0, -1)
        }
        const ray = integrateGalaxyRay(field, origin, direction, {
          ...(options.population === undefined
            ? {}
            : { population: options.population }),
          distanceParsecs:
            view === 'face-on' ? 24000 : view === 'edge-on' ? 64000 : 60000,
          maxStepParsecs,
        })
        const index = 3 * (y * width + x)
        rgb[index] = ray.rgbNanowatts[0]
        rgb[index + 1] = ray.rgbNanowatts[1]
        rgb[index + 2] = ray.rgbNanowatts[2]
        maxRadiance = Math.max(maxRadiance, ray.radianceNanowatts)
        samples += ray.samples
      }
    return {
      population: options.population ?? null,
      view,
      width,
      height,
      fieldVersions: GALAXY_FIELD_VERSIONS,
      seed: this.#seed,
      units: 'bolometric nW m^-2 sr^-1',
      emissionOnly: field.dustScale === 0,
      dustScale: field.dustScale,
      maxStepParsecs,
      rgb,
      maxRadiance,
      samples,
    }
  }
}
