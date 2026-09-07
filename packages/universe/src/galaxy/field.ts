import { invariant, PARSEC } from '@inertialref/shared'
import {
  algorithm,
  deriveSeed,
  manifest,
  noise3,
  type Seed,
} from '@inertialref/procedural'
import { UV, type UniverseVector } from '@inertialref/spatial'
import { SUN_POSITION } from '../catalog/astrometry.ts'
import { blackbodyColour, type LinearRgb } from '../catalog/photometry.ts'
import { LOCAL_DENSITY } from '../galaxy.ts'
import { armStrength } from './arms.ts'
import { localBubbleFactor, localCloudExtinction } from './localDust.ts'
import { GALAXY_DUST, galaxyDustModulation, galaxyDustProfile } from './dust.ts'

export const GALAXY_FIELD_ALGORITHM = Object.freeze(
  algorithm('galaxy-field', 4),
)
/** Preview versions never enter GENERATION_VERSIONS until population activation. */
export const GALAXY_FIELD_VERSIONS = Object.freeze(
  manifest([GALAXY_FIELD_ALGORITHM]),
)
export const GALAXY_RADIUS_PARSECS = 30000
export const GALAXY_HEIGHT_PARSECS = 10000
export const POPULATION_NAMES = Object.freeze([
  'thinDisk',
  'thickDisk',
  'youngArms',
  'barBulge',
  'halo',
] as const)
export type GalaxyPopulation = (typeof POPULATION_NAMES)[number]
export type PopulationDensities = Readonly<Record<GalaxyPopulation, number>>

/** Mean bolometric luminosities are explicit preview assumptions, pending M6 calibration. */
export const GALAXY_POPULATIONS = Object.freeze({
  thinDisk: Object.freeze({ meanSolarLuminosities: 0.5, temperature: 5000 }),
  thickDisk: Object.freeze({ meanSolarLuminosities: 0.35, temperature: 4600 }),
  youngArms: Object.freeze({ meanSolarLuminosities: 80, temperature: 12000 }),
  barBulge: Object.freeze({ meanSolarLuminosities: 0.6, temperature: 4300 }),
  halo: Object.freeze({ meanSolarLuminosities: 0.3, temperature: 4800 }),
})
const COLOURS = POPULATION_NAMES.map((name) =>
  blackbodyColour(GALAXY_POPULATIONS[name].temperature),
)
const BAR_ANGLE = (27 * Math.PI) / 180

/** Chen et al. 2019 Table 1, all-Cepheid power-law fit, converted from kpc to pc. */
export function galaxyWarp(radiusParsecs: number, beta: number): number {
  return (
    60 *
    Math.max(0, radiusParsecs / 1000 - 7.72) ** 1.33 *
    Math.sin(beta - (17.5 * Math.PI) / 180)
  )
}

export interface GalaxySample {
  readonly populations: PopulationDensities
  readonly totalPerCubicParsec: number
  /** Bolometric power per volume in solar luminosities/pc³; RGB is an illustrative color split. */
  readonly emissionSolarPerCubicParsec: number
  readonly emissionRgb: LinearRgb
  /** Extinction coefficient in inverse parsecs at the preview RGB wavelengths. */
  readonly extinctionPerParsec: LinearRgb
  readonly dustArmStrength: number
  readonly dustModulation: number
  readonly warpParsecs: number
  readonly armStrength: number
}
export interface GalaxyField {
  readonly versions: typeof GALAXY_FIELD_VERSIONS
  readonly seed: Seed
  readonly normalization: number
  readonly dustScale: number
  readonly dustNormalization: number
  /**
   * The field at a point. `footprintParsecs` is the width of the pixel
   * asking, and zero — the default, and every canonical caller — is the
   * exact field; see `galaxyDustModulation`.
   */
  sample(position: UniverseVector, footprintParsecs?: number): GalaxySample
}

export interface GalaxyFieldOptions {
  readonly dustScale?: number
}

