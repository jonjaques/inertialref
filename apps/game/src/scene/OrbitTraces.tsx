import { useEffect, useMemo, useRef } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  type Group,
  LineSegments,
} from 'three/webgpu'
import { UV, Vec, type Vec3 } from '@inertialref/spatial'
import {
  clipOccludedSegment,
  orbitCurve,
  pixelsPerRadian,
  sceneOccluders,
  tessellateOrbit,
  viewOrbit,
  type OrbitCurve,
} from '@inertialref/rendering'
import type { GameEngine } from '../engine/GameEngine.ts'
import { createOrbitTraceMaterial } from '../render/orbitTrace.ts'
import { useTimedFrame } from './useTimedFrame.ts'

/** Geometry carries directions; physical visibility is resolved before placement. */
const TRACE_SHELL = 1e6

export function OrbitTraces({ engine }: { engine: GameEngine }) {
  const group = useRef<Group>(null)
  const lines = useRef(new Map<string, LineSegments>())
  const curves = useRef(new WeakMap<object, OrbitCurve>())
  const material = useMemo(() => createOrbitTraceMaterial(), [])

  useEffect(() => {
    const held = lines.current
    return () => {
      for (const line of held.values()) {
        line.removeFromParent()
        line.geometry.dispose()
      }
      held.clear()
      material.dispose()
    }
  }, [material])

  useTimedFrame('orbitTraces', ({ size }) => {
    const parent = group.current
    const scene = engine.scene()
    if (parent === null) return
    if (!engine.showOrbits || scene === null) {
      parent.visible = false
      return
    }
    parent.visible = true
    parent.position.copy(scene.camera.position)
    parent.quaternion.copy(scene.camera.orientation)
    const perRadian = pixelsPerRadian(engine.lens, size)
    const occluders = sceneOccluders(scene)
    const live = new Set<string>()
    // A primary's translation is shared by every satellite trace.
    const shifts = new Map<string, Vec3>()
    for (const path of engine.orbits) {
      if (path.points.length < 9) continue
      live.add(path.address)
      let curve = curves.current.get(path.points)
      if (curve === undefined) {
        curve = orbitCurve(path.points)
        curves.current.set(path.points, curve)
      }
      let line = lines.current.get(path.address)
      if (line === undefined) {
        const geometry = new BufferGeometry()
        geometry.setAttribute(
          'position',
          new BufferAttribute(new Float32Array(512 * 6), 3).setUsage(
            DynamicDrawUsage,
          ),
        )
        line = new LineSegments(geometry, material)
        line.frustumCulled = false
        lines.current.set(path.address, line)
        parent.add(line)
      }
      let shift = shifts.get(path.parent)
      if (shift === undefined) {
        // The anchor belongs to the path's sampling instant, while this pose
        // must match the snapshot being drawn, including a held photograph.
        shift = engine.world.frames.has(path.parent)
          ? UV.difference(
              engine.world.frames.pose(
                path.parent,
                engine.snapshot?.renderTime ?? engine.world.clock.renderTime,
              ).position,
              path.anchor,
            )
          : Vec.ZERO
        shifts.set(path.parent, shift)
      }
      let attribute = line.geometry.getAttribute('position') as BufferAttribute
      let buffer = attribute.array as Float32Array
      let count = 0
      const emit = (a: Vec3, b: Vec3): void => {
        if (count + 6 > buffer.length) {
          const grown = new Float32Array(buffer.length * 2)
          grown.set(buffer)
          buffer = grown
        }
        for (const p of [a, b]) {
          const factor = TRACE_SHELL / Math.hypot(p.x, p.y, p.z)
          buffer[count++] = p.x * factor
          buffer[count++] = p.y * factor
          buffer[count++] = p.z * factor
        }
      }
      tessellateOrbit(viewOrbit(curve, shift, scene), perRadian, size, (a, b) =>
        clipOccludedSegment(a, b, occluders, emit),
      )
      if (buffer !== attribute.array) {
        // Replacing a GPU-backed attribute alone leaves its old allocation
        // alive. This line owns its geometry and shares no index buffer.
        line.geometry.dispose()
        attribute = new BufferAttribute(buffer, 3).setUsage(DynamicDrawUsage)
        line.geometry.setAttribute('position', attribute)
      }
      line.geometry.setDrawRange(0, count / 3)
      attribute.clearUpdateRanges()
      if (count > 0) {
        attribute.addUpdateRange(0, count)
        attribute.needsUpdate = true
      }
    }
    for (const [address, line] of lines.current) {
      if (live.has(address)) continue
      parent.remove(line)
      line.geometry.dispose()
      lines.current.delete(address)
    }
  })
  return <group ref={group} />
}
