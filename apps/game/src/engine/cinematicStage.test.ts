import { expect, it, vi } from 'vitest'
import { Quaternion, UV, vec3 } from '@inertialref/spatial'
import { headlessEngine } from './headlessEngine.ts'

it('holds the stage ephemeris while the director keeps advancing', () => {
  const game = headlessEngine()
  game.frame(1 / 60)
  game.harness.play('tng-intro')
  const sample = game.harness.cutsceneSample(game.world.clock.renderTime)!
  const held = game.world.clock.renderTime
  const stage = {
    model: 'mars-pad' as const,
    position: UV.translate(sample.camera.position, vec3(40, 20, -100)),
    orientation: Quaternion.IDENTITY,
  }
  const sampleCutscene = vi
    .spyOn(game.harness, 'cutsceneSample')
    .mockReturnValue({
      ...sample,
      presentationTime: held,
      elapsedSeconds: 12.5,
      stage,
      ship: { ...sample.ship, model: 'rocinante', throttle: 0.7 },
    })
  try {
    game.frame(1 / 60)
    game.frame(1 / 60)
    expect(game.snapshot?.renderTime).toBe(held)
    expect(sampleCutscene.mock.calls.at(-1)?.[0]).toBeGreaterThan(held)
    expect(game.cinematic?.stage?.model).toBe('mars-pad')
    expect(game.cinematic?.ship.model).toBe('rocinante')
    expect(game.cinematic?.ship.throttle).toBe(0.7)
    expect(game.cinematic?.elapsedSeconds).toBe(12.5)
    const view = game.cinematic!
    expect(UV.difference(stage.position, sample.camera.position)).toEqual(
      vec3(
        view.stage!.position.x - view.camera.position.x,
        view.stage!.position.y - view.camera.position.y,
        view.stage!.position.z - view.camera.position.z,
      ),
    )
  } finally {
    sampleCutscene.mockRestore()
    game.dispose()
  }
})
