import type { Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import { aerosolDepthOf } from './atmosphere.ts'

/*
 * The placeholder weather: analytic scenarios the cloud passes draw through
 * the real recipe — the maps' coverage, a genus's height profile, eroded
 * noise — before any climatology exists. Presentation only: nothing here is
 * stored, hashed or saved, and a scenario is chosen by a lever, never by a
 * body's record (rule 17).
 *
 * The σ values are the plan's §5.1 table divided down to 1/m, with round
 * placements. They are uncalibrated on purpose — phase 0 measures what the
 * passes cost, not how a cloud looks — and the measurement batches name
 * these scenarios, so a value here changes only with them.
 */

/** What a placeholder layer can be: each a height profile and an extinction. */
export const CLOUD_GENERA = [
  'stratus',
  'stratocumulus',
  'cumulus',
  'altocumulus',
  'cirrus',
  'cumulonimbus',
  'fog',
] as const
export type CloudGenus = (typeof CLOUD_GENERA)[number]

/** One shell over the datum, and what fills it. Meters, per meter, micrometers. */
export interface CloudLayerSpec {
  readonly genus: CloudGenus
  /** Over the datum, meters; base < top. */
  readonly base: number
  readonly top: number
  /** Mean column cloud fraction the maps carry, 0..1. */
  readonly coverage: number
  /** In-cloud extinction at full density, 1/m (plan §5.1's km⁻¹ ÷ 1000). */
  readonly sigma: number
  /** One Worley cell of the base noise, meters. */
  readonly cellMeters: number
  /** How far the detail noise eats the edge, 0..1. */
  readonly erosion: number
  /** Effective droplet radius, µm: the phase table's row. */
  readonly radius: number
}

export const SCENARIO_IDS = [
  'fair-cumulus',
  'broken-horizon',
  'inside',
  'two-decks',
  'near-gap-far',
  'cirrus-over-cumulus',
  'anvil',
  'overcast',
  'fog',
] as const
export type ScenarioId = (typeof SCENARIO_IDS)[number]

export interface WeatherScenario {
  readonly id: ScenarioId
  /** At most `MAX_CLOUD_LAYERS`, sorted by base, disjoint. */
  readonly layers: readonly CloudLayerSpec[]
  /** A uniform placeholder wind at the eye, m/s. */
  readonly wind: { readonly east: number; readonly north: number }
  /** How coverage varies over the body. */
  readonly pattern: 'uniform' | 'bands' | 'blobs'
  /** Angular size of a band or a blob, radians; 0 for a uniform pattern. */
  readonly patternScale: number
  /** Seconds a blob's cell holds one draw before it draws again; 0 for never. */
  readonly patternPeriod: number
}

/** The layers a frame carries: three shells' boundaries, six uniforms a body. */
export const MAX_CLOUD_LAYERS = 3

const cumulus = (
  base: number,
  top: number,
  coverage: number,
  sigma: number,
  cellMeters: number,
  erosion: number,
  radius: number,
): CloudLayerSpec => ({
  genus: 'cumulus',
  base,
  top,
  coverage,
  sigma,
  cellMeters,
  erosion,
  radius,
})

export const WEATHER_SCENARIOS: Readonly<Record<ScenarioId, WeatherScenario>> =
  {
    'fair-cumulus': {
      id: 'fair-cumulus',
      layers: [cumulus(1000, 2400, 0.35, 0.068, 1200, 0.6, 8)],
      wind: { east: 8, north: 2 },
      pattern: 'blobs',
      patternScale: 0.02,
      patternPeriod: 3600,
    },
    'broken-horizon': {
      id: 'broken-horizon',
      layers: [cumulus(900, 2200, 0.5, 0.052, 1500, 0.5, 10)],
      wind: { east: 10, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    inside: {
      id: 'inside',
      layers: [
        {
          genus: 'stratocumulus',
          base: 800,
          top: 1800,
          coverage: 1,
          sigma: 0.035,
          cellMeters: 2000,
          erosion: 0.3,
          radius: 10,
        },
      ],
      wind: { east: 5, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'two-decks': {
      id: 'two-decks',
      layers: [
        {
          genus: 'stratocumulus',
          base: 1000,
          top: 1500,
          coverage: 0.6,
          sigma: 0.035,
          cellMeters: 1800,
          erosion: 0.4,
          radius: 10,
        },
        {
          genus: 'altocumulus',
          base: 4000,
          top: 4800,
          coverage: 0.6,
          sigma: 0.04,
          cellMeters: 1000,
          erosion: 0.5,
          radius: 7,
        },
      ],
      wind: { east: 8, north: 4 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'near-gap-far': {
      id: 'near-gap-far',
      layers: [cumulus(1000, 2400, 0.5, 0.068, 1200, 0.6, 8)],
      wind: { east: 8, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    'cirrus-over-cumulus': {
      id: 'cirrus-over-cumulus',
      layers: [
        cumulus(1000, 2400, 0.35, 0.068, 1200, 0.6, 8),
        {
          genus: 'cirrus',
          base: 9000,
          top: 10000,
          coverage: 0.5,
          sigma: 0.0002,
          cellMeters: 5000,
          erosion: 0.3,
          radius: 32,
        },
      ],
      wind: { east: 12, north: 0 },
      pattern: 'bands',
      patternScale: 0.05,
      patternPeriod: 0,
    },
    anvil: {
      id: 'anvil',
      layers: [
        {
          genus: 'cumulonimbus',
          base: 1000,
          top: 15000,
          coverage: 0.25,
          sigma: 0.093,
          cellMeters: 8000,
          erosion: 0.4,
          radius: 12,
        },
      ],
      wind: { east: 6, north: 0 },
      pattern: 'blobs',
      patternScale: 0.05,
      patternPeriod: 7200,
    },
    overcast: {
      id: 'overcast',
      layers: [
        {
          genus: 'stratus',
          base: 300,
          top: 1000,
          coverage: 1,
          sigma: 0.057,
          cellMeters: 3000,
          erosion: 0.2,
          radius: 8,
        },
      ],
      wind: { east: 4, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
    fog: {
      id: 'fog',
      layers: [
        {
          genus: 'fog',
          base: 0,
          top: 150,
          coverage: 1,
          sigma: 0.0081,
          cellMeters: 500,
          erosion: 0.2,
          radius: 6,
        },
      ],
      wind: { east: 1, north: 0 },
      pattern: 'uniform',
      patternScale: 0,
      patternPeriod: 0,
    },
  }

/**
 * The coverage the maps hold for `layer` at a body-fixed unit direction, at
 * presentation time `t`: the CPU reference of the maps' bake. Blob cells hash
 * (cell, periodIndex) with pcg4d against a u32 threshold (rule 58).
 *
 * Here the layer's mean coverage everywhere, which is what a uniform pattern
 * draws.
 */
export function scenarioCoverage(
  s: WeatherScenario,
  layer: number,
  _direction: Vec3,
  _t: number,
): number {
  return s.layers[layer]?.coverage ?? 0
}

/**
 * The genus's density profile over a layer, `h01` = 0 at its base and 1 at
 * its top: continuous, 0 outside (0, 1), peak 1. The CPU reference of the
 * profile table.
 *
 * Here a box: the layer's whole height at full density.
 */
export function genusProfile(_genus: CloudGenus, h01: number): number {
  return h01 > 0 && h01 < 1 ? 1 : 0
}

/** The lowest base and highest top, meters over the datum. */
export function shellUnion(s: WeatherScenario): {
  readonly base: number
  readonly top: number
} {
  if (s.layers.length === 0) return { base: 0, top: 0 }
  let base = Infinity
  let top = -Infinity
  for (const layer of s.layers) {
    base = Math.min(base, layer.base)
    top = Math.max(top, layer.top)
  }
  return { base, top }
}

/**
 * Drawn with weather by default: a standing sea of water under an air whose
 * aerosol is a haze, not a deck. Derived; stored nowhere (rule 17).
 *
 * The aerosol bound is the line between a haze and a deck. A sulfuric
 * family's air (τ 8) and Titan's (τ 4.3) already are a cloud the air's tables
 * draw, and a volume over them counts the cloud twice; dust (0.4) and violet
 * (0.25) are hazes. The depth is the one the air's recipe draws
 * (`aerosolDepthOf`), so an unauthored haze thicker than 1/0.12 is a deck
 * here as it is in the sky.
 */
export function wetWorld(body: Body): boolean {
  const haze = body.appearance.haze
  return (
    body.surface.seaLevel !== null &&
    body.surface.grammar.liquidKind === 'water' &&
    (haze === null || aerosolDepthOf(haze) < 1)
  )
}
