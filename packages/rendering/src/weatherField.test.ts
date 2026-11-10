import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
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
import { type BodyWeather, regimeWeather } from './weatherClimate.ts'
import { latticeOrigin, turnBack } from './weatherClock.ts'
import {
  clearSightShare,
  cloudFieldAt,
  columnDepth,
  fieldClock,
  fieldLevel,
  fitSightLength,
  levelLattice,
  levelOrigin,
  levelTurnMatrix,
  sightForm,
} from './weatherField.ts'
import { levelProfile, readLevelProfile } from './weatherGenus.ts'
import {
  BASE_NOISE_PERIOD,
  baseNoiseTexture,
  detailNoiseTexture,
} from './weatherNoise.ts'
import { SCENARIO_IDS, type ScenarioId } from './weatherScenario.ts'

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
 * The field's clock, which is whole, and the field's shape. The clock is
 * held without a body: a weather is its rates, and the clock reads nothing
 * else of it.
 */

const TURN = 2 * Math.PI

const weatherAt = (
  turn: readonly [number, number, number],
  drift = 0.25,
): BodyWeather => ({
  seed: { hi: 1, lo: 2 } as unknown as BodyWeather['seed'],
  datumRadius: 6_371_000,
  levels: [
    { base: 1000, top: 2400, stratiform: 'cumulus', cumuliform: 'cumulus' },
    { base: 4000, top: 4800, stratiform: 'cirrus', cumuliform: 'cirrus' },
    { base: 4800, top: 4800, stratiform: 'stratus', cumuliform: 'stratus' },
  ],
  climate: {
    kind: 'regime',
    sample: () => ({
      cover: [0.5, 0.5, 0],
      convective: [1, 0, 0],
      ice: 1,
      deep: 0,
    }),
    coefficients: () => {
      throw new Error('the field reads a climate’s samples, not its uniforms')
    },
  },
  turn,
  drift,
})

/** A wind of up to 100 m/s on a body from 500 km to Jupiter's radius, either way. */
const rate = fc
  .tuple(between(-100, 100), between(5e5, 7e7))
  .map(([wind, radius]) => wind / radius)

describe('the field’s clock', () => {
  it('reduces each level’s turn into [0, 2π), ten years either side of the epoch', () => {
    fc.assert(
      fc.property(rate, rate, rate, between(-3.2e8, 3.2e8), (a, b, c, time) => {
        const { turn } = fieldClock(weatherAt([a, b, c]), time)
        for (const angle of turn) {
          expect(angle).toBeGreaterThanOrEqual(0)
          expect(angle).toBeLessThan(TURN)
        }
      }),
    )
  })

  it('is the rate times the time, on the circle', () => {
    fc.assert(
      fc.property(rate, between(-3.2e8, 3.2e8), (omega, time) => {
        const [angle] = fieldClock(weatherAt([omega, 0, 0]), time).turn
        // The two agree as points of the circle: a turn reduced first is
        // the more exact, so the bound is the unreduced product's own
        // rounding, a few float64 steps of its size.
        const product = omega * time
        const apart = Math.abs(Math.sin((angle - product) / 2) * 2)
        expect(apart).toBeLessThanOrEqual(
          8 * Number.EPSILON * Math.max(1, Math.abs(product)),
        )
      }),
    )
  })

  it('moves by the turn’s own step from one frame to the next, with no restart at any instant', () => {
    fc.assert(
      fc.property(rate, between(0, 3.2e8), (omega, time) => {
        const step = 1 / 60
        const before = fieldClock(weatherAt([omega, 0, 0]), time).turn[0]
        const after = fieldClock(weatherAt([omega, 0, 0]), time + step).turn[0]
        const moved = Math.abs(Math.sin((after - before - omega * step) / 2))
        // Each reduction rounds once at the size of a turn's period over
        // the instant; an hourly restart would be a step of radians.
        expect(moved).toBeLessThanOrEqual(1e-9)
      }),
    )
  })

  it('holds still for a level that does not turn, and carries the drift and the instant unreduced', () => {
    const clock = fieldClock(weatherAt([0, 1e-6, -1e-6], 0.25), 86_400)
    expect(clock.turn[0]).toBe(0)
    expect(clock.turn[1]).toBeCloseTo(0.0864, 12)
    expect(clock.turn[2]).toBeCloseTo(TURN - 0.0864, 12)
    expect(clock.drift).toBe(21_600)
    expect(clock.time).toBe(86_400)
  })
})

