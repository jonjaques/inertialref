import { blackbodyColour } from '../catalog/photometry.ts'
import { GALAXY_POPULATIONS } from './field.ts'
import { invariant, PARSEC } from '@inertialref/shared'
import { UV, vec3, type UniverseVector, type Vec3 } from '@inertialref/spatial'
import {
  GALAXY_HEIGHT_PARSECS,
  GALAXY_RADIUS_PARSECS,
  POPULATION_NAMES,
  galaxyWarp,
  type GalaxyField,
  type GalaxyPopulation,
  type PopulationDensities,
} from './field.ts'

const SOLAR_LUMINOSITY_WATTS = 3.828e26
/** A column in L☉/pc² converted to isotropic bolometric radiance, nW m⁻² sr⁻¹. */
export const GALAXY_RADIANCE_FACTOR =
  (SOLAR_LUMINOSITY_WATTS / PARSEC ** 2 / (4 * Math.PI)) * 1e9

export interface GalaxyRayIntegral {
  readonly radianceNanowatts: number
  readonly rgbNanowatts: readonly [number, number, number]
  readonly starsPerSquareParsec: number
  readonly samples: number
  readonly transmittanceRgb: readonly [number, number, number]
  readonly opticalDepthRgb: readonly [number, number, number]
}
/** Settled rays resolve dust near the plane and widen in the smooth halo. */
export const GALAXY_DUST_SETTLED_STEP_PARSECS = 10
export const GALAXY_DUST_SETTLED_HEIGHT_FACTOR = 0.1
export const GALAXY_OBSERVER_MIN_STEP_PARSECS = 1
export const GALAXY_OBSERVER_STEP_GROWTH = 0.1
/**
 * A live interval is no shorter than this fraction of the pixel's footprint.
 *
 * The floor sits under the observer and settled laws only, never under the
 * plane-crossing law: a ray through the 19 pc young disk at a steep angle
 * still needs the crossing resolved, or where its one midpoint lands in the
 * sheet decides the pixel and the disk renders as noise. Along the plane
 * the crossing law already allows 40 pc, so the floor is what widens the
 * settled 10 pc there — 71 pc from an outside view at 40 kpc, where a texel
 * is 140 pc wide and 10 pc intervals resolve nothing the pixel can show.
 */
export const GALAXY_FOOTPRINT_STEP_FRACTION = 0.5
export type GalaxyRaySampling = 'reference' | 'observer' | 'settled'

export interface GalaxyRayOptions {
  readonly sampling?: GalaxyRaySampling
  readonly population?: GalaxyPopulation
  readonly distanceParsecs?: number
  readonly maxStepParsecs?: number
  /**
   * The angle one pixel of the asking image subtends, radians. Zero, the
   * default, integrates the exact field along the pixel's center; a real
   * angle filters the dust texture to what the pixel can resolve at each
   * distance and floors the live intervals — see `galaxyDustModulation` and
   * `GALAXY_FOOTPRINT_STEP_FRACTION`. Every canonical caller passes zero.
   */
  readonly pixelAngle?: number
}

// A direct 1-exp(-q) loses the source term near zero, especially in float32.
const transportFactor = (q: number): number =>
  q < 0.01 ? 1 - q / 2 + (q * q) / 6 - (q * q * q) / 24 : (1 - Math.exp(-q)) / q

