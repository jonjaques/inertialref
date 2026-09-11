import { expect, it } from 'vitest'
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  MeshStandardNodeMaterial,
} from 'three/webgpu'
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
