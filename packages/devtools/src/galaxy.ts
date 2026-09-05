import { invariant, PARSEC } from '@inertialref/shared'
import { UV, vec3, type UniverseVector } from '@inertialref/spatial'
import {
  createGalaxyField,
  GALAXY_FIELD_VERSIONS,
  GENERATION_VERSIONS,
  integrateGalaxyCount,
  integrateGalaxyRay,
  GALAXY_ARMS,
  armTangencies,
  SUN_POSITION,
  type GalaxyCountOptions,
  type GalaxyField,
} from '@inertialref/universe'
import type { World } from '@inertialref/simulation'

export type GalaxyPlateView = 'face-on' | 'edge-on' | 'observer'
export interface GalaxyPlateOptions {
  readonly view?: GalaxyPlateView
  readonly width?: number
  readonly height?: number
  readonly maxStepParsecs?: number
  readonly observer?: UniverseVector
}
export interface GalaxyPlate {
  readonly view: GalaxyPlateView
  readonly width: number
  readonly height: number
  readonly fieldVersions: typeof GALAXY_FIELD_VERSIONS
  readonly seed: string
  readonly units: 'bolometric nW m^-2 sr^-1'
  readonly emissionOnly: true
  /** Interleaved linear RGB. Its sum is the pixel's bolometric radiance. */
  readonly rgb: Float64Array
  readonly maxRadiance: number
  readonly samples: number
}

/** Read-only diagnostics derive from the current world, including after a save load. */
export class GalaxyInspector {
  readonly field: GalaxyField
  readonly #seed: string
  constructor(world: World) {
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
  tangencies() {
    return GALAXY_ARMS.map((arm) => ({
      arm: arm.id,
      longitudes: armTangencies(arm),
    }))
  }
  plate(options: GalaxyPlateOptions = {}): GalaxyPlate {
    const view = options.view ?? 'face-on',
      width = options.width ?? 192,
      height = options.height ?? (view === 'face-on' ? 192 : 96)
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
        const ray = integrateGalaxyRay(this.field, origin, direction, {
          distanceParsecs:
            view === 'face-on' ? 24000 : view === 'edge-on' ? 64000 : 60000,
          ...(options.maxStepParsecs === undefined
            ? {}
            : { maxStepParsecs: options.maxStepParsecs }),
        })
        const index = 3 * (y * width + x)
        rgb[index] = ray.rgbNanowatts[0]
        rgb[index + 1] = ray.rgbNanowatts[1]
        rgb[index + 2] = ray.rgbNanowatts[2]
        maxRadiance = Math.max(maxRadiance, ray.radianceNanowatts)
        samples += ray.samples
      }
    return {
      view,
      width,
      height,
      fieldVersions: GALAXY_FIELD_VERSIONS,
      seed: this.#seed,
      units: 'bolometric nW m^-2 sr^-1',
      emissionOnly: true,
      rgb,
      maxRadiance,
      samples,
    }
  }
}
