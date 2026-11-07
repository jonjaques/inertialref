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
  type RenderStation,
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
    stations: [],
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

it('projects a station with what the spacecraft rules read, and hides it behind its planet', () => {
  /*
   * The facts the name rule needs and a body never raises: what it goes
   * round, and whether the eye is inside 2,000 km of it. Behind Earth it is no
   * candidate at all, as a moon is not.
   */
  const origin = createRenderOrigin(UV.fromMeters(0, 0, 0))
  const earth = {
    address: 'earth',
    name: 'Earth',
    kind: 'rocky',
    placement: placeAt(origin, UV.fromMeters(0, 0, -2e7), 6.4e6, Vec.ZERO),
    orientation: Q.IDENTITY,
    trueRadius: 6.4e6,
    flattening: 1,
    figure: null,
  } as unknown as RenderBody
  const station = (address: string, z: number): RenderStation => {
    const placement = placeAt(origin, UV.fromMeters(0, 0, z), 65, Vec.ZERO)
    return {
      id: `@${address}`,
      address,
      name: address,
      kind: 'station',
      asset: 'iss',
      parent: 'earth',
      placement,
      orientation: Q.IDENTITY,
      drawn: !placement.compressed && placement.tier !== 'point',
      sun: null,
    }
  }
  const scene = {
    origin,
    camera: { position: Vec.ZERO, orientation: Q.IDENTITY },
    bodies: [earth],
    stars: [],
    stations: [
      station('close', -1e3),
      station('far', -1e7),
      station('hidden', -3e7),
    ],
  } as unknown as RenderScene
  const camera = new PerspectiveCamera(60, 1, 1, 1e9)
  camera.updateMatrixWorld()
  const candidates = projectScene(
    scene,
    camera,
    { width: 1000, height: 1000 },
    lensForFov(60),
  )
  const close = candidates.find((c) => c.address === 'close')
  expect(close?.kind).toBe('station')
  expect(close?.craft).toEqual({ parent: 'earth', near: true })
  expect(candidates.find((c) => c.address === 'far')?.craft).toEqual({
    parent: 'earth',
    near: false,
  })
  expect(candidates.find((c) => c.address === 'hidden')).toBeUndefined()
  expect(candidates.find((c) => c.address === 'earth')?.craft).toBeNull()
})
