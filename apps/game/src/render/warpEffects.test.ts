import { expect, it } from 'vitest'
import { PerspectiveCamera } from 'three/webgpu'
import { lensForFov, NO_EFFECTS } from '@inertialref/rendering'
import { Quaternion, vec3 } from '@inertialref/spatial'
import type { CinematicView } from '../engine/GameEngine.ts'
import { createWarpEffects } from './warpEffects.ts'

it('leaves a visible cinematic hull free of unrequested warp and motion effects', () => {
  const camera = new PerspectiveCamera(55, 1, 0.1, 1000)
  camera.updateMatrixWorld()
  const view: CinematicView = {
    frame: 50,
    lens: lensForFov(55),
    camera: { position: vec3(0, 0, 0), orientation: Quaternion.IDENTITY },
    ship: {
      position: vec3(0, 0, -100),
      orientation: Quaternion.IDENTITY,
      visible: true,
    },
    texts: [],
    effects: NO_EFFECTS,
  }
  const fx = createWarpEffects(() => 46)
  try {
    fx.update(camera, view)
    expect(fx.group.visible).toBe(false)
    fx.update(camera, { ...view, effects: { ...NO_EFFECTS, motionSmear: 1 } })
    expect(fx.group.visible).toBe(true)
    fx.update(camera, view)
    expect(fx.group.visible).toBe(false)
  } finally {
    fx.dispose()
  }
})
