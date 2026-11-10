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
  MESOSCALE_GRADIENT,
  MESOSCALE_WAVES,
  mesoscaleDisplacement,
  mesoscalePhases,
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
 * The mesoscale displacement at a body point at t = 0, from the waves'
 * definition and no reduction: `Σ a·cell·push·sin(k·p)`.
 */
function displaced(p: Vec3, cell: number): Vec3 {
  let at = p
  for (const { along, push, wavelength, amplitude } of MESOSCALE_WAVES) {
    const k = (2 * Math.PI) / (wavelength * cell)
    const a =
      amplitude *
      cell *
      Math.sin(k * (along.x * p.x + along.y * p.y + along.z * p.z))
    at = plus(at, scale(push, a))
  }
  return at
}

/**
 * Phase 0's recipe (`render/cloudDensity.ts`) at t = 0, where its drift is
 * zero and its lattice is the point over the cell, read at the point the
 * mesoscale displacement carries it to: what the field must still be before
 * anything turns. Its numbers are the level's profile table's, so this holds
 * the recipe and the lattice, not the table.
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
  const q = displaced(p, cell)
  const base = baseNoiseTexture(scale(q, 1 / cell))
  const reach = 1 - smooth(cell / 16, cell / 4, footprint)
  const erosion =
    reach > 0
      ? detailNoiseTexture(scale(q, 4 / cell)) * profile.erosion * reach
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

  it.each(SCENARIO_IDS)(
    '%s: is phase 0’s recipe at t = 0, read through the mesoscale displacement',
    (id) => {
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
            expect(Math.abs(got.fraction - want.fraction)).toBeLessThan(
              ROUNDING,
            )
            expect(Math.abs(got.sigma - want.sigma)).toBeLessThan(
              ROUNDING * Math.max(1, want.sigma),
            )
            if (want.level >= 0)
              expect(Math.abs(got.radius - want.radius!)).toBeLessThan(ROUNDING)
          },
        ),
        { numRuns: 150 },
      )
    },
  )

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

/* ------------------------------------------------------------------------- */
/* The mesoscale displacement                                                 */
/* ------------------------------------------------------------------------- */

describe('the mesoscale displacement', () => {
  it('displaces each wave across its own direction, so the field is divergence-free and never folds', () => {
    let steepest = 0
    for (const { along, push, wavelength, amplitude } of MESOSCALE_WAVES) {
      expect(length(along)).toBeCloseTo(1, 14)
      expect(length(push)).toBeCloseTo(1, 14)
      expect(
        Math.abs(along.x * push.x + along.y * push.y + along.z * push.z),
      ).toBeLessThan(1e-14)
      const gradient = (2 * Math.PI * amplitude) / wavelength
      expect(gradient).toBeCloseTo(MESOSCALE_GRADIENT, 14)
      steepest += gradient
    }
    // The noise folds over itself where the displacement's gradient reaches
    // one; six waves aligned at their steepest reach 0.66.
    expect(steepest).toBeLessThan(1)
  })

  const weatherOf = (omega: number): BodyWeather => ({
    ...regimeWeather(world, 'fair-cumulus'),
    turn: [omega, omega, omega],
  })
  const point = fc
    .tuple(unit, between(0, 15_000))
    .map(([d, h]) => scale(d, world.radius + h))
  const instant = between(0, 3.2e8)
  const offset = fc.tuple(unit, between(0, 2e6)).map(([d, r]) => scale(d, r))
  const cell = 1200
  /** Two angles' distance on the circle. */
  const apart = (a: number, b: number): number =>
    Math.abs(Math.sin((a - b) / 2)) * 2

  it('is the same from any eye: the eye’s phases and the turned offset give the point’s own', () => {
    fc.assert(
      fc.property(rate, instant, point, offset, (omega, time, p, a) => {
        const clock = fieldClock(weatherOf(omega), time)
        const eye = plus(p, a)
        const m = levelTurnMatrix(clock, 0)
        const d = minus(p, eye)
        const turned = {
          x: m[0]! * d.x + m[1]! * d.y + m[2]! * d.z,
          y: m[3]! * d.x + m[4]! * d.y + m[5]! * d.z,
          z: m[6]! * d.x + m[7]! * d.y + m[8]! * d.z,
        }
        const atEye = mesoscalePhases(clock, 0, eye, cell)
        const atPoint = mesoscalePhases(clock, 0, p, cell)
        MESOSCALE_WAVES.forEach(({ along, wavelength }, j) => {
          const k = (2 * Math.PI) / (wavelength * cell)
          const seen =
            atEye[j]! +
            k * (along.x * turned.x + along.y * turned.y + along.z * turned.z)
          // Rounding: 2,000 km of offset is 600 rad of phase, and the
          // eye's and the point's phases each round at 10⁻¹² of a turn.
          expect(apart(seen, atPoint[j]!)).toBeLessThan(1e-9)
        })
      }),
      { numRuns: 300 },
    )
  })

  it('travels with the level’s lattice: a frame later, the point the lattice carried has the same displacement', () => {
    fc.assert(
      fc.property(rate, instant, point, (omega, time, p) => {
        const weather = weatherOf(omega)
        const step = time + 1 / 60 - time
        const moved = (() => {
          const q = { x: p.x, y: p.y - weather.drift * step, z: p.z }
          const a = omega * step
          return {
            x: Math.cos(a) * q.x + Math.sin(a) * q.z,
            y: q.y,
            z: -Math.sin(a) * q.x + Math.cos(a) * q.z,
          }
        })()
        const before = mesoscaleDisplacement(
          mesoscalePhases(fieldClock(weather, time), 0, p, cell),
          cell,
        )
        const after = mesoscaleDisplacement(
          mesoscalePhases(fieldClock(weather, time + 1 / 60), 0, moved, cell),
          cell,
        )
        // As the lattice test's bound: the instant's float64 step times ω
        // at this radius, times the displacement's gradient, under 0.66.
        const grid = 2 ** (Math.floor(Math.log2(Math.max(time, 1))) - 52)
        expect(length(minus(after, before))).toBeLessThan(
          4 * grid * Math.abs(omega) * length(p) + 1e-7,
        )
      }),
      { numRuns: 300 },
    )
  })
})

