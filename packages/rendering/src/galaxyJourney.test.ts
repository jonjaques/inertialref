import fc from 'fast-check'
import { expect, it } from 'vitest'
import { LIGHT_YEAR, PARSEC } from '@inertialref/shared'
import { UV, Vec, Quaternion as Q } from '@inertialref/spatial'
import { SUN_POSITION } from '@inertialref/universe'
import {
  createGalaxyJourney,
  galaxyJourneyState,
  galaxyJourneyProgress,
} from './galaxyJourney.ts'
import {
  clampDistance,
  MAX_OBSERVER_DISTANCE,
  observerPose,
} from './observer.ts'

const route = createGalaxyJourney(SUN_POSITION, 6_371_000)
it('maps a reversible logarithmic progress to finite poses inside the coordinate domain', () => {
  fc.assert(
    fc.property(fc.double({ min: 0, max: 1, noNaN: true }), (progress) => {
      const state = galaxyJourneyState(route, progress)
      expect(galaxyJourneyProgress(route, state.distance)).toBeCloseTo(
        progress,
        12,
      )
      expect(state.distance).toBeGreaterThanOrEqual(route.startDistance)
      expect(state.distance).toBeLessThanOrEqual(route.endDistance)
      const pose = observerPose(SUN_POSITION, state)
      expect(Object.values(pose.position).every(Number.isFinite)).toBe(true)
      for (const sector of [
        pose.position.sx,
        pose.position.sy,
        pose.position.sz,
      ])
        expect(Math.abs(sector)).toBeLessThan(UV.SECTOR_INDEX_LIMIT)
      expect(Vec.length(Q.basis(pose.orientation).forward)).toBeCloseTo(1, 12)
    }),
  )
})
it('ordinary zoom admits the centered endpoint and keeps its upper bound', () => {
  expect(route.endDistance / LIGHT_YEAR).toBeGreaterThan(100_000)
  expect(clampDistance(route.endDistance, 6_371_000)).toBe(route.endDistance)
  expect(clampDistance(1e25, 6_371_000)).toBe(MAX_OBSERVER_DISTANCE)
  expect(MAX_OBSERVER_DISTANCE).toBe(110_000 * LIGHT_YEAR)
  const end = observerPose(SUN_POSITION, galaxyJourneyState(route, 1))
  expect(
    UV.distance(end.position, UV.fromMeters(0, 30000 * PARSEC, 0)) / PARSEC,
  ).toBeLessThan(1e-8)
})
