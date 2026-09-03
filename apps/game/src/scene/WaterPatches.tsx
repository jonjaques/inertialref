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
import { HEIGHTFIELD_RESOLUTION } from '@inertialref/universe'
import { patchIndices, pixelAngle } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { GEOMETRY_CACHE } from '../engine/terrainStreamer.ts'
import { seaQualityFor } from '../render/quality.ts'
import { type WaterMaterial, waveWrap } from '../render/water.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { disposeKeepingSharedIndex } from '../render/terrainAttributes.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The sea, one sheet per patch the sea reaches.
 *
 * A sibling of `TerrainPatches` rather than a branch inside it: the two read
 * the same drawn set and place their meshes the same way, but a patch has a
 * ground always and a sheet only where the sea is, and the sheet is a
 * different material with a different pipeline. What is shared is the
 * placement, the index buffer, and the morph inputs — so a sheet and the
 * seabed under it hand over to their parents at the same distance.
 *
 * A sheet is transparent, which is what puts it after every opaque draw
 * and lets its material read the frame the seabed was just drawn into.
 */
export function WaterPatches({
  engine,
  water,
}: {
  engine: GameEngine
  water: WaterMaterial
}) {
  const group = useRef<Group>(null)
  const meshes = useMemo(() => new Map<string, Mesh>(), [])
  const material = water.material
  const indices = useMemo(
    () => new BufferAttribute(patchIndices(HEIGHTFIELD_RESOLUTION), 1),
    [],
  )
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)

  /*
   * Compile the sheet's pipeline at mount on a one-triangle dummy carrying
   * every attribute the graph reads, for the reason `TerrainPatches` gives:
   * the first real sheet otherwise pays the build in the frame it lands.
   */
  useEffect(() => {
    warmAtMount({
      label: 'compiling the sea',
      units: 1,
      run: async (done) => {
        const geometry = new BufferGeometry()
        const triangle = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
        const depths = new Float32Array([1, 1, 1])
        geometry.setAttribute('position', new BufferAttribute(triangle, 3))
        geometry.setAttribute('terrainMorph', new BufferAttribute(triangle, 3))
        geometry.setAttribute('waterDepth', new BufferAttribute(depths, 1))
        geometry.setAttribute('waterMorphDepth', new BufferAttribute(depths, 1))
        geometry.setIndex([0, 1, 2])
        const dummy = new Mesh(geometry, material)
        dummy.userData.eyeLocal = new Vector3()
        dummy.userData.morphBand = new Vector2(1, 2)
        dummy.userData.anchor = new Vector3(0, 0, 1)
        dummy.userData.waveOrigin = new Vector3()
        await warmCompile(warmRenderer(gl), {
          object: dummy,
          camera,
          scene: scene as Scene,
        }).then(done)
        geometry.dispose()
      },
    })
  }, [gl, camera, scene, material])

  useTimedFrame('waterPatches', () => {
    const container = group.current
    if (container === null) return
    const state = engine.terrainState()
    water.setQuality(seaQualityFor(engine.surfaceQuality.sea))
    if (state.palette !== null && state.orientation !== null) {
      water.setPalette(state.palette)
      if (state.lens !== null) {
        const display = pixelAngle(state.lens.lens, state.lens.viewport)
        const perSample =
          state.lens.viewport.height / Math.max(1, gl.domElement.height)
        water.setPixelAngle(display * perSample)
      }
      const key = engine.scene()?.stars[0]
      if (key !== undefined && state.centre !== null) {
        const toStar = Vec.sub(key.placement.position, state.centre)
        if (Vec.length(toStar) > 0) {
          const local = Q.rotate(
            Q.conjugate(state.orientation),
            Vec.normalize(toStar),
          )
          water.sunDirection.value.set(local.x, local.y, local.z)
        }
        water.sunColour.value.setRGB(key.color.r, key.color.g, key.color.b)
      }
      water.time.value = engine.snapshot?.renderTime ?? 0
    }
    const drawn = state.palette !== null && state.palette.sheet > 0
    const seen = new Set<string>()

    if (drawn) {
      for (const placed of state.patches) {
        const { patch, placement, key } = placed
        const sheet = patch.water
        if (sheet === null) continue
        seen.add(key)
        let mesh = meshes.get(key)
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
            new BufferAttribute(sheet.positions, 3),
          )
          geometry.setAttribute(
            'terrainMorph',
            new BufferAttribute(sheet.morphPositions, 3),
          )
          geometry.setAttribute(
            'waterDepth',
            new BufferAttribute(sheet.depths, 1),
          )
          geometry.setAttribute(
            'waterMorphDepth',
            new BufferAttribute(sheet.morphDepths, 1),
          )
          geometry.setIndex(indices)
          geometry.boundingSphere = new Sphere(
            new Vector3(
              sheet.boundsCentre.x,
              sheet.boundsCentre.y,
              sheet.boundsCentre.z,
            ),
            sheet.boundsRadius,
          )
          mesh = new Mesh(geometry, material)
          mesh.userData.eyeLocal = new Vector3()
          mesh.userData.morphBand = new Vector2()
          const ax = Math.fround(patch.anchor.x)
          const ay = Math.fround(patch.anchor.y)
          const az = Math.fround(patch.anchor.z)
          mesh.userData.anchor = new Vector3(ax, ay, az)
          mesh.userData.waveOrigin = new Vector3(
            waveWrap(patch.anchor.x),
            waveWrap(patch.anchor.y),
            waveWrap(patch.anchor.z),
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
        mesh.scale.setScalar(placement.scale)
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
    }

    for (const [key, mesh] of meshes) {
      if (seen.has(key)) continue
      container.remove(mesh)
      if (meshes.size > GEOMETRY_CACHE) {
        disposeKeepingSharedIndex(mesh)
        meshes.delete(key)
      }
    }
  })

  return <group ref={group} />
}
