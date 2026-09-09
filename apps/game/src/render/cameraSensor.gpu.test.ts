import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import {
  FloatType,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  SphereGeometry,
  PerspectiveCamera,
  SRGBColorSpace,
  LinearSRGBColorSpace,
  NoToneMapping,
  QuadMesh,
  NodeMaterial,
} from 'three/webgpu'
import { texture, vec3, vec4 } from 'three/tsl'
import {
  DEFAULT_SENSOR_SETTINGS,
  LENS_PRESETS,
  GALAXY_VIEWS,
  SURFACE_LUMINANCE,
  type SensorSettings,
} from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { sensorRadiance } from './radiance.ts'
import { createHistogramMeter } from './meter.ts'
import { composeSky } from './enhancedSky.ts'
import { installToneCurve } from './tonemap.ts'
import { DISPLAY_P3, LINEAR_P3 } from './gamut.ts'
import { createRenderOrigin, rebase, UV } from '@inertialref/spatial'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(32, 32)
})

it.each([SRGBColorSpace, DISPLAY_P3, LINEAR_P3])(
  'keeps the complete %s camera shader within the WGSL private-storage budget',
  async (colorSpace) => {
    const renderer = gpu.renderer
    const previousColor = renderer.outputColorSpace
    const previousTone = renderer.toneMapping
    renderer.outputColorSpace = colorSpace
    declareSceneTarget(renderer, { samples: 4, optics: true })
    installToneCurve(renderer, 1)
    const scene = new Scene()
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    const sensor = createSensor(renderer, scene, camera, () => ({
      lens: LENS_PRESETS.flight,
      settings: DEFAULT_SENSOR_SETTINGS,
      time: 0,
      headroom: 1,
      pinned: null,
      noiseTick: 0,
    }))
    const compile = vi.spyOn(renderer, 'compileAsync')
    try {
      await sensor.warm()
      const final = compile.mock.calls.find(
        ([object]) =>
          object instanceof QuadMesh &&
          !Array.isArray(object.material) &&
          object.material.name === 'RenderPipeline',
      )
      expect(
        final,
        'the actual camera output quad must be compiled',
      ).toBeDefined()
      const [quad, outputCamera] = final!
      // Inspect the same linear, untonemapped output context warmPipeline uses.
      // The camera graph already contains its one final output transform.
      renderer.outputColorSpace = LinearSRGBColorSpace
      renderer.toneMapping = NoToneMapping
      const { fragmentShader } = await gpu.shader(quad, outputCamera, scene)
      const declarations = [
        ...fragmentShader.matchAll(/var<private>\s+\w+\s*:\s*([^;]+);/g),
      ]
      expect(declarations.length).toBeGreaterThan(0)
      expect(declarations.length).toBe(
        fragmentShader.match(/var<private>/g)?.length,
      )
      // WGSL sums SizeOf for all private variables, including output padding.
      // Keep the supported types explicit so a builder change cannot undercount.
      const sizes: Record<string, number> = {
        f32: 4,
        i32: 4,
        u32: 4,
        'vec2<f32>': 8,
        'vec3<f32>': 12,
        'vec4<f32>': 16,
        OutputStruct: 32,
      }
      const output = fragmentShader.match(
        /struct OutputStruct\s*\{([^}]+)\}/,
      )?.[1]
      expect(output?.replace(/@\w+\([^)]*\)|\s/g, '')).toBe(
        'color:vec4<f32>,depth:f32',
      )
      let bytes = 0
      for (const [, type] of declarations) {
        const size = sizes[type!.trim()]
        expect(size, `unknown private WGSL type: ${type}`).toBeDefined()
        bytes += size!
      }
      console.log(
        `Camera ${colorSpace}: ${bytes} bytes of private WGSL storage`,
      )
      // https://www.w3.org/TR/WGSL/#limits: implementations may enforce 8192.
      expect(bytes).toBeLessThanOrEqual(8192)
    } finally {
      compile.mockRestore()
      sensor.dispose()
      renderer.outputColorSpace = previousColor
      renderer.toneMapping = previousTone
    }
  },
)