/** Front-to-back transport; each midpoint defines a homogeneous interval. */
export function integrateGalaxyRay(
  field: GalaxyField,
  origin: UniverseVector,
  direction: Vec3,
  options: GalaxyRayOptions = {},
): GalaxyRayIntegral {
  const length = Math.hypot(direction.x, direction.y, direction.z)
  const distance = options.distanceParsecs ?? 60000,
    maxStep = options.maxStepParsecs ?? 100
  invariant(
    Number.isFinite(length) && length > 0,
    'Galaxy ray needs a finite nonzero direction',
  )
  invariant(
    Number.isFinite(distance) && distance >= 0 && distance <= 100000,
    'Galaxy ray distance must be between 0 and 100000 pc',
  )
  invariant(
    Number.isFinite(maxStep) && maxStep >= 0.25,
    'Galaxy ray step must be at least 0.25 pc',
  )
  const sampling = options.sampling ?? 'reference'
  invariant(
    sampling === 'reference' ||
      sampling === 'observer' ||
      sampling === 'settled',
    'Unknown galaxy ray sampling profile',
  )
  const pixelAngle = options.pixelAngle ?? 0
  invariant(
    Number.isFinite(pixelAngle) && pixelAngle >= 0,
    'Galaxy ray pixel angle must be a finite nonnegative angle',
  )
  const population = options.population
  invariant(
    population === undefined || POPULATION_NAMES.includes(population),
    'Unknown galaxy population',
  )
  const properties =
    population === undefined ? undefined : GALAXY_POPULATIONS[population]
  const colour =
    properties === undefined
      ? undefined
      : blackbodyColour(properties.temperature)
  const colourSum = colour === undefined ? 1 : colour.r + colour.g + colour.b
  const dx = direction.x / length,
    dy = direction.y / length,
    dz = direction.z / length
  let r = 0,
    g = 0,
    b = 0,
    column = 0,
    tr = 1,
    tg = 1,
    tb = 1,
    tauR = 0,
    tauG = 0,
    tauB = 0,
    samples = 0
  // Bound the integration to the finite reference volume. Slab clipping also
  // keeps an outside observer from paying for the empty approach to the disk.
  const m = UV.approxMeters(origin)
  let near = 0,
    far = distance
  for (const [o, d, limit] of [
    [m.x / PARSEC, dx, GALAXY_RADIUS_PARSECS],
    [m.y / PARSEC, dy, GALAXY_HEIGHT_PARSECS],
    [m.z / PARSEC, dz, GALAXY_RADIUS_PARSECS],
  ]) {
    if (Math.abs(d!) < 1e-15) {
      if (Math.abs(o!) > limit!) far = -1
      continue
    }
    const a = (-limit! - o!) / d!,
      c = (limit! - o!) / d!
    near = Math.max(near, Math.min(a, c))
    far = Math.min(far, Math.max(a, c))
  }
  for (let t = near; t < far;) {
    const x = m.x / PARSEC + dx * t,
      y = m.y / PARSEC + dy * t,
      z = m.z / PARSEC + dz * t
    const height = Math.abs(
      y - galaxyWarp(Math.hypot(x, z), Math.atan2(-z, -x)),
    )
    // Resolve the 19 pc young population near its warped plane. Far from it,
    // the smooth thick disk and halo permit longer intervals.
    const floor = pixelAngle * t * GALAXY_FOOTPRINT_STEP_FRACTION
    const step = Math.min(
      maxStep,
      Math.max(4, height * 0.2) / (Math.abs(dy) + 0.1),
      far - t,
      sampling !== 'reference'
        ? Math.max(
            GALAXY_OBSERVER_MIN_STEP_PARSECS + GALAXY_OBSERVER_STEP_GROWTH * t,
            floor,
          )
        : Infinity,
      sampling === 'settled'
        ? Math.max(
            GALAXY_DUST_SETTLED_STEP_PARSECS,
            height * GALAXY_DUST_SETTLED_HEIGHT_FACTOR,
            floor,
          )
        : Infinity,
    )
    const p = UV.translate(
      origin,
      vec3(
        dx * (t + step / 2) * PARSEC,
        dy * (t + step / 2) * PARSEC,
        dz * (t + step / 2) * PARSEC,
      ),
    )
    const s = field.sample(p, pixelAngle * (t + step / 2))
    const qr = s.extinctionPerParsec.r * step,
      qg = s.extinctionPerParsec.g * step,
      qb = s.extinctionPerParsec.b * step
    const wr = tr * transportFactor(qr),
      wg = tg * transportFactor(qg),
      wb = tb * transportFactor(qb)
    if (
      population !== undefined &&
      properties !== undefined &&
      colour !== undefined
    ) {
      const density = s.populations[population]
      const light =
        (density * properties.meanSolarLuminosities * step) / colourSum
      r += wr * light * colour.r
      g += wg * light * colour.g
      b += wb * light * colour.b
      column += density * step
    } else {
      r += wr * s.emissionRgb.r * step
      g += wg * s.emissionRgb.g * step
      b += wb * s.emissionRgb.b * step
      column += s.totalPerCubicParsec * step
    }
    tr *= Math.exp(-qr)
    tg *= Math.exp(-qg)
    tb *= Math.exp(-qb)
    tauR += qr
    tauG += qg
    tauB += qb
    samples++
    t += step
  }
  return {
    radianceNanowatts: (r + g + b) * GALAXY_RADIANCE_FACTOR,
    rgbNanowatts: [
      r * GALAXY_RADIANCE_FACTOR,
      g * GALAXY_RADIANCE_FACTOR,
      b * GALAXY_RADIANCE_FACTOR,
    ],
    starsPerSquareParsec: column,
    samples,
    transmittanceRgb: [tr, tg, tb],
    opticalDepthRgb: [tauR, tauG, tauB],
  }
}

