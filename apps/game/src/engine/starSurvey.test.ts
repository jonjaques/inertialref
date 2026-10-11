import { afterAll, describe, expect, it } from 'vitest'
import { LIGHT_YEAR } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import type { SurveySkyRequest, SurveySkyResponse } from '@inertialref/workers'
import { headlessEngine } from './headlessEngine.ts'
import { StarSurvey } from './starSurvey.ts'

/*
 * The survey over a fake pool and a fake generation. The world is a real one,
 * for its catalog and its galaxy seed; nothing here runs a frame.
 */

const game = headlessEngine()
const world = game.world
afterAll(() => game.dispose())

function fakePool() {
  const requests: {
    request: SurveySkyRequest
    resolve: (response: SurveySkyResponse) => void
  }[] = []
  const run = (request: SurveySkyRequest) =>
    new Promise<SurveySkyResponse>((resolve) => {
      requests.push({ request, resolve })
    })
  return { requests, run }
}

const answer = (request: SurveySkyRequest, id: string): SurveySkyResponse => ({
  origin: request.origin,
  apparentMagnitudeLimit: 8,
  levelMask: 511,
  candidateCount: 1,
  cellsVisited: 1,
  stars: [
    {
      id,
      name: id,
      position: request.origin,
      solarLuminosities: 1,
      visualLuminosities: 1,
      color: [1, 1, 1],
    },
  ],
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
const here = UV.fromMeters(0, 0, 0)
const away = (lightYears: number) =>
  UV.translate(here, { x: lightYears * LIGHT_YEAR, y: 0, z: 0 })

describe('the star survey', () => {
  it('surveys again only past the hysteresis, and never while one is in flight', async () => {
    const pool = fakePool()
    const survey = new StarSurvey(pool.run)
    survey.update(0, here, world)
    await settle()
    expect(pool.requests).toHaveLength(1)
    survey.update(0, away(20), world)
    await settle()
    expect(pool.requests).toHaveLength(1)

    pool.requests[0]!.resolve(answer(pool.requests[0]!.request, 'first'))
    await settle()
    expect(survey.field(0).ids).toContain('first')
    survey.update(0, away(7), world)
    await settle()
    expect(pool.requests).toHaveLength(1)
    survey.update(0, away(9), world)
    await settle()
    expect(pool.requests).toHaveLength(2)
  })

  it('reads empty at a generation it has not surveyed in', async () => {
    const pool = fakePool()
    const survey = new StarSurvey(pool.run)
    survey.update(0, here, world)
    await settle()
    pool.requests[0]!.resolve(answer(pool.requests[0]!.request, 'first'))
    await settle()
    expect(survey.field(0).ids).toContain('first')
    expect(survey.field(1).positions).toHaveLength(0)
    expect(survey.status(1).center).toBeNull()

    // The same eye in a new world surveys again: the hysteresis is about
    // moving, and a replaced world has moved however near the eye is.
    survey.update(1, here, world)
    await settle()
    expect(pool.requests).toHaveLength(2)
  })

  it('discards a survey that lands after its world was replaced', async () => {
    const pool = fakePool()
    const survey = new StarSurvey(pool.run)
    survey.update(0, here, world)
    await settle()
    survey.update(1, here, world)
    pool.requests[0]!.resolve(answer(pool.requests[0]!.request, 'stale'))
    await settle()
    expect(survey.field(1).ids).not.toContain('stale')
    expect(survey.status(1).pending).toBe(false)

    survey.update(1, here, world)
    await settle()
    expect(pool.requests).toHaveLength(2)
    pool.requests[1]!.resolve(answer(pool.requests[1]!.request, 'fresh'))
    await settle()
    expect(survey.field(1).ids).toContain('fresh')
  })

  it('lets a failed survey wait for the next move rather than retry every frame', async () => {
    let calls = 0
    const survey = new StarSurvey(() => {
      calls += 1
      throw new Error('no worker')
    })
    survey.update(0, here, world)
    await settle()
    expect(survey.status(0).pending).toBe(false)
    survey.update(0, here, world)
    await settle()
    expect(calls).toBe(1)
  })
})
