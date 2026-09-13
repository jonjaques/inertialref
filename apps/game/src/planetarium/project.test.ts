import { expect, it } from 'vitest'
import { PerspectiveCamera } from 'three/webgpu'
import {
  createRenderOrigin,
  UV,
  Vec,
  Quaternion as Q,
  vec3,
} from '@inertialref/spatial'
import {
  type RenderBody,
  type RenderScene,
  placeAt,
  lensForFov,
} from '@inertialref/rendering'
import { projectScene } from './project.ts'

it('hides a background moon while keeping a foreground transit and the selected body available', () => {
  const origin = createRenderOrigin(UV.fromMeters(0, 0, 0))
  const body = (address: string, z: number, radius: number): RenderBody =>
    ({
      address,
      name: address,
      kind: 'moon',
      placement: placeAt(origin, UV.fromMeters(0, 0, z), radius, Vec.ZERO),
      orientation: Q.IDENTITY,
      trueRadius: radius,
      flattening: 1,
      figure: null,
    }) as RenderBody
  const scene = {
    origin,
    camera: { position: Vec.ZERO, orientation: Q.IDENTITY },
    bodies: [
      body('Saturn', -2e8, 6e7),
      body('behind', -3e8, 1e4),
      body('transit', -1e8, 1e4),
    ],
    stars: [],
  } as unknown as RenderScene
  const camera = new PerspectiveCamera(60, 1, 1, 1e9)
  camera.updateMatrixWorld()
  const candidates = projectScene(
    scene,
    camera,
    { width: 1000, height: 1000 },
    lensForFov(60),
  )
  expect(candidates.find((c) => c.address === 'behind')).toBeUndefined()
  expect(candidates.map((c) => c.address)).toEqual(['Saturn', 'transit'])
  // An object outside the body's silhouette keeps its name too.
  const shifted = {
    ...scene.bodies[1]!,
    placement: placeAt(origin, UV.fromMeters(2e8, 0, -3e8), 1e4, vec3(0, 0, 0)),
  }
  expect(
    projectScene(
      { ...scene, bodies: [scene.bodies[0]!, shifted] },
      camera,
      { width: 1000, height: 1000 },
      lensForFov(60),
    ),
  ).toHaveLength(2)
})
