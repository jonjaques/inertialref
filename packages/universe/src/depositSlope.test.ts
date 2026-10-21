import { describe, expect, it } from 'vitest'
import { rootSeed } from '@inertialref/procedural'
import { TEST_CATALOG } from './catalog/fixture.ts'
import {
  DEPOSIT_SLOPE_KNOTS,
  depositSlopeAt,
  depositSlopeKnot,
  depositSlopeTable,
} from './depositSlope.ts'
import { catalogStub, MILKY_WAY } from './galaxy.ts'
import { type Body, generateSystem, walkBodies } from './system.ts'
import { surfaceDetailFloor } from './terrain.ts'

/*
 * The table is a monotone map from a level's drawn slope onto the floor's
 * distribution: identity at the floor, rank-keeping everywhere, steeper at a
 * coarser level for the same drawn slope — because a coarse patch's normal is
 * the ground smoothed over its cell, and the floor's distribution is rougher.
 * Probes are cut to 64 here; the production count is a worker's seconds and
 * its figures are in ADR-0051.
 */

const SOL = generateSystem(
  rootSeed('inertialref'),
  MILKY_WAY,
  catalogStub(TEST_CATALOG.stars[0] as (typeof TEST_CATALOG.stars)[number]),
)
const find = (name: string): Body => {
  for (const body of walkBodies(SOL)) if (body.name === name) return body
  throw new Error(`no ${name} in Sol`)
}
const MIRANDA = find('Miranda')
const PROBES = 64

describe('the deposit slope table', () => {
  const table = depositSlopeTable(MIRANDA.surface, undefined, PROBES)
  const floor = surfaceDetailFloor(MIRANDA.surface)
  const at = (level: number, k: number): number =>
    table.table[level * DEPOSIT_SLOPE_KNOTS + k] as number

  it('has a row for every level from the root to the floor', () => {
    expect(table.levels).toBe(floor + 1)
    expect(table.table).toHaveLength(table.levels * DEPOSIT_SLOPE_KNOTS)
    for (const value of table.table) expect(Number.isFinite(value)).toBe(true)
  })

  it('leaves the floor as it is drawn', () => {
    for (let k = 0; k < DEPOSIT_SLOPE_KNOTS; k += 1) {
      expect(at(floor, k)).toBeCloseTo(Math.log10(depositSlopeKnot(k)), 5)
    }
  })

  it('keeps rank: a steeper drawn slope never maps flatter', () => {
    for (let level = 0; level < table.levels; level += 1) {
      for (let k = 1; k < DEPOSIT_SLOPE_KNOTS; k += 1) {
        expect(at(level, k)).toBeGreaterThanOrEqual(at(level, k - 1))
      }
    }
  })

  /*
   * The whole point, as an ordering: the middle of a coarse level's own
   * distribution maps steeper than it is drawn, because the floor's ground is
   * rougher than any smoothing of it.
   */
  it('steepens a coarse level toward the floor’s roughness', () => {
    const middle = Math.floor(DEPOSIT_SLOPE_KNOTS * 0.6)
    expect(at(Math.max(0, floor - 6), middle)).toBeGreaterThan(
      Math.log10(depositSlopeKnot(middle)),
    )
  })

  it('is the same table whoever asks first', () => {
    const again = depositSlopeTable({ ...MIRANDA.surface }, undefined, PROBES)
    expect(again.table).toEqual(table.table)
  })
})

describe('the slope a deposit reads', () => {
  const table = depositSlopeTable(MIRANDA.surface, undefined, PROBES)
  const floor = surfaceDetailFloor(MIRANDA.surface)
  // 1 − cos θ from a few degrees to steep, the range the thresholds sit in.
  const slopes = [0.5, 3, 10, 20, 33, 50, 70].map(
    (degrees) => 1 - Math.cos((degrees * Math.PI) / 180),
  )

  it('is the slope as drawn at the floor, with no table, and off a patch', () => {
    for (const slope of slopes) {
      // The table is float32: a log₁₀ tan² down to −7 is held to 8e-7, which
      // is 2e-6 of the slope once it is raised back.
      const floored = depositSlopeAt(table, floor, 0, slope)
      expect(Math.abs(floored - slope) / slope).toBeLessThan(2e-6)
      expect(depositSlopeAt(null, 3, 0.5, slope)).toBeCloseTo(slope, 10)
      expect(depositSlopeAt(table, -1, 0, slope)).toBe(slope)
    }
  })

  it('is the parent’s row at the end of the morph', () => {
    const level = floor - 3
    for (const slope of slopes) {
      expect(depositSlopeAt(table, level, 1, slope)).toBeCloseTo(
        depositSlopeAt(table, level - 1, 0, slope),
        12,
      )
    }
  })

  it('never reads a steeper drawn slope as flatter', () => {
    for (let level = 0; level <= floor; level += 1) {
      let previous = 0
      for (let i = 0; i <= 200; i += 1) {
        const mapped = depositSlopeAt(table, level, 0, i / 200)
        expect(mapped).toBeGreaterThanOrEqual(previous - 1e-12)
        previous = mapped
      }
    }
  })
})
