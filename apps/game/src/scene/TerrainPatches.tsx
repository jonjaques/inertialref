import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Mesh,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createTerrainMaterial } from '../render/materials.ts'

/**
 * Streamed terrain patches: geometry uploaded once, moved every frame.
 *
 * The two halves are separate on purpose. A patch's vertices are body-fixed and
 * never change, so re-uploading them is pure waste — this used to hand Three.js
 * three new BufferAttributes per patch per frame. Where the patch *is* changes
 * constantly, because the planet is orbiting and turning, and that is a position
 * and a quaternion. Baking the second into the first is what made the ground
 * slide away from the ship between origin rebases.
 */
export function TerrainPatches({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const meshes = useMemo(() => new Map<string, Mesh>(), [])
  const material = useMemo(() => createTerrainMaterial(), [])
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
   */
  useEffect(() => {
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    )
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    )
    geometry.setIndex([0, 1, 2])
    const renderer = gl as unknown as WebGPURenderer
    /*
     * Both pipeline variants, because the frame loop below flips
     * `transparent` with the fade — and the *transparent* one is what the
     * first real patch draws with, mid-descent, since terrain always fades
     * in. The flag is read during the compile call's synchronous walk, so
     * flipping it between the two calls compiles one variant each; two
     * meshes, because a repeated (object, material) pair would hand the
     * second call the first call's cached render object.
     */
    material.transparent = true
    const fading = renderer
      .compileAsync(new Mesh(geometry, material), camera, scene as Scene)
      .catch(() => {})
    material.transparent = false
    const opaque = renderer
      .compileAsync(new Mesh(geometry, material), camera, scene as Scene)
      .catch(() => {})
    void Promise.all([fading, opaque]).finally(() => geometry.dispose())
  }, [gl, camera, scene, material])

  useFrame(() => {
    const container = group.current
    if (container === null) return
    const state = engine.terrainState()
    // The streamer owns how present terrain is at this altitude; the material
    // just wears the number. `transparent` toggles with it because an opaque
    // material ignores opacity, and a permanently transparent one would be
    // sorted and blended on every frame of ordinary ground.
    material.opacity = state.opacity
    material.transparent = state.opacity < 1
    const seen = new Set<string>()

    for (const { patch, placement } of state.patches) {
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
        geometry.setIndex(new BufferAttribute(patch.indices, 1))
        geometry.computeBoundingSphere()
        mesh = new Mesh(geometry, material)
        container.add(mesh)
        meshes.set(key, mesh)
      }
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
      mesh.visible = true
    }

    for (const [key, mesh] of meshes) {
      if (!seen.has(key)) {
        mesh.visible = false
        container.remove(mesh)
        mesh.geometry.dispose()
        meshes.delete(key)
      }
    }
  })

  return <group ref={group} />
}
