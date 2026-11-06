import { describe, expect, it } from 'vitest'
import {
  edgeFade,
  ghostCover,
  ghostPosition,
  sunVisibility,
} from './flareMath.ts'

const SUN = { x: 1e9, y: 0, z: 0 }
const CAMERA = { x: 0, y: 0, z: 0 }

describe('sunVisibility', () => {
  it('is full in an empty sky and zero behind a body', () => {
    expect(sunVisibility(CAMERA, SUN, []).visibility).toBe(1)
    const planet = { position: { x: 1e6, y: 0, z: 0 }, radius: 1e5 }
    expect(sunVisibility(CAMERA, SUN, [planet]).visibility).toBe(0)
  })

  it('ramps across the limb instead of stepping', () => {
    // Slide the body sideways so the sight line crosses its limb. The ramp is
    // the sunset: each ratio inside the band must sit strictly between its
    // neighbors, which a step function fails.
    const radius = 1e5
    const at = (offset: number) =>
      sunVisibility(CAMERA, SUN, [
        { position: { x: 1e6, y: offset, z: 0 }, radius },
      ]).visibility
    const inside = at(radius * 0.9)
    const limb = at(radius * 1.007)
    const outside = at(radius * 1.05)
    expect(inside).toBe(0)
    expect(limb).toBeGreaterThan(0)
    expect(limb).toBeLessThan(1)
    expect(outside).toBe(1)
  })

  it('ignores bodies behind the camera and beyond the star', () => {
    const behind = { position: { x: -1e6, y: 0, z: 0 }, radius: 1e5 }
    const beyond = { position: { x: 2e9, y: 0, z: 0 }, radius: 1e8 }
    const clear = sunVisibility(CAMERA, SUN, [behind, beyond])
    expect(clear.visibility).toBe(1)
    expect(clear.graze).toBe(0)
  })

  it('hides a sun under a standing eye’s horizon and leaves one above it as it was', () => {
    // 1.5 km over Mars's radius the horizon dips 1.7°. The closest-approach
    // ramp alone holds a sun 3° under it at 0.23 — the glare drawn through
    // the ridges that hide it — and one anywhere above it at 0.27, so
    // standing on a body the horizon takes the flare away across the disk's
    // own diameter, and above the horizon the ramp's 0.27 stands.
    const radius = 3.39e6
    const eye = { x: 0, y: radius + 1_500, z: 0 }
    const body = { position: { x: 0, y: 0, z: 0 }, radius }
    const sunAt = (degrees: number) => {
      const e = (degrees * Math.PI) / 180
      return { x: 1e11 * Math.cos(e), y: eye.y + 1e11 * Math.sin(e), z: 0 }
    }
    const at = (degrees: number) =>
      sunVisibility(eye, sunAt(degrees), [body], 0.0047).visibility
    const dip = (-Math.acos(radius / eye.y) * 180) / Math.PI
    expect(dip).toBeCloseTo(-1.7, 1)
    const up = at(60)
    expect(up).toBeCloseTo(0.27, 2)
    expect(at(2)).toBeCloseTo(up, 6)
    expect(at(-3)).toBe(0)
    expect(at(dip + 0.5)).toBeGreaterThan(0.9 * up)
    expect(at(dip + 0.5)).toBeLessThanOrEqual(up)
    expect(at(dip - 0.5)).toBe(0)
    const half = at(dip)
    expect(half).toBeGreaterThan(0.3 * up)
    expect(half).toBeLessThan(0.7 * up)
    expect(at(dip - 0.15)).toBeLessThan(half)
    expect(at(dip + 0.15)).toBeGreaterThan(half)
  })

  it('reports a graze that peaks at the limb and dies away from it', () => {
    const radius = 1e5
    const at = (offset: number) =>
      sunVisibility(CAMERA, SUN, [
        { position: { x: 1e6, y: offset, z: 0 }, radius },
      ]).graze
    expect(at(radius * 1.001)).toBeGreaterThan(0.9)
    expect(at(radius * 1.15)).toBeGreaterThan(0)
    expect(at(radius * 1.15)).toBeLessThan(at(radius * 1.02))
    expect(at(radius * 1.4)).toBe(0)
  })
})

describe('ghostPosition', () => {
  it('walks the sun–center axis: on the sun at 0, center at 1, mirrored past', () => {
    expect(ghostPosition(0.6, -0.4, 0)).toEqual({ x: 0.6, y: -0.4 })
    expect(ghostPosition(0.6, -0.4, 1)).toEqual({ x: 0, y: -0 })
    const mirrored = ghostPosition(0.6, -0.4, 2)
    expect(mirrored.x).toBeCloseTo(-0.6, 12)
    expect(mirrored.y).toBeCloseTo(0.4, 12)
  })
})

describe('edgeFade', () => {
  it('holds inside the frame and dies past its margin', () => {
    expect(edgeFade(0, 0)).toBe(1)
    expect(edgeFade(1.0, 0.5)).toBe(1)
    expect(edgeFade(1.3, 0)).toBeGreaterThan(0)
    expect(edgeFade(1.3, 0)).toBeLessThan(1)
    expect(edgeFade(1.6, 0)).toBe(0)
  })
})

describe('ghostCover', () => {
  const disk = { x: 0, y: 0, radius: 0.3 }
  const ghost = (x: number) => ({ x, y: 0, radius: 0.1 })

  it('leaves a ghost whole clear of every disk, and removes one centered on a disk', () => {
    expect(ghostCover(ghost(0.9), [disk])).toBe(1)
    expect(ghostCover(ghost(0.4), [disk])).toBe(1)
    expect(ghostCover(ghost(0.1), [disk])).toBe(0)
    expect(ghostCover(ghost(0.3), [disk])).toBe(0)
    expect(ghostCover(ghost(0.1), [])).toBe(1)
  })

  it('fades across the overlap rather than stepping', () => {
    // The gap between the ghost's center and the limb, in ghost radii: a
    // ghost half over the limb sits strictly between its neighbors.
    const half = ghostCover(ghost(0.35), [disk])
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(1)
    expect(ghostCover(ghost(0.33), [disk])).toBeLessThan(half)
    expect(ghostCover(ghost(0.38), [disk])).toBeGreaterThan(half)
  })

  it('leaves a ghost over a dot much smaller than itself nearly whole', () => {
    // A moon a hundredth of the ghost's radius, dead under its center.
    const dot = { x: 0.5, y: 0, radius: 0.001 }
    expect(ghostCover(ghost(0.5), [dot])).toBeGreaterThan(0.99)
    // And the weight grows with the disk, so a disk half the ghost's size
    // takes part of it and one its own size takes the whole.
    const half = ghostCover(ghost(0.5), [{ ...dot, radius: 0.05 }])
    expect(half).toBeGreaterThan(0)
    expect(half).toBeLessThan(1)
    expect(ghostCover(ghost(0.5), [{ ...dot, radius: 0.1 }])).toBe(0)
  })

  it('compounds over several disks', () => {
    const other = { x: 0.7, y: 0, radius: 0.3 }
    const between = ghost(0.35)
    expect(ghostCover(between, [disk, other])).toBeCloseTo(
      ghostCover(between, [disk]) * ghostCover(between, [other]),
      12,
    )
  })
})
