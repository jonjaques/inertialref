import {
  BufferAttribute,
  type BufferGeometry as Geometry,
  BufferGeometry,
  InstancedInterleavedBuffer,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  type Object3D,
  Sphere,
  Vector2,
  Vector3,
} from 'three/webgpu'
import { COVER_CHANNELS } from '@inertialref/universe'
import { NO_MORPH_DISTANCE, type RenderPatch } from '@inertialref/rendering'
import { grainWrap } from './terrain.ts'
import { waveWrap } from './water.ts'
import { GROUND_WEAR, type GroundWear, SEA_WEAR, type SeaWear } from './wear.ts'

/*
 * Dressing a mesh as the ground, or as the sea over it.
 *
 * The ground material's real interface is not the eight members on
 * `TerrainMaterial`. It is the attributes a geometry has to carry — position,
 * normal, the morph twins, the cover record under two names and its morph twin
 * under two more — and the record a mesh has to wear for the `onObjectUpdate`
 * uniforms, with a ritual inside it: the anchor rounded to float32, its
 * altitude measured in float64 against that rounding, and the grain origin
 * reduced from the *unrounded* anchor. Four wearers, three warm-up dummies and
 * a test each spelled that, and two of the ways to get it wrong kill the
 * pipeline with the real message on a channel the page console does not carry
 * (ADR-0020, ADR-0021). This is the one place it is spelled; `wear.ts` is the
 * record the material reads back.
 */

/* ------------------------------------------------------------------------ */
/* The cover, as attributes                                                   */
/* ------------------------------------------------------------------------ */

/*
 * `packCover` writes `COVER_CHANNELS` bytes a vertex and the material reads
 * them as two `vec4`s — `terrainCover` and `terrainCover2` — because a vertex
 * attribute is at most four lanes wide. One `InterleavedBuffer` over the
 * eight-byte record, with an attribute *object* per name at its own offset,
 * is the layout that keeps the bytes where `packCover` put them: a plain
 * `BufferAttribute` has no stride, so two of them over an eight-byte array
 * would each read the other's lanes as their own second vertex.
 *
 * Two attribute objects, never one under two names, for the reason
 * [ADR-0021](../../../../docs/adr/0021-the-ground.md) gives; and the morph
 * twin is a second buffer over its own array, because the morph cover is a
 * different array. Every geometry that wears the material — a patch, a rock,
 * the warm-up dummies that compile the pipelines — goes through here, so the
 * layout the boot warm-up freezes is the layout the real draw uses.
 */

/** The attribute names, in the order `packCover` fills the record. */
export const COVER_ATTRIBUTES = ['terrainCover', 'terrainCover2'] as const
export const MORPH_COVER_ATTRIBUTES = [
  'terrainMorphCover',
  'terrainMorphCover2',
] as const

/** Both buffers a geometry's cover lives in, for the writer that updates them. */
export interface CoverBuffers {
  readonly cover: InterleavedBuffer
  readonly morphCover: InterleavedBuffer
}

/**
 * Attach a cover record and its morph twin to `geometry`, per vertex or per
 * instance, and hand back the buffers so a writer can flag its own ranges.
 */
export function attachCover(
  geometry: Geometry,
  cover: Uint8Array,
  morphCover: Uint8Array,
  instanced = false,
): CoverBuffers {
  const buffer = (bytes: Uint8Array): InterleavedBuffer =>
    instanced
      ? new InstancedInterleavedBuffer(bytes, COVER_CHANNELS, 1)
      : new InterleavedBuffer(bytes, COVER_CHANNELS)
  const coverBuffer = buffer(cover)
  const morphBuffer = buffer(morphCover)
  COVER_ATTRIBUTES.forEach((name, i) => {
    geometry.setAttribute(
      name,
      new InterleavedBufferAttribute(coverBuffer, 4, i * 4, true),
    )
  })
  MORPH_COVER_ATTRIBUTES.forEach((name, i) => {
    geometry.setAttribute(
      name,
      new InterleavedBufferAttribute(morphBuffer, 4, i * 4, true),
    )
  })
  return { cover: coverBuffer, morphCover: morphBuffer }
}

/**
 * Dispose a patch's geometry without taking the shared index down with it.
 *
 * Every patch geometry holds the one session-wide index attribute, and the
 * renderer's dispose path destroys the GPU buffer of every attribute the
 * geometry references — the index included, with no reference count. Disposing
 * one evicted mesh would destroy the index buffer under every patch still
 * drawn, which re-uploads it next frame: the exact per-patch churn the shared
 * attribute exists to avoid. Detaching the index first limits the dispose to
 * the buffers this mesh actually owns. The ground and the sheet both evict
 * through this, since both hold the same index.
 */
