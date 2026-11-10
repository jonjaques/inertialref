import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { pcg4d } from '@inertialref/procedural'
import {
  BASE_NOISE_PERIOD,
  baseNoise,
  baseNoiseWide,
  curlNoise,
  DETAIL_NOISE_PERIOD,
  detailNoise,
  NOISE_LANES,
  worleyFeature,
} from './weatherNoise.ts'

/*
 * The noises the GPU bakes are held to these functions texel by texel
 * (`cloudNoise.gpu.test.ts`), so what is held here is what the bake cannot
 * show: that each closes on its period, that every lattice draw is pcg4d's
 * own and survives float32 untouched, and that nothing is decided by a float
 * — a field continuous across every cell face, so a texel that rounds the
 * other way on the GPU reads a neighbor's value and not another feature's.
 */

const unitDouble = (max: number) =>
  fc.double({ min: 0, max, noNaN: true, noDefaultInfinity: true })
const point = (max: number) =>
  fc.record({ x: unitDouble(max), y: unitDouble(max), z: unitDouble(max) })

describe('the noises tile at their periods', () => {
  it('the base shape and its octaves repeat every eight cells on each axis', () => {
    fc.assert(
      fc.property(
        point(BASE_NOISE_PERIOD),
        fc.integer({ min: 0, max: 2 }),
        (p, axis) => {
          const shifted = {
            x: p.x + (axis === 0 ? BASE_NOISE_PERIOD : 0),
            y: p.y + (axis === 1 ? BASE_NOISE_PERIOD : 0),
            z: p.z + (axis === 2 ? BASE_NOISE_PERIOD : 0),
          }
          const a = baseNoiseWide(p)
          const b = baseNoiseWide(shifted)
          a.forEach((value, k) =>
            expect(Math.abs(value - b[k]!)).toBeLessThan(1e-9),
          )
        },
      ),
      { numRuns: 300 },
    )
  })

  it('the detail repeats every four cells, and the curl every unit', () => {
    fc.assert(
      fc.property(point(DETAIL_NOISE_PERIOD), (p) => {
        const d = detailNoise(p)
        expect(Math.abs(detailNoise({ ...p, x: p.x + 4 }) - d)).toBeLessThan(
          1e-9,
        )
        expect(Math.abs(detailNoise({ ...p, y: p.y - 4 }) - d)).toBeLessThan(
          1e-9,
        )
        expect(Math.abs(detailNoise({ ...p, z: p.z + 8 }) - d)).toBeLessThan(
          1e-9,
        )
        const [cx, cy] = curlNoise(p.x / 4, p.y / 4)
        const [ux, uy] = curlNoise(p.x / 4 + 1, p.y / 4 - 3)
        expect(Math.abs(ux - cx)).toBeLessThan(1e-9)
        expect(Math.abs(uy - cy)).toBeLessThan(1e-9)
      }),
      { numRuns: 300 },
    )
  })

  it('texel centers a period apart agree exactly, where the bake samples them', () => {
    // (i + ½)/16 is dyadic, so the shifted point loses nothing to rounding,
    // and the detail and the curl come out bit for bit. The base adds its
    // curl displacement to a coordinate a period larger, which rounds at
    // 2⁻⁴⁹ of a cell rather than 2⁻⁵², so it agrees to that and no better.
    for (const i of [0, 7, 64, 127]) {
      const p = { x: (i + 0.5) / 16, y: (127.5 - i) / 16, z: 0.5 / 16 }
      const shifted = baseNoiseWide({ ...p, z: p.z + 8 })
      baseNoiseWide(p).forEach((value, k) =>
        expect(Math.abs(value - shifted[k]!)).toBeLessThan(1e-12),
      )
      const d = { x: (i + 0.5) / 32, y: 0.5 / 32, z: (31.5 - (i % 32)) / 32 }
      expect(detailNoise({ ...d, y: d.y + 4 })).toBe(detailNoise(d))
    }
    expect(curlNoise(0.5 / 128, 1 + 0.5 / 128)).toEqual(
      curlNoise(0.5 / 128, 0.5 / 128),
    )
  })
})