/** A normalized field owns only immutable parameters; sampling consumes no random stream. */
export function createGalaxyField(
  seed: Seed,
  options: GalaxyFieldOptions = {},
): GalaxyField {
  const dustScale = options.dustScale ?? 1
  invariant(
    Number.isFinite(dustScale) &&
      dustScale >= 0 &&
      dustScale <= GALAXY_DUST.maxScale,
    'Galaxy dust scale must be between 0 and 8',
  )
  const ownedSeed = Object.freeze({ ...seed })
  const textureSeed = deriveSeed(ownedSeed, 'galaxy-field:young-arms')
  const dustSeed = deriveSeed(ownedSeed, 'galaxy-field:dust')
  // Normalize the smooth warped midplane, independent of its local texture.
  const dustNormalization =
    GALAXY_DUST.solarExtinctionPerParsec /
    galaxyDustProfile(8178, 0, 0, 1).density
  const raw = (position: UniverseVector) => {
    const meters = UV.approxMeters(position)
    const x = meters.x / PARSEC,
      y = meters.y / PARSEC,
      z = meters.z / PARSEC
    const radius = Math.hypot(x, z),
      beta = Math.atan2(-z, -x)
    const warp = galaxyWarp(radius, beta)
    const height = Math.abs(y - warp)
    const arms = armStrength(radius, beta)
    // A smooth rim keeps a finite reference domain without a luminous cut edge.
    const t = Math.max(0, Math.min(1, (GALAXY_RADIUS_PARSECS - radius) / 4000))
    const edge = t * t * (3 - 2 * t)
    const radial = Math.exp((8178 - radius) / 2600) * edge
    const along = -x * Math.cos(BAR_ANGLE) - z * Math.sin(BAR_ANGLE)
    const across = x * Math.sin(BAR_ANGLE) - z * Math.cos(BAR_ANGLE)
    const box = ((along / 1500) ** 4 + (across / 750) ** 4) ** 0.25
    const spheroid = Math.hypot(radius, y / 0.6)
    const populations = {
      thinDisk: radial * Math.exp(-height / 300) * (1 + 0.2 * arms),
      thickDisk:
        0.04 *
        Math.exp((8178 - radius) / 2000) *
        Math.exp(-height / 900) *
        edge,
      youngArms:
        0.003 *
        radial *
        Math.exp(-height / 19) *
        arms *
        (1 + 0.2 * noise3(textureSeed, x / 350, y / 350, z / 350)),
      barBulge:
        90 *
        Math.exp(-box - Math.abs(y) / 390) *
        Math.exp(-((radius / 5000) ** 4)),
      halo: 0.001 * ((1 + spheroid / 1000) / (1 + 8178 / 1000)) ** -3.5 * edge,
    }
    return { populations, warp, arms, x, y, z, radius, beta, height, edge }
  }
  const sun = raw(SUN_POSITION)
  const normalization =
    (LOCAL_DENSITY * PARSEC ** 3) /
    Object.values(sun.populations).reduce((a, b) => a + b, 0)
  return Object.freeze({
    versions: GALAXY_FIELD_VERSIONS,
    seed: ownedSeed,
    normalization,
    dustScale,
    dustNormalization,
    sample(position: UniverseVector, footprintParsecs = 0): GalaxySample {
      const {
        populations: rawPopulations,
        warp,
        arms,
        x,
        y,
        z,
        radius,
        beta,
        height,
        edge,
      } = raw(position)
      const dust = galaxyDustProfile(radius, beta, height, edge)
      const dustModulation =
        dustScale === 0
          ? 1
          : galaxyDustModulation(dustSeed, x, y, z, footprintParsecs)
      const extinction =
        dustScale *
        (dustNormalization *
          dust.density *
          dustModulation *
          localBubbleFactor(x, y, z) +
          localCloudExtinction(x, y, z))
      const populations = {} as Record<GalaxyPopulation, number>
      let total = 0,
        emission = 0,
        r = 0,
        g = 0,
        b = 0
      for (let i = 0; i < POPULATION_NAMES.length; i++) {
        const name = POPULATION_NAMES[i]!
        const density = rawPopulations[name] * normalization
        populations[name] = density
        total += density
        const light = density * GALAXY_POPULATIONS[name].meanSolarLuminosities
        emission += light
        const colour = COLOURS[i]!
        // Normalize the three channels to conserve the stated bolometric power.
        const sum = colour.r + colour.g + colour.b
        r += (light * colour.r) / sum
        g += (light * colour.g) / sum
        b += (light * colour.b) / sum
      }
      return {
        populations,
        totalPerCubicParsec: total,
        emissionSolarPerCubicParsec: emission,
        emissionRgb: { r, g, b },
        extinctionPerParsec: {
          r: extinction * GALAXY_DUST.extinctionRgb.r,
          g: extinction * GALAXY_DUST.extinctionRgb.g,
          b: extinction * GALAXY_DUST.extinctionRgb.b,
        },
        dustArmStrength: dust.arms,
        dustModulation,
        warpParsecs: warp,
        armStrength: arms,
      }
    },
  })
}
