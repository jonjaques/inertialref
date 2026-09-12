import { useThree } from '@react-three/fiber'
import { useEffect, useRef, useState } from 'react'
import type { Camera, Group, Scene } from 'three/webgpu'
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
 *
 * A playing script that names a hero prop gets it drawn from the engine's
 * second slot, `stagedHull`, never from `hull`: the chase distance, the warp
 * and the plumes all read `hull` as the player's, and the scene's prop must
 * not reach them for even the frame between the script's last sample and the
 * player's hull coming back.
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
  // Seeded from the engine so a Fast Refresh remount, whose effect may not
  // re-run, still renders the hull the session already loaded.
  const [hull, setHull] = useState<LoadedShip | null>(engine.hull)
  // The prop the playing script asks for, and the hull loaded against it.
  // `stagedId` is React state rather than a read of `engine.cinematic` at
  // render time because the primitive below is chosen at render time: the
  // frame loop writes it, React flushes, and only then does the group hold
  // the prop — so the visibility gate in the frame callback compares against
  // this, not the engine, and never shows the group holding the other hull.
  const [stagedId, setStagedId] = useState<string | null>(
    engine.cinematic?.ship.model ?? null,
  )
  const [staged, setStaged] = useState<LoadedShip | null>(engine.stagedHull)

  useEffect(
    () =>
      loadInto(shipId, anisotropy, gl, camera, scene as Scene, (ship) => {
        engine.hull = ship
        setHull(ship)
      }),
    [engine, anisotropy, shipId, gl, camera, scene],
  )

  useEffect(() => {
    if (stagedId === null) return
    return loadInto(
      stagedId,
      anisotropy,
      gl,
      camera,
      scene as Scene,
      (ship) => {
        engine.stagedHull = ship
        setStaged(ship)
      },
    )
  }, [engine, anisotropy, stagedId, gl, camera, scene])

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
    const wanted = engine.cinematic?.ship.model ?? null
    if (wanted !== stagedId) setStagedId(wanted)
    const scene = engine.scene()
    if (scene === null || group.current === null) return

    // The group holds what the frame asks for: the player's hull when no
    // script names a prop, the requested prop once it has loaded. Until then
    // it is hidden rather than shown holding the other one.
    const onStage =
      stagedId === wanted && (wanted === null || staged?.id === wanted)

    // A playing cutscene puts its hero prop where the director says, and the
    // entity underneath — still simulating, chase-framed, wherever the player
    // left it — is not drawn until the scene hands everything back.
    const cinematic = engine.cinematic
    if (cinematic !== null) {
      group.current.visible = cinematic.ship.visible && onStage
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

    group.current.visible = engine.showShip && onStage
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

  const shown =
    stagedId === null ? hull : staged?.id === stagedId ? staged : null

  // No dispose on unmount, and Starfield is the precedent: the loader owns the
  // hull for the life of the renderer, and R3F only detaches the primitive.
  // The cone stands in for the player's hull only: a prop still loading is an
  // empty group, because the cone at a scene's pose is a scene with a cone in it.
  return (
    <group ref={group}>
      {shown !== null ? (
        <primitive object={shown.group} />
      ) : stagedId === null ? (
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
      ) : null}
    </group>
  )
}

/**
 * Load one hull, compile it against the live scene, and hand it over — unless
 * the request has been superseded. Returns the effect's cleanup.
 *
 * The loader caches by id, so StrictMode's double-mount and the canvas remount
 * on an HDR change reuse the same fetch and the same meshes. The handover is
 * gated on the cleanup not having run: a fast switch resolves two cached
 * promises and the last requested id must win, not the last to land. The hull
 * already on stage stays there until the new one is ready, so a switch never
 * flashes the debug cone.
 */
function loadInto(
  id: string,
  anisotropy: number,
  gl: object,
  camera: Camera,
  scene: Scene,
  apply: (ship: LoadedShip) => void,
): () => void {
  let mounted = true
  void loadShipModel(id, anisotropy).then(async (ship) => {
    if (ship === null) return
    await warmCompile(warmRenderer(gl), { object: ship.group, camera, scene })
    if (mounted) apply(ship)
  })
  return () => {
    mounted = false
  }
}