export function disposeKeepingSharedIndex(mesh: Mesh): void {
  mesh.geometry.setIndex(null)
  mesh.geometry.dispose()
}

/* ------------------------------------------------------------------------ */
/* The geometry                                                               */
/* ------------------------------------------------------------------------ */

/** A sheet, as `buildPatch` hands one back beside its patch. */
export type SheetPatch = NonNullable<RenderPatch['water']>

/**
 * A patch's geometry, as the ground material reads it.
 *
 * The cover goes on as normalized bytes rather than floats: six channels of a
 * fraction, read through a splat weight — eight bits resolves each to a
 * four-hundredth, which is finer than anything downstream of a mip chain can
 * tell from a float, and it is a quarter of the bandwidth. A whole-disk
 * selection is several hundred patches and vertex memory is already the
 * streamer's largest number.
 *
 * The bounding sphere is set rather than computed. `computeBoundingSphere`
 * walks the position attribute, which for two hundred patches of 4,225
 * vertices is a million points on the frame a descent refines — and the patch
 * already carries the extent, measured while its vertices were being written.
 */
export function patchGeometry(
  patch: RenderPatch,
  index: BufferAttribute,
): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(patch.positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(patch.normals, 3))
  geometry.setAttribute(
    'terrainMorph',
    new BufferAttribute(patch.morphPositions, 3),
  )
  geometry.setAttribute(
    'terrainMorphNormal',
    new BufferAttribute(patch.morphNormals, 3),
  )
  attachCover(geometry, patch.cover, patch.morphCover)
  geometry.setIndex(index)
  geometry.boundingSphere = new Sphere(
    new Vector3(
      patch.boundsCentre.x,
      patch.boundsCentre.y,
      patch.boundsCentre.z,
    ),
    patch.boundsRadius,
  )
  return geometry
}

/** A sheet's geometry, as the sea material reads it: the surface, its morph, and the depth under each. */
export function sheetGeometry(
  sheet: SheetPatch,
  index: BufferAttribute,
): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(sheet.positions, 3))
  geometry.setAttribute(
    'terrainMorph',
    new BufferAttribute(sheet.morphPositions, 3),
  )
  geometry.setAttribute('waterDepth', new BufferAttribute(sheet.depths, 1))
  geometry.setAttribute(
    'waterMorphDepth',
    new BufferAttribute(sheet.morphDepths, 1),
  )
  geometry.setIndex(index)
  geometry.boundingSphere = new Sphere(
    new Vector3(
      sheet.boundsCentre.x,
      sheet.boundsCentre.y,
      sheet.boundsCentre.z,
    ),
    sheet.boundsRadius,
  )
  return geometry
}

/* ------------------------------------------------------------------------ */
/* The wear                                                                   */
/* ------------------------------------------------------------------------ */

