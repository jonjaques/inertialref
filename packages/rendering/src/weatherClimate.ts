import { deriveSeed, type Seed } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import type { Body } from '@inertialref/universe'
import {
  type CloudGenus,
  MAX_CLOUD_LAYERS,
  type ScenarioId,
  scenarioCoverage,
  shellUnion,
  WEATHER_SCENARIOS,
  type WeatherScenario,
  wetWorld,
} from './weatherScenario.ts'
import { GENUS_TABLE } from './weatherGenus.ts'

/*
 * The weather per body: three levels, a climate that says how much of each
 * is cloud at a place under a sun, and how the texture moves. Derived from a
 * body's record and stored nowhere (rule 17): nothing here is hashed or
 * saved, and the seed is a derivation of the surface's, never a draw from
 * the body's generator, so two bodies generated in either order have one
 * weather each (rule 4).
 *
 * A regime and a climate are one type, so every reader has one path: a
 * scenario's layers are the three levels, and its pattern is the climate's
 * `sample`. `bodyWeather` is the body's own climate, and until the zonal law
 * is fitted it answers with one regime, `CLIMATE_REGIME`, on every wet body.
 */

/** A level's envelope over the datum, meters. Three levels: low, middle, high. */
export interface LevelSpec {
  readonly base: number
  readonly top: number
  /** The genus where the level is stratiform, and where it is cumuliform. */
  readonly stratiform: CloudGenus
  readonly cumuliform: CloudGenus
}

export interface ClimateSample {
  /** Each level's cloud fraction, 0..1. */
  readonly cover: readonly [number, number, number]
  /** Each level's cumuliform share, 0..1. */
  readonly convective: readonly [number, number, number]
  /** The middle level's ice share, and the deep-convection rate, 0..1. */
  readonly ice: number
  readonly deep: number
}

export interface BodyClimate {
  readonly kind: 'regime' | 'zonal' | 'measured'
  /**
   * At a body-fixed unit direction, under a body-fixed unit sun. The season
   * is the sub-solar latitude and the local solar time is the sun's
   * longitude there; neither is a calendar's. `time`, seconds from J2000,
   * is read by a regime whose pattern redraws by a period, and by nothing
   * else: a climate is a function of the place and the sun.
   */
  sample(direction: Vec3, sun: Vec3, time: number): ClimateSample
}

export interface BodyWeather {
  /** `deriveSeed(surface.seed, 'weather')`. */
  readonly seed: Seed
  /** The datum the levels stand over, meters: the body's radius. */
  readonly datumRadius: number
  readonly levels: readonly [LevelSpec, LevelSpec, LevelSpec]
  readonly climate: BodyClimate
  /** Each level's turn about the spin axis against the ground, rad/s. */
  readonly turn: readonly [number, number, number]
  /** The texture's drift along the spin axis, m/s. */
  readonly drift: number
}

/** The regime a wet body's own climate is until its zonal law is fitted. */
export const CLIMATE_REGIME: ScenarioId = 'fair-cumulus'

/** The texture's drift along the spin axis, m/s: what changes the slice of noise a level cuts. */
export const WEATHER_AXIAL_DRIFT = 0.25

/** A level no layer fills: no thickness at the union's top, as `ShellHeights` lays it out. */
function absentLevel(scenario: WeatherScenario): LevelSpec {
  const { top } = shellUnion(scenario)
  return { base: top, top, stratiform: 'stratus', cumuliform: 'stratus' }
}

function levelOf(scenario: WeatherScenario, k: number): LevelSpec {
  const layer = scenario.layers[k]
  if (layer === undefined) return absentLevel(scenario)
  // A regime's layer is one genus, so both ends of the level's blend are it.
  return {
    base: layer.base,
    top: layer.top,
    stratiform: layer.genus,
    cumuliform: layer.genus,
  }
}

function regimeClimate(scenario: WeatherScenario): BodyClimate {
  const genus = (k: number): CloudGenus | undefined => scenario.layers[k]?.genus
  const convective = (k: number): number => {
    const of = genus(k)
    return of !== undefined && GENUS_TABLE[of].cumuliform ? 1 : 0
  }
  const share: ClimateSample['convective'] = [
    convective(0),
    convective(1),
    convective(2),
  ]
  const ice = genus(1) !== undefined && GENUS_TABLE[genus(1)!].class === 'ice'
  return {
    kind: 'regime',
    sample(direction, sun, time) {
      const cover = (k: number): number =>
        scenarioCoverage(scenario, k, direction, time, sun)
      return {
        cover: [cover(0), cover(1), cover(2)],
        convective: share,
        ice: ice ? 1 : 0,
        deep: 0,
      }
    },
  }
}

/**
 * A named regime as a weather: the scenario's layers as levels, its pattern
 * as the climate. Every level turns at the regime's eastward wind over the
 * body's radius; its northward wind is not drawn.
 */
export function regimeWeather(body: Body, regime: ScenarioId): BodyWeather {
  const scenario = WEATHER_SCENARIOS[regime]
  if (scenario.layers.length > MAX_CLOUD_LAYERS)
    throw new Error(
      `weatherClimate: ${regime} has ${scenario.layers.length} layers, and a weather has ${MAX_CLOUD_LAYERS} levels`,
    )
  const rate = body.radius > 0 ? scenario.wind.east / body.radius : 0
  return {
    seed: deriveSeed(body.surface.seed, 'weather'),
    datumRadius: body.radius,
    levels: [levelOf(scenario, 0), levelOf(scenario, 1), levelOf(scenario, 2)],
    climate: regimeClimate(scenario),
    turn: [rate, rate, rate],
    drift: WEATHER_AXIAL_DRIFT,
  }
}

/** A body's own weather; null where `wetWorld` is false. Derived, stored nowhere (rule 17). */
export function bodyWeather(body: Body): BodyWeather | null {
  return wetWorld(body) ? regimeWeather(body, CLIMATE_REGIME) : null
}
