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
  CLIMATE_WINDS,
  EARTH_SIDEREAL_DAY,
  EARTH_ZONAL_LAW,
  hadleyEdge,
  HADLEY_EDGE_RANGE,
  LEVEL_HEIGHTS,
  type ClimateCoefficients,
  regimeWeather,
  synopticFactor,
  turnAngle,
  WEATHER_AXIAL_DRIFT,
  zonalClimate,
  zonalLaw,
} from './weatherClimate.ts'
import {
  blobCells,
  MAX_CLOUD_LAYERS,
  SCENARIO_IDS,
  scenarioCoverage,
  shellUnion,
  WEATHER_SCENARIOS,
  type WeatherScenario,
  wetWorld,
} from './weatherScenario.ts'

/**
 * A number in [min, max]: three draws in four uniform in value, one from
 * `fc.double`. A double alone is drawn over float64's bit patterns, so most
 * of its draws are within a few powers of two of zero: an instant of
 * 10⁻²⁰⁰ s, a longitude of 10⁻⁹⁰ rad, under which a drift or a turn cannot
 * show a defect. The double's draws are kept for the edges it finds.
 */
const between = (min: number, max: number) =>
  fc.oneof(
    {
      weight: 3,
      arbitrary: fc
        .noBias(fc.integer({ min: 0, max: 2 ** 30 }))
        .map((i) => min + ((max - min) * i) / 2 ** 30),
    },
    { weight: 1, arbitrary: fc.double({ min, max, noNaN: true }) },
  )

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
/** The cornerstones' world, G1 to G6 (phase 1 design §3.3). */
const cornerstones = body(system('P222_3_2_k'), 'g:milky-way/s:P222_3_2_k/b:3')
const DEG = Math.PI / 180

