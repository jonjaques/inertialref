import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  Mesh,
  MeshBasicNodeMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  RGBAFormat,
  Scene,
} from 'three/webgpu'
import { uniform } from 'three/tsl'
import { ATMOSPHERE_GAIN } from '@inertialref/rendering'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { KNOT_PADDING } from './cloudKnots.ts'
import { createCloudFrontHandle } from './cloudSystem.ts'
import type { CloudTraceTextures } from './cloudTrace.ts'
import { createEntryTraceMaterials } from './entryTrace.ts'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { setSceneExposure } from './radiance.ts'

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(32, 32)
})
afterAll(() => gpu.dispose())

it('depth-tests the rope endpoints rather than its ribbon template', async () => {
  const materials = createEntryTraceMaterials()
  const target = new RenderTarget(32, 32, {
    type: FloatType,
    depthBuffer: true,
  })
  const geometry = new LineSegmentsGeometry()
  const line = new LineSegments2(geometry, materials.ring)
  line.position.z = -4
  line.renderOrder = 1
  const ground = new Mesh(
    new PlaneGeometry(10, 10),
    new MeshBasicNodeMaterial({ color: 0xff0000 }),
  )
  ground.position.z = -3.5
  const scene = new Scene()
  scene.add(ground, line)
  const camera = new PerspectiveCamera(60, 1, 0.1, 100)
  camera.updateMatrixWorld()
  try {
    for (const endpointZ of [1, -1]) {
      geometry.setPositions([-0.8, 0, endpointZ, 0.8, 0, endpointZ])
      scene.updateMatrixWorld(true)
      const pixels = await gpu.draw(scene, camera, { into: target })
      const blue = pixels.at(16, 16)[2]
      if (endpointZ > 0) expect(blue).toBeGreaterThan(0.5)
      else expect(blue).toBeLessThan(0.1)
    }
  } finally {
    geometry.dispose()
    target.dispose()
    ground.geometry.dispose()
    ground.material.dispose()
    for (const material of Object.values(materials)) material.dispose()
  }
})

it('draws a two-pixel landing ring at the same radiance across exposures', async () => {
  const materials = createEntryTraceMaterials()
  const geometry = new LineSegmentsGeometry().setPositions([
    -0.8, 0, 0, 0.8, 0, 0,
  ])
  const line = new LineSegments2(geometry, materials.ring)
  const scene = new Scene()
  scene.add(line)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  camera.position.z = 0.5
  camera.updateMatrixWorld()
  scene.updateMatrixWorld(true)
  try {
    const readings: number[] = []
    for (const exposure of [1e-6, 1]) {
      setSceneExposure(gpu.renderer, exposure, exposure)
      const pixels = await gpu.draw(scene, camera, { float: true })
      let rows = 0
      let blue = 0
      for (let y = 0; y < pixels.height; y += 1) {
        const value = pixels.at(16, y)[2]
        if (value > 0.5) rows += 1
        blue = Math.max(blue, value)
      }
      expect(rows).toBe(2)
      readings.push(blue)
    }
    expect(readings[0]).toBeCloseTo(1.8, 3)
    expect(readings[1]).toBeCloseTo(readings[0]!, 3)
  } finally {
    setSceneExposure(gpu.renderer, null)
    geometry.dispose()
    for (const material of Object.values(materials)) material.dispose()
  }
})

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

describe('the trace seen through the clouds in front of it', () => {
  /*
   * The landing ring's ink, alpha-blended, over black: where it covers a
   * pixel whole, the pixel is `color·T + L`. The segment is drawn half a
   * meter from the lens and its object's origin five and a half: Line2
   * expands its ribbon in its own projection, so a material that took its
   * distance from `positionView` would read the template at the origin, and
   * the slab between the two (2 to 3 m) tells which it read.
   */
  const THROUGH = 0.5
  const LIGHT = 0.1
  const WITHIN = 2e-3

  it('is dimmed and lit by a slab in front of the line, and untouched by one behind it', async () => {
    const handle = createCloudFrontHandle()
    const compression = uniform(1)
    const bare = createEntryTraceMaterials()
    const read = createEntryTraceMaterials({ handle, compression })
    const geometry = new LineSegmentsGeometry().setPositions([
      -0.8, 0, 5, 0.8, 0, 5,
    ])
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 10)
    camera.position.z = 0.5
    camera.updateMatrixWorld()
    const draw = (material: typeof bare.ring) => {
      const line = new LineSegments2(geometry, material)
      line.position.z = -5
      const scene = new Scene()
      scene.add(line)
      scene.updateMatrixWorld(true)
      return gpu.draw(scene, camera, { float: true })
    }
    try {
      const own = await draw(bare.ring)
      const clear = await draw(read.ring)
      handle.follow(() => slab([0.0001, 0.0003], THROUGH, LIGHT))
      const inFront = await draw(read.ring)
      handle.follow(() => slab([0.002, 0.003], THROUGH, LIGHT))
      const between = await draw(read.ring)
      // The compression divides the view distance: at a tenth, the line's
      // 0.5 m is 5 m true, behind a slab at 2 to 3 m.
      compression.value = 0.1
      const compressed = await draw(read.ring)
      let rows = 0
      for (let y = 0; y < own.height; y += 1) {
        const ink = own.at(16, y)
        if (ink[2] <= 0.5) continue
        rows += 1
        for (let c = 0; c < 3; c += 1) {
          expect(clear.at(16, y)[c]).toBe(ink[c])
          expect(between.at(16, y)[c]).toBe(ink[c])
          const expected = ink[c]! * THROUGH + LIGHT * ATMOSPHERE_GAIN
          expect(
            Math.abs(inFront.at(16, y)[c]! - expected),
            `row ${y} channel ${c}`,
          ).toBeLessThanOrEqual(WITHIN * expected)
          expect(
            Math.abs(compressed.at(16, y)[c]! - expected),
            `row ${y} channel ${c}, compressed`,
          ).toBeLessThanOrEqual(WITHIN * expected)
        }
      }
      expect(rows).toBe(2)
    } finally {
      geometry.dispose()
      for (const material of [...Object.values(bare), ...Object.values(read)])
        material.dispose()
    }
  })
})
