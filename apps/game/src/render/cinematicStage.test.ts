import { expect, it } from 'vitest'
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu'
import { lensForFov, NO_EFFECTS } from '@inertialref/rendering'
import { Quaternion, vec3 } from '@inertialref/spatial'
import type { CinematicView } from '../engine/GameEngine.ts'
import { createLandingEffects } from './cinematicStage.ts'
import { prepareSurfaceModel } from './surfaceModels.ts'
import { createThrusterPlumes } from './plumes.ts'

it('preserves the authored pad deck and metric geometry at the glTF boundary', () => {
  const model = new Group()
  const deck = new Mesh(
    new BoxGeometry(100, 4, 100),
    new MeshStandardMaterial({ color: 0x5b4230 }),
  )
  deck.position.y = -2
  model.add(deck)
  const stage = prepareSurfaceModel(model, 8)
  expect(stage.position.toArray()).toEqual([0, 0, 0])
  expect(stage.scale.toArray()).toEqual([1, 1, 1])
  expect(deck.position.y).toBe(-2)
  expect(deck.material).toBeInstanceOf(MeshStandardNodeMaterial)
})

it('samples a cinematic drive without valve history and extinguishes at touchdown', () => {
  const plumes = createThrusterPlumes({
    nozzles: [],
    drive: { position: { x: 0, y: 0, z: 20 }, radius: 3 },
  })
  try {
    plumes.sample(0.7, 12.5)
    const driven = plumes.group.children.map((child) => child.visible)
    expect(driven).toEqual([true, true])
    plumes.sample(0, 80)
    expect(plumes.group.children.every((child) => !child.visible)).toBe(true)
    plumes.sample(0.7, 12.5)
    expect(plumes.group.children.map((child) => child.visible)).toEqual(driven)
    plumes.sample(0, 12.5)
    expect(plumes.group.children.every((child) => !child.visible)).toBe(true)
  } finally {
    plumes.dispose()
  }
})

it('lights the sky and the dust from the stage sample while the hull is still loading', () => {
  const pose = { position: vec3(0, 0, 0), orientation: Quaternion.IDENTITY }
  const sample: CinematicView = {
    frame: 240,
    elapsedSeconds: 10,
    lens: lensForFov(55),
    camera: pose,
    ship: { ...pose, visible: true, model: 'rocinante' },
    stage: { ...pose, model: 'mars-pad' },
    texts: [],
    effects: { ...NO_EFFECTS, skyHaze: 1, landingDust: 0.5, entryHeat: 1 },
  }
  const fx = createLandingEffects()
  const sky = fx.group.getObjectByName('cinematic-sky')!
  const dust = fx.group.getObjectByName('dust-pose')!
  const entry = fx.group.getObjectByName('entry-pose')!
  try {
    // The cut lands before the script's prop resolves: the stars are already
    // hidden on the sky-haze figure, so the sky must be up on the same frame.
    fx.update(sample, null)
    expect(fx.group.visible).toBe(true)
    expect(sky.visible).toBe(true)
    expect(dust.visible).toBe(true)
    // Only the sheath waits — it is scaled from the hull's beam and length.
    expect(entry.visible).toBe(false)
    fx.update(sample, { lengthMetres: 46, beamMetres: 16 })
    expect(entry.visible).toBe(true)
    expect(entry.children[0]!.scale.toArray()).toEqual([16, 46, 16])
    fx.update(null, null)
    expect(fx.group.visible).toBe(false)
  } finally {
    fx.dispose()
  }
})
