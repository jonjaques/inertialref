import { expect, it } from 'vitest'
import { UV } from '@inertialref/spatial'
import { createStarProjection } from './starProjection.ts'

it.each([true, false])(
  'retains unchanged source buffers and bounds a replacement to active dirty records (compute=%s)',
  (compute) => {
    const projection = createStarProjection(100_000, { compute })
    const sources = {
      ids: ['a', 'b', 'c'],
      positions: [
        UV.fromMeters(1, 2, 3),
        UV.fromMeters(4, 5, 6),
        UV.fromMeters(7, 8, 9),
      ],
      luminosities: [1, 2, 3],
      visualLuminosities: [1, 2, 3],
    }
    const buffers = [
      ...new Set(
        [projection.current, projection.previous].flatMap((coordinates) => [
          coordinates.cells,
          coordinates.offsets,
          coordinates.subcells,
        ]),
      ),
    ]
    try {
      projection.upload(sources)
      const versions = buffers.map((buffer) => buffer.version)
      for (const buffer of buffers) buffer.clearUpdateRanges()
      projection.upload({
        ...sources,
        positions: sources.positions.map((position) => ({ ...position })),
      })
      expect(buffers.map((buffer) => buffer.version)).toEqual(versions)
      projection.upload({
        ...sources,
        ids: ['a', 'b', 'new'],
        positions: [
          ...sources.positions.slice(0, 2),
          UV.fromMeters(10, 11, 12),
        ],
      })
      // A new static source needs one active record, not the unused capacity
      // or a previous position identical to its current one.
      expect(projection.current.cells.updateRanges).toEqual([
        { start: 8, count: 4 },
      ])
      expect(projection.current.offsets.updateRanges).toEqual([
        { start: 8, count: 4 },
      ])
      expect(projection.current.subcells.updateRanges).toEqual([
        { start: 8, count: 4 },
      ])
      if (!compute)
        for (const buffer of [
          projection.previous.cells,
          projection.previous.offsets,
          projection.previous.subcells,
        ])
          expect(buffer.updateRanges).toEqual([])
    } finally {
      projection.dispose()
    }
  },
)
