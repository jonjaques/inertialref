import type { Vec3 } from '@inertialref/spatial'
import type { BodyWeather } from './weatherClimate.ts'
import { cloudFieldAt, type FieldClock } from './weatherField.ts'

/*
 * The isolated cumulus the path tracers render: the CPU field sampled on a
 * regular grid of voxels about one cell, as the reference and the march it
 * judges both read it. Built from `cloudFieldAt`, so the fixture cannot
 * drift from the field: a reference generated from an old field fails
 * against the voxels this builds.
 */

export interface CumulusFixture {
  /** Voxels along the fixture's east, up and north. */
  readonly size: readonly [number, number, number]
  /** A voxel's edge, meters. */
  readonly voxel: number
  /** The low corner's height over the datum, meters. */
  readonly base: number
  /** Scaled in-cloud extinction times the cloudy fraction, 1/m, laid out [up][north][east]. */
  readonly sigma: Float32Array
  /** Effective radius, µm, in the same layout. */
  readonly radius: Float32Array
}

/** Where on a body a fixture is cut, and how finely. */
export interface CumulusFixturePlace {
  /** The fixture's low corner on the datum, body-fixed, meters from the center. */
  readonly corner: Vec3
  /** Unit, body-fixed: the fixture's east and north; its up is the corner's own. */
  readonly east: Vec3
  readonly north: Vec3
  readonly size: readonly [number, number, number]
  readonly voxel: number
  readonly base: number
}

/** The field on a place's voxels, each read at its center at its own footprint. */
export function cumulusFixture(
  weather: BodyWeather,
  clock: FieldClock,
  sun: Vec3,
  place: CumulusFixturePlace,
): CumulusFixture {
  const [nx, ny, nz] = place.size
  const count = nx * ny * nz
  const sigma = new Float32Array(count)
  const radius = new Float32Array(count)
  const length = Math.hypot(place.corner.x, place.corner.y, place.corner.z)
  const up: Vec3 =
    length > 0
      ? {
          x: place.corner.x / length,
          y: place.corner.y / length,
          z: place.corner.z / length,
        }
      : { x: 0, y: 1, z: 0 }
  for (let j = 0; j < ny; j += 1)
    for (let k = 0; k < nz; k += 1)
      for (let i = 0; i < nx; i += 1) {
        const e = (i + 0.5) * place.voxel
        const n = (k + 0.5) * place.voxel
        const h = place.base + (j + 0.5) * place.voxel
        const at = cloudFieldAt(
          weather,
          clock,
          sun,
          {
            x: place.corner.x + place.east.x * e + place.north.x * n + up.x * h,
            y: place.corner.y + place.east.y * e + place.north.y * n + up.y * h,
            z: place.corner.z + place.east.z * e + place.north.z * n + up.z * h,
          },
          place.voxel,
        )
        const index = (j * nz + k) * nx + i
        sigma[index] = at.sigma * at.fraction
        radius[index] = at.radius
      }
  return {
    size: place.size,
    voxel: place.voxel,
    base: place.base,
    sigma,
    radius,
  }
}
