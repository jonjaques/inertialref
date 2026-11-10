import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  DepthTexture,
  HalfFloatType,
  Matrix3,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  SphereGeometry,
  StorageBufferAttribute,
  type Texture,
  Vector3,
  Vector4,
} from 'three/webgpu'
import {
  dot,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  select,
  step,
  storage,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { ATMOSPHERE_GAIN, SURFACE_LUMINANCE } from '@inertialref/rendering'
import {
  CLOUD_HISTOGRAM_BINS,
  cloudHistogramBin,
  cloudHistogramEdge,
} from '@inertialref/devtools'
import { CloudComposite, residualBin } from './cloudComposite.ts'
import type { AirMediumFn } from './cloudCompositeAir.ts'
import { CloudDepth } from './cloudDepth.ts'
import { CloudFrameNode } from './cloudFrameNode.ts'
import { traceScreen, viewDirection } from './cloudGeometry.ts'
import type { CloudHistoryTextures } from './cloudHistory.ts'
import { OVER_CLOUDS_LAYER } from './cloudLayers.ts'
import {
  CLOUD_STAND_INS,
  type CloudFarFn,
  cloudStorageTexture,
} from './cloudNodes.ts'
import {
  type CloudBodyUniforms,
  type CloudUniforms,
  createCloudUniforms,
} from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import { DEFAULT_PICTURE, type Picture } from './picture.ts'
import { sensorRadiance, setSceneExposure } from './radiance.ts'
import {
  attachmentFormat,
  attachmentType,
  type SceneAttachmentName,
  sceneBackend,
  sceneLayout,
  type SceneLayout,
} from './sceneLayout.ts'
import { sensorMrt } from './sensorMrt.ts'

/*
 * The composite in the sensor's own shape: a scene target of the layout —
 * four samples, or the temporal rows — the sensor's MRT, a renderer with the
 * scene's order, and a depth copy tied to the target and drawn by a real
 * frame node inside pass B, the OVER layer drawn over the pass under the
 * clouds. The
 * history is written by a kernel here, so every case states exactly what the
 * trace and the history would have left.
 *
 * The scene's exposure carries a gain of 4 throughout: a composite that
 * carried the gain itself would draw its cloud at 16.
 *
 * The served body is placed by hand in body-fixed axes that are the render
 * axes: Earth's radius, one cloud layer, an air 100 km tall. Most cases put
 * the eye 1 km up inside a layer from the datum to 3 km, so every pixel's
 * ray holds a span. The air is none, its coefficients the bundle's zeros,
 * unless a case stands in a gray one of constant extinction, whose
 * transmittance along a ray is exactly exp(−σ·length).
 */

const SIZE = 32
const HISTORY = 16
const TRACE = 8
const FOV = 60
const R = 6_371_000
/** The air's height over the datum, meters. */
const AIR = 100_000
const GAIN = 4
const TEMPORAL: Picture = {
  aa: 'temporal',
  scale: 'native',
  sharpness: 'standard',
}
/** A half float's relative step: the output's resolution about its values. */
const HALF = 2 ** -10
const LIGHT = ATMOSPHERE_GAIN * GAIN

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
  setSceneExposure(gpu.renderer, GAIN / SURFACE_LUMINANCE)
})

afterAll(() => {
  gpu.dispose()
})

/** Run `work` in a validation scope of the test's own, failing on either channel's error. */
async function checked(session: GpuSession, work: () => void): Promise<void> {
  const device = (session.renderer.backend as unknown as { device: GPUDevice })
    .device
  const from = session.reported().length
  device.pushErrorScope('validation')
  try {
    work()
  } catch (failure) {
    await device.popErrorScope()
    throw failure
  }
  const scoped = await device.popErrorScope()
  if (scoped !== null) throw new Error(`the device reported: ${scoped.message}`)
  await device.queue.onSubmittedWorkDone()
  expect(
    session
      .reported()
      .slice(from)
      .filter((entry) => entry.type === 'error'),
  ).toEqual([])
}

/** A gray air of constant extinction σ under the air's top, sea-level units⁻¹, that scatters nothing. */
const grayAir =
  (sigma: number): AirMediumFn =>
  (air, height) => ({
    extinction: vec3(sigma).mul(step(height, air.top.sub(1))),
    single: vec3(0),
    multiple: vec3(0),
  })

/** One layer from `base` to `top` over a datum of `radius`, the eye `eye` meters up along `up`. */
function serve(
  body: CloudBodyUniforms,
  eye: number,
  base: number,
  top: number,
  up = new Vector3(0, 1, 0),
): void {
  body.datumRadius.value = R
  body.eye.value = eye
  body.boundaries.value.set(base, top, top, top)
  body.boundariesHigh.value.set(top, top)
  body.eyeOver.value.set(eye - base, eye - top, eye - top, eye - top)
  body.eyeOverHigh.value.set(eye - top, eye - top)
  body.eyeTerm.value = eye * (2 * R + eye)
  body.up.value.copy(up)
  body.sun.value.copy(up)
  body.sunUp.value = 1
  body.compression.value = 1
  body.active.value = 1
  body.air.top.value = 1 + AIR / R
}

