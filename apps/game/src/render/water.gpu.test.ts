import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DepthTexture,
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  Vector3,
} from 'three/webgpu'
import { vec3 } from 'three/tsl'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { placeEye, wearSea } from './groundWear.ts'
import {
  installPassTimeline,
  namePass,
  passTimelineOf,
} from './passTimeline.ts'
import {
  createWaterMaterial,
  SWELL_PERIOD,
  type WaterMaterial,
} from './water.ts'

/*
 * The sea's two materials, drawn the way the scene pass draws them: into a
 * four-sample target with a float depth, after the opaque ground they read.
 *
 * A bay with a cliff standing out of it, seen from three meters. The full
 * sea copies the frame and must split the scene pass once; the plain sea
 * must not split it at all. And the clock: the waves have to move at a
 * present-day instant, and the surf has to run in at the swell's period.
 */

const SIZE = 64
const TIMESTAMPS = await adapterOffers('timestamp-query')
let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(SIZE, SIZE)
})
afterAll(() => gpu.dispose())

/**
 * A sheet of water over the plane z = 0, as `sheetGeometry` lays one out,
 * `near` meters deep along its −y edge and `far` along its +y edge.
 */
function sheet(
  material: MeshBasicNodeMaterial,
  eye: Vector3,
  [x0, y0, x1, y1]: readonly [number, number, number, number],
  near: number,
  far: number,
): Mesh {
  const corners = new Float32Array([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0])
  const depths = new Float32Array([near, near, far, far])
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(corners, 3))
  geometry.setAttribute('terrainMorph', new BufferAttribute(corners.slice(), 3))
  geometry.setAttribute('waterDepth', new BufferAttribute(depths, 1))
  geometry.setAttribute(
    'waterMorphDepth',
    new BufferAttribute(depths.slice(), 1),
  )
  geometry.setIndex([0, 1, 2, 0, 2, 3])
  const mesh = new Mesh(geometry, material)
  // An anchor straight up +Z on a Luna-sized body, so the datum's normal is
  // +Z across the sheet to a part in a million; the morph is far away.
  wearSea(mesh, { x: 0, y: 0, z: 1_737_400 })
  placeEye(mesh, eye, 1e6, 2e6)
  return mesh
}

function bay(water: WaterMaterial) {
  const eye = new Vector3(0, -20, 3)
  const camera = new PerspectiveCamera(60, 1, 0.05, 2000)
  camera.up.set(0, 0, 1)
  camera.position.copy(eye)
  camera.lookAt(0, 40, 3)
  camera.updateMatrixWorld(true)

  const seabedMaterial = new MeshBasicNodeMaterial()
  seabedMaterial.colorNode = vec3(0.05, 0.05, 0.05)
  const seabed = new Mesh(new PlaneGeometry(400, 400), seabedMaterial)
  seabed.position.z = -2

  const cliffMaterial = new MeshBasicNodeMaterial()
  cliffMaterial.colorNode = vec3(1, 0, 0)
  // Ten meters wide, standing from the seabed to fifteen meters up.
  const cliff = new Mesh(new BoxGeometry(10, 2, 17), cliffMaterial)
  cliff.position.set(0, 40, 6.5)

  const sea = sheet(water.material, eye, [-200, -100, 200, 300], 2, 2)
  const scene = new Scene()
  scene.add(seabed, cliff, sea)
  scene.updateMatrixWorld(true)

  const target = new RenderTarget(SIZE, SIZE, {
    samples: 4,
    depthTexture: new DepthTexture(SIZE, SIZE, FloatType),
  })
  namePass(target, 'scene')

  /** The pixel `point` projects to, y down from the top. */
  const pixel = (point: Vector3): [number, number] => {
    const ndc = point.clone().project(camera)
    return [
      Math.round(((ndc.x + 1) / 2) * SIZE - 0.5),
      Math.round(((1 - ndc.y) / 2) * SIZE - 0.5),
    ]
  }
  return {
    camera,
    scene,
    sea,
    target,
    pixel,
    dispose() {
      target.dispose()
      seabed.geometry.dispose()
      cliff.geometry.dispose()
      sea.geometry.dispose()
      seabedMaterial.dispose()
      cliffMaterial.dispose()
    },
  }
}

describe.skipIf(!TIMESTAMPS)('the sea splits the scene pass', () => {
  /*
   * The full sea copies the frame, and three's path for a copy ends the
   * pass and begins it again, so the timeline sees the scene pass and one
   * resumption of it. The plain sea copies nothing and the pass stays whole
   * — which is the whole reason `plain` is a material.
   */
  it.each([
    ['full', true, ['scene', 'scene after copy']],
    ['plain', false, ['scene']],
  ] as const)('the %s sea', async (_name, frame, passes) => {
    const water = createWaterMaterial()
    water.setQuality({ frame, waveOctaves: 2 })
    const rig = bay(water)
    const stop = installPassTimeline(gpu.renderer)
    try {
      const draw = () => {
        gpu.renderer.setRenderTarget(rig.target)
        gpu.renderer.render(rig.scene, rig.camera)
        gpu.renderer.setRenderTarget(null)
      }
      draw() // compile outside the measurement
      const timeline = passTimelineOf(gpu.renderer)
      expect(timeline).not.toBeNull()
      const result = await timeline!.measure(draw, 4)
      expect(result.dropped).toBe(0)
      expect(result.passes.map((pass) => pass.label)).toEqual(passes)
    } finally {
      stop()
      rig.dispose()
    }
  })
})

