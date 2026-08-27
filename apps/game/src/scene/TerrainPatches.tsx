import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Mesh,
  type Scene,
  Sphere,
  Vector2,
  Vector3,
} from 'three/webgpu'
import { HEIGHTFIELD_RESOLUTION } from '@inertialref/universe'
import { patchIndices } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createTerrainMaterial } from '../render/materials.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'

/**
 * Streamed terrain patches: geometry uploaded once, moved every frame.
 *
 * The two halves are separate on purpose. A patch's vertices are body-fixed and
 * never change, so re-uploading them is pure waste — this used to hand Three.js
 * three new BufferAttributes per patch per frame. Where the patch *is* changes
 * constantly, because the planet is orbiting and turning, and that is a position,
 * a quaternion and the body's render scale. Baking the second into the first is
 * what made the ground slide away from the ship between origin rebases.
 *
 * A whole-disk selection is a couple of hundred patches where a 3×3 window was
 * nine, so three things that did not matter at nine matter here. The index
 * buffer is one attribute shared by every mesh rather than 98 KB apiece. Each
 * mesh carries a bounding sphere built from the patch's own extent, so the
 * renderer frustum-culls the two thirds of the disk that are behind the camera.
 * And a mesh that leaves the drawn set is detached rather than disposed — the
 * streamer keeps the geometry, and a camera that turns around should not pay to
 * rebuild the ground it just left.
 */
export function TerrainPatches({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const meshes = useMemo(() => new Map<string, Mesh>(), [])
  const material = useMemo(() => createTerrainMaterial(), [])
  /*
   * One index attribute for the session. It is a function of the resolution
   * alone, and the renderer keys its GPU buffers on the attribute instance — so
   * sharing this is one upload rather than one per patch.
   */
  const indices = useMemo(
    () => new BufferAttribute(patchIndices(HEIGHTFIELD_RESOLUTION), 1),
    [],
  )
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)

  /*
   * Compile this exact material at mount, on a throwaway one-triangle patch,
   * rather than in the frame the first real patch lands — the same
   * instance-not-archetype reason `WarpFx` gives: the backend builds shader
   * source per material instance, so a warm-up of a *different* terrain
   * material leaves this one's first draw paying the build, synchronously on
   * the WebGL fallback, in the middle of a descent. The dummy mesh is never
   * parented; `compileAsync` takes the target scene by argument, and its
   * traversal is synchronous, so nothing here can reach a drawn frame.
   *
   * The dummy carries the morph attributes too. They are read by the vertex
   * stage, so a warm-up without them compiles a graph the real patches do not
   * use — and the pipeline built for the real one would arrive mid-descent,
   * which is the whole thing this exists to avoid.
   */
  useEffect(() => {
    warmAtMount({
      label: 'compiling the ground',
      units: 1,
      run: async (done) => {
        const geometry = new BufferGeometry()
        const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
        const up = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
        geometry.setAttribute('position', new BufferAttribute(triangle, 3))
        geometry.setAttribute('normal', new BufferAttribute(up, 3))
        geometry.setAttribute('terrainMorph', new BufferAttribute(triangle, 3))
        geometry.setAttribute('terrainMorphNormal', new BufferAttribute(up, 3))
        geometry.setIndex([0, 1, 2])
        const dummy = new Mesh(geometry, material)
        dummy.userData.eyeLocal = new Vector3()
        dummy.userData.morphBand = new Vector2(1, 2)
        await warmCompile(warmRenderer(gl), {
          object: dummy,
          camera,
          scene: scene as Scene,
        }).then(done)
        geometry.dispose()
      },
    })
  }, [gl, camera, scene, material])

  useFrame(() => {
    const container = group.current
    if (container === null) return
    /*
     * The selection is measured in pixels, so it needs the drawing buffer
     * rather than the CSS size — a two-times display genuinely wants twice the
     * patches for the same picture. Written every frame because a resize is not
     * an event this component subscribes to, and the assignment is a compare.
     */
    engine.viewportHeight = gl.domElement.height
    const state = engine.terrainState()
    // The ground is the picture of the planet now that the quadtree draws the
    // whole disk, so it wears the body's own published color rather than one
    // sandstone for every world. Phase 3 replaces this with the biome splat.
    material.color.setRGB(state.colour.r, state.colour.g, state.colour.b)
    const seen = new Set<string>()

    for (const placed of state.patches) {
      const { patch, placement } = placed
      const key = `${patch.region.face}.${patch.region.level}.${patch.region.i}.${patch.region.j}`
      seen.add(key)
      let mesh = meshes.get(key)
      if (mesh === undefined) {
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(patch.positions, 3),
        )
        geometry.setAttribute('normal', new BufferAttribute(patch.normals, 3))
        geometry.setAttribute(
          'terrainMorph',
          new BufferAttribute(patch.morphPositions, 3),
        )
        geometry.setAttribute(
          'terrainMorphNormal',
          new BufferAttribute(patch.morphNormals, 3),
        )
        geometry.setIndex(indices)
        /*
         * Set rather than computed. `computeBoundingSphere` walks the position
         * attribute, which for two hundred patches of 4,225 vertices is a
         * million points on the frame a descent refines — and the patch already
         * carries the extent, measured while its vertices were being written.
         */
        geometry.boundingSphere = new Sphere(
          new Vector3(
            patch.boundsCentre.x,
            patch.boundsCentre.y,
            patch.boundsCentre.z,
          ),
          patch.boundsRadius,
        )
        mesh = new Mesh(geometry, material)
        mesh.userData.eyeLocal = new Vector3()
        mesh.userData.morphBand = new Vector2()
        meshes.set(key, mesh)
      }
      if (mesh.parent === null) container.add(mesh)
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
      // The body's own compression. Past `NEAR_LIMIT` the planet is drawn
      // nearer and smaller so its angular size survives, and its ground has to
      // do the same or it is a different object at a different distance.
      mesh.scale.setScalar(placement.scale)
      // Per-patch morph inputs, read by `onObjectUpdate` uniforms in the
      // material. The eye is in the patch's own frame and in true meters, so
      // the morph band is comparable to it whatever the placement did.
      ;(mesh.userData.eyeLocal as Vector3).set(
        placed.eyeLocal.x,
        placed.eyeLocal.y,
        placed.eyeLocal.z,
      )
      ;(mesh.userData.morphBand as Vector2).set(
        placed.morphStart,
        placed.morphEnd,
      )
    }

    for (const [key, mesh] of meshes) {
      if (seen.has(key)) continue
      container.remove(mesh)
      // Kept, not disposed: the streamer still holds this patch's geometry, and
      // a camera that turns back should find the ground where it left it.
      if (meshes.size > GEOMETRY_KEPT) {
        mesh.geometry.dispose()
        meshes.delete(key)
      }
    }
  })

  return <group ref={group} />
}

/**
 * Meshes held after they leave the drawn set.
 *
 * Matched to the streamer's own geometry cache: it stops handing out patches
 * past that point, so anything held here beyond it can never be asked for again.
 */
const GEOMETRY_KEPT = 512