/** The image point of render pixel (x, y)'s center, y up. */
const screenOf = (x: number, y: number): [number, number] => [
  (2 * (x + 0.5)) / SIZE - 1,
  1 - (2 * (y + 0.5)) / SIZE,
]

/** The view direction through an image point of a camera looking down −z. */
function viewOf([sx, sy]: [number, number], halfTan: number): Vector3 {
  return new Vector3(sx * halfTan, sy * halfTan, -1).normalize()
}

function colored(
  rgb: readonly [number, number, number],
  instrument = false,
): MeshBasicNodeMaterial {
  const material = sensorRadiance(
    new MeshBasicNodeMaterial(),
    false,
    instrument,
  )
  material.colorNode = vec3(...rgb)
  return material
}

/** A plane facing a camera at the origin, `depth` meters down −z, over the image rectangle [x0, x1] × [y0, y1], y up. */
function facing(
  depth: number,
  [x0, x1, y0, y1]: readonly [number, number, number, number],
  material: MeshBasicNodeMaterial,
  halfTan = Math.tan((FOV / 2) * (Math.PI / 180)),
): Mesh {
  const scale = depth * halfTan
  const mesh = new Mesh(
    new PlaneGeometry((x1 - x0) * scale, (y1 - y0) * scale),
    material,
  )
  mesh.position.set(((x0 + x1) / 2) * scale, ((y0 + y1) / 2) * scale, -depth)
  return mesh
}

function sceneOf(...meshes: Mesh[]): Scene {
  const scene = new Scene()
  if (meshes.length > 0) scene.add(...meshes)
  return scene
}

/** The usual scene: a far wall, a near square, and an instrument the meter masks. */
const usual = (): Scene =>
  sceneOf(
    facing(50_000, [-1.5, 1.5, -1.5, 1.5], colored([0.3, 0.2, 0.1])),
    facing(200, [-1.5, 0, 0, 1.5], colored([0.05, 0.6, 0.2])),
    facing(1_000, [0, 1.5, -1.5, 0], colored([0.4, 0.4, 0.4], true)),
  )

/** A target of the scene pass's layout, as the sensor's pass makes one. */
function sceneTarget(layout: SceneLayout): RenderTarget {
  const target = new RenderTarget(SIZE, SIZE, {
    type: HalfFloatType,
    samples: layout.samples,
    depthTexture: new DepthTexture(SIZE, SIZE, layout.depthType),
    count: layout.attachments.length,
  })
  layout.attachments.forEach((row, i) => {
    const texture = target.textures[i]!
    texture.name = row.name
    texture.format = attachmentFormat(row)
    texture.type = attachmentType(row)
  })
  return target
}

/** What the trace and the history would have left, by uniform. */
interface Written {
  /** (L_c, T_c). */
  readonly light?: readonly [number, number, number, number]
  /** (B, d_reproj km). */
  readonly air?: readonly [number, number, number, number]
  /** (d_end km, d_front km, deviation km, age). */
  readonly moments?: readonly [number, number, number, number]
  /** d_reproj puts the cloud on the plane this many km down the axis, if set. */
  readonly viewDepth?: number
  /** L_c.x is (row + 1)/16 on top of `light`. */
  readonly ramp?: boolean
  /** History texels in this column and right of it hold no cloud. */
  readonly clearFrom?: number
}

function historyWriter(uniforms: CloudUniforms, history: CloudHistoryTextures) {
  const values = {
    light: uniform(new Vector4()),
    air: uniform(new Vector4()),
    moments: uniform(new Vector4()),
    viewDepth: uniform(0),
    ramp: uniform(0),
    clearFrom: uniform(HISTORY),
  }
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(HISTORY * HISTORY)), () => {
      const i = instanceIndex.mod(uint(HISTORY))
      const j = instanceIndex.div(uint(HISTORY))
      const pixel = uvec2(i, j)
      const screen = traceScreen(pixel, vec2(0), vec2(HISTORY, HISTORY))
      const cosine = dot(
        viewDirection(uniforms.camera, screen),
        uniforms.camera.forward,
      )
      const reproject = select(
        values.viewDepth.greaterThan(0),
        values.viewDepth.div(cosine),
        values.air.w,
      )
      const ramp = float(j).add(1).div(HISTORY).mul(values.ramp)
      const clear = float(i).greaterThanEqual(values.clearFrom)
      textureStore(
        history.light,
        pixel,
        select(
          clear,
          vec4(0, 0, 0, 1),
          vec4(values.light.xyz.add(vec3(ramp, 0, 0)), values.light.w),
        ),
      )
      textureStore(
        history.air,
        pixel,
        vec4(select(clear, vec3(0), values.air.xyz), reproject),
      )
      textureStore(history.depth, pixel, values.moments)
    })
  })().compute(HISTORY * HISTORY)
  return {
    kernel,
    set(written: Written): void {
      values.light.value.set(...(written.light ?? [0, 0, 0, 1]))
      values.air.value.set(...(written.air ?? [0, 0, 0, 0]))
      values.moments.value.set(...(written.moments ?? [0, 0, 0.001, 0]))
      values.viewDepth.value = written.viewDepth ?? 0
      values.ramp.value = written.ramp === true ? 1 : 0
      values.clearFrom.value = written.clearFrom ?? HISTORY
    },
  }
}

