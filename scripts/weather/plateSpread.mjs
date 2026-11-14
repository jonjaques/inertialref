/*
 * How much a plate shows: the number the capture writes beside each plate so
 * a blank one is known when it is taken (ruling 015).
 *
 * The first look round's E1 deck plate was a featureless gray, RGB 174 to
 * 205, and the same bytes stood in every record of the round with nothing in
 * the capture noticing. A plate's spread is the range of its luma between
 * the 1st and 99th percentiles. It is recorded, and judges nothing: the rule
 * that would set a floor under it, `sqrt(b · g)` where the least other
 * plate `g` is at least twice the blank one `b`, found `g` at 1.55 `b` on
 * round one, and chose none.
 */
import { decode } from '../castSteps.mjs'

/** Rec. 709's luma weights, in ten-thousandths, so a pixel's luma is exact. */
const WEIGHTS = [2126, 7152, 722]
const SCALE = 10_000

/**
 * The luma value at a share `p` of a plate's pixels, nearest rank: the least
 * value at least `ceil(p · n)` pixels sit at or under. Exact on the integer
 * luma, never interpolated, so a flat plate reads zero whatever its size.
 */
function rankOf(histogram, n, p) {
  const rank = Math.max(1, Math.ceil(p * n))
  let seen = 0
  for (let value = 0; value < histogram.length; value += 1) {
    seen += histogram[value]
    if (seen >= rank) return value
  }
  return histogram.length - 1
}

/**
 * The 1st to 99th percentile range of a plate's Rec. 709 luma, in 8-bit
 * code values, over every pixel. On the encoded values, as `castSteps.mjs`
 * weighs its frames: the question is what a viewer of the PNG sees. The
 * tails are cut because a plate of one gray with a sun's disc or a star on
 * it is still blank, and a 0-to-100 range would read the disc.
 */
export function lumaSpread(pixels, channels = 3) {
  const n = Math.floor(pixels.length / channels)
  if (n === 0) return null
  const histogram = new Uint32Array(255 * SCALE + 1)
  for (let at = 0; at < n * channels; at += channels)
    histogram[
      WEIGHTS[0] * pixels[at] +
        WEIGHTS[1] * pixels[at + 1] +
        WEIGHTS[2] * pixels[at + 2]
    ] += 1
  return (rankOf(histogram, n, 0.99) - rankOf(histogram, n, 0.01)) / SCALE
}

/** A plate file's spread, decoded as the step detector decodes a frame. */
export async function plateSpread(file) {
  const { pixels, channels } = await decode(file)
  return lumaSpread(pixels, channels)
}
