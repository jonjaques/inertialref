import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { lumaSpread, plateSpread } from './plateSpread.mjs'

/** A plate of `width × height` RGB pixels, each from `rgb(x, y)`. */
function plate(width, height, rgb) {
  const pixels = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      pixels.set(rgb(x, y), (y * width + x) * 3)
  return pixels
}

/*
 * The first look round, wherever a checkout of this clone holds it: the
 * orchestrator's worktree took it, and `capture.mjs`'s shared `.data/` does
 * not hold it. `IR_LOOK_ROUND` names another. Absent on CI, which has no
 * `.data/`, and then the plate's test is skipped for that reason alone.
 */
function roundOne() {
  if (process.env.IR_LOOK_ROUND !== undefined) return process.env.IR_LOOK_ROUND
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  })
  return (
    list
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => path.join(line.slice(9), '.data/weather/look/round-1'))
      .find((dir) => existsSync(dir)) ?? null
  )
}
const ROUND = roundOne()
const BLANK =
  ROUND === null
    ? null
    : path.join(ROUND, 'before/weather-e1-cumulus-orbit-deck.png')

describe('a plate’s luma spread', () => {
  it('reads a flat plate as zero', () => {
    expect(lumaSpread(plate(64, 48, () => [180, 182, 190]))).toBe(0)
  })

  it('reads a gray ramp as its 1st to 99th percentile range, by nearest rank', () => {
    // Columns 0 to 255 four rows deep: 1,024 pixels, so the 1st percentile
    // is the 11th pixel, gray 2, and the 99th the 1,014th, gray 253.
    expect(lumaSpread(plate(256, 4, (x) => [x, x, x]))).toBe(251)
  })

  it('weighs the channels by Rec. 709 on the encoded values', () => {
    // Half pure red, half pure green: the 1st percentile is red's luma,
    // 0.2126 · 255, and the 99th green's, 0.7152 · 255.
    const spread = lumaSpread(
      plate(10, 10, (x) => (x < 5 ? [255, 0, 0] : [0, 255, 0])),
    )
    expect(spread).toBeCloseTo((0.7152 - 0.2126) * 255, 10)
  })

  it('cuts a disc under 1% of the plate from the range', () => {
    // A sun on a gray sky is still a gray sky: 99 white pixels in 10,000.
    const sky = plate(100, 100, (x, y) =>
      y * 100 + x < 99 ? [255, 255, 255] : [120, 120, 120],
    )
    expect(lumaSpread(sky)).toBe(0)
  })

  it('reads an alpha channel as nothing', () => {
    const rgba = new Uint8Array(4 * 256)
    for (let x = 0; x < 256; x += 1) rgba.set([x, x, x, 255 - x], 4 * x)
    expect(lumaSpread(rgba, 4)).toBe(
      lumaSpread(plate(256, 1, (x) => [x, x, x])),
    )
  })

  it('is the same for any order of the pixels and any shift of gray inside the range', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 200 }), {
          minLength: 3,
          maxLength: 600,
        }),
        fc.integer({ min: 0, max: 55 }),
        fc.integer(),
        (grays, shift, seed) => {
          const flat = (values) =>
            Uint8Array.from(values.flatMap((g) => [g, g, g]))
          // A deterministic shuffle by the seed.
          const order = grays.map((g, i) => [
            ((seed ^ (i * 2654435761)) >>> 0) % 9973,
            g,
          ])
          order.sort((a, b) => a[0] - b[0])
          const spread = lumaSpread(flat(grays))
          expect(lumaSpread(flat(order.map(([, g]) => g)))).toBe(spread)
          expect(lumaSpread(flat(grays.map((g) => g + shift)))).toBe(spread)
        },
      ),
    )
  })

  it('reads nothing of an empty plate', () => {
    expect(lumaSpread(new Uint8Array(0))).toBeNull()
  })

  /*
   * Ruling 015's blank plate, round one's E1 deck: 2880 × 1800, RGB 174 to
   * 205, the same bytes in the round's `before/`, `candidate/` and
   * `experiment/`. 19.9278 is this module's figure for it on the Mac mini
   * (Mac18,5, Apple M6). The decode is about 0.2 s here.
   */
  it.skipIf(BLANK === null || !existsSync(BLANK))(
    'reads round one’s blank E1 deck plate at 19.9 code values',
    async () => {
      expect(await plateSpread(BLANK)).toBeCloseTo(19.9278, 4)
    },
  )
})