/** Every texel of a 2D texture as RGBA floats, row-major from the top, read by `textureLoad`. */
function reader(session: GpuSession) {
  const kernels = new Map<
    Texture,
    { kernel: ComputeNode; out: StorageBufferAttribute }
  >()
  return async (map: Texture): Promise<Float32Array> => {
    let read = kernels.get(map)
    if (read === undefined) {
      const out = new StorageBufferAttribute(
        new Float32Array(SIZE * SIZE * 4),
        4,
      )
      const into = storage(out, 'vec4', SIZE * SIZE)
      const kernel = Fn(() => {
        If(instanceIndex.lessThan(uint(SIZE * SIZE)), () => {
          const at = ivec2(
            int(instanceIndex.mod(uint(SIZE))),
            int(instanceIndex.div(uint(SIZE))),
          )
          into.element(instanceIndex).assign(textureLoad(map, at))
        })
      })().compute(SIZE * SIZE)
      read = { kernel, out }
      kernels.set(map, read)
    }
    await session.compute(read.kernel)
    return new Float32Array(await session.readBuffer(read.out))
  }
}

interface RigOptions {
  readonly picture?: Picture
  readonly medium?: AirMediumFn
  readonly far?: CloudFarFn
  readonly fov?: number
  readonly session?: GpuSession
  /** Whether the frame node draws the depth copy; true by default. */
  readonly copyDepth?: boolean
}

function rig({
  picture = DEFAULT_PICTURE,
  medium,
  far = CLOUD_STAND_INS.far(),
  fov = FOV,
  session = gpu,
  copyDepth = true,
}: RigOptions = {}) {
  const renderer = session.renderer
  const layout = sceneLayout(picture, sceneBackend(renderer))
  const target = sceneTarget(layout)
  const mrt = sensorMrt(layout)
  const uniforms = createCloudUniforms()
  const halfTan = Math.tan((fov / 2) * (Math.PI / 180))
  uniforms.trace.size.value.set(TRACE, TRACE)
  uniforms.trace.history.value.set(HISTORY, HISTORY)
  uniforms.trace.render.value.set(SIZE, SIZE)
  const camera = new PerspectiveCamera(fov, 1, 0.05, 1e10)
  camera.layers.enable(OVER_CLOUDS_LAYER)
  camera.updateMatrixWorld()
  const view = uniforms.camera
  view.plane.value.set(halfTan, halfTan)
  view.previousPlane.value.set(halfTan, halfTan)
  view.near.value = camera.near
  view.far.value = camera.far
  const depth = new CloudDepth(uniforms, layout)
  depth.tie(target)
  const history: CloudHistoryTextures = {
    light: cloudStorageTexture(
      HISTORY,
      HISTORY,
      'rgba16float',
      'history light',
    ),
    air: cloudStorageTexture(HISTORY, HISTORY, 'rgba16float', 'history air'),
    depth: cloudStorageTexture(
      HISTORY,
      HISTORY,
      'rgba16float',
      'history depth',
    ),
    extent: { width: HISTORY, height: HISTORY },
  }
  // The frame's cloud work, as far as the composite needs it: this frame's
  // depth copy, drawn where the system draws it.
  const driver = {
    inFrame: false,
    run: (three: typeof renderer) => {
      if (copyDepth) depth.render(three)
    },
  }
  const composite = new CloudComposite({
    uniforms,
    history: () => history,
    depth: () => depth.texture,
    far,
    phase: CLOUD_STAND_INS.phase(),
    frameNode: new CloudFrameNode(driver),
    ...(medium === undefined ? {} : { airMedium: medium }),
  })
  const writer = historyWriter(uniforms, history)
  const read = reader(session)
  const named = (name: SceneAttachmentName): Texture =>
    target.textures[layout.attachments.findIndex((row) => row.name === name)]!
  return {
    layout,
    target,
    uniforms,
    camera,
    halfTan,
    composite,
    depth,
    async write(written: Written): Promise<void> {
      writer.set(written)
      await session.compute(writer.kernel)
    },
    /** One frame of `scene`, with the composite in pass B or without it. */
    async frame(scene: Scene, on: boolean): Promise<void> {
      scene.add(composite.mesh)
      composite.show(on)
      const mask = camera.layers.mask
      await checked(session, () => {
        renderer.setRenderTarget(target)
        renderer.setMRT(mrt)
        driver.inFrame = on
        try {
          camera.layers.set(0)
          renderer.render(scene, camera)
          // Pass B: the OVER layer onto what the pass under the clouds left.
          if (on) {
            camera.layers.set(OVER_CLOUDS_LAYER)
            renderer.autoClear = false
            renderer.render(scene, camera)
          }
        } finally {
          driver.inFrame = false
          camera.layers.mask = mask
          renderer.autoClear = true
          renderer.setMRT(null)
          renderer.setRenderTarget(null)
        }
      })
    },
    read: (name: SceneAttachmentName): Promise<Float32Array> =>
      read(named(name)),
    readDepth: (): Promise<Float32Array> => read(depth.texture),
    async readAll(): Promise<Map<SceneAttachmentName, Float32Array>> {
      const all = new Map<SceneAttachmentName, Float32Array>()
      for (const row of layout.attachments)
        all.set(row.name, await read(named(row.name)))
      return all
    },
    dispose(): void {
      composite.dispose()
      depth.dispose()
      target.dispose()
      for (const map of [history.light, history.air, history.depth])
        map.dispose()
    },
  }
}

