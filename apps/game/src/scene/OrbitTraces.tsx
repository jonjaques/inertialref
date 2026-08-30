import { useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Line,
  LineBasicNodeMaterial,
} from 'three/webgpu'
import { UV, Vec } from '@inertialref/spatial'
import { placePathInto } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/*
 * Orbit traces, when the planetarium asks for them.
 *
 * One `Line` per body, its vertex buffer rewritten each frame. Rewriting rather
 * than transforming, because there is no single transform that would do: each
 * point goes through `placeAt` with the *body's own radius*, which is the only
 * way the curve lands where the body is drawn — render compression keys off an
 * object's radius, so a trace placed as a radius-zero point sits six times
 * nearer than Jupiter does at Jupiter's range, and the planet floats visibly
 * off its own orbit.
 *
 * The curve itself is not recomputed here. `engine.orbits` carries the anchor
 * each trace was built against, so following a moving primary is one vector
 * difference for a whole path rather than a period of Kepler solves.
 */
const ORBIT_CAPACITY = 4096

export function OrbitTraces({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const lines = useRef(new Map<string, Line>())
  const material = useMemo(() => {
    const line = new LineBasicNodeMaterial()
    line.transparent = true
    // Additive would bloom into a bright wash where the inner planets' orbits
    // overlap; a low-alpha normal blend keeps ten traces readable as ten.
    line.opacity = 0.32
    line.depthWrite = false
    line.color.setRGB(0.35, 0.62, 0.85)
    return line
  }, [])

  useTimedFrame('orbitTraces', () => {
    const parent = group.current
    /*
     * The origin *and* the eye off the same scene, never one of each.
     *
     * The eye is a render-space vector, so it only means anything paired with
     * the origin it was measured against. `engine.origin` is the live one and
     * runs ahead of `engine.scene()` on any frame `#step` returns early from —
     * a load, a save being applied — so reading one from each would compress
     * the trace about a point up to `REBASE_THRESHOLD` from the camera, which
     * is the very error that made the small moons vibrate. See `placement.ts`.
     */
    const scene = engine.scene()
    if (parent === null) return
    if (!engine.showOrbits || scene === null) {
      parent.visible = false
      return
    }
    const origin = scene.origin
    const eye = scene.camera.position
    parent.visible = true

    const live = new Set<string>()
    for (const path of engine.orbits) {
      if (path.points.length < 2 || path.points.length > ORBIT_CAPACITY)
        continue
      live.add(path.address)

      let line = lines.current.get(path.address)
      if (line === undefined) {
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(new Float32Array(path.points.length * 3), 3),
        )
        line = new Line(geometry, material)
        // The trace is drawn in the compressed shell along with everything
        // else, so its bounds are meaningless to the culler and a wrong
        // bounding sphere makes an orbit vanish when its center leaves the
        // frustum — which is most of the time, since the camera is usually
        // inside the orbit it is looking at.
        line.frustumCulled = false
        lines.current.set(path.address, line)
        parent.add(line)
      }

      // Where the primary is *now*, against where it was when the trace was
      // built. `frames.pose` rather than a search through the scene: a trace
      // exists for bodies the render culled, and losing the anchor would leave
      // the curve behind while the planet moved on.
      //
      // `renderTime`, because "now" here means the instant the frame depicts
      // and the bodies this ring is drawn around came off a snapshot taken at
      // that instant. At `clock.time` the ring hangs off its primary by that
      // primary's velocity times up to a tick — 375 m for anything riding Mars
      // — and sawtooths as alpha resets. Negligible seen whole, and not
      // negligible at all where the ring passes near the camera: framed on
      // Phobos, the near segment is ~37 km away and 375 m of it is 15 pixels.
      // `path.anchor` is built at a fixed instant and cancels out of the
      // difference, so only this lookup has to move.
      const shift = engine.world.frames.has(path.parent)
        ? UV.difference(
            engine.world.frames.pose(path.parent, engine.world.clock.renderTime)
              .position,
            path.anchor,
          )
        : Vec.ZERO

      const attribute = line.geometry.getAttribute(
        'position',
      ) as BufferAttribute
      // One call for the whole path, writing the buffer directly. Per point
      // this was a `UV.translate`, a `placeAt` and the placement record it
      // returns — see `placePathInto`, which is the same arithmetic without
      // the several thousand objects a frame.
      placePathInto(
        origin,
        path.points,
        shift,
        path.radius,
        eye,
        attribute.array as Float32Array,
      )
      attribute.needsUpdate = true
    }

    // A save loaded in another system leaves traces for bodies that are no
    // longer anywhere. Dropping them here rather than on world replacement
    // keeps the whole lifetime of a line in one place.
    for (const [address, line] of lines.current) {
      if (live.has(address)) continue
      parent.remove(line)
      line.geometry.dispose()
      lines.current.delete(address)
    }
  })

  return <group ref={group} />
}
