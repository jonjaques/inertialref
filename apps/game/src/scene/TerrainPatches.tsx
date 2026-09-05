import { useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { BufferAttribute, type Group, Mesh, type Scene } from 'three/webgpu'
import { Quaternion as Q, Vec } from '@inertialref/spatial'
import { HEIGHTFIELD_RESOLUTION } from '@inertialref/universe'
import { patchIndices, pixelAngle } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GEOMETRY_CACHE } from '../engine/terrainStreamer.ts'
import { texturesFor } from '../render/planetTextures.ts'
import type { TerrainMaterial } from '../render/terrain.ts'
import {
  disposeKeepingSharedIndex,
  groundDummy,
  patchGeometry,
  placeEye,
  wearGround,
} from '../render/groundWear.ts'
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
   * traversal is synchronous, so nothing here can reach a drawn frame. The
   * dummy is the dresser's own, so it wears exactly what a real patch wears.
   */
  useEffect(() => {
    warmAtMount({
      label: 'compiling the ground',
      units: 1,
      run: async (done) => {
        const dummy = groundDummy(material)
        await warmCompile(warmRenderer(gl), {
          object: dummy,
          camera,
          scene: scene as Scene,
        }).then(done)
        dummy.geometry.dispose()
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
    terrain.setQuality(engine.surfaceQuality.ground)
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
        const light =
          engine
            .scene()
            ?.bodies.find((body) => body.address === state.bodyAddress)
            ?.sunlight ?? key.sunlight
        terrain.sunIntensity.value = engine.calibratedLight ? 1 : light
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
        mesh = new Mesh(patchGeometry(patch, indices), material)
        // Body-fixed and constant for the life of the patch, which is what
        // turns an anchor-relative vertex back into a place on the planet.
        wearGround(mesh, patch.anchor, datumRadius)
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
      placeEye(mesh, placed.eyeLocal, placed.morphStart, placed.morphEnd)
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
 * Meshes held after they leave the drawn set.
 *
 * The streamer's own geometry cap, because the two caches describe the same
 * patches: the streamer stops handing out geometry past `GEOMETRY_CACHE`, so
 * anything held here beyond it can never be asked for again — and anything
 * disposed here *below* it is ground the streamer still hands out, rebuilt and
 * re-uploaded the next time the camera turns back.
 */
const GEOMETRY_KEPT = GEOMETRY_CACHE
