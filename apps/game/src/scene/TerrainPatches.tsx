import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import { BufferAttribute, BufferGeometry, type Group, Mesh } from 'three/webgpu'
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
