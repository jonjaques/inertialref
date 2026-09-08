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
        solarLuminosities: 1,
        visualLuminosities: 1,
        colour: [1, 1, 1],
      },
    ],
  }
}

afterEach(() => vi.restoreAllMocks())

it('holds a completed source field and its exact diffuse envelope until replacement', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  const submissions = vi.spyOn(game.pool()!, 'run')
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
    const requests = submissions.mock.calls.filter(
      ([task]) => task === surveySkyTask,
    )
    expect((requests[1]![1] as SurveySkyRequest).coverage).toBe(
      (requests[0]![1] as SurveySkyRequest).coverage,
    )
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

it('keeps a completed empty exterior sky while the next survey runs', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.galaxyJourney(1)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve({ ...response(pending[0]!.request, 'none'), stars: [] })
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    const completed = game.starField
    expect(completed.ids).toHaveLength(0)
    expect(completed.resolved).toBeDefined()
    game.harness.galaxyJourney(0.9)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(game.starField).toBe(completed)
    expect(game.starField.ids).toHaveLength(0)
    pending[1]!.resolve(response(pending[1]!.request, 'return'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toContain('return')
  } finally {
    game.dispose()
  }
})

it('retains the completed sky after failure and retries only after travel', async () => {
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
    for (let i = 0; i < 120; i++) game.frame(0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(pending).toHaveLength(2)
    game.harness.galaxyJourney(0.9)
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

it('reselects catalog sources during travel when no survey has completed', async () => {
  const pending = controlledSurveys()
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.galaxyJourney(0)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    const first = game.starField
    pending[0]!.reject(new Error('worker unavailable'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    game.harness.galaxyJourney(0.8)
    game.frame(0)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    expect(game.starField).not.toBe(first)
    expect(game.starField.resolved).toBeUndefined()
    pending[1]!.resolve(response(pending[1]!.request, 'recovered'))
    await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
    expect(game.starField.ids).toContain('recovered')
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