describe('the field’s shape', () => {
  const weather = weatherAt([0, 0, 0])
  const clock = fieldClock(weather, 0)
  const sun = { x: 0, y: 1, z: 0 }
  const up = (height: number) => ({
    x: 0,
    y: weather.datumRadius + height,
    z: 0,
  })

  it('finds a point’s level by its height over the datum, base in and top out', () => {
    expect(fieldLevel(weather, 999)).toBe(-1)
    expect(fieldLevel(weather, 1000)).toBe(0)
    expect(fieldLevel(weather, 2399)).toBe(0)
    expect(fieldLevel(weather, 2400)).toBe(-1)
    expect(fieldLevel(weather, 4400)).toBe(1)
    // An absent level has no thickness and holds no height.
    expect(fieldLevel(weather, 4800)).toBe(-1)
    expect(cloudFieldAt(weather, clock, sun, up(1500), 50).level).toBe(0)
    expect(cloudFieldAt(weather, clock, sun, up(3000), 50).level).toBe(-1)
  })

  it('answers every point and column with a sample and a depth that are finite', () => {
    const sample = cloudFieldAt(weather, clock, sun, up(1500), 50)
    for (const value of Object.values(sample))
      expect(Number.isFinite(value)).toBe(true)
    expect(sample.fraction).toBeGreaterThanOrEqual(0)
    expect(sample.fraction).toBeLessThanOrEqual(1)
    expect(sample.sigma).toBeGreaterThanOrEqual(0)
    expect(columnDepth(weather, clock, sun, sun, 0)).toBeGreaterThanOrEqual(0)
  })
})

/* ------------------------------------------------------------------------- */
/* On the cornerstones' world                                                 */
/* ------------------------------------------------------------------------- */

const ROOT = rootSeed('inertialref')
const world: Body = (() => {
  const stub = resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('P222_3_2_k'),
  )!
  return [...walkBodies(generateSystem(ROOT, MILKY_WAY, stub))].find(
    (one) => formatAddress(one.address) === 'g:milky-way/s:P222_3_2_k/b:3',
  )!
})()

/** G1's stance (phase 1 design §3.3), and its compass there. */
const G1 = { latitude: -0.29062177877890516, longitude: 0.6500744120490799 }
const compass = (latitude: number, longitude: number) => ({
  up: {
    x: Math.cos(latitude) * Math.cos(longitude),
    y: Math.sin(latitude),
    z: -Math.cos(latitude) * Math.sin(longitude),
  },
  east: { x: -Math.sin(longitude), y: 0, z: -Math.cos(longitude) },
  north: {
    x: -Math.sin(latitude) * Math.cos(longitude),
    y: Math.cos(latitude),
    z: Math.sin(latitude) * Math.sin(longitude),
  },
})
const scale = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
})
const plus = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})
const minus = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})
const length = (v: Vec3): number => Math.hypot(v.x, v.y, v.z)

const unit = fc
  .tuple(between(-1, 1), between(0, 2 * Math.PI))
  .map(([y, longitude]): Vec3 => {
    const ring = Math.sqrt(1 - y * y)
    return { x: ring * Math.cos(longitude), y, z: ring * Math.sin(longitude) }
  })

const clamp01 = (x: number) => Math.min(1, Math.max(0, x))
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

/**
 * Phase 0's recipe (`render/cloudDensity.ts`) at t = 0, where its drift is
 * zero and its lattice is the point over the cell: what the field must still
 * be before anything turns. Its numbers are the level's profile table's, so
 * this holds the recipe and the lattice, not the table.
 */
