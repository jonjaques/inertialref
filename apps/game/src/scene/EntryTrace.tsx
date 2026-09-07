import { useEffect, useMemo, useRef } from 'react'
import { useReducedMotion } from 'motion/react'
import { SpringRope } from '@inertialref/rendering'
import {
  BufferAttribute,
  BufferGeometry,
  type Group,
  LineSegments,
  type InterleavedBufferAttribute,
} from 'three/webgpu'
import { LineSegments2 } from 'three/addons/lines/webgpu/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js'
import { Vec, type Vec3 } from '@inertialref/spatial'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createEntryTraceMaterials } from '../render/entryTrace.ts'
import { useTimedFrame } from './useTimedFrame.ts'

const SAMPLES = 48
const RING_SEGMENTS = 48
const DASH_SEGMENTS = Math.floor((SAMPLES - 1) / 2)
const HEAD_SEGMENTS = 12
const FIGURE_SEGMENTS = HEAD_SEGMENTS + 5

/** The aid uses the body's placement, so compression cannot bury its ground ring. */
export function EntryTrace({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const rope = useMemo(() => new SpringRope(), [])
  const reducedMotion = useReducedMotion()
  const materials = useMemo(() => createEntryTraceMaterials(), [])
  const parts = useMemo(() => {
    const wide = (count: number, material: typeof materials.ring) =>
      new LineSegments2(
        new LineSegmentsGeometry().setPositions(new Float32Array(count * 6)),
        material,
      )
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array(DASH_SEGMENTS * 6), 3),
    )
    const ring = wide(RING_SEGMENTS, materials.ring)
    const outline = new LineSegments2(ring.geometry, materials.outline)
    const all = {
      fall: wide(32, materials.fall),
      through: new LineSegments(geometry, materials.through),
      outline,
      ring,
      hold: wide(RING_SEGMENTS, materials.hold),
      figure: wide(FIGURE_SEGMENTS, materials.figure),
    }
    Object.values(all).forEach((part, index) => {
      part.frustumCulled = false
      part.renderOrder = index + 1
    })
    return all
  }, [materials])

  useEffect(() => {
    const parent = group.current
    if (parent === null) return
    const children = Object.values(parts)
    parent.add(...children)
    return () => {
      parent.remove(...children)
      for (const geometry of new Set(children.map((part) => part.geometry)))
        geometry.dispose()
      for (const material of Object.values(materials)) material.dispose()
      rope.reset()
    }
  }, [parts, materials, rope])

  useTimedFrame('entryTrace', (_, delta) => {
    const parent = group.current
    if (parent === null) return
    const observatory = engine.harness.observatory
    const aim = observatory.aim
    const scene = engine.scene()
    const address = observatory.target?.address ?? null
    const drawn = scene?.bodies.find((body) => body.address === address)
    if (aim === null || drawn === undefined || scene === null) {
      parent.visible = false
      rope.reset()
      return
    }
    parent.visible = true
    const { placement, orientation } = drawn
    parent.position.set(
      placement.position.x,
      placement.position.y,
      placement.position.z,
    )
    parent.quaternion.set(
      orientation.x,
      orientation.y,
      orientation.z,
      orientation.w,
    )
    parent.scale.setScalar(placement.scale)

    const preview = observatory.entryArcPreview(undefined, aim, SAMPLES)
    if (preview === null) {
      parent.visible = false
      return
    }

    const write = (target: LineSegments2, pairs: readonly Vec3[]): void => {
      const attribute = target.geometry.getAttribute(
        'instanceStart',
      ) as InterleavedBufferAttribute
      const out = attribute.data.array as Float32Array
      pairs.forEach((point, index) =>
        out.set([point.x, point.y, point.z], index * 3),
      )
      attribute.data.needsUpdate = true
    }
    const segments = (points: readonly Vec3[], stride: number): Vec3[] => {
      const out: Vec3[] = []
      for (let index = 0; index + 1 < points.length; index += stride)
        out.push(points[index]!, points[index + 1]!)
      return out
    }
    write(
      parts.fall,
      segments(rope.step(preview.arc, delta, reducedMotion === true), 1),
    )
    write(parts.ring, segments(preview.ring, 1))
    write(parts.hold, segments(preview.hold, 1))
    parts.through.visible = preview.through.length > 0
    const through = parts.through.geometry.getAttribute(
      'position',
    ) as BufferAttribute
    segments(preview.through, 2)
      .slice(0, DASH_SEGMENTS * 2)
      .forEach((point, index) =>
        through.setXYZ(index, point.x, point.y, point.z),
      )
    through.needsUpdate = true

    // The held loop supplies a billboard basis in body-fixed axes. The figure
    // belongs inside it, so its feet, head and scale follow the same frame.
    const right = Vec.sub(preview.hold[0]!, preview.from)
    const up = Vec.sub(preview.hold[RING_SEGMENTS / 4]!, preview.from)
    const at = (x: number, y: number): Vec3 =>
      Vec.add(preview.from, Vec.add(Vec.scale(right, x), Vec.scale(up, y)))
    const figure: Vec3[] = []
    for (let index = 0; index < HEAD_SEGMENTS; index += 1) {
      for (const endpoint of [index, index + 1]) {
        const angle = (endpoint / HEAD_SEGMENTS) * Math.PI * 2
        figure.push(at(Math.cos(angle) * 0.13, 0.47 + Math.sin(angle) * 0.13))
      }
    }
    for (const [x1, y1, x2, y2] of [
      [0, 0.26, 0, -0.12],
      [-0.38, 0.15, 0, 0.22],
      [0, 0.22, 0.38, 0.15],
      [0, -0.12, -0.25, -0.55],
      [0, -0.12, 0.25, -0.55],
    ] as const)
      figure.push(at(x1, y1), at(x2, y2))
    write(parts.figure, figure)
  })

  return <group ref={group} visible={false} />
}