interface Point {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** The half of either record the frame writes: where the eye is, and the morph band. */
interface Placed {
  readonly eyeLocal: Vector3
  readonly morphBand: Vector2
}

/** The record an object is wearing, or a throw at the one moment a throw is the right answer. */
function worn(object: Object3D): Placed {
  const wear = (object.userData[GROUND_WEAR] ?? object.userData[SEA_WEAR]) as
    Placed | undefined
  if (wear === undefined)
    throw new Error(`${object.type} is not dressed as the ground or the sea`)
  return wear
}

/**
 * Dress an object as the ground, anchored at `anchor` on a body of
 * `datumRadius`, unmorphed until `placeEye` says otherwise.
 */
export function wearGround(
  object: Object3D,
  anchor: Point,
  datumRadius: number,
): GroundWear {
  const wear: GroundWear = {
    eyeLocal: new Vector3(),
    morphBand: new Vector2(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE),
    anchor: new Vector3(),
    anchorAltitude: 0,
    grainOrigin: new Vector3(),
  }
  object.userData[GROUND_WEAR] = wear
  anchorGround(object, anchor, datumRadius)
  return wear
}

/**
 * Move a ground wearer's anchor: the rounded vector, its altitude and the
 * grain origin together, never one without the others.
 *
 * `Math.fround` is not decoration. The uniform is float32, and the material's
 * altitude arithmetic is exact only if the offset beside it describes the
 * vector the shader actually gets rather than the float64 one the vertices
 * were built from — half a meter at Earth's radius, a quarter of the water
 * band, and a constant offset per patch is a grid of rectangles across a flat
 * sea.
 *
 * The grain origin is reduced here, in float64, from the *unrounded* anchor,
 * which is the whole trick and the reason it is not `anchor / GRAIN_METRES` in
 * the shader: that quotient is 2.5 × 10⁶ on Luna, where float32 resolves a
 * quarter of a wavelength; wrapped first it is under 64, where it resolves
 * four microns. A rock and the ground under it have to read the same field or
 * the two carry different texture at the point they touch.
 */
export function anchorGround(
  object: Object3D,
  anchor: Point,
  datumRadius: number,
): void {
  const wear = worn(object) as GroundWear
  const ax = Math.fround(anchor.x)
  const ay = Math.fround(anchor.y)
  const az = Math.fround(anchor.z)
  wear.anchor.set(ax, ay, az)
  wear.anchorAltitude = Math.hypot(ax, ay, az) - datumRadius
  wear.grainOrigin.set(
    grainWrap(anchor.x),
    grainWrap(anchor.y),
    grainWrap(anchor.z),
  )
}

/**
 * Dress an object as the sea over the ground at `anchor`.
 *
 * The wave origin is the sea's `grainOrigin`, for the same reason: a wave
 * field on the patch-local position jumps phase at every patch edge, and on
 * the body-fixed position it is quantized out of existence.
 */
export function wearSea(object: Object3D, anchor: Point): SeaWear {
  const wear: SeaWear = {
    eyeLocal: new Vector3(),
    morphBand: new Vector2(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE),
    anchor: new Vector3(
      Math.fround(anchor.x),
      Math.fround(anchor.y),
      Math.fround(anchor.z),
    ),
    waveOrigin: new Vector3(
      waveWrap(anchor.x),
      waveWrap(anchor.y),
      waveWrap(anchor.z),
    ),
  }
  object.userData[SEA_WEAR] = wear
  return wear
}

/**
 * Where the eye is in the wearer's own frame this frame, in true meters, and
 * where its morph to the parent begins and ends — comparable to that eye
 * whatever the placement did to the mesh.
 */
export function placeEye(
  object: Object3D,
  eye: Point,
  morphStart: number,
  morphEnd: number,
): void {
  const wear = worn(object)
  wear.eyeLocal.set(eye.x, eye.y, eye.z)
  wear.morphBand.set(morphStart, morphEnd)
}

/* ------------------------------------------------------------------------ */
/* The warm-up dummies                                                        */
/* ------------------------------------------------------------------------ */

const TRIANGLE = () => new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
const UP = () => new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])

/**
 * A one-triangle ground wearer, for compiling a material's pipeline ahead of
 * the first real patch.
 *
 * It carries every attribute the graph reads, the morph twins included: those
 * are read by the vertex stage, so a warm-up without them compiles a graph the
 * real patches do not use, and the pipeline built for the real one arrives
 * mid-descent — which is the whole thing a warm-up exists to avoid.
 *
 * With `instances`, an `InstancedMesh` at that capacity drawn one instance
 * deep. `InstanceNode` branches on `instanceMatrix.count`: a UBO read at or
 * under a thousand matrices, four instanced `vec4` attributes over an
 * interleaved buffer above it. Different WGSL, different vertex layout,
 * different pipeline — so a dummy of one compiles a program the real meshes
 * never use. `count` limits the draw; the capacity is what picks the path.
 */
export function groundDummy(
  material: Mesh['material'],
  instances?: number,
): Mesh {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(TRIANGLE(), 3))
  geometry.setAttribute('normal', new BufferAttribute(UP(), 3))
  geometry.setAttribute('terrainMorph', new BufferAttribute(TRIANGLE(), 3))
  geometry.setAttribute('terrainMorphNormal', new BufferAttribute(UP(), 3))
  const instanced = instances !== undefined
  const bytes = new Uint8Array((instanced ? 1 : 3) * COVER_CHANNELS)
  attachCover(geometry, bytes, bytes, instanced)
  geometry.setIndex([0, 1, 2])
  let dummy: Mesh
  if (instances === undefined) {
    dummy = new Mesh(geometry, material)
  } else {
    const mesh = new InstancedMesh(geometry, material, instances)
    mesh.count = 1
    mesh.setMatrixAt(0, new Matrix4())
    dummy = mesh
  }
  wearGround(dummy, { x: 0, y: 0, z: 1 }, 0)
  return dummy
}

/** A one-triangle sea wearer, for the same reason. */
export function seaDummy(material: Mesh['material']): Mesh {
  const geometry = new BufferGeometry()
  const depths = new Float32Array([1, 1, 1])
  geometry.setAttribute('position', new BufferAttribute(TRIANGLE(), 3))
  geometry.setAttribute('terrainMorph', new BufferAttribute(TRIANGLE(), 3))
  geometry.setAttribute('waterDepth', new BufferAttribute(depths, 1))
  geometry.setAttribute('waterMorphDepth', new BufferAttribute(depths, 1))
  geometry.setIndex([0, 1, 2])
  const dummy = new Mesh(geometry, material)
  wearSea(dummy, { x: 0, y: 0, z: 1 })
  return dummy
}
