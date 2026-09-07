import { afterEach, expect, it, vi } from 'vitest'
import { PARSEC } from '@inertialref/shared'
import { UV } from '@inertialref/spatial'
import { encodeUniverseVector } from '@inertialref/protocol'
import {
  surveySkyTask,
  type SurveySkyRequest,
  type SurveySkyResponse,
} from '@inertialref/workers'
import { headlessEngine } from './headlessEngine.ts'

function controlledSurveys() {
  const pending: {
    request: SurveySkyRequest
    resolve: (response: SurveySkyResponse) => void
    reject: (cause: Error) => void
  }[] = []
  vi.spyOn(surveySkyTask, 'run').mockImplementation(
    (request) =>
      new Promise((resolve, reject) => {
        pending.push({ request, resolve, reject })
      }),
  )
  return pending
}

function response(request: SurveySkyRequest, id: string): SurveySkyResponse {
  return {
    origin: request.origin,
    apparentMagnitudeLimit: 8,
    levelMask: 511,
    candidateCount: 1,
    cellsVisited: 1,
    stars: [
      {
        id,
        name: id,
        position: encodeUniverseVector(
          UV.translate(UV.universeVector(...request.origin), {
            x: PARSEC,
            y: 0,
            z: 0,
          }),
        ),
        spectralType: 'G',
        solarMasses: 1,
        solarRadii: 1,
        solarLuminosities: 1,
        visualLuminosities: 1,
        temperature: 5778,
        colour: [1, 1, 1],
        components: 1,
        catalogued: false,
        planets: [],
      },
    ],
  }
}

afterEach(() => vi.restoreAllMocks())

it('holds a completed source field and its exact diffuse envelope until replacement', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.galaxyJourney(0)
    game.frame(0)
    expect(game.starField.ids.length).toBeGreaterThan(0)
    expect(game.starField.resolved).toBeUndefined()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve(response(pending[0]!.request, 'first'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    const completed = game.starField
    const hash = game.world.stateHash()
    expect(completed.ids).toContain('first')

    game.harness.galaxyJourney(0.8)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(game.starField).toBe(completed)
    expect(game.starField.resolved).toBe(completed.resolved)
    expect(game.starSurvey.center).not.toEqual(completed.resolved!.origin)
    game.harness.galaxyJourney(0.9)
    for (let i = 0; i < 5; i++) game.frame(0)
    expect(pending).toHaveLength(2)
    expect(game.starField).toBe(completed)

    pending[1]!.resolve(response(pending[1]!.request, 'second'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toContain('second')
    expect(game.starField.ids).not.toContain('first')
    expect(game.starField.resolved!.origin).toEqual(
      UV.universeVector(...pending[1]!.request.origin),
    )
    expect(game.world.stateHash()).toBe(hash)
  } finally {
    game.dispose()
  }
})

it('retains the completed sky after failure and retries at the current observer', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.galaxyJourney(0)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve(response(pending[0]!.request, 'first'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    const completed = game.starField
    game.harness.galaxyJourney(0.8)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.reject(new Error('survey unavailable'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField).toBe(completed)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    expect(game.starField).toBe(completed)
    pending[2]!.resolve(response(pending[2]!.request, 'retry'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toContain('retry')
  } finally {
    game.dispose()
  }
})

it('drops the completed envelope on world replacement and rejects its late reply', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.frame(0)
    await game.save('survey-world')
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve(response(pending[0]!.request, 'first'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    game.harness.galaxyJourney(0.8)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(await game.load('survey-world')).toBe(true)
    expect(game.starField.ids).toHaveLength(0)
    expect(game.starField.resolved).toBeUndefined()
    pending[1]!.resolve(response(pending[1]!.request, 'stale'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toHaveLength(0)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(3))
    expect(game.starField.ids.length).toBeGreaterThan(0)
    expect(game.starField.resolved).toBeUndefined()
    pending[2]!.resolve(response(pending[2]!.request, 'new-world'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toContain('new-world')
    expect(game.starField.ids).not.toContain('stale')
  } finally {
    game.dispose()
  }
})
