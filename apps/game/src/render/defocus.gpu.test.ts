import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  DataTexture,
  FloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  NodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
} from 'three/webgpu'
import { nodeObject, texture, vec4 } from 'three/tsl'
import { DefocusNode } from './defocus.ts'
import { openGpu, type GpuSession, type Pixels } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})

it('warms both gather sizes, shares four targets, and reports the selected work', async () => {
  const source = image(new Float32Array([0.25, 0.5, 0.75, 1]))
  const depth = image(new Float32Array([0, 0, 0.5, 1]))
  const defocus = new DefocusNode(texture(source), texture(depth))
  defocus.parameters.value.set(8, 0)
  defocus.maximum.value = 4
  defocus.enabled.value = 1
  const material = new MeshBasicNodeMaterial()
  material.fragmentNode = nodeObject(defocus)
  const mesh = new Mesh(new PlaneGeometry(2, 2), material)
  const scene = new Scene()
  scene.add(mesh)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2)
  camera.position.z = 1
  const target = new RenderTarget(128, 128, {
    type: FloatType,
    depthBuffer: false,
  })
  const targets = new Set<string>()
  const render = gpu.renderer.render.bind(gpu.renderer)
  const spy = vi
    .spyOn(gpu.renderer, 'render')
    .mockImplementation((object, camera) => {
      const drawn = (object as Mesh).material
      if (
        drawn instanceof NodeMaterial &&
        drawn.name.startsWith('Sensor Defocus ')
      )
        targets.add(gpu.renderer.getRenderTarget()!.texture.uuid)
      return render(object, camera)
    })
  try {
    await gpu.draw(scene, camera, { into: target })
    await defocus.warm(gpu.renderer)
    const pipelines = gpu.pipelinesBuilt()
    for (const diameter of [0.5625, 4, 4.00001, 40, 4]) {
      defocus.maximum.value = diameter
      await gpu.draw(scene, camera, { into: target })
      expect(defocus.samples).toBe(diameter <= 4 ? 12 : 48)
      expect(defocus.passes).toBe(4)
      expect(gpu.pipelinesBuilt()).toBe(pipelines)
    }
    expect(targets.size).toBe(4)
    defocus.enabled.value = 0
    const sharp = await gpu.draw(scene, camera, { into: target })
    expect(defocus.samples).toBe(0)
    expect(defocus.passes).toBe(0)
    expect(sharp.at(64, 64)).toEqual([0.25, 0.5, 0.75, 1])
  } finally {
    spy.mockRestore()
    defocus.dispose()
    source.dispose()
    depth.dispose()
    target.dispose()
    mesh.geometry.dispose()
    material.dispose()
  }
})
afterAll(() => gpu.dispose())

it('uses the active gather count for partial far-layer coverage', async () => {
  const source = image(new Float32Array([0, 0, 0, 1]))
  const depth = image(new Float32Array([0, 0, 0.5, 1]))
  const defocus = new DefocusNode(texture(source), texture(depth))
  defocus.parameters.value.set(4, 1)
  defocus.enabled.value = 1
  const far = new NodeMaterial()
  const near = new NodeMaterial()
  near.fragmentNode = vec4(0)
  const render = gpu.renderer.render.bind(gpu.renderer)
  const spy = vi
    .spyOn(gpu.renderer, 'render')
    .mockImplementation((object, camera) => {
      const mesh = object as Mesh
      const original = mesh.material
      if (
        original instanceof NodeMaterial &&
        /^Sensor Defocus [12]/.test(original.name)
      ) {
        mesh.material = original.name.startsWith('Sensor Defocus 1')
          ? far
          : near
        try {
          return render(object, camera)
        } finally {
          mesh.material = original
        }
      }
      return render(object, camera)
    })
  try {
    // A single source tap covers a quarter of the far layer. The gathered
    // target stores that contribution divided by its number of samples.
    for (const maximum of [4, 4.00001]) {
      const count = maximum <= 4 ? 12 : 48
      far.fragmentNode = vec4(0.25 / count)
      far.needsUpdate = true
      defocus.maximum.value = maximum
      const result = await gpu.drawGraph(nodeObject(defocus), { float: true })
      expect(result.at(64, 64)[0]).toBeCloseTo(0.25, 3)
    }
  } finally {
    spy.mockRestore()
    defocus.dispose()
    source.dispose()
    depth.dispose()
    far.dispose()
    near.dispose()
  }
})

