import { invariant, PARSEC } from '@inertialref/shared'
import { UV, vec3, type UniverseVector } from '@inertialref/spatial'
import { galaxyWarp, type GalaxyField } from './field.ts'

export const STAR_EXTINCTION_SAMPLES = 512
export const STAR_EXTINCTION_NEAR_SAMPLES = 32
export const STAR_EXTINCTION_NEAR_PARSECS = 64
export const STAR_EXTINCTION_MID_SAMPLES = 64
export const STAR_EXTINCTION_MID_PARSECS = 512
export const STAR_EXTINCTION_PLANE_SCALE_PARSECS = 100
export const STAR_EXTINCTION_PLANE_SLOPE = 0.05

export interface StarExtinctionOptions {
  /** A fixed budget for convergence measurements; normal queries use distance tiers. */
  readonly samples?: number
}
export interface StarExtinction {
  readonly transmittanceRgb: readonly [number, number, number]
  readonly opticalDepthRgb: readonly [number, number, number]
  readonly distanceParsecs: number
  readonly samples: number
}

/** The dust column ends at the source. Nothing behind a star attenuates it. */
export function integrateStarExtinction(
  field: GalaxyField,
  observer: UniverseVector,
  star: UniverseVector,
  options: StarExtinctionOptions = {},
): StarExtinction {
  const distance = UV.distance(observer, star) / PARSEC
  invariant(
    Number.isFinite(distance) && distance >= 0 && distance <= 100000,
    'Star extinction distance must be between 0 and 100000 pc',
  )
  const samples =
    options.samples ??
    (distance <= STAR_EXTINCTION_NEAR_PARSECS
      ? STAR_EXTINCTION_NEAR_SAMPLES
      : distance <= STAR_EXTINCTION_MID_PARSECS
        ? STAR_EXTINCTION_MID_SAMPLES
        : STAR_EXTINCTION_SAMPLES)
  invariant(
    Number.isInteger(samples) && samples >= 16 && samples <= 4096,
    'Star extinction needs 16 through 4096 samples',
  )
  const depth: [number, number, number] = [0, 0, 0]
  if (distance === 0 || field.dustScale === 0)
    return {
      transmittanceRgb: [1, 1, 1],
      opticalDepthRgb: depth,
      distanceParsecs: distance,
      samples: 0,
    }
  const delta = UV.difference(star, observer)
  const dx = delta.x / (distance * PARSEC),
    dy = delta.y / (distance * PARSEC),
    dz = delta.z / (distance * PARSEC)
  const origin = UV.approxMeters(observer)
  const tilted = Math.abs(dy) > STAR_EXTINCTION_PLANE_SLOPE
  let focus = 0
  if (tilted) {
    focus = -origin.y / PARSEC / dy
    for (let iteration = 0; iteration < 2; iteration++) {
      const x = origin.x / PARSEC + dx * focus,
        z = origin.z / PARSEC + dz * focus
      focus =
        (galaxyWarp(Math.hypot(x, z), Math.atan2(-z, -x)) - origin.y / PARSEC) /
        dy
    }
  }
  const scale =
    STAR_EXTINCTION_PLANE_SCALE_PARSECS /
    Math.max(Math.abs(dy), STAR_EXTINCTION_PLANE_SLOPE)
  const lo = Math.asinh(-focus / scale),
    span = Math.asinh((distance - focus) / scale) - lo
  // Uniform distance samples can all miss an 81 pc dust layer on a 30 kpc
  // approach. This coordinate concentrates work around its warped crossing.
  const at = (u: number) =>
    tilted
      ? Math.min(
          distance,
          Math.max(0, focus + scale * Math.sinh(lo + span * u)),
        )
      : distance * u * u
  let previous = 0
  for (let i = 0; i < samples; i++) {
    const next = i + 1 === samples ? distance : at((i + 1) / samples)
    const t = (previous + next) / 2
    const sample = field.sample(
      UV.translate(
        observer,
        vec3(dx * t * PARSEC, dy * t * PARSEC, dz * t * PARSEC),
      ),
    ).extinctionPerParsec
    const step = next - previous
    depth[0] += sample.r * step
    depth[1] += sample.g * step
    depth[2] += sample.b * step
    previous = next
  }
  return {
    transmittanceRgb: [
      Math.exp(-depth[0]),
      Math.exp(-depth[1]),
      Math.exp(-depth[2]),
    ],
    opticalDepthRgb: depth,
    distanceParsecs: distance,
    samples,
  }
}