describe('the values stay in the ranges the textures store', () => {
  it('base and detail in [0, 1], the curl in [−1, 1]', () => {
    fc.assert(
      fc.property(point(64), (p) => {
        for (const value of baseNoiseWide(p)) {
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(1)
        }
        const d = detailNoise(p)
        expect(d).toBeGreaterThanOrEqual(0)
        expect(d).toBeLessThanOrEqual(1)
        for (const c of curlNoise(p.x, p.y)) {
          expect(c).toBeGreaterThanOrEqual(-1)
          expect(c).toBeLessThanOrEqual(1)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('the base is not a constant: a cloud field needs both its billows and its gaps', () => {
    const values: number[] = []
    for (let i = 0; i < 512; i += 1) {
      const t = (i * 0.618034) % 1
      values.push(
        baseNoise({
          x: t * 8,
          y: ((i * 0.414214) % 1) * 8,
          z: ((i * 0.732051) % 1) * 8,
        }),
      )
    }
    expect(Math.min(...values)).toBeLessThan(0.3)
    expect(Math.max(...values)).toBeGreaterThan(0.7)
  })
})

describe('the lattices are pcg4d’s', () => {
  it('a feature point is the top 24 bits of each of the first three lanes, of the cell modulo the period', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -64, max: 64 }),
        fc.integer({ min: -64, max: 64 }),
        fc.integer({ min: -64, max: 64 }),
        fc.constantFrom(4, 8, 16, 32),
        fc.constantFrom(...NOISE_LANES.worley, ...NOISE_LANES.detail),
        (i, j, k, period, lane) => {
          const m = (c: number) => ((c % period) + period) % period
          const h = pcg4d(m(i), m(j), m(k), lane)
          const f = worleyFeature(i, j, k, period, lane)
          expect(f).toEqual({
            x: (h.x >>> 8) / 2 ** 24,
            y: (h.y >>> 8) / 2 ** 24,
            z: (h.z >>> 8) / 2 ** 24,
          })
          // The same point a period over, and a float32 holds it exactly.
          expect(
            worleyFeature(i + period, j - period, k, period, lane),
          ).toEqual(f)
          for (const c of [f.x, f.y, f.z]) expect(Math.fround(c)).toBe(c)
        },
      ),
    )
  })

  it('no two octaves share a lane', () => {
    const lanes = Object.values(NOISE_LANES).flat()
    expect(new Set(lanes).size).toBe(lanes.length)
  })
})

describe('nothing is decided by a float', () => {
  /*
   * A cell index read one way on the CPU and the other on the GPU, at a
   * point that rounds across a cell face, reads a neighboring feature —
   * harmless only if the field is continuous there. Each noise is evaluated
   * a hair either side of a face of its finest lattice (32 cells a period
   * for the base, 16 for the detail, 8 for the curl) and must not jump.
   */
  const HAIR = 1e-9
  /** The steepest slope any octave reaches, in its own cells: four octaves' worth of margin. */
  const SLOPE = 64

  it('across every lattice face', () => {
    fc.assert(
      fc.property(point(8), fc.integer({ min: 0, max: 255 }), (p, face) => {
        const at = face / 32
        const below = { ...p, x: at - HAIR }
        const above = { ...p, x: at + HAIR }
        expect(Math.abs(baseNoise(above) - baseNoise(below))).toBeLessThan(
          SLOPE * 2 * HAIR * 32,
        )
        const d = face / 16
        expect(
          Math.abs(
            detailNoise({ ...p, y: d + HAIR }) -
              detailNoise({ ...p, y: d - HAIR }),
          ),
        ).toBeLessThan(SLOPE * 2 * HAIR * 16)
        const u = face / 8 / 8
        const [ax, ay] = curlNoise(u + HAIR, p.y / 8)
        const [bx, by] = curlNoise(u - HAIR, p.y / 8)
        expect(Math.abs(ax - bx) + Math.abs(ay - by)).toBeLessThan(
          SLOPE * 4 * HAIR * 64,
        )
      }),
      { numRuns: 300 },
    )
  })
})

describe('the curl', () => {
  it('is divergence-free wherever its clamp does not bind: the slope is the potential’s own', () => {
    // Central differences of (∂ψ/∂v, −∂ψ/∂u): the mixed partials cancel, so
    // what is left is the differences' own error, h² times a fourth
    // derivative of a field with eight lattice cells a unit.
    const h = 1e-5
    let tested = 0
    fc.assert(
      fc.property(unitDouble(1), unitDouble(1), (u, v) => {
        const samples = [
          curlNoise(u + h, v),
          curlNoise(u - h, v),
          curlNoise(u, v + h),
          curlNoise(u, v - h),
        ]
        if (samples.some(([x, y]) => Math.abs(x) > 0.99 || Math.abs(y) > 0.99))
          return
        tested += 1
        const divergence =
          (samples[0]![0] - samples[1]![0]) / (2 * h) +
          (samples[2]![1] - samples[3]![1]) / (2 * h)
        expect(Math.abs(divergence)).toBeLessThan(1e-3)
      }),
      { numRuns: 400 },
    )
    expect(tested).toBeGreaterThan(200)
  })
})