export interface GalaxyCountOptions {
  readonly radialSteps?: number
  readonly azimuthSteps?: number
  readonly verticalSteps?: number
}
export interface GalaxyCountIntegral {
  readonly totalStars: number
  readonly populations: PopulationDensities
  readonly radiusParsecs: number
  readonly halfHeightParsecs: number
  readonly samples: number
}

/** Cylindrical midpoint quadrature with a sinh grid resolving both disk and halo. */
export function integrateGalaxyCount(
  field: GalaxyField,
  options: GalaxyCountOptions = {},
): GalaxyCountIntegral {
  const nr = options.radialSteps ?? 120,
    na = options.azimuthSteps ?? 96,
    nz = options.verticalSteps ?? 48
  for (const n of [nr, na, nz])
    invariant(
      Number.isInteger(n) && n >= 4 && n <= 1024,
      'Galaxy quadrature counts must be integers from 4 through 1024',
    )
  const populations: Record<GalaxyPopulation, number> = {
    thinDisk: 0,
    thickDisk: 0,
    youngArms: 0,
    barBulge: 0,
    halo: 0,
  }
  const dr = GALAXY_RADIUS_PARSECS / nr,
    da = (2 * Math.PI) / na
  let samples = 0
  for (let i = 0; i < nr; i++) {
    const radius = (i + 0.5) * dr
    for (let j = 0; j < na; j++) {
      const beta = (j + 0.5) * da,
        x = -radius * Math.cos(beta),
        z = -radius * Math.sin(beta)
      const warp = galaxyWarp(radius, beta)
      // Split at the warped mid-plane so a narrow disk cannot sit between
      // samples. Both halves end at the same declared integration boundary.
      for (const sign of [-1, 1]) {
        const extent = GALAXY_HEIGHT_PARSECS - sign * warp
        const span = Math.asinh(extent / 10)
        for (let k = 0; k < nz; k++) {
          const lo = 10 * Math.sinh((k / nz) * span),
            hi = 10 * Math.sinh(((k + 1) / nz) * span)
          const y = warp + (sign * (lo + hi)) / 2
          const sample = field.sample(
            UV.fromMeters(x * PARSEC, y * PARSEC, z * PARSEC),
          )
          const volume = radius * dr * da * (hi - lo)
          for (const name of POPULATION_NAMES)
            populations[name] += sample.populations[name] * volume
          samples++
        }
      }
    }
  }
  return {
    totalStars: Object.values(populations).reduce((a, b) => a + b, 0),
    populations,
    radiusParsecs: GALAXY_RADIUS_PARSECS,
    halfHeightParsecs: GALAXY_HEIGHT_PARSECS,
    samples,
  }
}
