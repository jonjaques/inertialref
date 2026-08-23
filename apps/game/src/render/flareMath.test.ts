import { describe, expect, it } from 'vitest'
import { edgeFade, ghostPosition, sunVisibility } from './flareMath.ts'

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
