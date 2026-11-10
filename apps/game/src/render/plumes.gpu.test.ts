import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SURFACE_LUMINANCE, type ThrusterLayout } from '@inertialref/rendering'
import {
  type BufferGeometry,
  DataTexture,
  DataUtils,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  NodeUpdateType,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
} from 'three/webgpu'
import { pass, vec3 } from 'three/tsl'
import { KNOT_PADDING } from './cloudKnots.ts'
import { createCloudFrontHandle } from './cloudSystem.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import { openGpu, type GpuSession, type Pixels } from './gpuHarness.ts'
import { createThrusterPlumes } from './plumes.ts'
import { setSceneExposure } from './radiance.ts'
import { sensorMrt } from './sensorMrt.ts'
import { DEFAULT_PICTURE } from './picture.ts'
import { sceneBackend, sceneLayout } from './sceneLayout.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(64, 64)
})
afterAll(() => gpu.dispose())

function brightest(pixels: Pixels): [number, number] {
  let best: [number, number] = [0, 0]
  let light = 0
  for (let y = 0; y < pixels.height; y += 1)
    for (let x = 0; x < pixels.width; x += 1) {
      const [r, g, b] = pixels.at(x, y)
      if (r + g + b > light) {
        light = r + g + b
        best = [x, y]
      }
    }
  return best
}

it.each(['rcs', 'pod', 'drive shell', 'drive disk'] as const)(
  'exposes the %s plume as light and preserves the surface underneath',
  async (kind) => {
    const camera = new PerspectiveCamera(65, 1, 0.01, 100)
    camera.position.z = 3
    const scene = new Scene()
    const surface = new Mesh(
      new PlaneGeometry(8, 8),
      new MeshBasicNodeMaterial(),
    )
    surface.material.colorNode = vec3(0)
    scene.add(surface)
    const mouth = { position: { x: 0, y: 0, z: 1 }, radius: 0.12 }
    const layout: ThrusterLayout =
      kind === 'rcs' || kind === 'pod'
        ? {
            nozzles: [{ ...mouth, exhaust: { x: 0, y: 0, z: 1 }, kind }],
            drive: null,
          }
        : { nozzles: [], drive: mouth }
    const plumes = createThrusterPlumes(layout)
    plumes.update(new Float32Array([1]), 1, 1)
    // Each production material must supply both radiance and the overlay flag;
    // a lit disk cannot cover for a shell that draws black, or the reverse.
    plumes.group.children.forEach((child, index) => {
      child.visible = index === (kind === 'drive disk' ? 1 : 0)
    })
    scene.add(plumes.group)
    const scenePass = pass(scene, camera)
    scenePass.updateBeforeType = NodeUpdateType.RENDER
    scenePass.setMRT(
      sensorMrt(sceneLayout(DEFAULT_PICTURE, sceneBackend(gpu.renderer))),
    )
    const output = scenePass.getTextureNode('output')
    const motion = scenePass.getTextureNode('motion')
    try {
      setSceneExposure(gpu.renderer, 1 / SURFACE_LUMINANCE)
      const bright = await gpu.drawGraph(output, { float: true })
      const pixel = brightest(bright)
      const full = bright.at(...pixel)
      for (const channel of [0, 1, 2] as const)
        expect(full[channel]).toBeGreaterThan(0.1)

      setSceneExposure(gpu.renderer, 0.25 / SURFACE_LUMINANCE)
      const dim = await gpu.drawGraph(output, { float: true })
      const reduced = dim.at(...pixel)
      for (const channel of [0, 1, 2] as const)
        expect.soft(reduced[channel] / full[channel]).toBeCloseTo(0.25, 3)

      const depth = await gpu.drawGraph(motion, { float: true })
      // The plume is nearer than the three-meter surface. Test where it emits
      // light, as well as outside its footprint, so an invisible draw cannot pass.
      expect.soft(depth.at(...pixel)[2]).toBeCloseTo(1 / 3, 3)
      expect.soft(depth.at(2, 2)[2]).toBeCloseTo(1 / 3, 3)
      expect.soft(depth.at(...pixel)[0]).toBeCloseTo(0, 5)
      expect.soft(depth.at(...pixel)[1]).toBeCloseTo(0, 5)
    } finally {
      setSceneExposure(gpu.renderer, null)
      scenePass.dispose()
      plumes.dispose()
      surface.geometry.dispose()
      surface.material.dispose()
    }
  },
)