const bits = (values: Float32Array): Uint32Array =>
  new Uint32Array(values.buffer.slice(0))

/** Channel `c` of pixel (x, y) in a readback. */
const at = (values: Float32Array, x: number, y: number, c = 0): number =>
  values[(y * SIZE + x) * 4 + c]!

/**
 * Two half-float steps of the largest value involved: a stored value rounds
 * by one, and an expectation formed from two stored values by one more.
 */
const halfSteps = (...values: number[]): number =>
  2 * HALF * Math.max(...values.map(Math.abs)) + 1e-7

describe('off changes nothing', () => {
  it.each([
    ['four samples', DEFAULT_PICTURE],
    ['the temporal rows', TEMPORAL],
  ] as const)(
    'with no cloud the frame is the scene’s, bit for bit in every row, at a gain of 4 (%s)',
    async (_, picture) => {
      const f = rig({ picture })
      serve(f.uniforms.served, 1_000, 0, 3_000)
      await f.write({})
      const scene = usual()
      await f.frame(scene, false)
      const alone = await f.readAll()
      for (const mode of ['identity', 'thin', 'residual'] as const) {
        f.composite.setMode(mode)
        await f.frame(scene, true)
        const drawn = await f.readAll()
        for (const [name, values] of alone)
          expect(bits(drawn.get(name)!), `${mode}: ${name}`).toEqual(
            bits(values),
          )
      }
      f.dispose()
    },
  )

  it('leaves every pixel whose history holds no cloud as the scene drew it, motion included', async () => {
    const f = rig({ picture: TEMPORAL })
    serve(f.uniforms.served, 1_000, 0, 3_000)
    const scene = usual()
    await f.frame(scene, false)
    const alone = await f.readAll()
    // Cloud over the history's left half only, moving with the eye.
    f.uniforms.camera.translation.value.set(5, 0, 0)
    await f.write({
      light: [0.2, 0.2, 0.2, 0.5],
      air: [0, 0, 0, 2],
      clearFrom: HISTORY / 2,
    })
    await f.frame(scene, true)
    const drawn = await f.readAll()
    for (const [name, values] of alone)
      for (let y = 0; y < SIZE; y += 1)
        for (let x = SIZE / 2; x < SIZE; x += 1)
          for (let c = 0; c < 4; c += 1)
            expect(
              at(drawn.get(name)!, x, y, c),
              `${name} (${x}, ${y}) channel ${c}`,
            ).toBe(at(values, x, y, c))
    // And the left half is drawn over where the cloud, 2 km out, is in
    // front of the scene: the far wall's lower left, not the near square.
    expect(at(drawn.get('output')!, 4, 28)).not.toBe(
      at(alone.get('output')!, 4, 28),
    )
    // The scene is still, so the motion there is the cloud's alone.
    expect(at(drawn.get('motion')!, 4, 28)).not.toBe(0)
    expect(at(drawn.get('output')!, 4, 4)).toBe(at(alone.get('output')!, 4, 4))
    f.uniforms.camera.translation.value.set(0, 0, 0)
    f.dispose()
  })
})

describe('the cloud’s light', () => {
  it('with T_c = 0 is the cloud alone, at the gain applied once', async () => {
    const f = rig()
    serve(f.uniforms.served, 1_000, 0, 3_000)
    const cloud = [0.1, 0.2, 0.3] as const
    await f.write({ light: [...cloud, 0] })
    await f.frame(usual(), true)
    const output = await f.read('output')
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1)
        for (let c = 0; c < 3; c += 1) {
          // The gain twice would be four times this.
          const expected = cloud[c]! * LIGHT
          expect(
            Math.abs(at(output, x, y, c) - expected),
            `(${x}, ${y}) channel ${c}: ${at(output, x, y, c)}`,
          ).toBeLessThanOrEqual(halfSteps(expected))
        }
    f.dispose()
  })

  it('reads the history texel screenTexel gives each pixel, row 0 at the top', async () => {
    const f = rig()
    serve(f.uniforms.served, 1_000, 0, 3_000)
    const scene = sceneOf(
      facing(50_000, [-1.5, 1.5, -1.5, 1.5], colored([0.01, 0.01, 0.01])),
    )
    await f.frame(scene, false)
    const alone = await f.read('output')
    await f.write({ ramp: true })
    await f.frame(scene, true)
    const drawn = await f.read('output')
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1) {
        // Two render rows a history row: the history is half the render.
        const expected = ((Math.floor(y / 2) + 1) / HISTORY) * LIGHT
        const added = at(drawn, x, y) - at(alone, x, y)
        expect(
          Math.abs(added - expected),
          `(${x}, ${y}): ${added}`,
        ).toBeLessThanOrEqual(halfSteps(at(drawn, x, y)))
      }
    f.dispose()
  })

  it('weights the whole cloud term by the share in front of a near surface, so the surface reads back alone', async () => {
    const f = rig()
    serve(f.uniforms.served, 1_000, 0, 3_000)
    // A square 200 m out over the image's middle, in front of a slab whose
    // mean depth is 2 km: no history texel's ray ended where its pixels' do.
    const scene = sceneOf(
      facing(50_000, [-1.5, 1.5, -1.5, 1.5], colored([0.3, 0.2, 0.1])),
      facing(200, [-0.5, 0.5, -0.5, 0.5], colored([0.05, 0.6, 0.2])),
    )
    await f.frame(scene, false)
    const alone = await f.read('output')
    await f.write({
      light: [0.2, 0.2, 0.2, 0.3],
      air: [-0.05, -0.05, -0.05, 2],
      moments: [3, 1, 0.1, 0],
    })
    await f.frame(scene, true)
    const drawn = await f.read('output')
    for (let y = 10; y < 22; y += 1)
      for (let x = 10; x < 22; x += 1)
        for (let c = 0; c < 4; c += 1)
          expect(at(drawn, x, y, c), `(${x}, ${y}) channel ${c}`).toBe(
            at(alone, x, y, c),
          )
    // The wall 50 km out is behind the whole slab: the cloud is drawn there.
    const expected = 0.3 * 0.3 * GAIN + (0.2 - 0.05) * LIGHT
    expect(
      Math.abs(at(drawn, 2, 2) - expected),
      `wall: ${at(drawn, 2, 2)}`,
    ).toBeLessThanOrEqual(halfSteps(expected))
    f.dispose()
  })
})

