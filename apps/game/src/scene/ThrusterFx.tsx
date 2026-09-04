import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Group, Scene } from 'three/webgpu'
import {
  driveThrottle,
  type NozzleAllocation,
  nozzleFiring,
  prepareNozzles,
} from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createThrusterPlumes, type ThrusterPlumes } from '../render/plumes.ts'
import { thrusterLayoutFor } from '../render/thrusterLayouts.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { read, RENDER_SHIP } from '../state/preferences.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The plumes beside the hull: which valves are firing, and the drive.
 *
 * Its own component rather than a child of `ShipModel`, because it consumes a
 * different thing: the model consumes a hull, this consumes the entity's
 * thrust demand — `RenderEntity.thrust`, the fraction of each axis the tick
 * integrated — and maps it onto the valves the hull's layout names. It rides
 * the same pose as the hull, written here rather than by parenting into the
 * loader's group, so a hull switch swaps one child and disposes nothing that
 * the loader owns.
 *
 * Dormant unless a valve is open: `plumes.update` hides every mesh whose
 * intensity has decayed below its floor, so a coasting ship costs one
 * allocation pass over thirty valves a frame and no draw.
 */
export function ThrusterFx({ engine }: { engine: GameEngine }) {
  const camera = useThree((state) => state.camera)
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const group = useRef<Group>(null)

  /*
   * One set of plumes per hull, kept for the renderer's life the way the
   * loader keeps hulls — the compiled programs are the expensive part, and a
   * switch back to a hull already seen should cost nothing. No dispose on
   * unmount, on the precedent `WarpFx` and `SunFlare` cite: R3F only ever
   * detaches the primitive.
   */
  const built = useMemo(() => new Map<string, Staged>(), [])
  const stageFor = useCallback(
    (id: string): Staged => {
      let staged = built.get(id)
      if (staged === undefined) {
        const layout = thrusterLayoutFor(id)
        staged = {
          plumes: createThrusterPlumes(layout),
          allocation: prepareNozzles(layout),
          firing: new Float32Array(layout.nozzles.length),
        }
        built.set(id, staged)
      }
      return staged
    },
    [built],
  )

  /*
   * Compile the chosen hull's plumes behind the boot cover, lit.
   *
   * Lit, because `compileAsync` skips what is invisible and every plume mesh
   * hides itself until a valve opens; the warm-up opens them all, compiles,
   * and lets them decay. The preference rather than `engine.hull`, which is
   * null until the glTF resolves — the same read `render/preload.ts` makes to
   * warm the hull itself.
   */
  useEffect(() => {
    warmAtMount({
      label: 'compiling the plumes',
      units: 1,
      run: async (done) => {
        const staged = stageFor(read(RENDER_SHIP))
        staged.firing.fill(1)
        staged.plumes.update(staged.firing, 1, 1)
        await warmCompile(warmRenderer(gl), {
          object: staged.plumes.group,
          camera,
          scene: scene as Scene,
        })
        staged.plumes.update(null, 0, 10)
        done()
      },
    })
  }, [gl, camera, scene, stageFor])

  const mounted = useRef<string | null>(null)

  useTimedFrame('thrusterFx', (_, delta) => {
    const view = engine.scene()
    const root = group.current
    if (view === null || root === null) return

    /*
     * Nothing while a cutscene has the hull as its prop, or while the hull is
     * hidden, or before there is a hull: the debug cone is debug hardware and
     * a plume on a cone would be a claim about a ship nobody is flying.
     */
    const hull = engine.hull
    if (hull === null || engine.cinematic !== null || !engine.showShip) {
      root.visible = false
      return
    }
    const staged = stageFor(hull.id)
    if (mounted.current !== hull.id) {
      root.clear()
      root.add(staged.plumes.group)
      mounted.current = hull.id
    }

    const ship = view.entities.find((entity) => entity.isCamera)
    if (ship === undefined) {
      root.visible = false
      return
    }
    root.visible = true
    root.position.set(ship.position.x, ship.position.y, ship.position.z)
    root.quaternion.set(
      ship.orientation.x,
      ship.orientation.y,
      ship.orientation.z,
      ship.orientation.w,
    )

    const demand = ship.thrust
    if (demand === null) {
      staged.plumes.update(null, 0, delta)
      return
    }
    nozzleFiring(staged.allocation, demand, staged.firing)
    staged.plumes.update(staged.firing, driveThrottle(demand), delta)
  })

  // Empty until the first frame mounts a hull's plumes under it.
  return <group ref={group} />
}

interface Staged {
  readonly plumes: ThrusterPlumes
  readonly allocation: NozzleAllocation
  readonly firing: Float32Array
}