function asBuilt(weather: BodyWeather, sun: Vec3, p: Vec3, footprint: number) {
  const height = length(p) - weather.datumRadius
  const k = fieldLevel(weather, height)
  if (k < 0) return { fraction: 0, sigma: 0, level: k }
  const spec = weather.levels[k]!
  const profile = levelProfile(spec)
  // Normalized as the field normalizes, p/|p|: near a pole the latitude's
  // arcsine turns a last-bit difference in y into 10⁻⁸ rad, which a band
  // pattern's slope makes a difference in the cover.
  const r = length(p)
  const climate = weather.climate.sample(
    { x: p.x / r, y: p.y / r, z: p.z / r },
    sun,
    0,
  )
  const c = clamp01(climate.cover[k]!)
  const h01 = (height - spec.base) / Math.max(spec.top - spec.base, 1)
  const [shape, mean, , radius] = readLevelProfile(
    profile,
    h01,
    climate.convective[k]!,
  )
  const cell = profile.cell
  const base = baseNoiseTexture(scale(p, 1 / cell))
  const reach = 1 - smooth(cell / 16, cell / 4, footprint)
  const erosion =
    reach > 0
      ? detailNoiseTexture(scale(p, 4 / cell)) * profile.erosion * reach
      : 0
  const shaped = clamp01((base * shape - (1 - c)) / Math.max(c, 1e-6))
  const eroded = clamp01((shaped - erosion) / Math.max(1 - erosion, 1e-6))
  const unresolved = smooth(cell / 4, cell, footprint)
  const fraction = 1 + (c - 1) * unresolved
  const extinction =
    profile.scaled * (eroded + (c * mean - eroded) * unresolved)
  return {
    fraction,
    sigma: extinction / Math.max(fraction, 1e-6),
    radius: radius * profile.radius,
    level: k,
  }
}

