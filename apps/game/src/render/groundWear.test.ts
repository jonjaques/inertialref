import { describe, expect, it } from 'vitest'
import { BufferAttribute, Mesh, MeshBasicNodeMaterial } from 'three/webgpu'
import { buildPatch, NO_MORPH_DISTANCE } from '@inertialref/rendering'
import { COVER_CHANNELS, regionAddress } from '@inertialref/universe'
import {
  anchorGround,
  COVER_ATTRIBUTES,
  groundDummy,
  MORPH_COVER_ATTRIBUTES,
  patchGeometry,
  placeEye,
  seaDummy,
  sheetGeometry,
  wearGround,
  wearSea,
} from './groundWear.ts'
import { GRAIN_PERIOD } from './terrain.ts'
import { WAVE_PERIOD } from './water.ts'
import {
  groundWearOf,
  seaWearOf,
  UNDRESSED_GROUND,
  UNDRESSED_SEA,
} from './wear.ts'

/*
 * The protocol between a wearer and the material, held in Node.
 *
 * The attribute half is proven on the GPU by `materials.gpu.test.ts`, which
 * compiles the dresser's own patch and dummies and asks the node builder
 * whether anything it read was missing. This is the other half: the record
 * the `onObjectUpdate` uniforms read, and the ritual inside it, which no
 * compile can see — a wrong altitude is a flat sea drawn as a grid of
 * rectangles, not a warning.
 */

/** Every attribute the ground material names, in the vertex stage or after. */
const GROUND_ATTRIBUTES = [
  'position',
  'normal',
  'terrainMorph',
  'terrainMorphNormal',
  ...COVER_ATTRIBUTES,
  ...MORPH_COVER_ATTRIBUTES,
]

const SEA_ATTRIBUTES = [
  'position',
  'terrainMorph',
  'waterDepth',
  'waterMorphDepth',
]

/** A real patch from the real builder, nine samples a side. */
function patch(seaLevel?: number) {
  const resolution = 9
  const border = 2
  const stride = resolution + 2 * border
  const elevations = new Float32Array(stride * stride)
  for (let i = 0; i < elevations.length; i += 1) elevations[i] = (i % 7) - 3
  return buildPatch({
    region: regionAddress(0, 0, 0, 0),
    resolution,
    border,
    elevations,
    cover: new Uint8Array(resolution * resolution * COVER_CHANNELS),
    bodyRadius: 1_737_400,
    ...(seaLevel === undefined ? {} : { seaLevel }),
  })
}

const LUNA = 1_737_400

describe('a mesh that wears the ground', () => {
  it('carries the ritual the material relies on, from one anchor', () => {
    const built = patch()
    const mesh = new Mesh(
      patchGeometry(built, new BufferAttribute(built.indices, 1)),
      new MeshBasicNodeMaterial(),
    )
    const wear = wearGround(mesh, built.anchor, LUNA)
    expect(groundWearOf(mesh)).toBe(wear)
    // The anchor the shader gets is the rounded one, and the altitude is
    // measured against exactly that vector — not against the float64 anchor,
    // which is the difference between exact and exact-per-patch.
    const ax = Math.fround(built.anchor.x)
    const ay = Math.fround(built.anchor.y)
    const az = Math.fround(built.anchor.z)
    expect(wear.anchor.x).toBe(ax)
    expect(wear.anchorAltitude).toBe(Math.hypot(ax, ay, az) - LUNA)
    // A region center is on the datum, so the altitude is the rounding alone:
    // under a float32 step at this radius.
    expect(Math.abs(wear.anchorAltitude)).toBeLessThan(0.25)
    // The grain origin is in one period, from the unrounded anchor.
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(wear.grainOrigin[axis]).toBeGreaterThanOrEqual(0)
      expect(wear.grainOrigin[axis]).toBeLessThan(GRAIN_PERIOD)
    }
    // Unmorphed until the frame says where the eye is.
    expect(wear.morphBand.x).toBe(NO_MORPH_DISTANCE)
    placeEye(mesh, { x: 1, y: 2, z: 3 }, 10, 20)
    expect(wear.eyeLocal.toArray()).toEqual([1, 2, 3])
    expect(wear.morphBand.toArray()).toEqual([10, 20])
  })

  it('moves all three anchor terms together', () => {
    const mesh = new Mesh()
    const wear = wearGround(mesh, { x: 0, y: 0, z: 0 }, 0)
    anchorGround(mesh, { x: LUNA, y: 0.3, z: -0.7 }, LUNA)
    expect(wear.anchor.x).toBe(Math.fround(LUNA))
    expect(wear.anchorAltitude).toBe(
      Math.hypot(Math.fround(LUNA), Math.fround(0.3), Math.fround(-0.7)) - LUNA,
    )
    expect(wear.grainOrigin.z).toBeGreaterThanOrEqual(0)
  })

  it('reads as undressed, not as a throw, off an object nothing dressed', () => {
    // The reader runs inside the frame, where a throw takes the canvas.
    expect(groundWearOf(new Mesh())).toBe(UNDRESSED_GROUND)
    expect(groundWearOf(undefined)).toBe(UNDRESSED_GROUND)
    expect(seaWearOf(new Mesh())).toBe(UNDRESSED_SEA)
    // Dressing is where a missing record is a failure.
    expect(() => placeEye(new Mesh(), { x: 0, y: 0, z: 0 }, 0, 1)).toThrow(
      /not dressed/,
    )
  })

  it('supplies every attribute the material names, on a patch and on the dummies', () => {
    const built = patch()
    const geometry = patchGeometry(built, new BufferAttribute(built.indices, 1))
    for (const name of GROUND_ATTRIBUTES)
      expect(geometry.hasAttribute(name)).toBe(true)
    // Two attribute objects over the cover, never one under two names — the
    // aliasing that fails the pipeline build with the message off-console.
    expect(geometry.getAttribute(COVER_ATTRIBUTES[0])).not.toBe(
      geometry.getAttribute(COVER_ATTRIBUTES[1]),
    )
    for (const dummy of [
      groundDummy(new MeshBasicNodeMaterial()),
      groundDummy(new MeshBasicNodeMaterial(), 4),
    ]) {
      for (const name of GROUND_ATTRIBUTES)
        expect(dummy.geometry.hasAttribute(name)).toBe(true)
      expect(groundWearOf(dummy)).not.toBe(UNDRESSED_GROUND)
    }
  })

  it('dresses the sea over the same patch', () => {
    const built = patch(0)
    if (built.water === null) throw new Error('the sea reaches this patch')
    const mesh = new Mesh(
      sheetGeometry(built.water, new BufferAttribute(built.indices, 1)),
      new MeshBasicNodeMaterial(),
    )
    const wear = wearSea(mesh, built.anchor)
    expect(seaWearOf(mesh)).toBe(wear)
    for (const name of SEA_ATTRIBUTES)
      expect(mesh.geometry.hasAttribute(name)).toBe(true)
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(wear.waveOrigin[axis]).toBeGreaterThanOrEqual(0)
      expect(wear.waveOrigin[axis]).toBeLessThan(WAVE_PERIOD)
    }
    const dummy = seaDummy(new MeshBasicNodeMaterial())
    for (const name of SEA_ATTRIBUTES)
      expect(dummy.geometry.hasAttribute(name)).toBe(true)
    // The frame writes the sea's eye through the same verb as the ground's.
    placeEye(dummy, { x: 4, y: 5, z: 6 }, 1, 2)
    expect(seaWearOf(dummy).eyeLocal.toArray()).toEqual([4, 5, 6])
  })
})