const unit = fc
  .tuple(between(-1, 1), between(0, 2 * Math.PI))
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
    '%s: its pattern is the climate, blobs read as the layer’s cover, at any place, sun and instant',
    (id) => {
      const scenario = WEATHER_SCENARIOS[id]
      const uniform: WeatherScenario = {
        ...scenario,
        pattern: 'uniform',
        patternScale: 0,
        patternPeriod: 0,
      }
      const drawn = scenario.pattern === 'blobs' ? uniform : scenario
      const { climate } = regimeWeather(shore, id)
      fc.assert(
        fc.property(
          unit,
          unit,
          between(-3.2e8, 3.2e8),
          (direction, sun, time) => {
            const sample = climate.sample(direction, sun, time)
            for (let k = 0; k < MAX_CLOUD_LAYERS; k += 1)
              expect(sample.cover[k]).toBe(
                scenarioCoverage(drawn, k, direction, time, sun),
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

  it('stands its levels on its air’s scale height, blends each level’s two genera, and turns them at 8, 15 and 25 m/s', () => {
    const weather = bodyWeather(earth)!
    const height = earth.atmosphere!.scaleHeight
    expect(height).toBe(8500)
    // §5.3: 0.7–2.6, 3.4–6.0 and 8.1–11.1 km on Earth.
    expect(weather.levels).toEqual([
      {
        base: 680,
        top: 2550,
        stratiform: 'stratocumulus',
        cumuliform: 'cumulus',
      },
      {
        base: 3400,
        top: 5950,
        stratiform: 'altostratus',
        cumuliform: 'altocumulus',
      },
      { base: 8075, top: 11050, stratiform: 'cirrus', cumuliform: 'cirrus' },
    ])
    LEVEL_HEIGHTS.forEach(([low, high], k) => {
      expect(weather.levels[k]!.base).toBeCloseTo(low * height, 9)
      expect(weather.levels[k]!.top).toBeCloseTo(high * height, 9)
    })
    expect(weather.climate.kind).toBe('zonal')
    expect(weather.turn).toEqual(
      CLIMATE_WINDS.map((wind) => wind / earth.radius),
    )
    expect(weather.drift).toBe(WEATHER_AXIAL_DRIFT)
    expect(bodyWeather(shore)!.levels[0]!.base).toBeCloseTo(
      0.08 * shore.atmosphere!.scaleHeight,
      9,
    )
  })

  it('samples as a function of its arguments alone, from two weathers built in either order', () => {
    const first = [bodyWeather(earth)!, bodyWeather(shore)!]
    const second = [bodyWeather(shore)!, bodyWeather(earth)!].reverse()
    fc.assert(
      fc.property(
        unit,
        unit,
        between(-3.2e8, 3.2e8),
        (direction, sun, time) => {
          for (let b = 0; b < 2; b += 1) {
            const a = first[b]!.climate.sample(direction, sun, time)
            expect(second[b]!.climate.sample(direction, sun, time)).toEqual(a)
            expect(first[b]!.climate.sample(direction, sun, time)).toEqual(a)
            for (const value of [...a.cover, ...a.convective]) {
              expect(value).toBeGreaterThanOrEqual(0)
              expect(value).toBeLessThanOrEqual(1)
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* The zonal law                                                              */
/* ------------------------------------------------------------------------- */

/** The total cover of three levels overlapped at random (plan §3). */
const total = (cover: readonly number[]): number =>
  1 - cover.reduce((clear, c) => clear * (1 - Math.min(1, Math.max(0, c))), 1)

/** The area-weighted mean over latitude of the law's total at an equinox, by 0.1° bands. */
function globalMean(law = EARTH_ZONAL_LAW): number {
  let sum = 0
  let weight = 0
  for (let i = 0; i < 1800; i += 1) {
    const latitude = (-90 + (i + 0.5) / 10) * DEG
    sum += total(zonalClimate(law, latitude, 0).cover) * Math.cos(latitude)
    weight += Math.cos(latitude)
  }
  return sum / weight
}

describe('the zonal law', () => {
  it('meets the targets it was fitted to on Earth at an equinox, inside the plan’s measured ranges', () => {
    const mean = globalMean()
    const offset = (degrees: number) =>
      total(zonalClimate(EARTH_ZONAL_LAW, degrees * DEG, 0).cover) - mean
    // The fit's four targets, each to its fourth digit.
    expect(mean).toBeCloseTo(0.675, 3)
    expect(offset(0)).toBeCloseTo(0.1, 3)
    expect(offset(20)).toBeCloseTo(-0.125, 3)
    expect(offset(60)).toBeCloseTo(0.2, 3)
    // The plan's: global 0.67–0.68; 0.10 under at 20°N, 0.15 under at 20°S,
    // each held here by the hemispheres' mean; 0.15–0.25 over at 60°S.
    expect(mean).toBeGreaterThanOrEqual(0.67)
    expect(mean).toBeLessThanOrEqual(0.68)
    expect(offset(-60)).toBeGreaterThanOrEqual(0.15)
    expect(offset(-60)).toBeLessThanOrEqual(0.25)
    expect((offset(20) + offset(-20)) / 2).toBeCloseTo(-0.125, 3)
    // Every amplitude is positive: a dry belt dries and a storm track clouds.
    for (const term of ['base', 'itcz', 'dry', 'storm'] as const)
      for (const value of EARTH_ZONAL_LAW[term])
        expect(value).toBeGreaterThan(0)
  })

  it('moves the convergence zone with the sun, by ι of the sub-solar latitude', () => {
    fc.assert(
      fc.property(between(-30, 30), (degrees) => {
        const subsolar = degrees * DEG
        const zone = EARTH_ZONAL_LAW.follow * subsolar
        const at = (latitude: number) =>
          zonalClimate(EARTH_ZONAL_LAW, latitude, subsolar).convective[0]
        // The low level's share saturates over the zone's core; its edges,
        // where it falls through one half, stand symmetric about the zone.
        const half = (sign: number) => {
          let low = zone
          let high = zone + sign * 40 * DEG
          for (let i = 0; i < 60; i += 1) {
            const mid = (low + high) / 2
            if (at(mid) > 0.5) low = mid
            else high = mid
          }
          return (low + high) / 2
        }
        expect((half(1) + half(-1)) / 2).toBeCloseTo(zone, 9)
      }),
      { numRuns: 50 },
    )
  })

  it('stands the Hadley edge at 30° on Earth and widens it as a body turns slower, inside 12° to 80°', () => {
    expect(hadleyEdge(EARTH_SIDEREAL_DAY)).toBeCloseTo(30 * DEG, 12)
    expect(zonalLaw(earth).hadley).toBeCloseTo(30 * DEG, 3)
    // The cornerstones' world turns in 30.19 hours: its edge is 37.8°.
    expect(zonalLaw(cornerstones).hadley / DEG).toBeCloseTo(37.84, 2)
    expect(
      zonalLaw(cornerstones).storms - zonalLaw(cornerstones).hadley,
    ).toBeCloseTo(20 * DEG, 15)
    fc.assert(
      fc.property(between(1e3, 1e8), between(1e3, 1e8), (a, b) => {
        const [fast, slow] = a < b ? [a, b] : [b, a]
        expect(hadleyEdge(slow)).toBeGreaterThanOrEqual(hadleyEdge(fast))
        expect(hadleyEdge(-slow)).toBe(hadleyEdge(slow))
        expect(hadleyEdge(fast)).toBeGreaterThanOrEqual(HADLEY_EDGE_RANGE[0])
        expect(hadleyEdge(slow)).toBeLessThanOrEqual(HADLEY_EDGE_RANGE[1])
      }),
    )
  })

  it('multiplies the law by a synoptic field a quarter either side of one, whose zonal mean is one', () => {
    const radius = earth.radius
    let sum = 0
    let count = 0
    let low = Infinity
    let high = -Infinity
    for (let i = 0; i < 40; i += 1)
      for (let j = 0; j < 400; j += 1) {
        const latitude = (-78 + (i + 0.5) * 3.9) * DEG
        const longitude = (2 * Math.PI * j) / 400
        const factor = synopticFactor(
          {
            x: Math.cos(latitude) * Math.cos(longitude),
            y: Math.sin(latitude),
            z: -Math.cos(latitude) * Math.sin(longitude),
          },
          radius,
          0,
        )
        low = Math.min(low, factor)
        high = Math.max(high, factor)
        sum += factor * Math.cos(latitude)
        count += Math.cos(latitude)
      }
    expect(low).toBeGreaterThanOrEqual(0.75)
    expect(high).toBeLessThanOrEqual(1.25)
    // Measured over Earth at 16,000 places: 0.9966. The base noise is spread
    // to near uniform on [0, 1], so its mean is near a half; the bound is
    // the measurement and a hundredth.
    expect(Math.abs(sum / count - 1)).toBeLessThan(0.01)
  })

  it('turns the synoptic field with the low level, and reads no other clock', () => {
    const weather = bodyWeather(earth)!
    const direction = { x: 0.6, y: 0.48, z: 0.64 }
    const sun = { x: 0, y: 0, z: 1 }
    const hour = 3600
    const angle = turnAngle(weather.turn[0], hour)
    // At an hour, the field reads where the turn has carried the place from.
    expect(synopticFactor(direction, earth.radius, angle)).toBe(
      synopticFactor(
        {
          x: Math.cos(angle) * direction.x - Math.sin(angle) * direction.z,
          y: direction.y,
          z: Math.sin(angle) * direction.x + Math.cos(angle) * direction.z,
        },
        earth.radius,
        0,
      ),
    )
    const now = weather.climate.sample(direction, sun, hour)
    expect(weather.climate.sample(direction, sun, hour)).toEqual(now)
    expect(weather.climate.sample(direction, sun, hour + 1e5)).not.toEqual(now)
  })
})

/* ------------------------------------------------------------------------- */
/* No lattice, and a regime's cover at a stance                               */
/* ------------------------------------------------------------------------- */

/**
 * The amplitude of a cover's strongest line within 5% of `cycles` a turn,
 * along the circle of G1's latitude, 8,192 places: `2|Σ x·e^(−iωn)|/N`.
 */
function lineAt(cover: (direction: Vec3) => number, cycles: number): number {
  const count = 8192
  const latitude = -0.2906
  const values = Array.from({ length: count }, (_, n) => {
    const longitude = (2 * Math.PI * n) / count
    return cover({
      x: Math.cos(latitude) * Math.cos(longitude),
      y: Math.sin(latitude),
      z: -Math.cos(latitude) * Math.sin(longitude),
    })
  })
  let line = 0
  for (
    let k = Math.floor(cycles * 0.95);
    k <= Math.ceil(cycles * 1.05);
    k += 1
  ) {
    let re = 0
    let im = 0
    values.forEach((x, n) => {
      const phase = (2 * Math.PI * k * n) / count
      re += x * Math.cos(phase)
      im -= x * Math.sin(phase)
    })
    line = Math.max(line, (2 * Math.hypot(re, im)) / count)
  }
  return line
}

/**
 * The most cover a lattice may put at the cube's cell frequency. The
 * largest measured on any climate is Earth's zonal law at 128 cycles a
 * turn, 8.8 × 10⁻⁴, the synoptic field's own spectrum there; phase 0's
 * blobs put 0.27 at fair-cumulus's 256 and 0.15 at the anvil's 128.
 */
const LATTICE_LINE = 0.005

describe('the cover from orbit', () => {
  // A sun under G1's horizon, so the dusk deck's edge holds it whole.
  const sun = { x: 0, y: 1, z: 0 }
  /** Cells a turn of the circle: four equatorial faces of the pattern's grid. */
  const cycles = (id: (typeof SCENARIO_IDS)[number]) =>
    4 * blobCells(WEATHER_SCENARIOS[id].patternScale || 0.02)

  it.each(SCENARIO_IDS)('%s: no line at the cube cell’s frequency', (id) => {
    const { climate } = regimeWeather(cornerstones, id)
    for (let k = 0; k < WEATHER_SCENARIOS[id].layers.length; k += 1)
      expect(
        lineAt((d) => climate.sample(d, sun, 0).cover[k]!, cycles(id)),
      ).toBeLessThan(LATTICE_LINE)
  })

  it('finds the line phase 0’s blobs drew, so the bound can fail', () => {
    for (const id of ['fair-cumulus', 'anvil'] as const)
      expect(
        lineAt(
          (d) => scenarioCoverage(WEATHER_SCENARIOS[id], 0, d, 0, sun),
          cycles(id),
        ),
      ).toBeGreaterThan(20 * LATTICE_LINE)
  })

  it('draws no line on a world’s own climate either, at either grid', () => {
    for (const one of [earth, cornerstones]) {
      const { climate } = bodyWeather(one)!
      for (const grid of [128, 256])
        for (let k = 0; k < 3; k += 1)
          expect(
            lineAt(
              (d) => climate.sample(d, { x: 1, y: 0, z: 0 }, 0).cover[k]!,
              grid,
            ),
          ).toBeLessThan(LATTICE_LINE)
    }
  })

  it.each(SCENARIO_IDS)(
    '%s: over 20 km about G1, the regime’s cover, not 0 or 1 by a cell',
    (id) => {
      const scenario = WEATHER_SCENARIOS[id]
      const { climate } = regimeWeather(cornerstones, id)
      const latitude = -0.29062177877890516
      const longitude = 0.6500744120490799
      const radius = cornerstones.radius
      for (let k = 0; k < scenario.layers.length; k += 1) {
        let low = Infinity
        let high = -Infinity
        for (let i = -10; i <= 10; i += 1)
          for (let j = -10; j <= 10; j += 1) {
            const north = latitude + (i * 1000) / radius
            const east = longitude + (j * 1000) / radius / Math.cos(latitude)
            const cover = climate.sample(
              {
                x: Math.cos(north) * Math.cos(east),
                y: Math.sin(north),
                z: -Math.cos(north) * Math.sin(east),
              },
              sun,
              0,
            ).cover[k]!
            low = Math.min(low, cover)
            high = Math.max(high, cover)
          }
        if (scenario.pattern === 'bands') {
          // Cirrus over cumulus bands its cover by latitude, 196 km a band
          // here: 20 km of it moves the cover by under a fifth.
          expect(high - low).toBeLessThan(0.2)
        } else {
          expect(low).toBe(scenario.layers[k]!.coverage)
          expect(high).toBe(low)
        }
      }
    },
  )
})

/* ------------------------------------------------------------------------- */
/* The climate as the frame's uniforms                                        */
/* ------------------------------------------------------------------------- */

/**
 * A climate's coefficients evaluated as the GPU's port of `sample` will
 * read them, from the numbers alone: the law unpacked by its documented
 * layout, a regime's pattern by its kind. The synoptic factor is the one
 * term not in the numbers: the GPU reads it from its noise and the low
 * level's turn, as `synopticFactor` does.
 */
function fromCoefficients(
  data: ClimateCoefficients,
  direction: Vec3,
  sun: Vec3,
  synoptic: number,
): { readonly cover: number[]; readonly convective: number[] } {
  const clamp = (x: number) => Math.min(1, Math.max(0, x))
  const latitude = Math.asin(Math.min(1, Math.max(-1, direction.y)))
  if (data.kind === 'zonal') {
    const law = data.law
    const [zone, hadley, storms, width] = law.slice(12) as [
      number,
      number,
      number,
      number,
    ]
    const g = (x: number) => Math.exp((-0.5 * x * x) / (width * width))
    const levels = [0, 1, 2]
    return {
      cover: levels.map((k) =>
        clamp(
          (law[4 * k]! +
            law[4 * k + 1]! * g(latitude - zone) -
            law[4 * k + 2]! * (g(latitude - hadley) + g(latitude + hadley)) +
            law[4 * k + 3]! * (g(latitude - storms) + g(latitude + storms))) *
            synoptic,
        ),
      ),
      convective: levels.map((k) =>
        clamp(data.convective[k]! * g(latitude - zone)),
      ),
    }
  }
  expect(data.pattern).not.toBe('blobs')
  const up = direction.x * sun.x + direction.y * sun.y + direction.z * sun.z
  const [full, clear] = data.terminator
  const t = clamp((up - full) / (clear - full))
  const share = 1 - t * t * (3 - 2 * t)
  const band = (c: number) => {
    if (data.pattern !== 'bands' || !(data.patternScale > 0)) return c
    const swing = c <= 0.5 ? 1 : (1 - c) / c
    return c * (1 + swing * Math.cos((Math.PI * latitude) / data.patternScale))
  }
  return {
    cover: data.cover.map((c) => share * band(c)),
    convective: [...data.convective],
  }
}

describe('the climate as the frame’s uniforms', () => {
  const instants = [0, 7_200, 98_977.5, 1.17e8]
  const suns = [-23.4, 0, 15].map((degrees) => ({
    x: Math.cos(degrees * DEG),
    y: Math.sin(degrees * DEG),
    z: 0,
  }))
  const places = Array.from({ length: 17 }, (_, i) => (i - 8) * 10).flatMap(
    (latitude) =>
      [0, 1.3, 2.9, 4.4].map((longitude) => ({
        x: Math.cos(latitude * DEG) * Math.cos(longitude),
        y: Math.sin(latitude * DEG),
        z: -Math.cos(latitude * DEG) * Math.sin(longitude),
      })),
  )

  it('lays a world’s law out as documented and reproduces its sample at every latitude, season and instant', () => {
    for (const one of [earth, cornerstones]) {
      const weather = bodyWeather(one)!
      const law = zonalLaw(one)
      for (const sun of suns)
        for (const time of instants) {
          const data = weather.climate.coefficients(sun, time)
          expect(data.kind).toBe('zonal')
          expect(data.law).toHaveLength(16)
          const shared = [
            law.follow * Math.asin(sun.y),
            law.hadley,
            law.storms,
            law.width,
          ]
          data.law
            .slice(12)
            .forEach((value, i) => expect(value).toBeCloseTo(shared[i]!, 14))
          const angle = turnAngle(weather.turn[0], time)
          for (const direction of places) {
            const want = weather.climate.sample(direction, sun, time)
            const got = fromCoefficients(
              data,
              direction,
              sun,
              synopticFactor(direction, one.radius, angle),
            )
            for (let k = 0; k < 3; k += 1) {
              expect(got.cover[k]).toBeCloseTo(want.cover[k]!, 12)
              expect(got.convective[k]).toBeCloseTo(want.convective[k]!, 12)
            }
            expect([want.ice, want.deep]).toEqual([data.ice, data.deep])
          }
        }
    }
  })

  it.each(SCENARIO_IDS)(
    '%s: carries its pattern as numbers that reproduce its sample, with no law',
    (id) => {
      const { climate } = regimeWeather(cornerstones, id)
      for (const sun of suns)
        for (const time of instants) {
          const data = climate.coefficients(sun, time)
          expect(data.kind).toBe('regime')
          expect(data.law).toEqual(new Array<number>(16).fill(0))
          for (const direction of places) {
            const want = climate.sample(direction, sun, time)
            const got = fromCoefficients(data, direction, sun, 1)
            for (let k = 0; k < 3; k += 1) {
              expect(got.cover[k]).toBeCloseTo(want.cover[k]!, 12)
              expect(got.convective[k]).toBe(want.convective[k])
            }
            expect([want.ice, want.deep]).toEqual([data.ice, data.deep])
          }
        }
    },
  )
})
