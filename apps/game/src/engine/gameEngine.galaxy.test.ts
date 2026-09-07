import { expect, it, vi } from 'vitest'
import { surveySkyTask } from '@inertialref/workers'
import { ExposureMeter, SURFACE_LUMINANCE } from '@inertialref/rendering'
import { headlessEngine } from './headlessEngine.ts'

it('keeps a visible diffuse sky while orbiting with Enhanced', () => {
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.harness.look('s:SOL/b:2', { ease: false })
    game.presentation.push({ diffuseGalaxy: true, observatory: true })
    game.frame(0)
    const meter = new ExposureMeter()
    game.exposure = meter.update(game.lens, game.sensorSettings, 0)
    expect(game.exposure.total).toBeCloseTo(1 / SURFACE_LUMINANCE, 12)
    const before = game.world.stateHash()
    for (let i = 0; i < 120; i++) {
      game.harness.observatory.setAngles(i * 0.02, 0.25, false)
      game.frame(1 / 60)
      expect(game.galaxyPose).not.toBeNull()
    }
    expect(game.world.stateHash()).toBe(before)
  } finally {
    game.dispose()
  }
})

it('keeps camera mode and unpinned exposure along a galaxy journey', () => {
  const game = headlessEngine()
  try {
    game.harness.pause()
    game.presentation.push({ diffuseGalaxy: true, observatory: true })
    for (const mode of ['enhanced', 'automatic', 'manual'] as const) {
      game.sensorSettings = { ...game.sensorSettings, mode }
      for (const progress of [0, 0.7, 1, 0]) {
        game.harness.galaxyJourney(progress)
        game.frame(0)
        expect(game.galaxyPose).not.toBeNull()
        expect(game.sensorSettings.mode).toBe(mode)
        expect(game.pinnedExposure).toBeNull()
        expect(game.cameraPolicy.processing).toBe(
          mode === 'enhanced' ? 'enhanced' : 'photographic',
        )
      }
      game.harness.galaxyView('face-on')
      game.frame(0)
      expect(game.pinnedExposure).not.toBeNull()
      expect(game.cameraPolicy.processing).toBe('photographic')
      expect(game.sensorSettings.mode).toBe(mode)
      game.harness.look('s:SOL/b:2', { ease: false })
      game.frame(0)
      expect(game.pinnedExposure).toBeNull()
    }
  } finally {
    game.dispose()
  }
})

it('publishes the sampled universe pose and scopes diffuse rendering to its presentation owner', () => {
  const game = headlessEngine()
  try {
    game.sensorSettings = { ...game.sensorSettings, mode: 'automatic' }
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
    expect(game.visibilityProcessing).toBe(false)
    expect(game.world.stateHash()).toBe(before)
    game.harness.play('tng-intro')
    game.frame(0)
    expect(game.galaxyPose).toBeNull()
    expect(game.galaxyInstrument).toBe(false)
    game.harness.stopCutscene()
    game.harness.look('s:SOL/b:2', { ease: false })
    game.frame(0)
    expect(game.galaxyInstrument).toBe(false)
    expect(game.visibilityProcessing).toBe(false)
    layer.release()
    game.frame(0)
    expect(game.galaxyPose).toBeNull()
  } finally {
    game.dispose()
  }
})

it('keeps magnitude surveys and sprite selection bounded along both directions', async () => {
  const game = headlessEngine()
  try {
    game.harness.pause()
    const run = vi.spyOn(game.pool()!, 'run')
    for (const progress of [0, 0.45, 0.7, 0.85, 1, 0.7, 0]) {
      game.harness.galaxyJourney(progress)
      game.frame(0)
      const requests = run.mock.calls.filter(([task]) => task === surveySkyTask)
      const count = requests.length
      for (let i = 0; i < 5; i++) game.frame(0)
      expect(
        run.mock.calls.filter(([task]) => task === surveySkyTask),
      ).toHaveLength(count)
      await vi.waitFor(() => expect(game.starSurvey.pending).toBe(false))
      expect(game.starSurvey.spriteCount).toBeLessThanOrEqual(100_000)
      expect(game.starSurvey.cellCeiling).toBe(2000)
      expect(game.starSurvey.candidateCeiling).toBe(1000000)
      expect(game.starField.resolved).toBeDefined()
    }
    const requests = run.mock.calls.filter(([task]) => task === surveySkyTask)
    expect(requests.length).toBeGreaterThan(2)
    for (const [, payload] of requests) {
      const request = payload as Parameters<typeof surveySkyTask.run>[0]
      expect(request.cellCeiling).toBe(2000)
      expect(request.candidateCeiling).toBe(1000000)
      expect(request.spriteCeiling).toBe(100000)
    }
  } finally {
    game.dispose()
  }
})
