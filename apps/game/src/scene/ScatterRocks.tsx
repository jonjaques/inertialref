import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  InstancedMesh,
  Matrix4,
  type Scene,
  Sphere,
  Vector2,
  Vector3,
} from 'three/webgpu'
import {
  NO_MORPH_DISTANCE,
  ROCK_VARIANTS,
  rockMesh,
} from '@inertialref/rendering'
import { COVER_CHANNELS } from '@inertialref/universe'
import type { GameEngine } from '../engine/GameEngine.ts'
import { MAX_ROCKS, type ScatterBatch } from '../engine/scatterField.ts'
import { grainWrap, type TerrainMaterial } from '../render/terrain.ts'
import { attachCover, type CoverBuffers } from '../render/terrainAttributes.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The rocks lying on the streamed ground.
 *
 * Four `InstancedMesh`es — one per shape — wearing **the terrain's own
 * material**, which is the decision the rest of this file follows from. A rock
 * and the regolith it sits on are the same body's surface seen a meter apart, so
 * they have to agree about the palette, the photometry, the terminator, the
 * aerial veil and the published photograph; a second material would be a third
 * surface for `AGENTS.md`'s "never add a shading term to the ground without
 * adding it to the sphere" to police, and it would drift the first time either
 * one was touched.
 *
 * Sharing it costs nothing and needs no branch, because Three's node material
 * inserts the instancing *before* `positionNode` runs: `instancedMesh( object )`
 * assigns the instanced position and normal into `positionLocal` and
 * `normalLocal`, and the terrain graph reads exactly those. So a rock's
 * `localPosition` varying is its own anchor-relative place on the planet, and
 * every term the material derives from it — the altitude, the latitude, the
 * map's UV, the footprint the detail fades on — is right for the rock rather
 * than for the field's anchor.
 *
 * The morph attributes are the base ones, and the band is `NO_MORPH`: a rock
 * has no coarser version to hand over to, so the factor saturates to zero and
 * the mix is the identity. They are present because the graph reads them and a
 * missing attribute is a shader that does not compile, not a term that is
 * skipped.
 *
 * **The cover is per instance and everything else is per vertex.** A block
 * thrown by a fresh crater is brighter than the plain it landed on and a basalt
 * one is darker; that is four bytes, and four bytes of `InstancedBufferAttribute`
 * beside a shared shape is what makes two thousand different-looking rocks four
 * draw calls.
 */