it.each(['rcs', 'pod'] as const)(
  'draws a short %s settling puff at low opening',
  async (kind) => {
    const camera = new OrthographicCamera(-2, 2, 2, -2, 0.01, 100)
    camera.position.z = 5
    const scene = new Scene()
    const plumes = createThrusterPlumes({
      nozzles: [
        {
          position: { x: -1, y: 0, z: 0 },
          exhaust: { x: 1, y: 0, z: 0 },
          radius: 0.1,
          kind,
        },
      ],
      drive: null,
    })
    // Keep the production vertex graph. A white silhouette isolates its length
    // from the plume's noise, brightness falloff and sensor exposure.
    const mesh = plumes.group.children[0] as Mesh<
      BufferGeometry,
      MeshBasicNodeMaterial
    >
    mesh.material.colorNode = vec3(1)
    scene.add(plumes.group)
    const scenePass = pass(scene, camera)
    scenePass.updateBeforeType = NodeUpdateType.RENDER
    const span = (pixels: Pixels) => {
      let first = pixels.width
      let last = -1
      for (let y = 0; y < pixels.height; y += 1)
        for (let x = 0; x < pixels.width; x += 1)
          if (pixels.at(x, y)[0] > 0.1) {
            first = Math.min(first, x)
            last = Math.max(last, x)
          }
      return last - first + 1
    }
    try {
      plumes.update(new Float32Array([1]), 0, 10)
      const full = span(await gpu.drawGraph(scenePass, { float: true }))
      plumes.update(new Float32Array([0.08]), 0, 10)
      const small = span(await gpu.drawGraph(scenePass, { float: true }))
      expect(full).toBeGreaterThan(8)
      expect(small).toBeGreaterThan(2)
      expect(small / full).toBeLessThan(0.6)
    } finally {
      scenePass.dispose()
      plumes.dispose()
    }
  },
)

/** A one-texel trace: one slab's knot, the other three padding (design §4.9). */
function slab(
  [entry, exit]: readonly [number, number],
  through: number,
  light: number,
): CloudTraceTextures {
  const half = (values: readonly number[]) =>
    new Uint16Array(values.map((v) => DataUtils.toHalfFloat(v)))
  const pad = KNOT_PADDING.depth
  const depth = new DataTexture(
    half([entry, exit, pad, pad, pad, pad, pad, pad]),
    2,
    1,
    RGBAFormat,
    HalfFloatType,
  )
  // Knot k at (k & 1, k >> 1): the slab's first, padding after.
  const knots = new DataTexture(
    half([
      ...[light, light, light, through],
      ...[0, 0, 0, 1],
      ...[0, 0, 0, 1],
      ...[0, 0, 0, 1],
    ]),
    2,
    2,
    RGBAFormat,
    HalfFloatType,
  )
  depth.needsUpdate = true
  knots.needsUpdate = true
  return {
    light: depth,
    aux: depth,
    knotDepth: depth,
    knotLight: knots,
    extent: { width: 1, height: 1 },
  } as unknown as CloudTraceTextures
}

describe('a plume seen through the clouds in front of it', () => {
  /*
   * The drive, burning toward the camera over black: its sheath and its
   * disk, both additive, so each pixel is the plume's own light times the
   * transmittance in front of it and the cloud's light is the frame's, not
   * the plume's. Built before the handle follows anything, as the page
   * builds it, and sampled at one instant, so the noise is the same frame
   * for every draw.
   */
  const THROUGH = 0.3
  /** The knots are half floats: 0.3 is 2⁻¹³ off in one. */
  const WITHIN = 1e-3

  it('is dimmed by a slab in front of it, and untouched by one behind it', async () => {
    const camera = new PerspectiveCamera(65, 1, 0.01, 100)
    camera.position.z = 3
    camera.updateMatrixWorld()
    const mouth = { position: { x: 0, y: 0, z: 1 }, radius: 0.12 }
    const layout: ThrusterLayout = { nozzles: [], drive: mouth }
    const handle = createCloudFrontHandle()
    const drawFor = async (front?: typeof handle) => {
      const plumes = createThrusterPlumes(layout, front)
      plumes.sample(1, 2.5)
      const scene = new Scene()
      scene.add(plumes.group)
      scene.updateMatrixWorld(true)
      try {
        return await gpu.draw(scene, camera, { float: true })
      } finally {
        plumes.dispose()
      }
    }
    const bare = await drawFor()
    const plumes = createThrusterPlumes(layout, handle)
    plumes.sample(1, 2.5)
    const scene = new Scene()
    scene.add(plumes.group)
    scene.updateMatrixWorld(true)
    const draw = () => gpu.draw(scene, camera, { float: true })
    try {
      // Every fragment is 0.9 to 2.1 m from the lens.
      const clear = await draw()
      handle.follow(() => slab([0.0001, 0.0005], THROUGH, 0.2))
      const inFront = await draw()
      handle.follow(() => slab([0.01, 0.02], THROUGH, 0.2))
      const behind = await draw()
      let lit = 0
      for (let y = 0; y < bare.height; y += 1)
        for (let x = 0; x < bare.width; x += 1)
          for (let c = 0; c < 3; c += 1) {
            const own = bare.at(x, y)[c]!
            if (own > 0.01) lit += 1
            expect(clear.at(x, y)[c]).toBe(own)
            expect(behind.at(x, y)[c]).toBe(own)
            expect(
              Math.abs(inFront.at(x, y)[c]! - own * THROUGH),
              `(${x}, ${y}) channel ${c}`,
            ).toBeLessThanOrEqual(WITHIN * own + 1e-6)
          }
      // A plume that drew nothing would pass every comparison above.
      expect(lit).toBeGreaterThan(100)
    } finally {
      plumes.dispose()
    }
  })
})
