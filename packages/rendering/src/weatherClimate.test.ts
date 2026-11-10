import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { deriveSeed, rootSeed } from '@inertialref/procedural'
import type { Vec3 } from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import {
  bodyWeather,
  CLIMATE_REGIME,
  regimeWeather,
  WEATHER_AXIAL_DRIFT,
} from './weatherClimate.ts'
import {
  MAX_CLOUD_LAYERS,
  SCENARIO_IDS,
  scenarioCoverage,
  shellUnion,
  WEATHER_SCENARIOS,
  wetWorld,
} from './weatherScenario.ts'

/*
 * The weather per body, as far as a regime carries it: a scenario's layers
 * are the three levels and its pattern is the climate's sample, on real
 * records from the universe seed, as the scenario's own test builds them.
 */

const ROOT = rootSeed('inertialref')
const GALAXY = galaxySeedOf(ROOT, MILKY_WAY)

function system(id: string): readonly Body[] {
  const stub = resolveSystem(GALAXY, SOL_ONLY_CATALOG, systemId(id))
  if (stub === undefined) throw new Error(`no system ${id}`)
  return [...walkBodies(generateSystem(ROOT, MILKY_WAY, stub))]
}

function body(bodies: readonly Body[], address: string): Body {
  const found = bodies.find((one) => formatAddress(one.address) === address)
  if (found === undefined) throw new Error(`no body ${address}`)
  return found
}

const sol = system('SOL')
const farShore = system('P222_1_0_9')
const earth = body(sol, 'g:milky-way/s:SOL/b:2')
const shore = body(farShore, 'g:milky-way/s:P222_1_0_9/b:4')

const unit = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: 0, max: 2 * Math.PI, noNaN: true }),
  )
  .map(([y, longitude]): Vec3 => {
    const ring = Math.sqrt(1 - y * y)
    return { x: ring * Math.cos(longitude), y, z: ring * Math.sin(longitude) }
  })

describe('a regime as a weather', () => {
  it.each(SCENARIO_IDS)('%s: its layers are the levels', (id) => {
    const scenario = WEATHER_SCENARIOS[id]
    const weather = regimeWeather(shore, id)
    const { top } = shellUnion(scenario)
    expect(weather.levels).toHaveLength(MAX_CLOUD_LAYERS)
    weather.levels.forEach((level, k) => {
      const layer = scenario.layers[k]
      if (layer === undefined) {
        // An absent level has no thickness, at the union's top.
        expect([level.base, level.top]).toEqual([top, top])
        return
      }
      expect([level.base, level.top]).toEqual([layer.base, layer.top])
      expect(level.stratiform).toBe(layer.genus)
      expect(level.cumuliform).toBe(layer.genus)
    })
    expect(weather.climate.kind).toBe('regime')
    expect(weather.datumRadius).toBe(shore.radius)
  })

  it.each(SCENARIO_IDS)(
    '%s: its pattern is the climate, at any place, sun and instant',
    (id) => {
      const scenario = WEATHER_SCENARIOS[id]
      const { climate } = regimeWeather(shore, id)
      fc.assert(
        fc.property(
          unit,
          unit,
          fc.double({ min: -3.2e8, max: 3.2e8, noNaN: true }),
          (direction, sun, time) => {
            const sample = climate.sample(direction, sun, time)
            for (let k = 0; k < MAX_CLOUD_LAYERS; k += 1)
              expect(sample.cover[k]).toBe(
                scenarioCoverage(scenario, k, direction, time, sun),
              )
          },
        ),
        { numRuns: 200 },
      )
    },
  )

  it('reads a cumuliform layer as convective, cirrus in the middle as ice, and no deep convection', () => {
    const at = (id: (typeof SCENARIO_IDS)[number]) =>
      regimeWeather(shore, id).climate.sample(
        { x: 0, y: 1, z: 0 },
        { x: 1, y: 0, z: 0 },
        0,
      )
    expect(at('fair-cumulus').convective).toEqual([1, 0, 0])
    expect(at('overcast').convective).toEqual([0, 0, 0])
    // Cumulus under cirrus: the low level convective, the level over it ice.
    const layered = at('cirrus-over-cumulus')
    expect(layered.convective).toEqual([1, 0, 0])
    expect(layered.ice).toBe(1)
    expect(at('fair-cumulus').ice).toBe(0)
    for (const id of SCENARIO_IDS) expect(at(id).deep).toBe(0)
  })

  it('turns every level at the regime’s eastward wind over the body’s radius, and drifts along the axis', () => {
    for (const id of SCENARIO_IDS) {
      const weather = regimeWeather(earth, id)
      const rate = WEATHER_SCENARIOS[id].wind.east / earth.radius
      expect(weather.turn).toEqual([rate, rate, rate])
      expect(weather.drift).toBe(WEATHER_AXIAL_DRIFT)
    }
  })
})

describe('a body’s own weather', () => {
  it('is null on a dry world and on one whose air is already a deck', () => {
    for (const one of [...sol, ...farShore])
      expect(bodyWeather(one) === null, formatAddress(one.address)).toBe(
        !wetWorld(one),
      )
    expect(bodyWeather(body(sol, 'g:milky-way/s:SOL/b:3'))).toBeNull()
  })

  it('takes its seed from the surface’s, by a label, and from nothing else', () => {
    for (const one of [earth, shore]) {
      const weather = bodyWeather(one)!
      expect(weather.seed).toEqual(deriveSeed(one.surface.seed, 'weather'))
    }
    // A derivation, never a draw: a system generated again, and its bodies
    // asked in the other order, give each body the weather it had (rule 4).
    const again = system('P222_1_0_9')
    const seeds = (bodies: readonly Body[]) =>
      new Map(
        bodies.map((one) => [
          formatAddress(one.address),
          bodyWeather(one)?.seed ?? null,
        ]),
      )
    expect(seeds([...again].reverse())).toEqual(seeds(farShore))
    expect(bodyWeather(earth)!.seed).not.toEqual(bodyWeather(shore)!.seed)
  })

  it('is one regime on every wet body: the climate’s stand-in', () => {
    for (const one of [earth, shore]) {
      const own = bodyWeather(one)!
      const held = regimeWeather(one, CLIMATE_REGIME)
      expect(own.levels).toEqual(held.levels)
      expect(own.turn).toEqual(held.turn)
      expect(own.climate.kind).toBe('regime')
      const direction = { x: 0.6, y: 0.48, z: 0.64 }
      const sun = { x: 0, y: 0, z: 1 }
      expect(own.climate.sample(direction, sun, 7200)).toEqual(
        held.climate.sample(direction, sun, 7200),
      )
    }
  })
})