it('retains faint radiance beside a bright silhouette before one output transform', async () => {
  const renderer = gpu.renderer
  renderer.setSize(32, 32, false)
  renderer.outputColorSpace = SRGBColorSpace
  declareSceneTarget(renderer, { samples: 4, optics: true })
  installToneCurve(renderer, 1)
  const retained = new RenderTarget(32, 32, {
    type: HalfFloatType,
    depthBuffer: false,
  })
  const sourceMaterial = new NodeMaterial()
  sourceMaterial.fragmentNode = vec4(0.4, 0.3, 0.2, 1)
  renderer.setRenderTarget(retained)
  new QuadMesh(sourceMaterial).render(renderer)
  renderer.setRenderTarget(null)
  sourceMaterial.dispose()
  const physical = texture(retained.texture).rgb.mul(1e-7)
  const scene = new Scene()
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.updateMatrixWorld()
  const backdrop = new Mesh(
    new PlaneGeometry(20, 20),
    sensorRadiance(new MeshBasicNodeMaterial(), true),
  )
  backdrop.position.z = -5
  backdrop.material.colorNode = composeSky(physical)
  const body = new Mesh(
    new SphereGeometry(0.45, 24, 16),
    sensorRadiance(new MeshBasicNodeMaterial()),
  )
  body.position.z = -2
  body.material.colorNode = vec3(0.4, 0.3, 0.2)
  scene.add(backdrop, body)
  const lens = {
    ...GALAXY_VIEWS['edge-on'].lens,
    fStop: 2.8,
    iso: 100,
    shutter: 1 / 40_000,
  }
  let settings: SensorSettings = DEFAULT_SENSOR_SETTINGS
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens,
    settings,
    time: 0,
    headroom: 1,
    pinned: null,
    noiseTick: 0,
  }))
  const target = new RenderTarget(32, 32, {
    type: FloatType,
    depthBuffer: false,
  })
  try {
    await sensor.warm()
    sensor.render(target)
    const enhanced = await gpu.read(target)
    const scenePixels = await gpu.drawGraph(
      texture(sensor.sceneTarget.texture),
      { float: true },
    )
    expect(scenePixels.at(16, 16)[0]).toBeCloseTo(0.4, 3)
    expect(scenePixels.at(3, 16)[0]).toBeGreaterThan(0.01)
    expect(enhanced.at(3, 16)[0]).toBeGreaterThan(0.02)
    expect(enhanced.at(16, 16)[0]).toBeLessThan(0.95)
    settings = { ...settings, mode: 'manual' }
    sensor.render(target)
    const daylight = await gpu.read(target)
    expect(daylight.at(3, 16)[0]).toBeLessThan(0.01)
    expect(sensor.exposure!.total).toBeLessThan(1 / SURFACE_LUMINANCE)
    lens.shutter = 2400
    sensor.render(target)
    const long = await gpu.read(target)
    expect(Math.log2(2400 * 40_000)).toBeCloseTo(26.5165, 4)
    expect(long.at(3, 16)[0]).toBeGreaterThan(0.05)
    expect(long.at(16, 16)[0]).toBeGreaterThan(daylight.at(16, 16)[0])
    const source = await gpu.drawGraph(texture(retained.texture), {
      float: true,
    })
    expect(source.at(16, 16)[1]).toBeCloseTo(0.3, 3)
    sensor.render(target)
    expect((await gpu.read(target)).data).toEqual(long.data)
  } finally {
    sensor.dispose()
    target.dispose()
    retained.dispose()
    for (const mesh of [backdrop, body]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
})
afterAll(() => gpu.dispose())

