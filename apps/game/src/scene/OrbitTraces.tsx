import { useFrame } from '@react-three/fiber'
import { useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Line,
  LineBasicNodeMaterial,
} from 'three/webgpu'
import { UV, Vec } from '@inertialref/spatial'
import { placeAt } from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'

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

  useFrame(() => {
    const parent = group.current
    const origin = engine.origin
    if (parent === null) return
    if (!engine.showOrbits || origin === null) {
      parent.visible = false
      return
    }
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
      const shift = engine.world.frames.has(path.parent)
        ? UV.difference(
            engine.world.frames.pose(path.parent, engine.world.clock.time)
              .position,
            path.anchor,
          )
        : Vec.ZERO

      const attribute = line.geometry.getAttribute(
        'position',
      ) as BufferAttribute
      const array = attribute.array as Float32Array
      for (let i = 0; i < path.points.length; i += 1) {
        const point = path.points[i]
        if (point === undefined) continue
        const placed = placeAt(
          origin,
          UV.translate(point, shift),
          path.radius,
        ).position
        array[i * 3] = placed.x
        array[i * 3 + 1] = placed.y
        array[i * 3 + 2] = placed.z
      }
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
