import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  SLAB_DIFFUSION_REACH,
  SLAB_SUN_HOLD,
  bearingCosine,
  depthCoordinate,
  diffusionExtension,
  readSource,
  sourceAt,
  stretchedHarmonic,
  viewReads,
  viewSlabs,
  type SlabSourceGrid,
  type SlabSourceReadOptions,
  type SlabSourceTable,
} from './slabSourceRead.ts'

/*
 * The source table's CPU read, on tables whose texels are known functions
 * of their coordinates: what a node on the GPU is held to.
 */

/** The read as a clamped texture returns it, neither convention applied. */
const OFF: SlabSourceReadOptions = { holdSun: false, extend: false }
const AXES = { suns: 3, sunMuMin: 0.2, depthScale: 0.02, depthMax: 16 } as const
const sunNode = (grid: SlabSourceGrid, k: number): number =>
  grid.sunMuMin + (k * (1 - grid.sunMuMin)) / (grid.suns - 1)

describe('the table’s read', () => {
  const grid: SlabSourceGrid = { ...AXES, nodes: 6 }
  /** Two slabs: the second is the first plus a hundred, so a read that strays is seen. */
  const terms = new Float64Array(2 * 3 * 6 * 6 * 4)
  for (let slab = 0; slab < 2; slab += 1)
    for (let sun = 0; sun < 3; sun += 1)
      for (let bottom = 0; bottom < 6; bottom += 1)
        for (let top = 0; top < 6; top += 1) {
          const cell = (((slab * 3 + sun) * 6 + bottom) * 6 + top) * 4
          terms[cell] =
            100 * slab + 1 + 2 * (top / 5) - bottom / 5 + 3 * sunNode(grid, sun)
          terms[cell + 1] = top / 5
          terms[cell + 2] = (bottom / 5) * sunNode(grid, sun)
          terms[cell + 3] = 7
        }
  const table: SlabSourceTable = { ...grid, slabs: 2, terms }

  it('puts a transport depth on a logarithm, zero at a face and one at the last node', () => {
    expect(depthCoordinate(grid, 0)).toBe(0)
    expect(depthCoordinate(grid, -1)).toBe(0)
    expect(depthCoordinate(grid, 16)).toBeCloseTo(1, 15)
    expect(depthCoordinate(grid, 40)).toBe(1)
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        (a, b) => {
          if (a < b)
            expect(depthCoordinate(grid, a)).toBeLessThanOrEqual(
              depthCoordinate(grid, b),
            )
        },
      ),
    )
  })

  it('is exact for texels that are linear along each axis, in the slab it is asked for', () => {
    const out = new Float64Array(4)
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1 }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        fc.double({ min: 0.2, max: 1, noNaN: true }),
        (slab, top, bottom, sunMu) => {
          readSource(table, slab, top, bottom, sunMu, out, OFF)
          const x = depthCoordinate(grid, top)
          const y = depthCoordinate(grid, bottom)
          expect(out[0]).toBeCloseTo(100 * slab + 1 + 2 * x - y + 3 * sunMu, 9)
          expect(out[1]).toBeCloseTo(x, 10)
          expect(out[2]).toBeCloseTo(y * sunMu, 10)
          expect(out[3]).toBeCloseTo(7, 10)
        },
      ),
    )
  })

  it('with both conventions off, holds the end’s value past either end, and never blends two slabs', () => {
    const out = new Float64Array(4)
    // Under the first sun and over the last: a clamped texture's read, and
    // the first slab's last slice is not blended with the second's first.
    readSource(table, 0, 99, 0, 0.01, out, OFF)
    expect(out[0]).toBeCloseTo(1 + 2 + 3 * 0.2, 12)
    readSource(table, 0, 0, 0, 1.5, out, OFF)
    expect(out[0]).toBeCloseTo(1 + 3, 12)
    readSource(table, 1, 0, 0, 0.01, out, OFF)
    expect(out[0]).toBeCloseTo(100 + 1 + 3 * 0.2, 12)
  })

  it('holds the sun’s coordinate a 64th of a slice inside its slab, by default', () => {
    const out = new Float64Array(4)
    const step = (1 - grid.sunMuMin) / (grid.suns - 1)
    // At and past either end the read is a 64th of a slice in from it: the
    // slice past belongs to the next slab, a hundred over.
    for (const [sunMu, slice] of [
      [0.01, SLAB_SUN_HOLD],
      [grid.sunMuMin, SLAB_SUN_HOLD],
      [1, grid.suns - 1 - SLAB_SUN_HOLD],
      [1.5, grid.suns - 1 - SLAB_SUN_HOLD],
    ] as const)
      for (const slab of [0, 1]) {
        readSource(table, slab, 0, 0, sunMu, out)
        expect(out[0]).toBeCloseTo(
          100 * slab + 1 + 3 * (grid.sunMuMin + slice * step),
          12,
        )
        readSource(table, slab, 0, 0, sunMu, out, { holdSun: false })
        expect(out[0]).toBeCloseTo(
          100 * slab + 1 + 3 * Math.min(1, Math.max(grid.sunMuMin, sunMu)),
          12,
        )
      }
    // Inside the hold nothing moves.
    readSource(table, 0, 0, 0, 0.6, out)
    expect(out[0]).toBeCloseTo(1 + 3 * 0.6, 12)
  })

  it('extends a read past the last node from the lit face by diffusion’s law, by default', () => {
    const out = new Float64Array(4)
    const held = new Float64Array(4)
    const reach = SLAB_DIFFUSION_REACH
    fc.assert(
      fc.property(
        fc.double({ min: 16.001, max: 400, noNaN: true }),
        fc.double({ min: 0, max: 16, noNaN: true }),
        (top, bottom) => {
          readSource(table, 0, top, bottom, 0.6, out)
          readSource(table, 0, top, bottom, 0.6, held, { extend: false })
          const factor = (16 + bottom + reach) / (top + bottom + reach)
          for (let c = 0; c < 4; c += 1)
            expect(out[c]).toBeCloseTo(held[c]! * factor, 12)
        },
      ),
    )
    // Continuous at the node, and nothing moves inside the table, nor on
    // the reflected side of a deep slab: a far face past the node alone.
    expect(diffusionExtension(grid, 16, 3)).toBe(1)
    expect(diffusionExtension(grid, 16 + 1e-9, 3)).toBeCloseTo(1, 9)
    expect(diffusionExtension(grid, 3, 300)).toBe(1)
    // Both faces past the node: the diffuse light's linear fall, which is
    // half its level at the middle of any slab deep enough.
    expect(diffusionExtension(grid, 200, 200)).toBeCloseTo(1, 12)
    expect(diffusionExtension(grid, 300, 100)).toBeCloseTo(
      (2 * (100 + reach / 2)) / (400 + reach),
      12,
    )
  })

  it('sums a ray’s reads, each channel by its own weight', () => {
    const out = new Float64Array(4)
    readSource(table, 0, 3, 2, 0.6, out)
    const first = [...out]
    readSource(table, 1, 3, 2, 0.6, out)
    const second = [...out]
    const weights = [
      [0.25, 1, -0.5, 2],
      [0.75, 0, 0.5, -1],
    ] as const
    expect(
      sourceAt(
        table,
        [
          { slab: 0, weights: weights[0] },
          { slab: 1, weights: weights[1] },
        ],
        3,
        2,
        0.6,
      ),
    ).toBeCloseTo(
      first.reduce((sum, value, c) => sum + value * weights[0][c]!, 0) +
        second.reduce((sum, value, c) => sum + value * weights[1][c]!, 0),
      12,
    )
  })
})