/* ------------------------------------------------------------------------- */
/* No tile from orbit                                                         */
/* ------------------------------------------------------------------------- */

/** In-place radix-2 FFT of one row or column. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j]!, re[i]!]
      ;[im[i], im[j]] = [im[j]!, im[i]!]
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const turn = ((inverse ? 2 : -2) * Math.PI) / size
    const wr = Math.cos(turn)
    const wi = Math.sin(turn)
    for (let start = 0; start < n; start += size) {
      let cr = 1
      let ci = 0
      for (let j = 0; j < size / 2; j += 1) {
        const a = start + j
        const b = a + size / 2
        const vr = re[b]! * cr - im[b]! * ci
        const vi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - vr
        im[b] = im[a]! - vi
        re[a] = re[a]! + vr
        im[a] = im[a]! + vi
        const next = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = next
      }
    }
  }
  if (inverse)
    for (let i = 0; i < n; i += 1) {
      re[i] = re[i]! / n
      im[i] = im[i]! / n
    }
}

/** A map's correlation with itself at every lag, as sums, on a grid padded to twice its size. */
function selfCorrelation(
  map: Float64Array,
  n: number,
  size: number,
): Float64Array {
  const re = new Float64Array(size * size)
  const im = new Float64Array(size * size)
  for (let y = 0; y < n; y += 1)
    for (let x = 0; x < n; x += 1) re[y * size + x] = map[y * n + x]!
  const pass = (inverse: boolean) => {
    const r = new Float64Array(size)
    const i = new Float64Array(size)
    for (const rows of [true, false])
      for (let a = 0; a < size; a += 1) {
        for (let b = 0; b < size; b += 1) {
          const at = rows ? a * size + b : b * size + a
          r[b] = re[at]!
          i[b] = im[at]!
        }
        fft(r, i, inverse)
        for (let b = 0; b < size; b += 1) {
          const at = rows ? a * size + b : b * size + a
          re[at] = r[b]!
          im[at] = i[b]!
        }
      }
  }
  pass(false)
  for (let k = 0; k < size * size; k += 1) {
    re[k] = re[k]! * re[k]! + im[k]! * im[k]!
    im[k] = 0
  }
  pass(true)
  return re
}

/**
 * A footprint's cloud-or-clear map, a column a texel: cloud where any of
 * five heights through the low level holds σ′·fraction over 10⁻⁵ 1/m at a
 * footprint of zero.
 */
function cloudMap(
  weather: BodyWeather,
  time: number,
  latitude: number,
  longitude: number,
  half: number,
  grid: number,
): { readonly map: Uint8Array; readonly n: number } {
  const { up, east, north } = compass(latitude, longitude)
  const clock = fieldClock(weather, time)
  const radius = weather.datumRadius
  const level = weather.levels[0]!
  const n = Math.round((2 * half) / grid) + 1
  const map = new Uint8Array(n * n)
  for (let j = 0; j < n; j += 1)
    for (let i = 0; i < n; i += 1) {
      const d = plus(
        up,
        plus(
          scale(east, (-half + i * grid) / radius),
          scale(north, (-half + j * grid) / radius),
        ),
      )
      const direction = scale(d, 1 / length(d))
      for (const h of [0.15, 0.3, 0.45, 0.6, 0.75]) {
        const r = radius + level.base + h * (level.top - level.base)
        const at = cloudFieldAt(weather, clock, up, scale(direction, r), 0)
        if (at.fraction * at.sigma > 1e-5) {
          map[j * n + i] = 1
          break
        }
      }
    }
  return { map, n }
}

