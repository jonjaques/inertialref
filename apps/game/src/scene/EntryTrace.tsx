import { useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  Line,
  LineSegments,
} from 'three/webgpu'
import type { Vec3 } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createEntryTraceMaterials } from '../render/entryTrace.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/*
 * Where the figure would land, drawn in the scene rather than over it.
 *
 * The aid was an SVG in the HUD first, and it was wrong for a reason no amount
 * of styling fixes: an overlay is flat. It cannot be occluded by the limb it
 * crosses, its dashes do not shorten with distance, and the ring it puts on
 * the ground is a circle rather than the ellipse a circle on a sphere actually
 * is.
 *
 * **It is placed in the body's own frame, exactly as a terrain patch is.** A
 * body is not drawn where its metric position says: render compression pulls
 * it nearer and shrinks it so its angular size survives, and `placement.scale`
 * is the radius it comes out at. A point put through its *own* compression
 * therefore lands at a different depth from the sphere it is supposed to be
 * lying on — and that is not a subtle error: placed that way the ground ring
 * sank inside the planet and disappeared. So the observatory answers in body
 * radii, in the body's rotating axes, and this hangs the whole aid off the
 * placement the body was drawn with. One unit is the drawn surface, by
 * construction.
 *
 * The buffers are therefore *camera-independent*: they change when the aim
 * moves and not when the eye does, so a frame in which the hand held still
 * writes nothing at all.
 */

/** Points in the fall and the x-ray, and in either ring. */
const SAMPLES = 48
const RING_POINTS = 49

/**
 * The fall is drawn as segments with gaps, not as a dashed material.
 *
 * A dashed line in a node material needs per-vertex line distances and a
 * shader that reads them; alternate segments of a `LineSegments` are the same
 * picture with no material work and no second attribute to keep in step.
 */
const DASH_SEGMENTS = Math.floor((SAMPLES - 1) / 2)

export function EntryTrace({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const materials = useMemo(() => createEntryTraceMaterials(), [])
  const parts = useRef<{
    fall: LineSegments
    through: LineSegments
    ring: Line
    hold: Line
  } | null>(null)
  /** The aim the buffers hold, so a still hand costs one comparison a frame. */
  const written = useRef('')

  useTimedFrame('entryTrace', () => {
    const parent = group.current
    if (parent === null) return
    const observatory = engine.harness.observatory
    const aim = observatory.aim
    const scene = engine.scene()
    const address = observatory.target?.address ?? null
    // The body as it was *drawn*: the placement carries the compression, and
    // the aid is only in the right place if it uses the same one.
    const drawn =
      scene === null || address === null
        ? undefined
        : scene.bodies.find((body) => body.address === address)
    if (aim === null || drawn === undefined) {
      parent.visible = false
      written.current = ''
      return
    }
    parent.visible = true
    const placement = drawn.placement
    parent.position.set(
      placement.position.x,
      placement.position.y,
      placement.position.z,
    )
    // The body's own turn, so the aid rides the ground rather than inertial
    // space — the aim is a latitude, and a latitude moves with the world.
    parent.quaternion.set(
      drawn.orientation.x,
      drawn.orientation.y,
      drawn.orientation.z,
      drawn.orientation.w,
    )
    // One unit of the buffers is one body radius, and this is the radius the
    // body came out at — so the ring lands on the ground that is on screen.
    parent.scale.setScalar(placement.scale)

    if (parts.current === null) {
      const build = (count: number): BufferGeometry => {
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(new Float32Array(count * 3), 3),
        )
        return geometry
      }
      const fall = new LineSegments(build(DASH_SEGMENTS * 2), materials.fall)
      const through = new LineSegments(
        build(DASH_SEGMENTS * 2),
        materials.through,
      )
      const ring = new Line(build(RING_POINTS), materials.ring)
      const hold = new Line(build(RING_POINTS), materials.hold)
      // The group is placed in the compressed shell, so a bounding sphere
      // computed from its geometry means nothing to the culler.
      for (const part of [fall, through, ring, hold]) {
        part.frustumCulled = false
        parent.add(part)
      }
      parts.current = { fall, through, ring, hold }
    }
    const held = parts.current

    /*
     * The aim is the key the buffers are cached against. Two angles decide
     * every point, so a drag that has paused writes nothing rather than a
     * hundred and ninety vertices.
     */
    const key = `${aim.latitude},${aim.longitude}`
    if (key === written.current) return
    const preview = observatory.entryArcPreview(undefined, aim, SAMPLES)
    if (preview === null) {
      parent.visible = false
      return
    }
    written.current = key

    /** Every second segment, so the line is dashed by omission. */
    const dash = (points: readonly Vec3[], target: LineSegments): void => {
      const attribute = target.geometry.getAttribute(
        'position',
      ) as BufferAttribute
      const out = attribute.array as Float32Array
      for (let pair = 0; pair < DASH_SEGMENTS; pair += 1) {
        const from = points[pair * 2]
        const to = points[pair * 2 + 1]
        if (from === undefined || to === undefined) continue
        out.set([from.x, from.y, from.z, to.x, to.y, to.z], pair * 6)
      }
      attribute.needsUpdate = true
    }

    const loop = (points: readonly Vec3[], target: Line): void => {
      const attribute = target.geometry.getAttribute(
        'position',
      ) as BufferAttribute
      const out = attribute.array as Float32Array
      for (let index = 0; index < RING_POINTS; index += 1) {
        const point = points[index]
        if (point === undefined) continue
        out.set([point.x, point.y, point.z], index * 3)
      }
      attribute.needsUpdate = true
    }

    dash(preview.arc, held.fall)
    dash(preview.through, held.through)
    loop(preview.ring, held.ring)
    loop(preview.hold, held.hold)
  })

  return <group ref={group} />
}
