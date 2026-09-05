import { expect, it, vi } from 'vitest'
import { surveyRegionTask } from '@inertialref/workers'
import { headlessEngine } from './headlessEngine.ts'

it('publishes the sampled universe pose and scopes diffuse rendering to its presentation owner', () => {
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.look('s:SOL/b:2', { ease: false })
    game.frame(0)
    expect(game.galaxyPose).toBeNull()
    const layer = game.presentation.push({
      diffuseGalaxy: true,
      observatory: true,
    })
    game.frame(0)
    expect(game.galaxyPose).toEqual(game.harness.observerSample(0))
    game.harness.galaxyJourney(0)
    const before = game.world.stateHash()
    game.harness.galaxyJourney(1, 12)
    game.frame(0.1)
    const shown = game.galaxyPose
    expect(shown).toEqual(game.harness.observerSample(0))
    expect(game.galaxyInstrument).toBe(true)
    expect(game.calibratedLight).toBe(false)
    expect(game.world.stateHash()).toBe(before)
    game.harness.play('tng-intro')
    game.frame(0)
    expect(game.galaxyPose).toBeNull()
    expect(game.galaxyInstrument).toBe(false)
    game.harness.stopCutscene()
    game.harness.look('s:SOL/b:2', { ease: false })
    game.frame(0)
    expect(game.galaxyInstrument).toBe(false)
    expect(game.calibratedLight).toBe(true)
    layer.release()
    game.frame(0)
    expect(game.galaxyPose).toBeNull()
  } finally {
    game.dispose()
  }
})

it('keeps each survey local and its requests and sprite selection bounded along both directions', async () => {
  const game = headlessEngine()
  try {
    game.harness.pause()
    const run = vi.spyOn(game.pool()!, 'run')
    for (const progress of [0, 0.45, 0.7, 0.85, 1, 0.7, 0]) {
      game.harness.galaxyJourney(progress)
      game.frame(0)
      const requests = run.mock.calls.filter(
        ([task]) => task === surveyRegionTask,
      )
      const count = requests.length
      for (let i = 0; i < 5; i++) game.frame(0)
      expect(
        run.mock.calls.filter(([task]) => task === surveyRegionTask),
      ).toHaveLength(count)
      await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
      expect(game.starSurvey.spriteCount).toBeLessThanOrEqual(20_000)
      expect(game.starSurvey.cellCeiling).toBe(125)
    }
    const requests = run.mock.calls.filter(
      ([task]) => task === surveyRegionTask,
    )
    expect(requests.length).toBeGreaterThan(2)
    for (const [, payload] of requests) {
      const request = payload as Parameters<typeof surveyRegionTask.run>[0]
      for (const axis of ['x', 'y', 'z'] as const)
        expect(request.max[axis] - request.min[axis]).toBe(4)
    }
  } finally {
    game.dispose()
  }
})
