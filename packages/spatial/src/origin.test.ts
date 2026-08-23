import { describe, expect, it } from 'vitest'
import { AU, LIGHT_YEAR } from '@inertialref/shared'
import {
  createRenderOrigin,
  fromRenderSpace,
  maintainOrigin,
  needsRebase,
  REBASE_SNAP,
  REBASE_THRESHOLD,
  rebase,
  toRenderSpace,
} from './origin.ts'
import * as Q from './quat.ts'
import * as UV from './universeVector.ts'
import * as V from './vec3.ts'
import { vec3 } from './vec3.ts'

const START = UV.fromMeters(4.2 * LIGHT_YEAR, 0, 0)

describe('floating origin', () => {
  it('round-trips render space', () => {
    const origin = createRenderOrigin(START)
    const point = UV.translate(START, vec3(123.5, -40, 9))
    const render = toRenderSpace(origin, point)
    expect(render.x).toBeCloseTo(123.5, 6)
    expect(UV.distance(fromRenderSpace(origin, render), point)).toBeLessThan(
      UV.POSITION_RESOLUTION * 2,
    )
  })

  it('does not move canonical entities when the origin moves', () => {
    const entity = UV.translate(START, vec3(3000, 0, 0))
    let origin = createRenderOrigin(START)
    const before = toRenderSpace(origin, entity)

    const camera = UV.translate(START, vec3(9000, 2500, -700))
    origin = rebase(origin, camera)

    const after = toRenderSpace(origin, entity)
    // The render coordinate moved by exactly the origin shift...
    expect(V.distance(before, after)).toBeGreaterThan(1000)
    // ...and the canonical position it decodes back to is unchanged.
    expect(UV.equals(fromRenderSpace(origin, after), entity)).toBe(true)
    expect(origin.generation).toBe(1)
  })

  it('accumulates no error over ten thousand rebases', () => {
    // The reason the snap grid is a power of two: every shift is exactly
    // representable, so a long flight is not a long sequence of roundings.
    let origin = createRenderOrigin(START)
    let camera = START
    const step = vec3(REBASE_THRESHOLD + 1, 0, 0)
    for (let i = 0; i < 10_000; i += 1) {
      camera = UV.translate(camera, step)
      origin = maintainOrigin(origin, camera)
    }
    // Not one rebase per step: the snap leaves a small residual, so some steps
    // land back inside the threshold. That is the intended hysteresis.
    expect(origin.generation).toBeGreaterThan(7_000)
    expect(origin.generation).toBeLessThanOrEqual(10_000)

    // Exactly on the snap grid, with no drift relative to a single computed jump.
    const travelled = UV.difference(origin.position, START)
    expect(travelled.x % REBASE_SNAP).toBe(0)
    expect(travelled.y).toBe(0)
    expect(travelled.z).toBe(0)
    expect(
      Math.abs(UV.difference(camera, origin.position).x),
    ).toBeLessThanOrEqual(REBASE_SNAP)
  })

  it('keeps render coordinates inside float32 comfort while flying', () => {
    let origin = createRenderOrigin(START)
    let camera = START
    let worstError = 0
    for (let i = 0; i < 500; i += 1) {
      camera = UV.translate(camera, vec3(137.7, -19.3, 44.1))
      origin = maintainOrigin(origin, camera)
      const render = toRenderSpace(origin, camera)
      expect(V.length(render)).toBeLessThan(REBASE_THRESHOLD * 2)
      // What the GPU will actually store must still be sub-millimeter.
      const rounded = V.toFloat32(render)
      worstError = Math.max(worstError, V.distance(render, rounded))
    }
    expect(worstError).toBeLessThan(1e-3)
  })

  it('only rebases when the camera has actually drifted', () => {
    const origin = createRenderOrigin(START)
    const near = UV.translate(START, vec3(10, 10, 10))
    expect(needsRebase(origin, near)).toBe(false)
    expect(maintainOrigin(origin, near)).toBe(origin)
    expect(
      needsRebase(
        origin,
        UV.translate(START, vec3(REBASE_THRESHOLD + 1, 0, 0)),
      ),
    ).toBe(true)
  })

  it('renders an interplanetary separation without losing the near field', () => {
    // Camera at the planet, star 1 AU away: the star's render coordinate is
    // huge but the meter-scale objects beside the camera are still exact.
    const origin = createRenderOrigin(START)
    const star = UV.translate(START, vec3(AU, 0, 0))
    const bolt = UV.translate(START, vec3(0.0254, 0, 0))
    expect(toRenderSpace(origin, star).x).toBeCloseTo(AU, 0)
    expect(Math.abs(toRenderSpace(origin, bolt).x - 0.0254)).toBeLessThan(
      UV.POSITION_RESOLUTION,
    )
  })

  it('re-anchors axes without moving the origin point', () => {
    const rotated = Q.fromAxisAngle(vec3(0, 1, 0), Math.PI / 3)
    const origin = createRenderOrigin(START, rotated)
    const point = UV.translate(START, vec3(100, 0, 0))
    const render = toRenderSpace(origin, point)
    // Rotated 60 degrees about +Y: x' = x cos - z sin.
    expect(render.x).toBeCloseTo(100 * Math.cos(-Math.PI / 3), 6)
    expect(UV.distance(fromRenderSpace(origin, render), point)).toBeLessThan(
      1e-6,
    )
  })
})
