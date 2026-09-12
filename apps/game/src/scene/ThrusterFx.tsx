import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { Group, Scene } from 'three/webgpu'
import { driveThrottle, ThrusterVisuals } from '@inertialref/rendering'
import { Vec } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createThrusterPlumes, type ThrusterPlumes } from '../render/plumes.ts'
import { thrusterLayoutFor } from '../render/thrusterLayouts.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import {
  read,
  RENDER_SHIP,
  RENDER_THRUSTER_VARIATION,
  usePersistentState,
} from '../state/preferences.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/**
 * The plumes beside the hull: which valves are firing, and the drive.
 *
 * Its own component rather than a child of `ShipModel`, because it consumes a
 * different thing: the model consumes a hull, this consumes the entity's
 * thrust demand and the presentation-only stop and settling cues, mapped onto
 * the valves the hull's layout names. It rides
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
  const [variation] = usePersistentState(RENDER_THRUSTER_VARIATION)

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
          visuals: new ThrusterVisuals(layout),
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
        for (const id of new Set([read(RENDER_SHIP), 'rocinante'])) {
          const staged = stageFor(id)
          staged.firing.fill(1)
          staged.plumes.update(staged.firing, 1, 1)
          await warmCompile(warmRenderer(gl), {
            object: staged.plumes.group,
            camera,
            scene: scene as Scene,
          })
          staged.plumes.update(null, 0, 10)
        }
        done()
      },
    })
  }, [gl, camera, scene, stageFor])

  const mounted = useRef<string | null>(null)

  useTimedFrame('thrusterFx', (_, delta) => {
    const view = engine.scene()
    const root = group.current
    if (view === null || root === null) return

    // The hull the frame draws, so the plumes are keyed on the same layout:
    // a script's prop while it names one and has loaded, the player's hull
    // otherwise. Never `engine.hull` under a named prop — that slot stays
    // the player's, and the prop's plumes at the entity's pose would be the
    // Rocinante's drive burning beside the Enterprise.
    const hull = engine.hullOnStage
    const cinematic = engine.cinematic
    const visible =
      cinematic === null ? engine.showShip : cinematic.ship.visible
    if (hull === null || !visible) {
      if (root.visible) {
        for (const held of built.values()) held.plumes.update(null, 0, 10)
      }
      root.visible = false
      return
    }
    const staged = stageFor(hull.id)
    if (mounted.current !== hull.id) {
      root.clear()
      staged.plumes.update(null, 0, 10)
      root.add(staged.plumes.group)
      mounted.current = hull.id
    }

    if (cinematic !== null) {
      root.visible = true
      root.position.set(
        cinematic.ship.position.x,
        cinematic.ship.position.y,
        cinematic.ship.position.z,
      )
      root.quaternion.set(
        cinematic.ship.orientation.x,
        cinematic.ship.orientation.y,
        cinematic.ship.orientation.z,
        cinematic.ship.orientation.w,
      )
      staged.plumes.sample(
        cinematic.ship.throttle ?? 0,
        cinematic.elapsedSeconds ?? 0,
      )
      return
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
    const state = engine.snapshot?.entities.find(
      (entity) => entity.id === ship.id,
    )
    const stop =
      engine.rotationStop?.entity === ship.id ? engine.rotationStop : null
    const holding =
      state !== undefined &&
      !state.landed &&
      Vec.length(state.angularVelocity) < 1e-3 &&
      (state.flightAssist ||
        (stop !== null && engine.presentationTime - stop.at < 8))
    const firing = staged.visuals.sample(
      demand,
      engine.presentationTime,
      stop,
      holding,
      variation,
    )
    staged.plumes.update(firing, driveThrottle(demand), delta, variation)
  })

  // Empty until the first frame mounts a hull's plumes under it.
  return <group ref={group} />
}

interface Staged {
  readonly plumes: ThrusterPlumes
  readonly visuals: ThrusterVisuals
  readonly firing: Float32Array
}