it.each(['scrub', 'focus', 'resize'] as const)(
  'validates focus extent independently during %s',
  async (change) => {
    const renderer = gpu.renderer
    declareSceneTarget(renderer, { samples: 0, optics: true })
    const scene = new Scene()
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    const lens = { ...LENS_PRESETS.flight, focus: Infinity }
    let time = 0
    const sensor = createSensor(renderer, scene, camera, () => ({
      lens,
      settings: { ...DEFAULT_SENSOR_SETTINGS, mode: 'automatic' },
      time,
      adaptationTime: time,
      historyKey: `scrub:${time}`,
      headroom: 1,
      pinned: null,
      noiseTick: 0,
    }))
    const target = new RenderTarget(32, 32, {
      type: FloatType,
      depthBuffer: false,
    })
    let release!: () => void
    const gate = {
      promise: new Promise<void>((resolve) => {
        release = resolve
      }),
      resolve: () => release(),
    }
    const read = renderer.getArrayBufferAsync.bind(renderer)
    const pending = vi
      .spyOn(renderer, 'getArrayBufferAsync')
      .mockImplementation(async (...args) => {
        const buffer = await read(...args)
        await gate.promise
        return buffer
      })
    try {
      await sensor.warm()
      sensor.render(target)
      expect(sensor.diagnostics.maximumCircle).toBe(40)
      time = 1 / 60
      if (change === 'focus') lens.focus = 100
      if (change === 'resize') renderer.setSize(64, 64, false)
      sensor.render(target)
      gate.resolve()
      await vi.waitFor(() =>
        expect(
          pending.mock.settledResults.every(
            (result) => result.type !== 'incomplete',
          ),
        ).toBe(true),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(sensor.diagnostics.maximumCircle).toBe(change === 'scrub' ? 0 : 40)
      expect(sensor.exposure!.metered).toBe(false)
      sensor.render(target)
      expect(sensor.diagnostics.defocusPasses).toBe(change === 'scrub' ? 0 : 4)
    } finally {
      gate.resolve()
      pending.mockRestore()
      renderer.setSize(32, 32, false)
      sensor.dispose()
      target.dispose()
    }
  },
)

it('keeps metered exposure when continuous camera motion rebases the scene', async () => {
  const renderer = gpu.renderer
  renderer.setSize(32, 32, false)
  declareSceneTarget(renderer, { samples: 0, optics: true })
  installToneCurve(renderer, 1)
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.set(4090, 0, 2)
  camera.updateMatrixWorld()
  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = vec3(0.003)
  const ground = new Mesh(new PlaneGeometry(2, 2), material)
  ground.position.x = 4090
  scene.add(ground)
  let origin = createRenderOrigin(UV.UNIVERSE_ORIGIN)
  let time = 0
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens: GALAXY_VIEWS['edge-on'].lens,
    settings: { ...DEFAULT_SENSOR_SETTINGS, mode: 'automatic' },
    time,
    headroom: 1,
    pinned: null,
    noiseTick: 0,
    renderOrigin: origin,
  }))
  const target = new RenderTarget(32, 32, { type: FloatType })
  try {
    await sensor.warm()
    for (let frame = 0; frame < 60; frame++) {
      time += 0.1
      sensor.render(target)
      await gpu.read(target)
    }
    expect(sensor.exposure!.metered).toBe(true)
    const before = sensor.exposure!.effectiveEV
    expect(before).toBeLessThan(13)
    // A homogeneous field keeps the photograph fixed as the physical eye moves
    // ten meters. The render coordinate jumps by 4086 m at the snapped origin.
    origin = rebase(origin, UV.fromMeters(4100, 0, 2))
    camera.position.x = 4
    camera.updateMatrixWorld()
    ground.position.x = 4
    time += 0.1
    sensor.render(target)
    expect(sensor.exposure!.metered).toBe(true)
    expect(Math.abs(sensor.exposure!.effectiveEV - before)).toBeLessThan(0.1)
    await gpu.read(target)
  } finally {
    sensor.dispose()
    target.dispose()
    ground.geometry.dispose()
    material.dispose()
  }
})

it('excludes visible instrument pixels from the physical histogram', async () => {
  declareSceneTarget(gpu.renderer, { samples: 0, optics: true })
  const scene = new Scene()
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
  camera.position.z = 2
  camera.updateMatrixWorld()
  const ground = new Mesh(
    new PlaneGeometry(2, 2),
    sensorRadiance(new MeshBasicNodeMaterial()),
  )
  ground.material.colorNode = vec3(0.3)
  const ink = new Mesh(
    new PlaneGeometry(1, 2),
    sensorRadiance(new MeshBasicNodeMaterial(), true, true),
  )
  ink.material.colorNode = vec3(10)
  ink.position.set(-0.5, 0, 0.1)
  ink.renderOrder = 2
  scene.add(ground, ink)
  const sensor = createSensor(gpu.renderer, scene, camera)
  const target = new RenderTarget(32, 32, { type: FloatType })
  try {
    sensor.render(target)
    const mask = sensor.sceneTarget.textures.find((t) => t.name === 'meterMask')
    expect(mask).toBeDefined()
    const meter = createHistogramMeter(
      sensor.sceneTarget.texture,
      undefined,
      mask,
    )
    try {
      meter.width.value = 8
      meter.height.value = 8
      meter.count.count = 64
      await gpu.compute(meter.clear)
      await gpu.compute(meter.count)
      const bins = new Uint32Array(await gpu.readBuffer(meter.bins))
      expect(bins.reduce((sum, count) => sum + count, 0)).toBe(32)
    } finally {
      meter.dispose()
    }
    const image = await gpu.read(target)
    expect(image.at(4, 16)[0]).toBeGreaterThan(image.at(28, 16)[0])
  } finally {
    sensor.dispose()
    target.dispose()
    for (const mesh of [ground, ink]) {
      mesh.geometry.dispose()
      mesh.material.dispose()
    }
  }
})
