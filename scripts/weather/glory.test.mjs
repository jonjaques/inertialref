import { describe, expect, it } from 'vitest'
import { mieDroplets, radiusOf } from '../../packages/rendering/src/mieTable.ts'
import {
  antisolarPixel,
  bowPeak,
  firstRing,
  focalPixels,
  GLORY,
  profileGlory,
  radialProfile,
  tableRing,
} from './glory.mjs'

/*
 * A synthetic plate: a deck of gray with a glory drawn about a known pixel,
 * red's share rising to a ring at 2.5° past a trough at 1.5°, and the ring
 * brighter than the trough by a known ratio.
 */

const WIDTH = 240
const HEIGHT = 180
const FOCAL = focalPixels(HEIGHT, 20)
const DEG = Math.PI / 180

/** Degrees between pixel (x, y)'s ray and the ray through `center`. */
const angleAt = (x, y, center) => {
  const ray = (u, v) => [(u - WIDTH / 2) / FOCAL, (HEIGHT / 2 - v) / FOCAL, 1]
  const p = ray(x + 0.5, y + 0.5)
  const c = ray(center.x, center.y)
  const dot = p[0] * c[0] + p[1] * c[1] + p[2] * c[2]
  return (
    Math.acos(Math.min(1, dot / (Math.hypot(...p) * Math.hypot(...c)))) / DEG
  )
}

/** The plate: red's share by angle, with a cosine of period 2° inside 4°. */
const plate = (center) => {
  const pixels = new Uint8Array(WIDTH * HEIGHT * 3)
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const angle = angleAt(x, y, center)
      const wave = angle < 4 ? Math.cos((Math.PI * (angle - 2.5)) / 1) : 0
      const at = (y * WIDTH + x) * 3
      pixels[at] = Math.round(120 + 20 * wave)
      pixels[at + 1] = 120
      pixels[at + 2] = 120
    }
  return { pixels, width: WIDTH, height: HEIGHT, channels: 3 }
}

describe('the glory profiler', () => {
  it('finds the first red ring past the first trough, at the center', () => {
    const center = { x: WIDTH / 2, y: HEIGHT / 2 }
    const image = plate(center)
    const ring = firstRing(
      radialProfile(image.pixels, WIDTH, HEIGHT, 3, { center, focal: FOCAL }),
    )
    expect(ring.trough).toBeCloseTo(1.5, 0)
    expect(Math.abs(ring.angle - 2.5)).toBeLessThanOrEqual(GLORY.bin)
    // Brightness at the ring over the trough: (120·3 + 20)/(120·3 − 20).
    expect(ring.peakOverTrough).toBeGreaterThan(1.08)
    expect(ring.peakOverTrough).toBeLessThan(380 / 340 + 0.01)
  })

  it('reads a ring off the frame’s center by its true angle, not its pixel radius', () => {
    const center = { x: 60, y: 50 }
    const ring = profileGlory(plate(center), {
      center,
      focal: FOCAL,
      radius: null,
    }).ring
    expect(Math.abs(ring.angle - 2.5)).toBeLessThanOrEqual(GLORY.bin)
  })

  it('puts the antisolar point at the center when the sun is straight behind the camera', () => {
    expect(antisolarPixel([0, 0, 1], WIDTH, HEIGHT, FOCAL)).toEqual({
      x: WIDTH / 2,
      y: HEIGHT / 2,
    })
    // The sun up and behind: the antisolar point is below the center.
    const below = antisolarPixel(
      [0, Math.sin(5 * DEG), Math.cos(5 * DEG)],
      WIDTH,
      HEIGHT,
      FOCAL,
    )
    expect(below.y - HEIGHT / 2).toBeCloseTo(FOCAL * Math.tan(5 * DEG), 6)
    expect(antisolarPixel([0, 0, -1], WIDTH, HEIGHT, FOCAL)).toBe(null)
  })

  it('reads the table’s ring at a row’s own radius, and between rows by the row', () => {
    const table = mieDroplets()
    for (const row of [0, 9, 31])
      expect(tableRing(radiusOf(table, row))).toBeCloseTo(
        table.gloryRed[row],
        10,
      )
    const between = tableRing(
      Math.sqrt(radiusOf(table, 9) * radiusOf(table, 10)),
    )
    expect(between).toBeCloseTo(
      (table.gloryRed[9] + table.gloryRed[10]) / 2,
      10,
    )
  })

  it('holds the ring within row 8’s 0.2° of the table’s, two of its bins', () => {
    const center = { x: WIDTH / 2, y: HEIGHT / 2 }
    // The radius whose table ring is nearest the plate's 2.5°.
    const table = mieDroplets()
    const row = table.gloryRed.reduce(
      (best, ring, i) =>
        Math.abs(ring - 2.5) < Math.abs(table.gloryRed[best] - 2.5) ? i : best,
      0,
    )
    const result = profileGlory(plate(center), {
      center,
      focal: FOCAL,
      radius: radiusOf(table, row),
    })
    expect(result.off).toBeCloseTo(result.ring.angle - table.gloryRed[row], 10)
    expect(result.withinRow8).toBe(Math.abs(result.off) <= 0.2)
    expect(GLORY.ring).toBe(2 * GLORY.bin)
  })

  it('finds the brightest bin of the bow’s span', () => {
    const profile = [30.25, 30.75, 31.25, 31.75].map((angle, i) => ({
      angle,
      brightness: [10, 14, 11, 10][i],
    }))
    expect(bowPeak(profile)).toEqual({ angle: 30.75, overMedian: 14 / 11 })
  })
})