describe('the other rows', () => {
  it('writes reactive and motion by opacity, the cloud’s view depth as a surface’s, and keeps the meter mask', async () => {
    const f = rig({ picture: TEMPORAL })
    serve(f.uniforms.served, 1_000, 0, 3_000)
    // What a surface 3 km out writes, everywhere.
    await f.frame(
      sceneOf(facing(3_000, [-1.5, 1.5, -1.5, 1.5], colored([0.2, 0.2, 0.2]))),
      false,
    )
    const surface = await f.read('motion')
    // A wall 4 km out and an instrument 3.5 km out over the lower right,
    // behind a cloud on the plane 3 km out, opaque.
    const scene = sceneOf(
      facing(4_000, [-1.5, 1.5, -1.5, 1.5], colored([0.2, 0.2, 0.2])),
      facing(3_500, [0, 1.5, -1.5, 0], colored([0.4, 0.4, 0.4], true)),
    )
    await f.frame(scene, false)
    const alone = await f.readAll()
    await f.write({ light: [0.1, 0.1, 0.1, 0], viewDepth: 3 })
    await f.frame(scene, true)
    const opaque = await f.readAll()
    // At three quarters' opacity, with the eye moving 5 m along +x.
    const translation = new Vector3(5, 0, 0)
    f.uniforms.camera.translation.value.copy(translation)
    await f.write({ light: [0.1, 0.1, 0.1, 0.25], viewDepth: 3 })
    await f.frame(scene, true)
    const partial = await f.readAll()
    f.uniforms.camera.translation.value.set(0, 0, 0)
    // Motion is the one vector the composite writes: a second row written at
    // full weight wherever it draws is an edge at the discard.
    const outputs = (f.composite.mesh.material as MeshBasicNodeMaterial).mrtNode
    expect(outputs?.has('motion')).toBe(true)
    expect(outputs?.has('velocity')).toBe(false)
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1) {
        // The history texel this pixel reads, and its ray's distance to the
        // plane 3 km out, which is the cloud's depth the history holds.
        const i = Math.floor(x / 2)
        const j = Math.floor(y / 2)
        const center = viewOf(
          [(2 * (i + 0.5)) / HISTORY - 1, 1 - (2 * (j + 0.5)) / HISTORY],
          f.halfTan,
        )
        const distance = 3_000 / -center.z
        const ray = viewOf(screenOf(x, y), f.halfTan)
        // The cloud's view depth is that distance along this pixel's ray:
        // the surface's own 1/z to the ratio of the two rays' cosines, under
        // 1.6% at a 60° frame's corners at this history's resolution.
        const cloudZ = at(opaque.get('motion')!, x, y, 2)
        const expectedZ = 1 / (distance * -ray.z)
        expect(
          Math.abs(cloudZ - expectedZ),
          `motion.z (${x}, ${y}): ${cloudZ}`,
        ).toBeLessThanOrEqual(halfSteps(expectedZ))
        const own = at(surface, x, y, 2)
        expect(Math.abs(cloudZ - own)).toBeLessThanOrEqual(
          Math.abs(-ray.z / -center.z - 1) * own + halfSteps(own),
        )
        // Three quarters of the cloud's over a quarter of what the scene
        // wrote: the wall's, or the nearer instrument's.
        const under = at(alone.get('motion')!, x, y, 2)
        const blended = 0.75 * cloudZ + 0.25 * under
        expect(
          Math.abs(at(partial.get('motion')!, x, y, 2) - blended),
          `blended motion.z (${x}, ${y})`,
        ).toBeLessThanOrEqual(halfSteps(blended))
        // Opacity as a union over the scene's own: the instrument's is 1.
        const reactive = 0.75 + 0.25 * at(alone.get('reactive')!, x, y)
        expect(
          Math.abs(at(partial.get('reactive')!, x, y) - reactive),
          `reactive (${x}, ${y})`,
        ).toBeLessThanOrEqual(1 / 255)
        expect(at(partial.get('meterMask')!, x, y), `meter (${x}, ${y})`).toBe(
          at(alone.get('meterMask')!, x, y),
        )
        // The cloud's motion: the same point projected now and from the eye
        // before it moved. `motion.rg` is what a temporal picture's
        // reconstruction reads, so it takes the cloud by its opacity over the
        // scene's none, with nothing written beside it at full weight.
        const now = ray.clone().multiplyScalar(distance)
        const before = now.clone().add(translation)
        const ndc = (p: Vector3) => [
          p.x / (-p.z * f.halfTan),
          p.y / (-p.z * f.halfTan),
        ]
        const [nx, ny] = ndc(now)
        const [bx, by] = ndc(before)
        const velocity = [nx! - bx!, ny! - by!]
        for (const c of [0, 1]) {
          const written = at(partial.get('motion')!, x, y, c)
          expect(
            Math.abs(written - 0.75 * velocity[c]!),
            `motion (${x}, ${y}) ${c}: ${written}`,
          ).toBeLessThanOrEqual(halfSteps(velocity[c]!))
        }
      }
    f.dispose()
  })
})

