import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  DEFAULT_SENSOR_SETTINGS,
  defocusDiameter,
  defocusParameters,
  GLASS_PRESETS,
  LENS_PRESETS,
  lensForFov,
} from '@inertialref/rendering'
import {
  DataTexture,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Scene,
  Sprite,
} from 'three/webgpu'
import { nodeObject, pass, texture, uv, vec4 } from 'three/tsl'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { createSensor, declareSceneTarget } from './sensor.ts'
import { sensorRadiance } from './radiance.ts'
import { sensorSignature } from './signature.ts'
import { installToneCurve } from './tonemap.ts'
import { sensorMrt } from './sensorMrt.ts'
import { DefocusNode } from './defocus.ts'
import { createStarfieldMaterial } from './materials.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(128, 128)
})
afterAll(() => gpu.dispose())

it('measures a star at its instance position instead of the sprite quad', async () => {
  const camera = new PerspectiveCamera(65, 1, 0.01, 20000)
  camera.position.z = 2
  const field = createStarfieldMaterial(1)
  field.positions.setXYZ(0, 0, 0, -10000)
  field.positions.needsUpdate = true
  field.size.value = 16
  const star = new Sprite(field.material)
  star.count = 1
  star.frustumCulled = false
  const scene = new Scene()
  scene.add(star)
  const scenePass = pass(scene, camera)
  scenePass.setMRT(sensorMrt())
  const motion = scenePass.getTextureNode('motion')
  const history = (
    gpu.renderer as unknown as { _nodes: { nodeFrame: { frameId: number } } }
  )._nodes.nodeFrame
  try {
    await gpu.drawGraph(motion, { float: true })
    history.frameId += 1
    camera.position.x = 1
    const moved = await gpu.drawGraph(motion, { float: true })
    expect(moved.at(64, 64)[2]).toBeGreaterThan(0)
    expect(Math.abs(moved.at(64, 64)[0])).toBeLessThan(0.001)
    // The sprite writes the motion attachment opaquely over the cleared sky,
    // so the ratio of the two channels is the projection's alone.
    expect(
      Math.abs(
        moved.at(64, 64)[0] / moved.at(64, 64)[2] +
          1 / Math.tan((65 * Math.PI) / 360),
      ),
    ).toBeLessThan(0.01)
  } finally {
    scenePass.dispose()
    field.material.dispose()
  }
})

it('keeps a surface’s depth in the motion attachment under an overlay quad', async () => {
  // A flare quad hangs in camera space over what is really there. Without the
  // overlay blend it would replace the motion attachment's inverse depth with
  // its own — twenty metres in front of the lens — over its whole footprint,
  // and the meter would read a near circle and enable defocus over the Sun.
  const camera = new PerspectiveCamera(65, 1, 0.01, 100)
  camera.position.z = 2
  const scene = new Scene()
  const surface = new Mesh(new PlaneGeometry(4, 4), new MeshBasicNodeMaterial())
  scene.add(surface) // At z = 0, two metres away: inverse depth 0.5.
  const overlay = new Mesh(
    new PlaneGeometry(1, 1),
    sensorRadiance(new MeshBasicNodeMaterial(), true),
  )
  overlay.position.z = 1 // One metre away: inverse depth 1, were it believed.
  overlay.material.transparent = true
  overlay.material.depthWrite = false
  overlay.renderOrder = 1
  scene.add(overlay)
  const scenePass = pass(scene, camera)
  scenePass.setMRT(sensorMrt())
  const motion = scenePass.getTextureNode('motion')
  try {
    const drawn = await gpu.drawGraph(motion, { float: true })
    // The centre is under the overlay; the edge is the bare surface. Both read
    // the surface's 0.5, not the overlay's 1.0.
    expect(drawn.at(64, 64)[2]).toBeCloseTo(0.5, 2)
    expect(drawn.at(8, 8)[2]).toBeCloseTo(0.5, 2)
  } finally {
    scenePass.dispose()
    surface.geometry.dispose()
    surface.material.dispose()
    overlay.geometry.dispose()
    overlay.material.dispose()
  }
})