describe('the presentation clock', () => {
  /** The red channel down the middle column of `scene`, at `seconds`. */
  const column = async (
    water: WaterMaterial,
    scene: Scene,
    camera: PerspectiveCamera,
    seconds: number,
  ): Promise<number[]> => {
    water.setTime(seconds)
    const frame = await gpu.draw(scene, camera, { float: true })
    const rows: number[] = []
    for (let y = 0; y < SIZE; y += 1) rows.push(frame.at(SIZE / 2, y)[0])
    return rows
  }
  const apart = (a: number[], b: number[]) =>
    Math.max(...a.map((value, y) => Math.abs(value - b[y]!)))

  it('moves the waves between two frames of a present-day instant', async () => {
    /*
     * Simulation time is seconds after J2000, and a session set in 2026 is
     * 8.2 × 10⁸ of them, which float32 holds to the nearest 64 s. A clock
     * handed to the shader whole moves the waves once a minute.
     */
    const water = createWaterMaterial()
    water.setQuality({ frame: false, waveOctaves: 2 })
    water.sunDirection.value.set(0.6, 0, 0.8)
    const eye = new Vector3(0, -6, 3)
    const camera = new PerspectiveCamera(60, 1, 0.05, 200)
    camera.up.set(0, 0, 1)
    camera.position.copy(eye)
    camera.lookAt(0, 4, 0)
    camera.updateMatrixWorld(true)
    const sea = sheet(water.material, eye, [-40, -10, 40, 60], 2, 2)
    const scene = new Scene()
    scene.add(sea)
    scene.updateMatrixWorld(true)
    const instant = 8.2e8 + 0.375
    try {
      const now = await column(water, scene, camera, instant)
      const later = await column(water, scene, camera, instant + 1)
      // A second of drift moves the column by a tenth of its brightest
      // pixel; a clock quantized to 64 s moves it by nothing at all.
      expect(apart(now, later)).toBeGreaterThan(0.03 * Math.max(...now))
    } finally {
      sea.geometry.dispose()
    }
  })

  /*
   * A shore seen from straight above: a sheet shoaling from 1.4 m to a few
   * centimeters across twenty meters, the zone the foam stands in, with the
   * waves off so the swell's value cannot move the foam for it. What is
   * left to move is the surf's phase, and only the presentation clock moves
   * it.
   */
  it('runs in at the swell period and comes back to where it was', async () => {
    const water = createWaterMaterial()
    water.setQuality({ frame: false, waveOctaves: 0 })
    // Off to the side, so the glint lands off the sheet.
    water.sunDirection.value.set(0.6, 0, 0.8)
    const eye = new Vector3(0, 0, 30)
    const camera = new PerspectiveCamera(60, 1, 0.05, 200)
    camera.position.copy(eye)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld(true)
    // Deep along −y, shallow along +y: the top of the frame is the shore.
    const sea = sheet(water.material, eye, [-10, -10, 10, 10], 1.4, 0.04)
    const scene = new Scene()
    scene.add(sea)
    scene.updateMatrixWorld(true)
    const start = 1_000_000.25
    try {
      const at = (seconds: number) => column(water, scene, camera, seconds)
      const now = await at(start)
      const quarter = await at(start + SWELL_PERIOD / 4)
      const whole = await at(start + SWELL_PERIOD)
      const moved = (later: number[]) => apart(later, now)
      /** The rows `later` is shifted toward the shore by, at its best match with `now`. */
      const shoreward = (later: number[]) => {
        let best = 0
        let least = Infinity
        for (let rows = -8; rows <= 8; rows += 1) {
          let sum = 0
          for (let y = 8; y < SIZE - 8; y += 1)
            sum += (later[y]! - now[y + rows]!) ** 2
          if (sum < least) [best, least] = [rows, sum]
        }
        return best
      }
      /*
       * A quarter period on, every crest stands a quarter of `SURF_SPACING`
       * shallower: 0.11 m of depth over a shoal of 0.068 m a meter is 1.7 m
       * of sea, three rows at this height.
       */
      expect(moved(quarter)).toBeGreaterThan(0.02)
      expect(shoreward(quarter)).toBeGreaterThanOrEqual(2)
      expect(shoreward(quarter)).toBeLessThanOrEqual(4)
      // A whole period on it is back, to the phase's float64 reduction.
      expect(moved(whole)).toBeLessThan(1e-3 * moved(quarter))
    } finally {
      sea.geometry.dispose()
    }
  })
})
