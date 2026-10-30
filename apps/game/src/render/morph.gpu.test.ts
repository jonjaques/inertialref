import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Object3D, Vector2, Vector3 } from 'three/webgpu'
import { int, uniform, uniformArray, uv, vec4 } from 'three/tsl'
import {
  COVER_CHANNELS,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  heightfieldStride,
  regionAddress,
  regionDirection,
} from '@inertialref/universe'
import {
  buildPatch,
  PATCH_EDGE,
  type RenderPatch,
  vertexMorph,
} from '@inertialref/rendering'
import { openGpu, type GpuSession } from './gpuHarness.ts'
import { vertexMorphFactor } from './morph.ts'
import { placeEye, wearGround } from './groundWear.ts'

/*
 * The vertex stage's morph factor, on the GPU, against `vertexMorph` — the
 * rule the rocks are seated by and the drawn ground's closure is tested
 * through. The graph is the production node over a real patch's vertices, the
 * band crossing the patch so the factor runs through its whole range, and the
 * held edges reaching every one of the four; the flags arrive through the
 * production dresser, so the bit order is held end to end.
 */

const RES = HEIGHTFIELD_RESOLUTION
const COUNT = 64

let gpu: GpuSession
beforeAll(async () => {
  gpu = await openGpu(COUNT, 1)
})
afterAll(() => gpu.dispose())

/** A patch of rolling ground on a 1,000 km body: enough relief to move a vertex. */
function patch(): RenderPatch {
  const region = regionAddress(2, 6, 10, 20)
  const border = HEIGHTFIELD_BORDER
  const stride = heightfieldStride({ resolution: RES, border })
  const elevations = new Float32Array(stride * stride)
  for (let row = -border; row < RES + border; row += 1)
    for (let col = -border; col < RES + border; col += 1) {
      const d = regionDirection(region, col / (RES - 1), row / (RES - 1))
      elevations[(row + border) * stride + col + border] =
        300 * Math.sin(d.x * 900) + 120 * Math.cos(d.z * 2_300)
    }
  return buildPatch({
    region,
    resolution: RES,
    border,
    elevations,
    cover: new Uint8Array(RES * RES * COVER_CHANNELS),
    bodyRadius: 1_000_000,
  })
}

/** Corners, both parities on all four edges, and the interior between. */
function vertices(): number[] {
  const last = RES - 1
  const picked = [
    0,
    last,
    last * RES,
    last * RES + last,
    31,
    32,
    31 * RES,
    32 * RES,
    31 * RES + last,
    32 * RES + last,
    last * RES + 31,
    last * RES + 32,
  ]
  let state = 17
  while (picked.length < COUNT) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    picked.push(state % (RES * RES))
  }
  return picked
}

describe('the vertex morph factor', () => {
  const source = patch()
  const indices = vertices()
  const size = (RES - 1) * source.spacing
  // The eye over the middle; the band closes inside the edges, so every edge
  // vertex would be fully morphed if nothing held it.
  const eye = new Vector3(
    source.anchor.x * 1.00001,
    source.anchor.y * 1.00001,
    source.anchor.z * 1.00001,
  )
  const band = { start: size * 0.15, end: size * 0.4 }

  for (const [label, edges] of [
    ['with nothing held', 0],
    ['with two edges held', PATCH_EDGE.colStart | PATCH_EDGE.rowEnd],
    ['with the other two held', PATCH_EDGE.colEnd | PATCH_EDGE.rowStart],
  ] as const) {
    it(`is vertexMorph ${label}`, async () => {
      const wearer = new Object3D()
      const wear = wearGround(wearer, source.anchor, 1_000_000)
      placeEye(
        wearer,
        {
          x: eye.x - source.anchor.x,
          y: eye.y - source.anchor.y,
          z: eye.z - source.anchor.z,
        },
        band.start,
        band.end,
        edges,
      )
      const pixel = int(uv().x.mul(COUNT))
      // Typed for the reason `terrain.ts` gives its attributes: the literal
      // widens to `string` without it.
      const index = uniformArray<'float'>(indices.slice(), 'float').element(
        pixel,
      )
      const position = uniformArray<'vec3'>(
        indices.map(
          (i) =>
            new Vector3(
              source.positions[i * 3],
              source.positions[i * 3 + 1],
              source.positions[i * 3 + 2],
            ),
        ),
        'vec3',
      ).element(pixel)
      const k = vertexMorphFactor(
        index,
        position,
        uniform(wear.eyeLocal),
        uniform(new Vector2(band.start, band.end)),
        uniform(wear.morphEdges),
      )
      const pixels = await gpu.drawGraph(vec4(k, 0, 0, 1), {
        float: true,
        width: COUNT,
        height: 1,
      })
      let held = 0
      let sliding = 0
      for (let n = 0; n < COUNT; n += 1) {
        const i = indices[n] as number
        const row = Math.floor(i / RES)
        const col = i % RES
        const want = vertexMorph(
          source,
          { eye, start: band.start, end: band.end, finerEdges: edges },
          row,
          col,
        )
        const free = vertexMorph(
          source,
          { eye, start: band.start, end: band.end, finerEdges: 0 },
          row,
          col,
        )
        const [got] = pixels.at(n, 0)
        /*
         * float32 distance against float64: the eye and the vertex are a
         * few kilometers apart in patch-local meters, where a float32 step
         * is a millimeter, over a band tens of kilometers wide.
         */
        expect(Math.abs(got - want)).toBeLessThan(1e-4)
        if (want === 0 && free > 0) held += 1
        if (want > 0 && want < 1) sliding += 1
      }
      // The draw asked the question it was meant to: some vertices mid-band,
      // and with edges held, edge vertices the band had reached held still.
      expect(sliding).toBeGreaterThan(5)
      if (edges === 0) expect(held).toBe(0)
      else expect(held).toBeGreaterThan(4)
    })
  }
})
