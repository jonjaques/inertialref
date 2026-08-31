import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { Vec } from '@inertialref/spatial'
import { regionAddress } from './address.ts'
import { TEST_CATALOG } from './catalog/fixture.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import { terrainSketch } from './sketch.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import { regionDirection } from './terrain.ts'
import {
  GRIT_FRAMES_AT,
  KERNEL_RECORDS,
  KERNEL_WORDS,
  LEVELS_AT,
  MAX_KERNEL_LEVELS,
  PLATES_AT,
  sampleOffset,
  surfaceKernel,
  TILE_STRIDE,
  WORD,
  writeTileFrame,
} from './terrainKernel.ts'

/*
 * The frame a tile is evaluated in, held on the CPU.
 *
 * The kernel itself runs only under `pnpm test:gpu`; what runs here is the
 * arithmetic it rests on, which is float64 and testable anywhere. Two claims:
 * that `sampleOffset` is the difference of two `regionDirection`s without
 * ever subtracting them, and that an anchor cell plus its fraction plus a
 * sample's offset lands on the lattice coordinate `levelContribution` floors
 * — at every rung, including the one-meter one where an absolute float32
 * direction is a fifth of a crater wide.
 */

const ROOT = rootSeed('inertialref')
const SOL = generateSystem(
  ROOT,
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)

const find = (name: string): Body => {
  for (const body of walkBodies(SOL)) if (body.name === name) return body
  throw new Error(`no ${name} in Sol`)
}

const region = fc
  .record({
    face: fc.integer({ min: 0, max: 5 }),
    level: fc.integer({ min: 0, max: 22 }),
    u: fc.double({ min: 0, max: 1, noNaN: true }),
    v: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ face, level, u, v }) => {
    const span = 2 ** level
    return regionAddress(
      face,
      level,
      Math.min(span - 1, Math.floor(u * span)),
      Math.min(span - 1, Math.floor(v * span)),
    )
  })

/** A sample position, the border rows included: `[-2/64, 1 + 2/64]`. */
const position = fc.integer({ min: -2, max: 66 }).map((index) => index / 64)

describe('sampleOffset', () => {
  it('is the difference of two regionDirections, to float64', () => {
    fc.assert(
      fc.property(region, position, position, (address, s, t) => {
        const direct = Vec.sub(
          regionDirection(address, s, t),
          regionDirection(address, 0.5, 0.5),
        )
        const offset = sampleOffset(address, s, t)
        /*
         * Relative to the offset's own size, which is what the kernel needs:
         * an absolute bound would pass a level-22 tile whose whole offset is
         * 1e-7 with an error that is the whole offset.
         *
         * The second term is the *reference's* error, not the formula's. At
         * level 22 two adjacent samples are 4e-9 apart, and subtracting two
         * float64 unit vectors there keeps about seven digits of the
         * difference — which is the whole reason `sampleOffset` never
         * subtracts them. A few ulps of a unit vector over the offset's size
         * is what the naive subtraction can be trusted to, and the formula is
         * held to that or to a billionth, whichever is looser.
         */
        const scale = Math.max(Vec.length(direct), 1e-300)
        const bound = Math.max(1e-9, (8 * Number.EPSILON) / scale)
        expect(Vec.length(Vec.sub(direct, offset)) / scale).toBeLessThan(bound)
      }),
      { numRuns: 400 },
    )
  })

  it('is exactly zero at the center', () => {
    fc.assert(
      fc.property(region, (address) => {
        // A length rather than a tuple: a face's fixed axis comes out as
        // `-0` on the negative faces, which is zero.
        expect(Vec.length(sampleOffset(address, 0.5, 0.5))).toBe(0)
      }),
    )
  })
})