describe('the class', () => {
  /*
   * From 400 km over Earth, the image centered on the limb with a 10° lens:
   * the disk of the real 512 × 256 sphere below, the sky over it, and a moon
   * 800 km across 20,000 km behind the limb, all seen through a layer from 2
   * to 60 km. Under Enhanced from orbit a surface sees the cloud's light
   * through the cleared transmittance — none at all — and the sky through
   * the physical one: the shortest limb path from the air's top to the
   * layer's is 260 km, 0.04 sea-level units, which a gray air of 500 a unit
   * takes to e⁻²⁰.
   */
  const ALTITUDE = 400_000
  const LIMB = Math.acos(R / (R + ALTITUDE))
  const LAYER_TOP = 60_000

  it('takes a sphere pixel for a surface, and a limb pixel and a moon behind the limb for sky', async () => {
    const f = rig({ medium: grayAir(500), fov: 10 })
    const up = new Vector3(0, Math.cos(LIMB), Math.sin(LIMB))
    serve(f.uniforms.served, ALTITUDE, 2_000, LAYER_TOP, up)
    f.uniforms.served.cleared.value = 1
    const center = up.clone().multiplyScalar(-(R + ALTITUDE))
    const planet = new Mesh(
      new SphereGeometry(1, 512, 256),
      colored([0.2, 0.3, 0.4]),
    )
    planet.scale.setScalar(R)
    planet.position.copy(center)
    // The moon along a ray that grazes 30 km over the datum, 3° to the right.
    const grazing = Math.acos((R + 30_000) / (R + ALTITUDE))
    const toMoon = new Vector3(
      Math.sin((3 * Math.PI) / 180),
      0,
      -Math.cos((3 * Math.PI) / 180),
    )
      .applyAxisAngle(new Vector3(1, 0, 0), LIMB - grazing)
      .normalize()
    const moon = new Mesh(
      new SphereGeometry(1, 64, 32),
      colored([0.5, 0.5, 0.5]),
    )
    moon.scale.setScalar(400_000)
    moon.position.copy(toMoon.multiplyScalar(2e7))
    const scene = sceneOf(planet, moon)
    await f.frame(scene, false)
    const alone = await f.read('output')
    const cloud = 0.1
    await f.write({ light: [cloud, cloud, cloud, 1] })
    await f.frame(scene, true)
    const drawn = await f.read('output')
    const depth = await f.readDepth()
    const full = cloud * LIGHT
    const counted = { surface: 0, sky: 0, moon: 0 }
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1) {
        const added = at(drawn, x, y) - at(alone, x, y)
        const km = at(depth, x, y)
        const ray = viewOf(screenOf(x, y), f.halfTan)
        // The ray's closest approach to the center, over the datum.
        const closest = new Vector3().crossVectors(center, ray).length() - R
        const ahead = center.dot(ray) > 0
        if (km < 5_000) {
          counted.surface += 1
          expect(
            Math.abs(added - full),
            `surface (${x}, ${y}): ${added}`,
          ).toBeLessThanOrEqual(halfSteps(at(drawn, x, y)))
        } else if (ahead && closest > 3_000 && closest < LAYER_TOP - 3_000) {
          if (km < 30_000) counted.moon += 1
          else counted.sky += 1
          expect(added, `sky (${x}, ${y}) at ${km} km`).toBeLessThan(
            0.01 * full,
          )
        }
      }
    expect(counted.surface).toBeGreaterThan(100)
    expect(counted.sky).toBeGreaterThan(10)
    expect(counted.moon).toBeGreaterThan(2)
    f.dispose()
  })

  it.each([
    ['in the render axes', new Matrix3()],
    // Render +z is body-fixed −y: a transpose would turn the ray the other way.
    [
      'on a body turned a quarter about x',
      new Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0),
    ],
  ] as const)(
    'dims the cloud’s own light by the cleared transmittance on a surface and the physical one on the sky, and the blocked air by the physical one on both, %s',
    async (_, toBodyFixed) => {
      // Looking straight down from 10 km at a layer from 1 to 3 km, through a
      // gray air: a surface 9.5 km down over the left half, nothing on the right.
      const sigma = 630
      const f = rig({ medium: grayAir(sigma) })
      // Up is render +z, given in the body's own axes.
      const up = new Vector3(0, 0, 1)
      serve(
        f.uniforms.served,
        10_000,
        1_000,
        3_000,
        up.clone().applyMatrix3(toBodyFixed),
      )
      f.uniforms.served.toBodyFixed.value.copy(toBodyFixed)
      f.uniforms.served.cleared.value = 1
      const scene = sceneOf(
        facing(9_500, [-1.5, 0, -1.5, 1.5], colored([0.2, 0.2, 0.2])),
      )
      await f.frame(scene, false)
      const alone = await f.read('output')
      await f.write({ light: [0.1, 0.1, 0.1, 1] })
      await f.frame(scene, true)
      const lit = await f.read('output')
      await f.write({ light: [0, 0, 0, 1], air: [-0.05, -0.05, -0.05, 0] })
      await f.frame(scene, true)
      const blocked = await f.read('output')
      const eye = R + 10_000
      const shell = R + 3_000
      for (let y = 0; y < SIZE; y += 1)
        for (const x of [2, 7, 12, 19, 24, 29]) {
          const ray = viewOf(screenOf(x, y), f.halfTan)
          const mu = ray.dot(up)
          const b = eye * mu
          const start = -b - Math.sqrt(b * b - (eye * eye - shell * shell))
          const physical = Math.exp((-sigma * start) / R)
          const surface = x < SIZE / 2
          const ownLight = 0.1 * LIGHT * (surface ? 1 : physical)
          const lightAdded = at(lit, x, y) - at(alone, x, y)
          expect(
            Math.abs(lightAdded - ownLight),
            `L_c (${x}, ${y}): ${lightAdded} against ${ownLight}`,
          ).toBeLessThanOrEqual(0.01 * ownLight)
          const airAdded = at(blocked, x, y) - at(alone, x, y)
          const ownAir = -0.05 * LIGHT * physical
          expect(
            Math.abs(airAdded - ownAir),
            `B (${x}, ${y}): ${airAdded} against ${ownAir}`,
          ).toBeLessThanOrEqual(0.01 * Math.abs(ownAir))
        }
      f.dispose()
    },
  )
})