function image(data: Float32Array, size = 1): DataTexture {
  const value = new DataTexture(data, size, size, RGBAFormat, FloatType)
  value.minFilter = value.magFilter = LinearFilter
  value.needsUpdate = true
  return value
}

it('submits twelve source taps per small gather in the actual drawn shaders', async () => {
  const source = image(new Float32Array([0.25, 0.5, 0.75, 1]))
  const depth = image(new Float32Array([0, 0, 0.5, 1]))
  const defocus = new DefocusNode(texture(source), texture(depth))
  defocus.parameters.value.set(4.5, 0)
  defocus.maximum.value = 2.25
  defocus.enabled.value = 1
  const materials: NodeMaterial[] = []
  const render = gpu.renderer.render.bind(gpu.renderer)
  const spy = vi
    .spyOn(gpu.renderer, 'render')
    .mockImplementation((object, camera) => {
      const material = (object as Mesh).material
      if (
        material instanceof NodeMaterial &&
        /^Sensor Defocus [12]/.test(material.name)
      )
        materials.push(material)
      return render(object, camera)
    })
  try {
    await gpu.drawGraph(nodeObject(defocus), { float: true })
    spy.mockRestore()
    expect(defocus.passes).toBe(4)
    expect(materials).toHaveLength(2)
    const reads: number[] = []
    for (const material of materials) {
      const mesh = new Mesh(new PlaneGeometry(2, 2), material)
      const scene = new Scene()
      scene.add(mesh)
      try {
        const { fragmentShader } = await gpu.shader(
          mesh,
          new PerspectiveCamera(),
          scene,
        )
        reads.push(
          (fragmentShader.match(/\btextureSample(?:Level)?\(/g) ?? []).length,
        )
      } finally {
        mesh.geometry.dispose()
      }
    }
    // The far gather additionally reads the center's circle. The near gather
    // uses the frame maximum; it needs only the twelve offset source reads.
    expect(reads.sort((a, b) => a - b)).toEqual([12, 13])
  } finally {
    spy.mockRestore()
    defocus.dispose()
    source.dispose()
    depth.dispose()
  }
})

function moments(pixels: Pixels): { light: number; diameter: number } {
  let light = 0
  let second = 0
  for (let y = 0; y < 128; y += 1)
    for (let x = 0; x < 128; x += 1) {
      const value = pixels.at(x, y)[0]
      light += value
      second += value * ((x - 63.5) ** 2 + (y - 63.5) ** 2)
    }
  // The 4×4 source contributes 2.5 px² before any optical gather.
  return { light, diameter: Math.sqrt(Math.max(0, 8 * (second / light - 2.5))) }
}

it.each([-1, 1])(
  'keeps small %s-side circles normalized and continuous at four pixels',
  async (side) => {
    const data = new Float32Array(128 * 128 * 4)
    for (let y = 62; y < 66; y += 1)
      for (let x = 62; x < 66; x += 1)
        data.set([0.25, 0.5, 0.75, 1], (y * 128 + x) * 4)
    const source = image(data, 128)
    const depth = image(new Float32Array([0, 0, 0.5, 1]))
    const defocus = new DefocusNode(texture(source), texture(depth))
    defocus.enabled.value = 1
    defocus.openness.value = 1
    try {
      let boundary: ReturnType<typeof moments> | undefined
      for (const diameter of [0.5625, 1.35, 2.25, 4, 4.00001]) {
        defocus.parameters.value.set(diameter * 2, side < 0 ? 0 : 1)
        defocus.maximum.value = diameter
        const result = await gpu.drawGraph(nodeObject(defocus), { float: true })
        const measured = moments(result)
        // Positive, shared channel weights conserve the input's four red units
        // and its 1:2:3 hue through either layer; half-float resolves remain.
        expect(Math.abs(measured.light / 4 - 1)).toBeLessThan(0.02)
        for (let i = 0; i < result.data.length; i += 4) {
          expect(
            Math.abs(result.data[i + 1]! - result.data[i]! * 2),
          ).toBeLessThan(0.001)
          expect(
            Math.abs(result.data[i + 2]! - result.data[i]! * 3),
          ).toBeLessThan(0.001)
        }
        if (diameter === 4) boundary = measured
        if (diameter > 4) {
          expect(boundary).toBeDefined()
          expect(Math.abs(measured.diameter - boundary!.diameter)).toBeLessThan(
            0.5,
          )
          expect(Math.abs(measured.light / boundary!.light - 1)).toBeLessThan(
            0.02,
          )
        }
      }
    } finally {
      defocus.dispose()
      source.dispose()
      depth.dispose()
    }
  },
)
