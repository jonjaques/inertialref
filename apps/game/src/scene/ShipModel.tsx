import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import type { Group, Scene } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { type LoadedShip, loadShipModel } from '../render/shipModels.ts'
import { RENDER_SHIP, usePersistentState } from '../state/preferences.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
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
  const gl = useThree((state) => state.gl)
  const camera = useThree((state) => state.camera)
  const scene = useThree((state) => state.scene)
  const anisotropy = useThree(
    (state) => state.gl.capabilities?.getMaxAnisotropy?.() ?? 8,
  )
  // The chosen hull, live: changing it in settings reloads the ship without a
  // reload of the page, which here would rebuild the renderer and lose the
  // camera. The loader caches by id, so switching back is instant.
  const [shipId] = usePersistentState(RENDER_SHIP)
  const [requestedId, setRequestedId] = useState(
    engine.cinematic?.ship.model ?? shipId,
  )
  // Seeded from the engine so a Fast Refresh remount, whose effect may not
  // re-run, still renders the hull the session already loaded.
  const [hull, setHull] = useState<LoadedShip | null>(engine.hull)

  useEffect(() => {
    // The loader caches by id, so StrictMode's double-mount and the canvas
    // remount on an HDR change reuse the same fetch and the same meshes.
    let mounted = true
    void loadShipModel(requestedId, anisotropy).then(async (ship) => {
      if (ship !== null)
        await warmCompile(warmRenderer(gl), {
          object: ship.group,
          camera,
          scene: scene as Scene,
        })
      // Only apply if this is still the wanted hull: a fast switch resolves two
      // cached promises and the last requested id must win, not the last to
      // land. The old hull stays on stage until the new one is ready, so a
      // switch never flashes the debug cone.
      if (mounted && ship !== null) {
        engine.hull = ship
        setHull(ship)
      }
    })
    return () => {
      mounted = false
    }
  }, [engine, anisotropy, requestedId, gl, camera, scene])

  useEffect(() => {
    warmAtMount({
      label: 'compiling the cinematic hull',
      units: 1,
      run: async (done) => {
        const ship = await loadShipModel('rocinante', anisotropy)
        if (ship !== null)
          await warmCompile(warmRenderer(gl), {
            object: ship.group,
            camera,
            scene: scene as Scene,
          })
        done()
      },
    })
  }, [anisotropy, gl, camera, scene])

  useTimedFrame('shipModel', () => {
    const desiredId = engine.cinematic?.ship.model ?? shipId
    if (desiredId !== requestedId) setRequestedId(desiredId)
    const scene = engine.scene()
    if (scene === null || group.current === null) return

    // A playing cutscene borrows the hull as its hero prop: the director says
    // where it is and whether it is on stage at all, and the entity underneath
    // — still simulating, chase-framed, wherever the player left it — is not
    // drawn until the scene hands everything back.
    const cinematic = engine.cinematic
    if (cinematic !== null) {
      group.current.visible =
        cinematic.ship.visible &&
        (cinematic.ship.model === undefined ||
          cinematic.ship.model === hull?.id)
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