describe('the field', () => {
  const sun = { x: 0, y: 1, z: 0 }

  it.each(SCENARIO_IDS)('%s: is phase 0’s recipe at t = 0', (id) => {
    const weather = regimeWeather(world, id)
    const clock = fieldClock(weather, 0)
    fc.assert(
      fc.property(
        unit,
        fc.integer({ min: 0, max: 2 }),
        between(0, 1),
        between(0, 5),
        (direction, k, h, cells) => {
          const level = weather.levels[k]!
          const r =
            weather.datumRadius + level.base + h * (level.top - level.base)
          const p = scale(direction, r)
          const footprint = cells * levelProfile(level).cell
          const got = cloudFieldAt(weather, clock, sun, p, footprint)
          const want = asBuilt(weather, sun, p, footprint)
          expect(got.level).toBe(want.level)
          // The field reduces the lattice by its period before it divides
          // by the cell, and phase 0's read does not: two float64 roundings
          // of a coordinate 5 × 10⁴ texels out, through a remap that
          // divides by the cover, measured at 5 × 10⁻¹⁰.
          const ROUNDING = 1e-8
          expect(Math.abs(got.fraction - want.fraction)).toBeLessThan(ROUNDING)
          expect(Math.abs(got.sigma - want.sigma)).toBeLessThan(
            ROUNDING * Math.max(1, want.sigma),
          )
          if (want.level >= 0)
            expect(Math.abs(got.radius - want.radius!)).toBeLessThan(ROUNDING)
        },
      ),
      { numRuns: 150 },
    )
  })

  it('holds, unresolved, the level’s cover and the profile’s mean, whatever the noise', () => {
    const weather = regimeWeather(world, 'fair-cumulus')
    const clock = fieldClock(weather, 0)
    const level = weather.levels[0]!
    const profile = levelProfile(level)
    fc.assert(
      fc.property(unit, between(0.001, 0.999), (d, h) => {
        const p = scale(
          d,
          world.radius + level.base + h * (level.top - level.base),
        )
        const at = cloudFieldAt(weather, clock, sun, p, 4 * profile.cell)
        const [, mean] = readLevelProfile(
          profile,
          (length(p) - world.radius - level.base) / (level.top - level.base),
          1,
        )
        expect(at.fraction).toBe(0.35)
        expect(at.fraction * at.sigma).toBeCloseTo(
          profile.scaled * 0.35 * mean,
          12,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('gives G1 the scattered sky of fair weather: a share of its columns cloudy, not none and not all', () => {
    // Measured on this world at G1, 41 × 41 columns 500 m apart: 0.224 of
    // them hold cloud under a cover of 0.35. Phase 0's blob put G1 under a
    // cover of one, every column cloudy, or of none.
    const weather = regimeWeather(world, 'fair-cumulus')
    const clock = fieldClock(weather, 98977.5083075788)
    const { up, east, north } = compass(G1.latitude, G1.longitude)
    let cloudy = 0
    let count = 0
    for (let i = -20; i <= 20; i += 1)
      for (let j = -20; j <= 20; j += 1) {
        const d = plus(
          up,
          plus(
            scale(east, (i * 500) / world.radius),
            scale(north, (j * 500) / world.radius),
          ),
        )
        if (columnDepth(weather, clock, up, d, 0) > 0) cloudy += 1
        count += 1
      }
    expect(cloudy / count).toBeGreaterThan(0.1)
    expect(cloudy / count).toBeLessThan(0.5)
  })
})

describe('a column', () => {
  it.each([
    'fair-cumulus',
    'overcast',
    'stratocumulus',
    'cirrus-over-cumulus',
    'anvil',
  ] as const)('%s: is a 512-step integral of the unscaled extinction', (id) => {
    const weather = regimeWeather(world, id)
    const clock = fieldClock(weather, 12_345)
    const sun = { x: 0, y: 1, z: 0 }
    fc.assert(
      fc.property(unit, (direction) => {
        for (let k = 0; k < 3; k += 1) {
          const level = weather.levels[k]!
          if (!(level.top > level.base)) continue
          const profile = levelProfile(level)
          const thickness = level.top - level.base
          let sum = 0
          for (let i = 0; i < 512; i += 1) {
            const r = world.radius + level.base + ((i + 0.5) / 512) * thickness
            const at = cloudFieldAt(weather, clock, sun, scale(direction, r), 0)
            sum += at.fraction * at.sigma
          }
          const want =
            ((sum * profile.sigma) / profile.scaled) * (thickness / 512)
          const got = columnDepth(weather, clock, sun, direction, k)
          // 256 midpoints against 512: the profile and the noise are
          // piecewise linear between texels, so the two differ at the
          // kinks by a share of one step's full depth, σ·T/256. Measured
          // over 400 columns of each of these regimes: 0.021 of a step at
          // worst, the anvil's; 0.1% of any column deeper than ten steps.
          const step = (profile.sigma * thickness) / 256
          expect(Math.abs(got - want)).toBeLessThanOrEqual(0.05 * step)
        }
      }),
      { numRuns: 25 },
    )
  })
})

describe('the field’s motion', () => {
  const weatherOf = (omega: number): BodyWeather => ({
    ...regimeWeather(world, 'fair-cumulus'),
    turn: [omega, omega, omega],
  })
  const point = fc
    .tuple(unit, between(0, 15_000))
    .map(([d, h]) => scale(d, world.radius + h))
  const instant = between(0, 3.2e8)

  it('carries a cloud ten years past the epoch by the turn’s own step a frame, with no restart at any instant', () => {
    fc.assert(
      fc.property(rate, instant, point, (omega, time, p) => {
        const weather = weatherOf(omega)
        // The frame as float64 holds it at this instant: 1/60 s within
        // one step of the instant's own grid.
        const step = time + 1 / 60 - time
        const before = fieldClock(weather, time)
        const after = fieldClock(weather, time + 1 / 60)
        // Where the lattice point under p has gone a frame later: turned
        // east by ω·Δt and carried down the axis by w·Δt.
        const moved = (() => {
          const q = { x: p.x, y: p.y - weather.drift * step, z: p.z }
          const a = omega * step
          return {
            x: Math.cos(a) * q.x + Math.sin(a) * q.z,
            y: q.y,
            z: -Math.sin(a) * q.x + Math.cos(a) * q.z,
          }
        })()
        const there = levelLattice(after, 0, moved)
        const here = levelLattice(before, 0, p)
        // Rounding: a turn is reduced through the instant's remainder in
        // its period, which is exact to the instant's own float64 step,
        // so its angle is good to that step times ω, at the point's
        // radius; the drift, 8 × 10⁷ m at ten years, to 1.5 × 10⁻⁸ m.
        const grid = 2 ** (Math.floor(Math.log2(Math.max(time, 1))) - 52)
        const bound = 4 * grid * Math.abs(omega) * length(p) + 1e-7
        expect(length(minus(there, here))).toBeLessThan(bound)
        // And no frame moves a point further than the turn and the drift
        // can: an hourly restart is a jump of a kilometer.
        const speed = Math.abs(omega) * length(p) + weather.drift
        expect(length(minus(levelLattice(after, 0, p), here))).toBeLessThan(
          speed * step * (1 + 1e-6) + bound,
        )
      }),
      { numRuns: 500 },
    )
  })

  it('turns and drifts by exactly the span between any two instants: no instant is a restart', () => {
    // A frame's step can straddle a restart only once an hour, which a
    // property drawing instants would not find; a span of up to twelve days
    // straddles every one under it.
    fc.assert(
      fc.property(rate, instant, between(0, 1e6), (omega, time, span) => {
        const weather = weatherOf(omega)
        const later = time + span
        const before = fieldClock(weather, time)
        const after = fieldClock(weather, later)
        const grid = 2 ** (Math.floor(Math.log2(Math.max(later, 1))) - 52)
        // A point on the axis is carried by the drift alone.
        const axis = { x: 0, y: world.radius, z: 0 }
        const drifted =
          levelLattice(after, 0, axis).y - levelLattice(before, 0, axis).y
        expect(drifted).toBeCloseTo(weather.drift * (later - time), 4)
        // A point on the equator is turned by the span's angle alone.
        const equator = { x: world.radius, y: 0, z: 0 }
        const a = levelLattice(before, 0, equator)
        const b = levelLattice(after, 0, equator)
        const turned = Math.atan2(b.z, b.x) - Math.atan2(a.z, a.x)
        const apart = Math.sin((turned - omega * (later - time)) / 2)
        expect(Math.abs(apart)).toBeLessThan(4 * grid * Math.abs(omega) + 1e-12)
      }),
      { numRuns: 500 },
    )
  })

  it('reduces a point’s place by the period with the drift reduced first, and is the lattice point modulo the period', () => {
    const period = BASE_NOISE_PERIOD * 1200
    fc.assert(
      fc.property(rate, instant, point, (omega, time, p) => {
        const clock = fieldClock(weatherOf(omega), time)
        const origin = levelOrigin(clock, 0, p, period)
        const lattice = levelLattice(clock, 0, p)
        for (const axis of ['x', 'y', 'z'] as const) {
          expect(origin[axis]).toBeGreaterThanOrEqual(0)
          expect(origin[axis]).toBeLessThan(period)
          const apart =
            (((origin[axis] - lattice[axis]) % period) + period) % period
          // The unreduced form rounds at its own size, 8 × 10⁷ m of drift
          // at ten years: 1.5 × 10⁻⁸ m a step, a few steps in all.
          expect(Math.min(apart, period - apart)).toBeLessThan(1e-6)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('places every level’s noise exactly where the frame does: one lattice for the field and the drawn frame', () => {
    // The frame writes each level's origin and turn with `latticeOrigin`
    // and `turnBack`; the field must read the same lattice to the bit, or
    // the CPU oracle and the drawn noise disagree by a reduction's rounding.
    const period = BASE_NOISE_PERIOD * 1200
    fc.assert(
      fc.property(rate, instant, point, (omega, time, p) => {
        const clock = fieldClock(weatherOf(omega), time)
        for (const k of [0, 1, 2] as const) {
          expect(levelOrigin(clock, k, p, period)).toEqual(
            latticeOrigin(p, clock.turn[k], clock.drift, period),
          )
          expect(levelTurnMatrix(clock, k)).toEqual(turnBack(clock.turn[k]))
        }
      }),
      { numRuns: 300 },
    )
  })

  it('maps a body point to one lattice point from any two eyes, modulo the noise’s period', () => {
    const period = BASE_NOISE_PERIOD * 1200
    const offset = fc.tuple(unit, between(0, 2e6)).map(([d, r]) => scale(d, r))
    fc.assert(
      fc.property(
        rate,
        instant,
        point,
        offset,
        offset,
        (omega, time, p, a, b) => {
          const clock = fieldClock(weatherOf(omega), time)
          const m = levelTurnMatrix(clock, 0)
          const turn = (v: Vec3): Vec3 => ({
            x: m[0]! * v.x + m[1]! * v.y + m[2]! * v.z,
            y: m[3]! * v.x + m[4]! * v.y + m[5]! * v.z,
            z: m[6]! * v.x + m[7]! * v.y + m[8]! * v.z,
          })
          const seen = (eye: Vec3): Vec3 =>
            plus(levelOrigin(clock, 0, eye, period), turn(minus(p, eye)))
          const one = seen(plus(p, a))
          const two = seen(plus(p, b))
          for (const axis of ['x', 'y', 'z'] as const) {
            const apart = (((one[axis] - two[axis]) % period) + period) % period
            // Rounding of a 2,000 km offset through the matrix: 10⁻⁹ m.
            expect(Math.min(apart, period - apart)).toBeLessThan(1e-6)
          }
          // The matrix is the turn the lattice uses.
          const q = turn(p)
          const lattice = levelLattice(clock, 0, p)
          expect(q.x).toBeCloseTo(lattice.x, 6)
          expect(q.z).toBeCloseTo(lattice.z, 6)
        },
      ),
      { numRuns: 300 },
    )
  })
})

describe('the sight count', () => {
  /*
   * §5.9's form, P(θ) = P₀^√(1 + (ℓ/c)²), against lines of sight counted
   * through the field. Measured at G1 at t = 0 on 2,304 lines a zenith
   * angle, 1.37 cells apart: fair-cumulus fits at c = 3.0 km, broken-horizon
   * 2.7, near-gap-far 2.8, the cumulus under cirrus 2.7 and the anvil 24 km,
   * each within 5% of its count at every angle; c is two to three of the
   * noise's cells, not one. The test counts 1,024, within 5% likewise. Lines
   * closer than a cell share their cells: 576 of them 410 m apart cover
   * eight, the share is then that patch's, and a patch a kilometer over
   * moves c by a quarter.
   */
  const ZENITHS = [0, 30, 45, 60, 70, 75, 80]
  const CUMULIFORM: readonly ScenarioId[] = [
    'fair-cumulus',
    'broken-horizon',
    'near-gap-far',
    'cirrus-over-cumulus',
    'anvil',
  ]

  it.each(CUMULIFORM)(
    '%s: clear lines of sight follow the form within 10%',
    (id) => {
      const weather = regimeWeather(world, id)
      const clock = fieldClock(weather, 0)
      const { up, east, north } = compass(G1.latitude, G1.longitude)
      const level = weather.levels[0]!
      const { cell } = levelProfile(level)
      const counts = ZENITHS.map((degrees) => {
        const zenith = (degrees * Math.PI) / 180
        return {
          zenith,
          clear: clearSightShare(
            weather,
            clock,
            up,
            { up, east, north, lines: 32, spacing: 1.37 * cell },
            0,
            zenith,
            cell / 30,
          ),
        }
      })
      const thickness = level.top - level.base
      const sight = fitSightLength(counts, thickness)
      expect(counts[0]!.clear).toBeGreaterThan(0.05)
      expect(counts[0]!.clear).toBeLessThan(0.95)
      for (const { zenith, clear } of counts)
        expect(
          Math.abs(
            sightForm(counts[0]!.clear, thickness, zenith, sight) - clear,
          ),
        ).toBeLessThanOrEqual(0.1 * clear)
    },
  )
})
