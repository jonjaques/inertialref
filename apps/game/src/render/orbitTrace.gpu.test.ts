import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LineSegments,
  Mesh,
  MeshBasicNodeMaterial,
  SphereGeometry,
  LineBasicNodeMaterial,
  OrthographicCamera,
  Scene,
} from 'three/webgpu'
import { Quaternion as Q, vec3 } from '@inertialref/spatial'
import { clipOccludedSegment, type Occluder } from '@inertialref/rendering'
import { createOrbitTraceMaterial } from './orbitTrace.ts'
import { sensorRadiance, setSceneExposure } from './radiance.ts'
import { openGpu, type GpuSession, type Pixels } from './gpuHarness.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(16, 16)
})
afterAll(() => gpu.dispose())

/** The brightest pixel of a readback — the line, wherever the rasterizer put it. */
function brightest(pixels: Pixels): [number, number, number] {
  let best: [number, number, number] = [0, 0, 0]
  for (let y = 0; y < pixels.height; y++)
    for (let x = 0; x < pixels.width; x++) {
      const [r, g, b] = pixels.at(x, y)
      if (r + g + b > best[0] + best[1] + best[2]) best = [r, g, b]
    }
  return best
}

function traceAcross(material: LineBasicNodeMaterial): Scene {
  const geometry = new BufferGeometry()
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, 0, 0, 1, 0, 0]), 3),
  )
  const line = new Line(geometry, material)
  line.frustumCulled = false
  const scene = new Scene()
  scene.add(line)
  scene.updateMatrixWorld(true)
  return scene
}

it('presents at one brightness from a 1/40,000 s snapshot to a 2,400 s instrument', async () => {
  const renderer = gpu.renderer
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  camera.position.z = 0.5
  camera.updateMatrixWorld()
  const trace = createOrbitTraceMaterial()
  const scene = traceAcross(trace)
  // The control: a line pre-exposed with the scene, the way the trace was.
  const exposed = sensorRadiance(new LineBasicNodeMaterial())
  exposed.color.setRGB(0.35, 0.62, 0.85)
  const control = traceAcross(exposed)
  try {
    // Pre-exposures spanning the lens's range, each with no residual, so a
    // scene-exposed line scales by the whole ratio and a trace by none.
    const readings: [number, number, number][] = []
    const controls: [number, number, number][] = []
    for (const pre of [1e-6, 1e-3, 1]) {
      setSceneExposure(renderer, pre, pre)
      readings.push(brightest(await gpu.draw(scene, camera, { float: true })))
      controls.push(brightest(await gpu.draw(control, camera, { float: true })))
    }
    for (const [r, g, b] of readings) {
      // The written color through a 0.32 blend over the clear.
      expect(r).toBeCloseTo(0.35 * 0.32, 4)
      expect(g).toBeCloseTo(0.62 * 0.32, 4)
      expect(b).toBeCloseTo(0.85 * 0.32, 4)
    }
    expect(controls[2]![0] / controls[0]![0]).toBeGreaterThan(1e5)
  } finally {
    setSceneExposure(renderer, null)
    trace.dispose()
    exposed.dispose()
  }
})

it('draws the visible pieces around an opaque disk and preserves a foreground transit', async () => {
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 10)
  camera.position.z = 1
  camera.updateMatrixWorld()
  const material = createOrbitTraceMaterial()
  const diskMaterial = new MeshBasicNodeMaterial({ color: 0xff0000 })
  const diskGeometry = new SphereGeometry(0.2, 32, 16)
  const disk = new Mesh(diskGeometry, diskMaterial)
  const scene = new Scene()
  scene.add(disk)
  const occluder: Occluder = {
    address: 'planet',
    center: vec3(0, 0, -10),
    axes: vec3(2, 2, 2),
    inverse: Q.IDENTITY,
    bounds: [-Infinity, Infinity, -Infinity, Infinity],
  }
  const trace = (z: number): LineSegments => {
    const values: number[] = []
    clipOccludedSegment(
      vec3(z / 2, 0, z),
      vec3(-z / 2, 0, z),
      [occluder],
      (a, b) => {
        for (const p of [a, b]) values.push(p.x / -p.z, p.y / -p.z, 0.5)
      },
    )
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(values), 3),
    )
    return new LineSegments(geometry, material)
  }
  const behind = trace(-20),
    front = trace(-5)
  try {
    scene.add(behind)
    scene.updateMatrixWorld(true)
    const hidden = await gpu.draw(scene, camera, {
      width: 64,
      height: 64,
      float: true,
    })
    for (let y = 31; y <= 32; y++)
      for (let x = 28; x <= 35; x++)
        expect(hidden.at(x, y)[2]).toBeLessThan(0.001)
    expect(brightest(hidden)[0]).toBeGreaterThan(0.9)
    scene.remove(behind)
    scene.add(front)
    scene.updateMatrixWorld(true)
    const transit = await gpu.draw(scene, camera, {
      width: 64,
      height: 64,
      float: true,
    })
    expect(
      Math.max(transit.at(32, 31)[2], transit.at(32, 32)[2]),
    ).toBeGreaterThan(0.2)
  } finally {
    behind.geometry.dispose()
    front.geometry.dispose()
    material.dispose()
    diskMaterial.dispose()
    diskGeometry.dispose()
  }
})