it('draws one scene per full sensor frame, warms every pass, and holds a paused photograph', async () => {
  const renderer = gpu.renderer
  installToneCurve(renderer, 1)
  renderer.outputColorSpace = LinearSRGBColorSpace
  declareSceneTarget(renderer, { samples: 0, optics: true })
  const camera = new PerspectiveCamera(65, 1, 0.01, 100)
  camera.position.z = 2
  const scene = new Scene()
  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = vec4(0.4, 0.3, 0.2, 1).rgb
  const plane = new Mesh(new PlaneGeometry(1, 1), material)
  scene.add(plane)
  let draws = 0
  plane.onBeforeRender = () => {
    draws += 1
  }
  let time = 0
  const sensor = createSensor(renderer, scene, camera, () => ({
    lens: LENS_PRESETS.flight,
    settings: DEFAULT_SENSOR_SETTINGS,
    time,
    pinned: 0,
    headroom: 1,
    motionBlur: true,
  }))
  const target = new RenderTarget(128, 128, {
    type: FloatType,
    depthBuffer: false,
  })
  try {
    await sensor.warm()
    draws = 0
    sensor.render(target)
    const first = await gpu.read(target)
    expect(draws).toBe(1)
    expect(first.at(64, 64)[0]).toBeGreaterThan(0.1)
    sensor.render(target)
    const paused = await gpu.read(target)
    expect(draws).toBe(2)
    expect(paused.data).toEqual(first.data)
    time = 1 / 60
    sensor.render(target)
    const moving = await gpu.read(target)
    expect(draws).toBe(3)
    expect(moving.at(64, 64)[0]).toBeGreaterThan(0.1)
  } finally {
    sensor.dispose()
    target.dispose()
    material.dispose()
    plane.geometry.dispose()
  }
})