describe('surfaceKernel', () => {
  it('packs every rung the sketch has, canonical then tail, with its rung number', () => {
    for (const name of ['Luna', 'Mercury', 'Earth', 'Iapetus', 'Enceladus']) {
      const body = find(name)
      const kernel = surfaceKernel(body.surface)
      const sketch = terrainSketch(body.surface)
      expect(kernel.words[WORD.CRATER_LEVELS]).toBe(sketch.craterLevels.length)
      expect(kernel.words[WORD.MICRO_LEVELS]).toBe(sketch.microLevels.length)
      expect(kernel.rungs).toHaveLength(
        sketch.craterLevels.length + sketch.microLevels.length,
      )
      expect(kernel.rungs.length).toBeLessThanOrEqual(MAX_KERNEL_LEVELS)
      kernel.rungs.forEach((rung, index) => {
        const at = (LEVELS_AT + index) * 4
        expect(kernel.records[at]).toBe(Math.fround(rung.cells))
        expect(kernel.records[at + 3]).toBe(
          index < sketch.craterLevels.length
            ? index
            : sketch.microFirstRung + index - sketch.craterLevels.length,
        )
      })
      expect(kernel.records).toHaveLength(KERNEL_RECORDS * 4)
      expect(kernel.words).toHaveLength(KERNEL_WORDS)
    }
  })

  it('is packed once per surface', () => {
    const luna = find('Luna')
    expect(surfaceKernel(luna.surface)).toBe(surfaceKernel(luna.surface))
  })

  it('carries the plates a plate world has and none for a stagnant lid', () => {
    const earth = surfaceKernel(find('Earth').surface)
    const mercury = surfaceKernel(find('Mercury').surface)
    expect(earth.words[WORD.PLATES]).toBeGreaterThan(1)
    expect(mercury.words[WORD.PLATES]).toBe(1)
    // The first plate's axis is a unit vector, which is the record's shape.
    const axis = earth.records.subarray(PLATES_AT * 4, PLATES_AT * 4 + 3)
    expect(
      Math.hypot(axis[0] as number, axis[1] as number, axis[2] as number),
    ).toBeCloseTo(1, 5)
  })
})

describe('writeTileFrame', () => {
  it('reconstructs the lattice coordinate at every rung, to a millionth of a cell', () => {
    /*
     * Luna's tail reaches one meter — 1.7 million cells per unit — and Earth's
     * 6.4 million, the largest in scope. At those scales float32 holds the
     * integer part exactly and the fraction to 6e-8, so a millionth is loose
     * against the arithmetic and tight against the failure this exists to
     * catch: a frame taken from the wrong direction, or a fraction that lost
     * its integer.
     */
    const bodies = [find('Luna'), find('Earth'), find('Iapetus')]
    fc.assert(
      fc.property(
        fc.constantFrom(...bodies),
        region,
        position,
        position,
        (body, address, s, t) => {
          const kernel = surfaceKernel(body.surface)
          const out = new Float32Array(TILE_STRIDE * 4)
          writeTileFrame(kernel, address, out, 0)
          expect(out[0]).toBe(address.face)
          expect(out[1]).toBe(address.level)
          expect(out[2]).toBe(address.i)
          expect(out[3]).toBe(address.j)

          const direction = regionDirection(address, s, t)
          const offset = sampleOffset(address, s, t)
          const frames = [
            ...kernel.rungs.map((rung, index) => ({
              index,
              cells: rung.cells,
            })),
            ...kernel.gritFrequencies.map((cells, k) => ({
              index: GRIT_FRAMES_AT + k,
              cells,
            })),
          ]
          for (const { index, cells } of frames) {
            const cell = 4 + index * 8
            const fraction = cell + 4
            for (const [axis, component, offsetComponent] of [
              [0, direction.x, offset.x],
              [1, direction.y, offset.y],
              [2, direction.z, offset.z],
            ] as const) {
              const c0 = out[cell + axis] as number
              const f0 = out[fraction + axis] as number
              expect(Number.isInteger(c0)).toBe(true)
              expect(f0).toBeGreaterThanOrEqual(0)
              expect(f0).toBeLessThan(1)
              const reconstructed = c0 + f0 + offsetComponent * cells
              expect(Math.abs(reconstructed - component * cells)).toBeLessThan(
                1e-6,
              )
            }
          }
        },
      ),
      { numRuns: 300 },
    )
  })

  it('refuses a level its face coordinates cannot carry exactly', () => {
    const kernel = surfaceKernel(find('Luna').surface)
    const out = new Float32Array(TILE_STRIDE * 4)
    expect(() =>
      writeTileFrame(kernel, regionAddress(0, 24, 0, 0), out, 0),
    ).toThrow(/level 23/)
  })
})