describe('a ray’s reads of the view table', () => {
  const cosines = [0.0003, 0.3, 0.7, 0.9997]
  const form = { cosines, stretch: 0.65 }
  const ray = (muV: number, azimuth: number) => {
    const phi = (azimuth * Math.PI) / 180
    return {
      sunMu: 0.5,
      muV,
      along: Math.sqrt(1 - muV * muV) * Math.cos(phi),
      nu: 0,
    }
  }

  it('reads a hemisphere’s own slabs: the lit face’s first, then the far one’s', () => {
    // On a node the blend is all that node’s, beside the next at none: the
    // angle’s difference is −0 there, which a texture weighs as zero.
    expect(viewSlabs(cosines, 0.3)).toEqual([
      { slab: 1, share: 1 },
      { slab: 2, share: -0 },
    ])
    expect(viewSlabs(cosines, -0.3)[0]).toEqual({ slab: 5, share: 1 })
    expect(viewSlabs(cosines, 1)).toEqual([{ slab: 3, share: 1 }])
    expect(viewSlabs(cosines, -0.0001)).toEqual([{ slab: 4, share: 1 }])
  })

  it('blends the two cosines a ray lies between in the polar angle', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 180, noNaN: true }),
        (muV, azimuth) => {
          const reads = viewReads(form, ray(muV, azimuth))
          expect(reads.length).toBeLessThanOrEqual(2)
          // The first weight is cos 0ψ = 1 times the slab's share.
          expect(
            reads.reduce((sum, read) => sum + read.weights[0], 0),
          ).toBeCloseTo(1, 12)
          const base = muV >= 0 ? 0 : cosines.length
          for (const read of reads) {
            expect(read.slab).toBeGreaterThanOrEqual(base)
            expect(read.slab).toBeLessThan(base + cosines.length)
          }
          if (reads.length === 2) {
            const [low, high] = reads as [(typeof reads)[0], (typeof reads)[0]]
            expect(high.slab).toBe(low.slab + 1)
            const angle =
              low.weights[0] * Math.acos(cosines[low.slab - base]!) +
              high.weights[0] * Math.acos(cosines[high.slab - base]!)
            expect(angle).toBeCloseTo(Math.acos(Math.abs(muV)), 10)
          }
        },
      ),
    )
    // In the cosine, the share is the cosine's own.
    const [, high] = viewSlabs(cosines, 0.5, 'cosine')
    expect(high!.share).toBeCloseTo(0.5, 12)
    expect(viewSlabs(cosines, 0.45, 'nearest')).toEqual([{ slab: 1, share: 1 }])
  })

  it('weighs the bearing by stretched harmonics, one at the sun’s bearing and ±1 opposite', () => {
    for (let k = 0; k < 4; k += 1) {
      expect(stretchedHarmonic(k, 0.65, 1)).toBeCloseTo(1, 12)
      expect(stretchedHarmonic(k, 0.65, -1)).toBeCloseTo((-1) ** k, 12)
      expect(stretchedHarmonic(k, 1, Math.cos(0.7))).toBeCloseTo(
        Math.cos(k * 0.7),
        12,
      )
    }
    // Straight along the normal there is no bearing: a right angle.
    expect(bearingCosine({ muV: 1, along: 0 })).toBe(0)
    const [read] = viewReads(form, ray(0.3, 0))
    expect(read!.weights).toEqual(
      [1, 1, 1, 1].map((w) => expect.closeTo(w, 12)),
    )
  })
})