export function ScatterRocks({
  engine,
  terrain,
}: {
  engine: GameEngine
  terrain: TerrainMaterial
}) {
  const group = useRef<Group>(null)
  // What the instance buffers currently hold, by identity — the batch array
  // *and* the meshes it was written into. See the upload below.
  const uploaded = useRef<{
    meshes: readonly InstancedMesh[]
    batches: readonly ScatterBatch[]
  } | null>(null)
  const material = terrain.material
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)

  /*
   * One `InstancedMesh` per shape, allocated at the ceiling and drawn short.
   *
   * `InstancedMesh` fixes its capacity at construction, so growing one means a
   * new object and a new GPU buffer — in the middle of a descent, every time the
   * count crept up. Allocated at `MAX_ROCKS` it is 1 MB of matrices for the
   * session and `count` does the rest; a frame with two hundred rocks uploads
   * two hundred matrices and draws two hundred.
   */
  const meshes = useMemo(() => {
    const built: InstancedMesh[] = []
    for (let variant = 0; variant < ROCK_VARIANTS; variant += 1) {
      const shape = rockMesh(variant)
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(shape.positions, 3))
      geometry.setAttribute('normal', new BufferAttribute(shape.normals, 3))
      /*
       * The morph targets are the vertices themselves — but through **their own
       * `BufferAttribute` over the same array**, never one object under two
       * names.
       *
       * That is not tidiness. The backend builds its vertex layout by asking the
       * geometry for each attribute the graph names and keys the GPU buffer on
       * the object it gets back, so one object answering to two names is one
       * buffer at two shader locations — and the whole pipeline fails to build.
       * It surfaces as `[Invalid ShaderModule "fragment"] is invalid due to a
       * previous error`, with the real message on the channel the page console
       * does not carry and the canvas never presenting: the same shape of
       * silence a varying sharing an attribute's name produces
       * ([ADR-0020](../../../../docs/adr/0020-the-face.md)). Isolated by
       * un-aliasing these two and leaving the instanced pair aliased, which
       * builds — it is the vertex-rate attributes that collide.
       *
       * The instanced pair below is separated anyway. Two attribute objects over
       * one array is a few bytes and one fewer trap.
       */
      geometry.setAttribute(
        'terrainMorph',
        new BufferAttribute(shape.positions, 3),
      )
      geometry.setAttribute(
        'terrainMorphNormal',
        new BufferAttribute(shape.normals, 3),
      )
      geometry.setIndex(new BufferAttribute(shape.indices, 1))
      // A unit sphere, because the shapes are normalized to it and the instance
      // scale is applied on top. Set rather than computed for the reason
      // `TerrainPatches` gives.
      geometry.boundingSphere = new Sphere(new Vector3(), 1)
      const bytes = new Uint8Array(INSTANCE_CAPACITY * COVER_CHANNELS)
      const buffers = attachCover(geometry, bytes, bytes, true)
      const mesh = new InstancedMesh(geometry, material, INSTANCE_CAPACITY)
      mesh.userData.coverBuffers = buffers
      mesh.count = 0
      mesh.frustumCulled = false
      mesh.userData.eyeLocal = new Vector3()
      mesh.userData.morphBand = new Vector2(
        NO_MORPH_DISTANCE,
        NO_MORPH_DISTANCE,
      )
      mesh.userData.anchor = new Vector3()
      mesh.userData.anchorAltitude = 0
      mesh.userData.grainOrigin = new Vector3()
      built.push(mesh)
    }
    return built
  }, [material])

  /*
   * Compile the *instanced* pipeline at mount.
   *
   * The terrain material's graph is shared with the patches, and its compiled
   * program is not: the instancing insert changes the vertex stage, so the
   * warm-up `TerrainPatches` runs leaves this one's first draw paying the build
   * — synchronously on the WebGL fallback, in the frame a landing arrives. The
   * dummy is an `InstancedMesh` for exactly that reason, and it carries the
   * per-instance cover as well, because an attribute that arrives later is
   * another program.
   */
  useEffect(() => {
    warmAtMount({
      label: 'compiling the scatter',
      units: 1,
      run: async (done) => {
        const geometry = new BufferGeometry()
        // Four attribute objects over two arrays, exactly as the real geometry
        // above — a warm-up that aliased them compiled nothing, and
        // `warmCompile` swallows its rejection, so the failure was invisible
        // until the real draw hit the same wall.
        const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
        const ups = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
        geometry.setAttribute('position', new BufferAttribute(points, 3))
        geometry.setAttribute('normal', new BufferAttribute(ups, 3))
        geometry.setAttribute('terrainMorph', new BufferAttribute(points, 3))
        geometry.setAttribute('terrainMorphNormal', new BufferAttribute(ups, 3))
        const bytes = new Uint8Array(COVER_CHANNELS)
        attachCover(geometry, bytes, bytes, true)
        geometry.setIndex([0, 1, 2])
        /*
         * At the real capacity, and drawn one instance deep.
         *
         * `InstanceNode` branches on `instanceMatrix.count`: a UBO read at or
         * under a thousand matrices, four instanced `vec4` attributes over an
         * interleaved buffer above it. Different WGSL, different vertex layout,
         * different pipeline — so a dummy of one compiled a program the real
         * meshes never use, and the first frame a landing brought rocks into
         * range still paid the build this effect exists to remove. `count`
         * limits the draw; the capacity is what picks the path.
         */
        const dummy = new InstancedMesh(geometry, material, INSTANCE_CAPACITY)
        dummy.count = 1
        dummy.setMatrixAt(0, new Matrix4())
        dummy.userData.eyeLocal = new Vector3()
        dummy.userData.morphBand = new Vector2(
          NO_MORPH_DISTANCE,
          NO_MORPH_DISTANCE,
        )
        dummy.userData.anchor = new Vector3(0, 0, 1)
        await warmCompile(warmRenderer(gl), {
          object: dummy,
          camera,
          scene: scene as Scene,
        }).then(done)
        geometry.dispose()
      },
    })
  }, [gl, camera, scene, material])

  useTimedFrame('scatterRocks', () => {
    const container = group.current
    if (container === null) return
    const scatter = engine.terrainState().scatter
    const placement = scatter.placement
    const anchor = scatter.anchor
    if (placement === null || anchor === null || scatter.batches.length === 0) {
      for (const mesh of meshes) {
        mesh.count = 0
        mesh.removeFromParent()
      }
      return
    }
    for (const mesh of meshes) {
      if (mesh.parent === null) container.add(mesh)
      mesh.count = 0
      mesh.position.set(
        placement.position.x,
        placement.position.y,
        placement.position.z,
      )
      mesh.quaternion.set(
        placement.orientation.x,
        placement.orientation.y,
        placement.orientation.z,
        placement.orientation.w,
      )
      // The body's own compression, exactly as a patch wears it: rocks placed at
      // true meters against ground drawn at compressed ones are somewhere else.
      mesh.scale.setScalar(placement.scale)
      // `Math.fround` for the reason `TerrainPatches` gives — the uniform is
      // float32 and the altitude arithmetic below it is exact only against the
      // vector the shader actually receives.
      ;(mesh.userData.anchor as Vector3).set(
        Math.fround(anchor.x),
        Math.fround(anchor.y),
        Math.fround(anchor.z),
      )
      mesh.userData.anchorAltitude = scatter.anchorAltitude
      // The grain field's domain, wrapped into one period on this side of the
      // uniform. A rock and the ground under it have to read the same field or
      // the two carry different texture at the point they touch.
      ;(mesh.userData.grainOrigin as Vector3).set(
        grainWrap(anchor.x),
        grainWrap(anchor.y),
        grainWrap(anchor.z),
      )
      const eye = scatter.eyeLocal
      if (eye !== null) {
        ;(mesh.userData.eyeLocal as Vector3).set(eye.x, eye.y, eye.z)
      }
    }
    /*
     * The buffers are re-uploaded only when the field laid out a new list.
     *
     * `ScatterField` returns the *same* batch array by identity while the eye,
     * the anchor, the range and the ready set hold still — that memo is what
     * makes a hover free — and copying it in anyway spent it: 4,000 matrices
     * is 256 KB memcpy'd and re-written to the GPU sixty times a second for
     * bytes already resident. The transforms above still move every frame,
     * because the render origin does.
     */
    const held = uploaded.current
    // The meshes as well as the batches: a new set of `InstancedMesh`es has
    // empty buffers, and matching on the batch array alone would leave them
    // that way for as long as the field kept handing back the same list.
    const fresh = held?.batches !== scatter.batches || held.meshes !== meshes
    uploaded.current = { meshes, batches: scatter.batches }
    for (const batch of scatter.batches) {
      const mesh = meshes[batch.variant]
      if (mesh === undefined) continue
      const count = Math.min(batch.count, INSTANCE_CAPACITY)
      mesh.count = count
      if (!fresh) continue
      mesh.instanceMatrix.array.set(batch.matrices.subarray(0, count * 16))
      /*
       * Cleared first, and it is `instanceMatrix` alone that needs it. The
       * backend clears the ranges of the attribute it uploads, and above a
       * thousand instances that attribute is the `InstancedInterleavedBuffer`
       * Three builds beside this one — `InstanceNode.update` copies these
       * ranges into it and clears only its own. So without this the array
       * grows by one entry a frame, the driver takes that many `writeBuffer`
       * calls for the same bytes, and the spread that copies them eventually
       * exceeds the argument limit outright.
       */
      mesh.instanceMatrix.clearUpdateRanges()
      mesh.instanceMatrix.addUpdateRange(0, count * 16)
      mesh.instanceMatrix.needsUpdate = true
      // Both buffers are over one array, so the write lands once and both
      // are flagged; the four attribute names are views on the two buffers.
      const { cover, morphCover } = mesh.userData.coverBuffers as CoverBuffers
      ;(cover.array as Uint8Array).set(
        batch.cover.subarray(0, count * COVER_CHANNELS),
      )
      cover.clearUpdateRanges()
      cover.addUpdateRange(0, count * COVER_CHANNELS)
      cover.needsUpdate = true
      morphCover.clearUpdateRanges()
      morphCover.addUpdateRange(0, count * COVER_CHANNELS)
      morphCover.needsUpdate = true
    }
  })

  return <group ref={group} />
}

/**
 * Instances each shape may hold.
 *
 * `MAX_ROCKS` itself rather than a copy of its value, because it is the ceiling
 * the field lays out against and a capacity below it would silently drop the
 * tail — but applied per *variant*, since the split between the four is a
 * property of the ground and an even one cannot be assumed. Four thousand
 * matrices is 256 KB a variant and 1 MB for the session, which is a rounding
 * error against the ground they sit on.
 */
const INSTANCE_CAPACITY = MAX_ROCKS