describe('the second body', () => {
  it('draws its far march under the served body’s cloud, by the thin form', async () => {
    // A far field that stands half the light out and adds a tenth.
    const far: CloudFarFn = (_ray, from) => ({
      light: vec3(0.1),
      air: vec3(0),
      airLight: vec3(0),
      transmittance: float(0.5),
      depthMean: from,
      depthDeviation: float(0),
    })
    const f = rig({ far })
    serve(f.uniforms.served, 1_000, 0, 3_000)
    serve(f.uniforms.second, 1_000, 0, 3_000)
    const scene = sceneOf(
      facing(50_000, [-1.5, 1.5, -1.5, 1.5], colored([0.3, 0.3, 0.3])),
    )
    await f.frame(scene, false)
    const alone = await f.read('output')
    await f.write({})
    await f.frame(scene, true)
    const second = await f.read('output')
    await f.write({ light: [0.2, 0.2, 0.2, 0.5] })
    await f.frame(scene, true)
    const both = await f.read('output')
    for (const [x, y] of [
      [3, 3],
      [16, 16],
      [28, 20],
    ] as const) {
      const behind = at(alone, x, y)
      const under = 0.5 * behind + 0.1 * LIGHT
      expect(Math.abs(at(second, x, y) - under)).toBeLessThanOrEqual(
        halfSteps(under),
      )
      // The served cloud over it: its light, then the second's through it.
      const over = 0.25 * behind + (0.2 + 0.5 * 0.1) * LIGHT
      expect(Math.abs(at(both, x, y) - over)).toBeLessThanOrEqual(
        halfSteps(over),
      )
    }
    f.dispose()
  })
})

