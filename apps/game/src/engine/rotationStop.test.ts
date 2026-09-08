import { expect, it } from 'vitest'
import { ThrusterVisuals } from '@inertialref/rendering'
import { thrusterLayoutFor } from '../render/thrusterLayouts.ts'
import { Vec } from '@inertialref/spatial'
import { headlessEngine } from './headlessEngine.ts'

it('retains a counter-thrust cue when spin starts and stops between rendered frames', () => {
  const game = headlessEngine()
  try {
    game.harness.flightAssist(false)
    game.harness.control({ rotation: [1, -1, 0.5] })
    game.harness.step(8)
    game.harness.hold()
    const player = game.session.player()!
    const spin = game.world.entities.require(player).state.angularVelocity
    expect(Vec.length(spin)).toBeGreaterThan(0)
    const saved = game.harness.save()
    game.killRotation()
    expect(game.world.entities.require(player).state.angularVelocity).toEqual(
      Vec.ZERO,
    )
    expect(game.rotationStop).toBeDefined()
    expect(game.rotationStop).not.toBeNull()
    expect(Vec.dot(game.rotationStop!.angular, spin)).toBeLessThan(0)
    const hash = game.world.stateHash()
    game.killRotation()
    expect(game.world.stateHash()).toBe(hash)
    expect(game.rotationStop).not.toBeNull()
    expect(game.harness.load(saved).ok).toBe(true)
    expect(game.rotationStop).toBeNull()
  } finally {
    game.dispose()
  }
})

it('keeps valve variation and stop cues out of the flight state and save', () => {
  const pictured = headlessEngine()
  const bare = headlessEngine()
  try {
    for (const game of [pictured, bare]) {
      game.harness.flightAssist(false)
      game.harness.control({ rotation: [0, 1, 0] })
      game.harness.step(12)
      game.harness.hold()
    }
    pictured.killRotation()
    bare.world.killRotation(bare.session.player()!)
    const visuals = new ThrusterVisuals(thrusterLayoutFor('rocinante'))
    for (let frame = 0; frame < 600; frame += 1) {
      visuals.sample(
        null,
        frame / 60,
        pictured.rotationStop,
        true,
        frame % 2 === 0,
      )
      pictured.harness.step(1)
      bare.harness.step(1)
    }
    expect(pictured.world.stateHash()).toBe(bare.world.stateHash())
    expect(pictured.harness.save()).toBe(bare.harness.save())
  } finally {
    pictured.dispose()
    bare.dispose()
  }
})
