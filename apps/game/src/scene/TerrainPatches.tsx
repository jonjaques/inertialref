import { useThree } from '@react-three/fiber'
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
import { Quaternion as Q, Vec } from '@inertialref/spatial'
import { COVER_CHANNELS, HEIGHTFIELD_RESOLUTION } from '@inertialref/universe'
import { patchIndices, pixelAngle } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GEOMETRY_CACHE } from '../engine/terrainStreamer.ts'
import { texturesFor } from '../render/planetTextures.ts'
import { grainWrap, type TerrainMaterial } from '../render/terrain.ts'
import { attachCover } from '../render/terrainAttributes.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { useTimedFrame } from './useTimedFrame.ts'

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
export function TerrainPatches({
  engine,
  terrain,
}: {
  engine: GameEngine
  terrain: TerrainMaterial
}) {
  const group = useRef<Group>(null)
  const meshes = useMemo(() => new Map<string, Mesh>(), [])
  const material = terrain.material
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
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
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
        const cover = new Uint8Array(3 * COVER_CHANNELS)
        attachCover(geometry, cover, cover)
        geometry.setIndex([0, 1, 2])
        const dummy = new Mesh(geometry, material)
        dummy.userData.eyeLocal = new Vector3()
        dummy.userData.morphBand = new Vector2(1, 2)
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

  useTimedFrame('terrainPatches', () => {
    const container = group.current
    if (container === null) return
    /*
     * The selection is measured in pixels, so it needs the drawing buffer
     * rather than the CSS size — a two-times display genuinely wants twice the
     * patches for the same picture. The engine divides the supersampling factor
     * back out, because a two-times *sample count* does not. Written every
     * frame because a resize is not an event this component subscribes to; the
     * setter compares and returns before doing anything when nothing changed.
     */
    engine.viewportPixels = {
      width: gl.domElement.width,
      height: gl.domElement.height,
    }
    const state = engine.terrainState()
    const datumRadius = state.datumRadius
    /*
     * The body's own appearance, and the star that lights it.
     *
     * The sun arrives in **body-fixed** axes because everything in the material
     * is: the shading normal is body-fixed because the geometry is, and the eye
     * already had to be for the morph. Rotating one vector on the CPU here is
     * cheaper and has one fewer frame in it than transforming the normal to
     * world space per fragment to meet a world-space sun.
     */
    if (state.palette !== null && state.orientation !== null) {
      terrain.setPalette(state.palette, state.datumRadius)
      /*
       * The pixel angle of the **drawing buffer**, not of the display.
       *
       * The selection deliberately measures in display pixels: a two-times
       * display wants twice the patches for the same picture and a two-times
       * supersample does not. Anti-aliasing is the opposite question — what
       * matters is the grid the samples actually land on — so the display angle
       * is divided by the supersampling factor to get the angle one *sample*
       * covers.
       *
       * The ratio below is that factor's **reciprocal**, and it is spelled as a
       * ratio rather than read from `engine.supersample` for exactly that
       * reason: the engine's field is the factor itself, and reaching for it
       * here would be a factor of four the wrong way at 4× AA.
       */
      if (state.lens !== null) {
        const display = pixelAngle(state.lens.lens, state.lens.viewport)
        const perSample =
          state.lens.viewport.height / Math.max(1, gl.domElement.height)
        terrain.setPixelAngle(display * perSample)
      }
      /*
       * The same texture set `Bodies.tsx` draws the sphere from, looked up by
       * the same key. Not passed down from there, because the two components
       * see different frames of the same body and the loader is a cache: asking
       * it again is a map lookup, and sharing a reference would make the
       * terrain's material depend on whether the body happened to be in the
       * drawn set this frame.
       */
      terrain.setAlbedoMap(
        texturesFor(state.palette.textureKey, anisotropy).albedo,
        state.palette.textureKey !== null,
      )
      const key = engine.scene()?.stars[0]
      if (key !== undefined && state.centre !== null) {
        const toStar = Vec.sub(key.placement.position, state.centre)
        // A body sitting exactly on its star leaves this zero-length, and a
        // normalized zero is a NaN across the whole surface.
        if (Vec.length(toStar) > 0) {
          const local = Q.rotate(
            Q.conjugate(state.orientation),
            Vec.normalize(toStar),
          )
          terrain.sunDirection.value.set(local.x, local.y, local.z)
        }
        terrain.sunColour.value.setRGB(key.color.r, key.color.g, key.color.b)
      }
    }
    const seen = new Set<string>()

    for (const placed of state.patches) {
      const { patch, placement, key } = placed
      seen.add(key)
      let mesh = meshes.get(key)
      /*
       * The key carries the body, but not the world: a save load with a
       * different seed streams the same `s:SOL/b:2` region keys over ground
       * that is no longer the same ground. The streamer rebuilds its
       * `RenderPatch`es on `clear()`, so a retained mesh whose patch is not
       * *this* patch is stale geometry wearing a current key — rebuild it.
       */
      if (mesh !== undefined && mesh.userData.patch !== patch) {
        mesh.removeFromParent()
        disposeKeepingSharedIndex(mesh)
        meshes.delete(key)
        mesh = undefined
      }
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
        /*
         * The cover, as normalized bytes rather than floats.
         *
         * Six channels of a fraction, read through a splat weight — eight bits
         * resolves each to a four-hundredth, which is finer than anything
         * downstream of a mip chain can tell from a float, and it is a quarter
         * of the bandwidth. A whole-disk selection is several hundred patches
         * and vertex memory is already the streamer's largest number.
         */
        attachCover(geometry, patch.cover, patch.morphCover)
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
        /*
         * Body-fixed and constant for the life of the patch, which is what
         * turns an anchor-relative vertex back into a place on the planet.
         *
         * `Math.fround` is not decoration: the uniform is float32, and the
         * material's altitude arithmetic is exact only if the offset beside it
         * describes the vector the shader actually gets rather than the float64
         * one this array was built from. Half a meter at Earth's radius, which
         * is a quarter of the water band.
         */
        const ax = Math.fround(patch.anchor.x)
        const ay = Math.fround(patch.anchor.y)
        const az = Math.fround(patch.anchor.z)
        mesh.userData.anchor = new Vector3(ax, ay, az)
        mesh.userData.anchorAltitude = Math.hypot(ax, ay, az) - datumRadius
        /*
         * The anchor in grain wavelengths, wrapped into one period.
         *
         * Reduced here, in float64, from the *unrounded* anchor — which is the
         * whole trick and the reason it is not `anchor / GRAIN_METRES` in the
         * shader. That quotient is 2.5 × 10⁶ on Luna, where float32 resolves 0.25
         * of a wavelength; wrapped first it is under 64, where it resolves four
         * microns. `mod` rather than `%`, so a negative anchor lands in [0, 64)
         * rather than in (−64, 0] and the two sides of the body agree.
         */
        mesh.userData.grainOrigin = new Vector3(
          grainWrap(patch.anchor.x),
          grainWrap(patch.anchor.y),
          grainWrap(patch.anchor.z),
        )
        mesh.userData.patch = patch
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
        disposeKeepingSharedIndex(mesh)
        meshes.delete(key)
      }
    }
  })

  return <group ref={group} />
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
 * the buffers this mesh actually owns.
 */
function disposeKeepingSharedIndex(mesh: Mesh): void {
  mesh.geometry.setIndex(null)
  mesh.geometry.dispose()
}

/**
 * Meshes held after they leave the drawn set.
 *
 * The streamer's own geometry cap, because the two caches describe the same
 * patches: the streamer stops handing out geometry past `GEOMETRY_CACHE`, so
 * anything held here beyond it can never be asked for again — and anything
 * disposed here *below* it is ground the streamer still hands out, rebuilt and
 * re-uploaded the next time the camera turns back.
 */
const GEOMETRY_KEPT = GEOMETRY_CACHE