it('produces the full-well noise variance and an exactly repeatable tick', async () => {
  const data = new DataTexture(
    new Float32Array([0.18, 0.18, 0.18, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  data.minFilter = data.magFilter = LinearFilter
  data.needsUpdate = true
  const signature = sensorSignature(texture(data))
  const update = (time: number) =>
    signature.update(
      LENS_PRESETS.flight,
      GLASS_PRESETS.flight,
      DEFAULT_SENSOR_SETTINGS,
      128,
      128,
      time,
      1,
      false,
    )
  try {
    update(2)
    const first = await gpu.drawGraph(signature.linear, {
      width: 128,
      height: 128,
      float: true,
    })
    const again = await gpu.drawGraph(signature.linear, {
      width: 128,
      height: 128,
      float: true,
    })
    expect(again.data).toEqual(first.data)
    let sum = 0
    let squares = 0
    for (let i = 0; i < first.data.length; i += 4) {
      const n = first.data[i]! - 0.18
      sum += n
      squares += n * n
    }
    const count = 128 * 128
    expect(Math.abs(sum / count)).toBeLessThan(0.00015)
    expect(squares / count).toBeCloseTo((0.18 * 20000 + 9) / 20000 ** 2, 6)
    update(3)
    const next = await gpu.drawGraph(signature.linear, {
      width: 128,
      height: 128,
      float: true,
    })
    expect(next.data).not.toEqual(first.data)
  } finally {
    data.dispose()
  }
})

it('distributes SDR quantization across a sub-code-value sky ramp', async () => {
  const data = new DataTexture(
    new Float32Array([0, 0, 0, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  data.minFilter = data.magFilter = LinearFilter
  data.needsUpdate = true
  const signature = sensorSignature(texture(data))
  signature.update(
    LENS_PRESETS.flight,
    GLASS_PRESETS.flight,
    DEFAULT_SENSOR_SETTINGS,
    128,
    128,
    0,
    1,
    true,
  )
  const ramp = vec4(uv().x.mul(0.001).add(0.04), 0, 0, 1)
  try {
    const plain = await gpu.drawGraph(ramp, { width: 128, height: 128 })
    const dithered = await gpu.drawGraph(signature.encode(ramp), {
      width: 128,
      height: 128,
    })
    const codes = (data: ArrayLike<number>) =>
      new Set(Array.from({ length: 128 * 128 }, (_, i) => data[i * 4])).size
    expect(codes(dithered.data)).toBeGreaterThan(codes(plain.data))
  } finally {
    data.dispose()
  }
})

it('gives a stationary prop zero velocity across a camera-relative rebase', async () => {
  const camera = new PerspectiveCamera(65, 1, 0.01, 100)
  camera.position.z = 2
  const scene = new Scene()
  const plane = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial())
  scene.add(plane)
  const scenePass = pass(scene, camera)
  scenePass.setMRT(sensorMrt())
  const data = scenePass.getTextureNode('motion')
  // The headless renderer has no rAF; this advances three's own history clock.
  const history = (
    gpu.renderer as unknown as { _nodes: { nodeFrame: { frameId: number } } }
  )._nodes.nodeFrame
  try {
    await gpu.drawGraph(data, { float: true })
    history.frameId += 1
    camera.position.add({ x: 10000, y: -17000, z: 9000 } as never)
    plane.position.set(10000, -17000, 9000)
    const rebased = await gpu.drawGraph(data, { float: true })
    expect(Math.abs(rebased.at(64, 64)[0])).toBeLessThan(1e-5)
    expect(Math.abs(rebased.at(64, 64)[1])).toBeLessThan(1e-5)
    expect(rebased.at(64, 64)[2]).toBeCloseTo(0.5, 3)
  } finally {
    scenePass.dispose()
    plane.geometry.dispose()
    plane.material.dispose()
  }
})

it('submits no defocus draws for a sharp frame and keeps the input texture', async () => {
  const image = new DataTexture(
    new Float32Array([0.25, 0.5, 0.75, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  image.minFilter = image.magFilter = LinearFilter
  image.needsUpdate = true
  const defocus = new DefocusNode(texture(image), texture(image))
  try {
    const result = await gpu.drawGraph(nodeObject(defocus), { float: true })
    expect(defocus.passes).toBe(0)
    expect(result.at(20, 20)).toEqual([0.25, 0.5, 0.75, 1])
  } finally {
    defocus.dispose()
    image.dispose()
  }
})

it('draws the thin-lens blur diameter of a two-meter calibration plane', async () => {
  const size = 128
  const lens = { ...lensForFov(10), fStop: 1.4 }
  const viewport = { width: size, height: size }
  const pixels = new Float32Array(size * size * 4)
  for (const x of [63, 64])
    for (const y of [63, 64]) pixels[(y * size + x) * 4] = 1
  const source = new DataTexture(pixels, size, size, RGBAFormat, FloatType)
  const distances = new DataTexture(
    new Float32Array([0, 0, 0.5, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  for (const image of [source, distances]) {
    image.minFilter = image.magFilter = LinearFilter
    image.needsUpdate = true
  }
  const pass = new DefocusNode(texture(source), texture(distances))
  const diameter = Math.abs(defocusDiameter(lens, viewport, 2))
  pass.parameters.value.set(...defocusParameters(lens, viewport))
  pass.maximum.value = diameter
  pass.enabled.value = 1
  pass.openness.value = 1
  try {
    const result = await gpu.drawGraph(nodeObject(pass), {
      width: size,
      height: size,
      float: true,
    })
    let light = 0
    let moment = 0
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const value = result.at(x, y)[0]
        light += value
        moment += value * ((x - 63.5) ** 2 + (y - 63.5) ** 2)
      }
    // Subtract the known second moment of the 2×2 source before measuring the kernel.
    const measured = Math.sqrt(8 * (moment / light - 0.5))
    console.log(
      `Sensor 2 m blur: ${measured.toFixed(3)} px, thin lens ${diameter.toFixed(3)} px`,
    )
    expect(Math.abs(measured - diameter)).toBeLessThan(0.5)
    expect(result.at(64, 64)[0]).toBeLessThan(0.2)
  } finally {
    pass.dispose()
    source.dispose()
    distances.dispose()
  }
})

it('preserves a uniform foreground through defocus coverage', async () => {
  const source = new DataTexture(
    new Float32Array([0.25, 0.5, 0.75, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  const distance = new DataTexture(
    new Float32Array([0, 0, 0.5, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  for (const image of [source, distance]) {
    image.minFilter = image.magFilter = LinearFilter
    image.needsUpdate = true
  }
  const defocus = new DefocusNode(texture(source), texture(distance))
  defocus.parameters.value.set(8, 0)
  defocus.maximum.value = 40
  defocus.enabled.value = 1
  try {
    const result = await gpu.drawGraph(nodeObject(defocus), { float: true })
    expect(result.at(64, 64)[0]).toBeCloseTo(0.25, 3)
    expect(result.at(64, 64)[1]).toBeCloseTo(0.5, 3)
    expect(result.at(64, 64)[2]).toBeCloseTo(0.75, 3)
  } finally {
    defocus.dispose()
    source.dispose()
    distance.dispose()
  }
})

it('keeps subpixel defocus close to the sharp full-resolution image', async () => {
  const pixels = new Float32Array(128 * 128 * 4)
  for (let y = 0; y < 128; y += 1)
    for (let x = 0; x < 128; x += 1)
      pixels[(y * 128 + x) * 4] = x % 2 === 0 ? 1 : 0
  const source = new DataTexture(pixels, 128, 128, RGBAFormat, FloatType)
  const depth = new DataTexture(
    new Float32Array([0, 0, 0.5, 1]),
    1,
    1,
    RGBAFormat,
    FloatType,
  )
  for (const image of [source, depth]) {
    image.minFilter = image.magFilter = LinearFilter
    image.needsUpdate = true
  }
  const defocus = new DefocusNode(texture(source), texture(depth))
  defocus.parameters.value.set(1.125, 0)
  defocus.maximum.value = 0.5625
  defocus.enabled.value = 1
  try {
    const result = await gpu.drawGraph(nodeObject(defocus), { float: true })
    expect(result.at(64, 64)[0]).toBeGreaterThan(0.9)
    expect(result.at(65, 64)[0]).toBeLessThan(0.1)
  } finally {
    defocus.dispose()
    source.dispose()
    depth.dispose()
  }
})
