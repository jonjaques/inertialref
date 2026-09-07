import { expect, it } from 'vitest'
import fc from 'fast-check'
import { SECTOR_SIZE, UV } from '@inertialref/spatial'
import { writeStarCoordinates } from './starCoordinates.ts'

it('preserves sector identity and local coordinates through two float32 words', () => {
  fc.assert(
    fc.property(
      fc.integer({ min: -2147483647, max: 2147483647 }),
      fc.double({ min: 0, max: SECTOR_SIZE - 1, noNaN: true }),
      (sector, offset) => {
        const cells = new Int32Array(8)
        const offsets = new Float32Array(8)
        const residuals = new Float32Array(8)
        const point = UV.universeVector(
          sector,
          -sector,
          sector,
          offset,
          offset,
          offset,
        )
        writeStarCoordinates(point, cells, offsets, residuals, 1)
        expect(cells.slice(4, 7)).toEqual(
          new Int32Array([sector, -sector, sector]),
        )
        for (let axis = 4; axis < 7; axis++)
          expect(
            Math.abs(
              (offsets[axis]! + residuals[axis]!) * SECTOR_SIZE - offset,
            ),
          ).toBeLessThanOrEqual(0.002)
        expect(cells[0]).toBe(0)
      },
    ),
    { numRuns: 1000 },
  )
})
