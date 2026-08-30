import { useRef } from 'react'
import type { Group } from 'three/webgpu'
import type { GameEngine } from '../engine/GameEngine.ts'
import { debugMaterials } from './debugMaterials.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * Meter-scale reference objects around the player.
 *
 * Milestone requirement 8, made visible: a meter grid and a one-meter cube sat
 * next to the ship, four light-years from the galactic origin, so the precision
 * claim is something you can look at rather than only assert in a test.
 */
export function NearFieldProps({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const rack = useRef<Group>(null)

  useTimedFrame('nearFieldProps', () => {
    const scene = engine.scene()
    if (scene === null || group.current === null) return
    // The props ride the same toggle as the ship: both are debug hardware, and
    // a bookmarked composition wants neither in the middle of it. A cutscene
    // wants them even less — a meter cube beside a 642 m hero hull is a gag.
    group.current.visible = engine.showShip && engine.cinematic === null
    // ±4 m from the origin was beside the debug cone; inside a modeled hull
    // it is somewhere in the saucer's wiring. Slide the rack out past the
    // starboard beam so the cubes stay inspectable next to the hull.
    if (rack.current !== null) {
      rack.current.position.x =
        engine.hull === null ? 0 : engine.hull.beamMetres / 2 + 40
    }
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

  return (
    <group ref={group}>
      <group ref={rack}>
        {/* One meter. */}
        <mesh position={[4, 0, 0]} material={debugMaterials.metre}>
          <boxGeometry args={[1, 1, 1]} />
        </mesh>
        {/* One foot. */}
        <mesh position={[-4, 0, 0]} material={debugMaterials.foot}>
          <boxGeometry args={[0.3048, 0.3048, 0.3048]} />
        </mesh>
        {/* One inch — the smallest thing the spec asks the coordinate system to
            resolve, sitting 8 kiloparsecs from the universe origin. */}
        <mesh position={[-4.7, 0, 0]} material={debugMaterials.inch}>
          <boxGeometry args={[0.0254, 0.0254, 0.0254]} />
        </mesh>
      </group>
    </group>
  )
}
