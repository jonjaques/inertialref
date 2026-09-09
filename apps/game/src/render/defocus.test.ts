import { expect, it } from 'vitest'
import { GLASS_PRESETS } from '@inertialref/rendering'
import { irisPattern } from './defocus.ts'

it('redistributes a small gather across the full iris', () => {
  const small = irisPattern(GLASS_PRESETS.flight, 12)
  const full = irisPattern(GLASS_PRESETS.flight)
  expect(small).toHaveLength(12)
  expect(full).toHaveLength(48)
  expect(Math.max(...small.map(([x, y]) => Math.hypot(x, y)))).toBeGreaterThan(
    0.9,
  )
  const moment = (points: readonly (readonly [number, number])[]) =>
    points.reduce((sum, [x, y]) => sum + x * x + y * y, 0) / points.length
  // Twelve samples cover the same iris area. Taking the first twelve of the
  // old pattern instead shrinks its second moment to about one quarter.
  expect(Math.abs(moment(small) / moment(full) - 1)).toBeLessThan(0.01)
  expect(small.every(([x, y]) => Number.isFinite(x + y))).toBe(true)
  expect(small.every(([x, y]) => Math.hypot(x, y) <= 1)).toBe(true)
})
