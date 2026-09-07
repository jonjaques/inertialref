import { afterAll, beforeAll, expect, it } from 'vitest'
import { PerspectiveCamera, Scene, Sprite } from 'three/webgpu'
import { instanceIndex, mix, uniform, varying, vec3 } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { rootSeed } from '@inertialref/procedural'
import { createRenderOrigin, UV, vec3 as vector } from '@inertialref/spatial'
import {
  createGalaxyField,
  integrateStarExtinction,
} from '@inertialref/universe'
import { createStarProjection } from './starProjection.ts'
import { createStarfieldMaterial } from './materials.ts'
import { acquireGalaxyStructure } from './galaxyStructure.ts'
import { createGalaxyKernel } from './galaxyKernel.ts'
import { StarExtinctionCache } from './starExtinctionCache.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})
afterAll(() => gpu.dispose())

it('draws the retained dust transmission through the production sprite material', async () => {
  const field = createGalaxyField(rootSeed('inertialref'))
  const structure = acquireGalaxyStructure(gpu.renderer)
  const kernel = createGalaxyKernel(field, {
    structure: (position) => structure.table.sample(position),
  })
  const cache = new StarExtinctionCache(1, field, { kernel })
  const projection = createStarProjection(1)
  const attenuate = uniform(0)
  const material = createStarfieldMaterial(
    1,
    projection,
    mix(vec3(1), varying(cache.sample(instanceIndex)), attenuate),
  )
  material.colours.array.fill(1)
  material.size.value = 30
  const sprite = new Sprite(material.material)
  sprite.count = 1
  sprite.frustumCulled = false
  const scene = new Scene()
  scene.add(sprite)
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e9)
  const observer = UV.fromMeters(-8178 * PARSEC, 20.8 * PARSEC, 0)
  const star = UV.translate(observer, vector(0, 0, -400 * PARSEC))
  projection.upload({ ids: ['dust'], positions: [star], luminosities: [1] })
  projection.update(
    gpu.renderer,
    createRenderOrigin(observer),
    observer,
    vector(0, 0, 0),
    false,
  )
  try {
    const clear = await gpu.draw(scene, camera, { float: true })
    const shader = await gpu.shader(sprite, camera, scene)
    expect(
      shader.vertexShader.match(/var<storage/g)?.length ?? 0,
    ).toBeLessThanOrEqual(8)
    cache.configure(
      { ids: ['dust'], positions: [star], catalogued: [false] },
      observer,
    )
    await structure.table.warm(gpu.renderer)
    await cache.warm(gpu.renderer)
    for (let frame = 0; frame < 8; frame++) cache.advance(gpu.renderer)
    attenuate.value = 1
    const dusty = await gpu.draw(scene, camera, { float: true })
    const expected = integrateStarExtinction(field, observer, star)
    const baseline = clear.at(64, 64)
    const actual = dusty.at(64, 64)
    expect(baseline[1]).toBeGreaterThan(0)
    expect(actual[1]).toBeLessThan(baseline[1])
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(
          actual[channel]! / baseline[channel]! -
            expected.transmittanceRgb[channel]!,
        ),
      ).toBeLessThan(0.04)
  } finally {
    cache.dispose()
    structure.release()
    projection.dispose()
    material.material.dispose()
    for (const a of [
      material.positions,
      material.colours,
      material.prominence,
      material.visibility,
      material.enabled,
      material.transmission,
    ])
      a.dispose()
  }
})
