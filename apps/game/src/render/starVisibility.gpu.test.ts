import { afterAll, beforeAll, expect, it } from 'vitest'
import { PerspectiveCamera, Scene, Sprite, Vector3 } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { PARSEC } from '@inertialref/shared'
import { createRenderOrigin, UV, vec3 } from '@inertialref/spatial'
import { createStarProjection } from './starProjection.ts'
import { createStarfieldMaterial } from './materials.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})
afterAll(() => gpu.dispose())

it('draws an absolute V hierarchy and leaves no remote or extinguished sprite floor', async () => {
  const projection = createStarProjection(1, { visual: true })
  const transport = uniform(new Vector3(1, 1, 1))
  const field = createStarfieldMaterial(1, projection, transport)
  field.integrated.value = 1
  field.colours.array.fill(1)
  const sprite = new Sprite(field.material)
  sprite.count = 1
  sprite.frustumCulled = false
  const scene = new Scene()
  scene.add(sprite)
  const camera = new PerspectiveCamera(60, 1, 0.1, 1e9)
  const eye = UV.fromMeters(0, 0, 0)
  const origin = createRenderOrigin(eye)
  const render = async (magnitude: number, distance = 10 * PARSEC) => {
    projection.upload({
      ids: ['V source'],
      positions: [UV.fromMeters(0, 0, -distance)],
      luminosities: [1],
      visualLuminosities: [10 ** ((4.81 - magnitude) / 2.5)],
    })
    projection.update(gpu.renderer, origin, eye, vec3(0, 0, 0), true)
    const pixels = await gpu.draw(scene, camera, { float: true })
    let red = 0,
      green = 0,
      blue = 0
    for (let i = 0; i < pixels.data.length; i += 4) {
      red += pixels.data[i]!
      green += pixels.data[i + 1]!
      blue += pixels.data[i + 2]!
    }
    return [red, green, blue] as const
  }
  try {
    const magnitudes = [-1.46, 0.03, 1.98, 7.9, 10, 18]
    const light: number[] = []
    for (const magnitude of magnitudes) light.push((await render(magnitude))[1])
    for (let i = 0; i < 3; i++) expect(light[i]!).toBeGreaterThan(light[i + 1]!)
    expect(light[3]).toBeGreaterThan(0)
    expect(light.slice(4)).toEqual([0, 0])
    expect((await render(-5, 30_000 * PARSEC))[1]).toBe(0)
    const clear = await render(1)
    const { vertexShader } = await gpu.shader(sprite, camera, scene)
    // The V draw reads the three packed source buffers; a brightest-source
    // normalization buffer would be unused work in this absolute-light path.
    expect((vertexShader.match(/var<storage, read>/g) ?? []).length).toBe(3)
    expect(projection.maximum).toBeNull()
    transport.value.set(0.12, 0.1, 0.07)
    const dust = await render(1)
    expect(dust[1]).toBeGreaterThan(0)
    expect(dust[1]).toBeLessThan(clear[1])
    expect(dust[0] / dust[1]).toBeCloseTo(1.2, 5)
    expect(dust[2] / dust[1]).toBeCloseTo(0.7, 5)
    transport.value.set(0, 0, 0)
    expect(await render(1)).toEqual([0, 0, 0])
    expect(projection.diagnostics.reductions).toBe(0)
  } finally {
    projection.dispose()
    field.material.dispose()
    for (const a of [
      field.positions,
      field.colours,
      field.prominence,
      field.visibility,
      field.enabled,
      field.transmission,
    ])
      a.dispose()
  }
})
