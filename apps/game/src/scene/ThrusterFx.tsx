import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  type Camera,
  type Group,
  Quaternion,
  type Scene,
  Vector3,
} from 'three/webgpu'
import { driveThrottle, ThrusterVisuals } from '@inertialref/rendering'
import { Vec } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createThrusterPlumes, type ThrusterPlumes } from '../render/plumes.ts'
import { thrusterLayoutFor } from '../render/thrusterLayouts.ts'
import { warmAtMount, warmCompile, warmRenderer } from '../render/warmup.ts'
import { markOverClouds } from '../render/cloudLayers.ts'
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
          // Seen through the clouds in front of them under `?clouds=1`.
          plumes: createThrusterPlumes(layout, engine.cloudFront ?? undefined),
          visuals: new ThrusterVisuals(layout),
          firing: new Float32Array(layout.nozzles.length),
        }
        // Over the clouds under `?clouds=1`, before the warm-up compiles them.
        if (engine.cloudsAvailable) markOverClouds(staged.plumes.group)
        built.set(id, staged)
      }
      return staged
    },
    [built, engine],
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
          await warmCompile(warmRenderer(gl, engine.sceneLayout(gl)), {
            object: staged.plumes.group,
            camera,
            scene: scene as Scene,
          })
          staged.plumes.update(null, 0, 10)
        }
        done()
      },
    })
  }, [engine, gl, camera, scene, stageFor])

  const mounted = useRef<string | null>(null)
  const lit = useRef(false)

  useTimedFrame('thrusterFx', (_, delta) => {
    const view = engine.scene()
    const root = group.current
    if (view === null || root === null) return

    // `ir.lightEngine`: a drive lit in front of the lens, drawn only.
    const held = engine.harness.lightEngine.throttle
    if (held !== null) {
      const own = engine.hullOnStage?.id ?? read(RENDER_SHIP)
      const id = thrusterLayoutFor(own).drive === null ? 'rocinante' : own
      const staged = stageFor(id)
      if (mounted.current !== id) {
        root.clear()
        root.add(staged.plumes.group)
        mounted.current = id
      }
      root.visible = standInFront(root, camera, thrusterLayoutFor(id))
      staged.plumes.sample(held, engine.presentationTime)
      lit.current = true
      return
    }
    // Released: the held plume goes out where it stood, rather than fading
    // over a third of a second on a ship it never lit.
    if (lit.current) {
      lit.current = false
      for (const each of built.values()) each.plumes.update(null, 0, 10)
      mounted.current = null
    }

    // The hull the frame draws, so the plumes are keyed on the same layout:
    // a script's prop or the pad's parked Rocinante once it has loaded, the
    // player's hull otherwise. Never `engine.hull` while a model is staged —
    // that slot stays the player's, and its plumes beside the staged hull
    // would be the Enterprise's drive burning under the Rocinante.
    const hull = engine.hullOnStage
    const owner = engine.owner
    const cinematic = owner?.arm === 'cutscene' ? owner.cinematic : null
    const visible = cinematic?.ship.visible ?? engine.showShip
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

    // The player's ship as the frame names it — on foot, the one the walker
    // stepped out of. Its demand is the entity's, and its pose is the one
    // `ShipModel` draws the hull at: the raised pad pose for a parked
    // Rocinante, which a parked hull can thrust from, because a control held
    // at the step out stays on the vessel.
    const ship = view.entities.find((entity) => entity.id === owner?.ship)
    if (ship === undefined) {
      root.visible = false
      return
    }
    const pose = engine.parkedRocinante ?? ship
    root.visible = true
    root.position.set(pose.position.x, pose.position.y, pose.position.z)
    root.quaternion.set(
      pose.orientation.x,
      pose.orientation.y,
      pose.orientation.z,
      pose.orientation.w,
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

/** m: how far down the lens the held drive's plume stands. */
const STAND = 60
const forward = new Vector3()
const right = new Vector3()
const mouth = new Vector3()
const turn = new Quaternion()
const ACROSS = new Quaternion().setFromAxisAngle(
  new Vector3(0, 1, 0),
  Math.PI / 2,
)

/*
 * The held drive's pose: its plume across the middle of the frame, the
 * mouth left of center and the torch running right, `STAND` meters out.
 * The stances that ask for it are cameras on the ground, nowhere near the
 * ship, so the plume is placed on the lens rather than on the hull; across
 * the frame, so its whole length is drawn rather than its mouth alone. The
 * camera rig runs earlier in the frame, so the pose is this frame's.
 */
function standInFront(
  root: Group,
  camera: Camera,
  layout: ReturnType<typeof thrusterLayoutFor>,
): boolean {
  const drive = layout.drive
  if (drive === null) return false
  // Hull +Z is the exhaust; a quarter turn about +Y lays it along the lens's +X.
  turn.copy(camera.quaternion).multiply(ACROSS)
  forward.set(0, 0, -1).applyQuaternion(camera.quaternion)
  right.set(1, 0, 0).applyQuaternion(camera.quaternion)
  mouth
    .set(drive.position.x, drive.position.y, drive.position.z)
    .applyQuaternion(turn)
  root.quaternion.copy(turn)
  root.position
    .copy(camera.position)
    .addScaledVector(forward, STAND)
    // Half the torch's full length, nine mouth radii (`plumes.ts`).
    .addScaledVector(right, -drive.radius * 4.5)
    .sub(mouth)
  return true
}

interface Staged {
  readonly plumes: ThrusterPlumes
  readonly visuals: ThrusterVisuals
  readonly firing: Float32Array
}