describe('the residual meter', () => {
  it('counts the cloud texels, puts each error in its bin, and counts the texels whose class the corners dispute', async () => {
    const f = rig()
    serve(f.uniforms.served, 1_000, 0, 3_000)
    // A square 200 m out whose right edge is inside trace column 4; nothing
    // past it, which is sky.
    const scene = sceneOf(
      facing(200, [-1.5, 0.1, -1.5, 1.5], colored([0.3, 0.3, 0.3])),
    )
    await f.frame(scene, false)
    const alone = await f.readAll()
    await f.write({
      light: [0.2, 0.2, 0.2, 0.5],
      air: [-0.1, -0.1, -0.1, 1e6],
    })
    f.composite.setMode('residual')
    // Inert: the scene as built.
    await f.frame(scene, true)
    const inert = await f.readAll()
    for (const [name, values] of alone)
      expect(bits(inert.get(name)!), name).toEqual(bits(values))
    f.composite.measureResidual(gpu.renderer, f.target)
    await f.composite.residualRead()
    const residual = f.composite.residual
    expect(residual).not.toBeNull()
    const { thin, light, total, limb, classDisagreement } = residual!
    expect(thin.samples).toBe(TRACE * TRACE)
    for (const histogram of [thin, light, total])
      expect(histogram.bins.reduce((sum, n) => sum + n, 0)).toBe(TRACE * TRACE)
    // From 1 km the limb dips 1.0°, and the rows nearest it stand at ±4.1°.
    expect(limb.samples).toBe(0)
    expect(limb.bins.reduce((sum, n) => sum + n, 0)).toBe(0)
    // No air: the identity's own residuals are nothing.
    expect(light.bins[0]).toBe(TRACE * TRACE)
    expect(total.bins[0]).toBe(TRACE * TRACE)
    // The thin form drops B = −0.1 of light against an identity of
    // 0.5·scene + (0.2 − 0.1)·π: over the square's 0.3 a 0.677 error, bin 61;
    // over the black sky all of it, the top bin.
    const surface = 0.1 * Math.PI
    const reference = 0.5 * 0.3 + surface
    const bin = cloudHistogramBin(surface / reference)
    expect(bin).toBe(61)
    expect(thin.bins[bin]).toBe(TRACE * 4)
    expect(thin.bins[63]).toBe(TRACE * 4)
    expect(classDisagreement).toBe(TRACE)
    f.dispose()
  })

  it('bins on the GPU exactly as the report’s definition the runner reads back by', async () => {
    // Each bin's geometric middle, clear of the edges' rounding either way,
    // and the two ends' overflow.
    const errors = [
      ...Array.from({ length: CLOUD_HISTOGRAM_BINS }, (_, i) =>
        Math.sqrt(cloudHistogramEdge(i) * cloudHistogramEdge(i + 1)),
      ),
      0,
      1e-9,
      1,
      7,
    ]
    const input = new StorageBufferAttribute(new Float32Array(errors), 1)
    const output = new StorageBufferAttribute(new Uint32Array(errors.length), 1)
    const from = storage(input, 'float', errors.length)
    const into = storage(output, 'uint', errors.length)
    const kernel = Fn(() => {
      If(instanceIndex.lessThan(uint(errors.length)), () => {
        into
          .element(instanceIndex)
          .assign(residualBin(from.element(instanceIndex)))
      })
    })().compute(errors.length)
    await gpu.compute(kernel)
    const bins = [...new Uint32Array(await gpu.readBuffer(output))]
    expect(bins).toEqual(errors.map((e) => cloudHistogramBin(e)))
    kernel.dispose()
  })

  it('counts the sky texels within 2° of the limb apart, and a ring Enhanced does not draw loses nothing', async () => {
    // At 30° the row under the horizon stands at −1.9°, 0.9° from the limb
    // 1 km up, and the one over it at +1.9°, 2.9° away. The square fills
    // the lower half and ends inside column 4, so the row under the horizon
    // is sky in columns 4–7 alone and the row over it is sky throughout: a
    // band measured from the zenith would count 8.
    const fov = 30
    const halfTan = Math.tan((fov / 2) * (Math.PI / 180))
    const f = rig({ fov })
    serve(f.uniforms.served, 1_000, 0, 3_000)
    const scene = sceneOf(
      facing(200, [-1.5, 0.1, -1.5, 0], colored([0.3, 0.3, 0.3]), halfTan),
    )
    await f.write({
      light: [0.2, 0.2, 0.2, 0.5],
      air: [-0.1, -0.1, -0.1, 1e6],
    })
    f.composite.setMode('residual')
    await f.frame(scene, true)
    f.composite.measureResidual(gpu.renderer, f.target)
    await f.composite.residualRead()
    const { limb, thin } = f.composite.residual!
    expect(thin.samples).toBe(TRACE * TRACE)
    expect(limb.samples).toBe(4)
    expect(limb.bins[0]).toBe(4)
    f.dispose()
  })
})

describe('the warm-up', () => {
  it('builds every pipeline the first frame and the meter’s first measurement use', async () => {
    const fresh = await openGpu(SIZE, SIZE)
    try {
      setSceneExposure(fresh.renderer, GAIN / SURFACE_LUMINANCE)
      // A session of its own, because three caches a pipeline across
      // materials; and no depth copy in the frame, whose own warm-up is the
      // depth copy's to hold (`cloudDepth.gpu.test.ts`).
      const f = rig({ session: fresh, copyDepth: false })
      serve(f.uniforms.served, 1_000, 0, 3_000)
      await f.write({ light: [0.1, 0.1, 0.1, 0.5] })
      const scene = usual()
      // The scene's own pipelines, which are not the composite's to warm.
      await f.frame(scene, false)
      await f.composite.warm(fresh.renderer, f.layout, f.camera, scene)
      const render = fresh.pipelinesBuilt()
      const compute = fresh.computePipelinesBuilt()
      await f.frame(scene, true)
      expect(fresh.pipelinesBuilt()).toBe(render)
      f.composite.setMode('residual')
      f.composite.measureResidual(fresh.renderer, f.target)
      await f.composite.residualRead()
      expect(fresh.computePipelinesBuilt()).toBe(compute)
      f.dispose()
    } finally {
      fresh.dispose()
    }
  })
})
