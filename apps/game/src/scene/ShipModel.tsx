import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import type { Group } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import {
  DEFAULT_SHIP,
  type LoadedShip,
  loadShipModel,
} from '../render/shipModels.ts'
import { debugMaterials } from './debugMaterials.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The player's ship: a modeled hull once its glTF resolves, the debug cone
 * until then and whenever loading fails. The cone is the same degradation
 * story as the star catalog's Sol fallback — the flight model neither knows
 * nor cares what the hull looks like.
 */
export function ShipModel({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
  // Seeded from the engine so a Fast Refresh remount, whose effect may not
  // re-run, still renders the hull the session already loaded.
  const [hull, setHull] = useState<LoadedShip | null>(engine.hull)

  useEffect(() => {
    // The loader caches by id, so StrictMode's double-mount and the canvas
    // remount on an HDR change reuse the same fetch and the same meshes.
    let mounted = true
    void loadShipModel(DEFAULT_SHIP, anisotropy).then((ship) => {
      if (mounted && ship !== null) {
        engine.hull = ship
        setHull(ship)
      }
    })
    return () => {
      mounted = false
    }
  }, [engine, anisotropy])

  useTimedFrame('shipModel', () => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return

    // A playing cutscene borrows the hull as its hero prop: the director says
    // where it is and whether it is on stage at all, and the entity underneath
    // — still simulating, chase-framed, wherever the player left it — is not
    // drawn until the scene hands everything back.
    const cinematic = engine.cinematic
    if (cinematic !== null) {
      group.current.visible = cinematic.ship.visible
      group.current.position.set(
        cinematic.ship.position.x,
        cinematic.ship.position.y,
        cinematic.ship.position.z,
      )
      group.current.quaternion.set(
        cinematic.ship.orientation.x,
        cinematic.ship.orientation.y,
        cinematic.ship.orientation.z,
        cinematic.ship.orientation.w,
      )
      return
    }

    group.current.visible = engine.showShip
    const ship = scene.entities.find((entity) => entity.isCamera)
    if (ship === undefined) return
    group.current.position.set(
      ship.position.x,
      ship.position.y,
      ship.position.z,
    )
    group.current.quaternion.set(
      ship.orientation.x,
      ship.orientation.y,
      ship.orientation.z,
      ship.orientation.w,
    )
  })

  // No dispose on unmount, and Starfield is the precedent: the loader owns the
  // hull for the life of the renderer, and R3F only detaches the primitive.
  return (
    <group ref={group}>
      {hull !== null ? (
        <primitive object={hull.group} />
      ) : (
        <>
          {/* Nose along −Z, matching the forward convention the whole codebase uses. */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} material={debugMaterials.hull}>
            <coneGeometry args={[1.4, 6, 4]} />
          </mesh>
          <mesh position={[0, 0, 1.6]} material={debugMaterials.wing}>
            <boxGeometry args={[5.2, 0.3, 1.6]} />
          </mesh>
          {/* Engine bell, so which way is aft is unambiguous at a glance. */}
          <mesh position={[0, 0, 3.2]} material={debugMaterials.bell}>
            <cylinderGeometry args={[0.9, 1.2, 1.2, 12]} />
          </mesh>
        </>
      )}
    </group>
  )
}