/**
 * The largest normalized autocorrelation of a map at any lag from 2 km to
 * half its width, each lag over the pairs that overlap at it, and the map's
 * cloudy share.
 */
function largestRepeat(
  map: Uint8Array,
  n: number,
  grid: number,
): { readonly peak: number; readonly cloudy: number } {
  let cloudy = 0
  for (const value of map) cloudy += value
  cloudy /= map.length
  let size = 1
  while (size < 2 * n) size <<= 1
  const centered = new Float64Array(n * n)
  const ones = new Float64Array(n * n).fill(1)
  map.forEach((value, k) => (centered[k] = value - cloudy))
  const sums = selfCorrelation(centered, n, size)
  const counts = selfCorrelation(ones, n, size)
  const variance = cloudy * (1 - cloudy)
  const reach = Math.floor((n - 1) / 2)
  let peak = -1
  for (let dy = -reach; dy <= reach; dy += 1)
    for (let dx = 0; dx <= reach; dx += 1) {
      const lag = Math.hypot(dx, dy) * grid
      if (lag < 2000 || lag > reach * grid) continue
      const k = ((dy + size) % size) * size + dx
      peak = Math.max(peak, sums[k]! / Math.round(counts[k]!) / variance)
    }
  return { peak, cloudy }
}

const earth: Body = (() => {
  const stub = resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('SOL'),
  )!
  return [...walkBodies(generateSystem(ROOT, MILKY_WAY, stub))].find(
    (one) => formatAddress(one.address) === 'g:milky-way/s:SOL/b:2',
  )!
})()

describe('the field from orbit', () => {
  /*
   * A cloud-or-clear map at 200 m, over 80 km about a cornerstone's stance
   * at its instant (`packages/devtools/src/cornerstones.json`), correlates
   * with itself at no lag from 2 km to 40 km by more than this.
   *
   * Without the mesoscale displacement the base noise's 9.6 km tile shows
   * through: E1 correlates at 0.876 at 23.5 km, G4 at 0.828 at 32 km, G6
   * at 0.303 over 80 km and 0.116 over 40 km (the tile lies across that
   * stance's plane). G6's two are its descent's footprint: the middle
   * 80 km of the frame from 400 km, and the whole 46 km frame from 40 km,
   * whose lags reach 20 km. With it: 0.249, 0.154, 0.213 and 0.140, and over 24
   * places drawn at random on Earth and on the cornerstones' world under
   * cumulus and stratocumulus, 0.296 at most. A cumulus field's own
   * autocorrelation falls to near nothing within a few cells, and an
   * organized one rises again at its streets' or cells' spacing; 0.3 is
   * a repeat no eye takes for a tile, set at the measured worst and not
   * from a measured photograph. Under 2 km is a cloud's own extent.
   */
  const ORGANIZED = 0.3

  it.each([
    [
      'E1',
      earth,
      'fair-cumulus',
      -0.08726646259971647,
      -1.0471975511965976,
      17424.925169385428,
      40e3,
    ],
    [
      'G4',
      world,
      'stratocumulus',
      -0.2928832177490203,
      0.6526948251778841,
      6219.386038889019,
      40e3,
    ],
    [
      'G6 at 400 km',
      world,
      'stratocumulus',
      -0.29062177877890516,
      0.6500744120490799,
      86090.56815677337,
      40e3,
    ],
    [
      'G6 at 40 km',
      world,
      'stratocumulus',
      -0.29062177877890516,
      0.6500744120490799,
      86090.56815677337,
      20e3,
    ],
  ] as const)(
    '%s: no lag repeats the field',
    (_, body, regime, latitude, longitude, time, half) => {
      const weather = regimeWeather(body, regime)
      const { map, n } = cloudMap(weather, time, latitude, longitude, half, 200)
      const { peak, cloudy } = largestRepeat(map, n, 200)
      expect(peak).toBeLessThan(ORGANIZED)
      // The stance's share of cloudy columns is the regime's, as without
      // the displacement: 0.216 at E1 and 0.77 under stratocumulus.
      if (regime === 'fair-cumulus') {
        expect(cloudy).toBeGreaterThan(0.19)
        expect(cloudy).toBeLessThan(0.24)
      } else {
        expect(cloudy).toBeGreaterThan(0.74)
        expect(cloudy).toBeLessThan(0.8)
      }
    },
  )
})
