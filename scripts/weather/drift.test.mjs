import { describe, expect, it } from 'vitest'
import { checkDrift, cloudMask, DRIFT, register, turnShift } from './drift.mjs'

/*
 * A held camera over a field of soft blobs: the ground is the left third,
 * still, and the clouds are the rest, moved by the field's own shift between
 * the first frame and the last. Reduced frames, as the design reads them.
 */

const WIDTH = 160
const HEIGHT = 120

/** Fourteen soft blobs at fixed places, a cloud field's luminance at (x, y). */
const BLOBS = Array.from({ length: 14 }, (_, i) => ({
  x: 20 + ((i * 53) % 140),
  y: 10 + ((i * 37) % 100),
  r: 6 + (i % 5) * 2,
  lift: 40 + (i % 3) * 30,
}))
const field = (x, y) =>
  90 +
  BLOBS.reduce(
    (sum, blob) =>
      sum +
      blob.lift *
        Math.exp(-((x - blob.x) ** 2 + (y - blob.y) ** 2) / (2 * blob.r ** 2)),
    0,
  )

/** The ground: a still texture of its own. */
const ground = (x, y) => 60 + 20 * Math.sin(x * 0.7) * Math.cos(y * 0.5)

const GROUND = WIDTH / 3

/** A frame with the clouds moved by (dx, dy) and the ground where it stands. */
const frame = (dx, dy) =>
  Float64Array.from({ length: WIDTH * HEIGHT }, (_, i) => {
    const x = i % WIDTH
    const y = Math.floor(i / WIDTH)
    return x < GROUND ? ground(x, y) : field(x - dx, y - dy)
  })

const control = Float64Array.from({ length: WIDTH * HEIGHT }, (_, i) => {
  const x = i % WIDTH
  const y = Math.floor(i / WIDTH)
  return x < GROUND ? ground(x, y) : 90
})

describe('the field’s displacement', () => {
  const first = frame(0, 0)
  const mask = cloudMask(first, control)

  it('finds a shifted field’s shift to a fraction of a pixel', () => {
    const shift = register(first, frame(11.4, -6.3), mask, WIDTH, HEIGHT, 32)
    expect(shift.dx).toBeCloseTo(11.4, 0)
    expect(shift.dy).toBeCloseTo(-6.3, 0)
    expect(Math.abs(shift.dx - 11.4)).toBeLessThan(0.3)
    expect(Math.abs(shift.dy + 6.3)).toBeLessThan(0.3)
  })

  it('reads the clouds and not the still ground under them', () => {
    expect(mask.slice(0, GROUND).every((one) => one === 0)).toBe(true)
    const whole = new Float64Array(mask.length).fill(1)
    // Over every pixel the still third pulls the answer toward zero.
    const unmasked = register(
      first,
      frame(11.4, -6.3),
      whole,
      WIDTH,
      HEIGHT,
      32,
    )
    const masked = register(first, frame(11.4, -6.3), mask, WIDTH, HEIGHT, 32)
    expect(Math.hypot(masked.dx - 11.4, masked.dy + 6.3)).toBeLessThan(
      Math.hypot(unmasked.dx - 11.4, unmasked.dy + 6.3) + 0.3,
    )
  })

  it('holds a shifted field to the turn within 10%', () => {
    const shift = register(first, frame(11.4, -6.3), mask, WIDTH, HEIGHT, 32)
    expect(checkDrift(shift, { dx: 11.4, dy: -6.3 }).holds).toBe(true)
  })

  it('fails a frozen field: it measures zero', () => {
    const shift = register(first, frame(0, 0), mask, WIDTH, HEIGHT, 32)
    expect(Math.hypot(shift.dx, shift.dy)).toBeLessThan(0.1)
    const verdict = checkDrift(shift, { dx: 11.4, dy: -6.3 })
    expect(verdict.holds).toBe(false)
    expect(verdict.ratio).toBeLessThan(0.1)
  })

  it('fails a field that moves the wrong way, or too far', () => {
    const backward = register(first, frame(-11.4, 6.3), mask, WIDTH, HEIGHT, 32)
    expect(checkDrift(backward, { dx: 11.4, dy: -6.3 })).toMatchObject({
      holds: false,
    })
    expect(checkDrift(backward, { dx: 11.4, dy: -6.3 }).angle).toBeGreaterThan(
      170,
    )
    expect(checkDrift({ dx: 13, dy: -7.2 }, { dx: 11.4, dy: -6.3 }).holds).toBe(
      false,
    )
  })

  it('takes 10% in direction as the angle a tenth’s perpendicular error makes', () => {
    const turned = (degrees) => {
      const a = (degrees * Math.PI) / 180
      return { dx: 10 * Math.cos(a), dy: 10 * Math.sin(a) }
    }
    expect(checkDrift(turned(5.5), { dx: 10, dy: 0 }).holds).toBe(true)
    expect(checkDrift(turned(6), { dx: 10, dy: 0 }).holds).toBe(false)
  })
})

describe('the turn in pixels', () => {
  it('is ω·a·cos φ·Δt over the range through the lens: the rubric’s 4 km and 45 px', () => {
    // The rubric's derivation for E1's 100× cast: 4 km over the cast, 45 of
    // the frame's pixels, which is a range of 88.9 km through a 1,000 px lens.
    const shift = turnShift({
      omega: 1e-4,
      radius: 6.4e6,
      latitude: 60,
      seconds: 12.5,
      range: 4000 / 0.045,
      focal: 1000,
      heading: 0,
    })
    expect(shift.meters).toBeCloseTo(4000, 6)
    expect(shift.dx).toBeCloseTo(45, 6)
    expect(shift.dy).toBeCloseTo(0, 6)
  })

  it('turns east up the frame at a heading of 90°', () => {
    const shift = turnShift({
      omega: 1e-4,
      radius: 6.4e6,
      latitude: 0,
      seconds: 1,
      range: 640,
      focal: 100,
      heading: 90,
    })
    expect(shift.dx).toBeCloseTo(0, 6)
    expect(shift.dy).toBeCloseTo(-100, 6)
  })

  it('searches the design’s ±64 pixels on frames reduced by two', () => {
    expect(DRIFT).toMatchObject({ radius: 64, reduce: 2, tolerance: 0.1 })
  })
})
