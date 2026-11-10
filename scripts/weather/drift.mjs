#!/usr/bin/env node
/**
 * How far the drawn field moved over a cast, against the CPU turn (C7).
 *
 *   node scripts/weather/drift.mjs <cast dir> --expect <dx,dy>
 *     [--control <clouds-off frame>] [--first <i>] [--last <j>]
 *   node scripts/weather/drift.mjs <cast dir> --omega <rad/s> --radius <m>
 *     --latitude <deg> --seconds <s> --range <m> --focal <px> --heading <deg>
 *
 * The clock runs and the field has to move with it, by the right amount: a
 * frozen clock draws a picture that steps nowhere and strobes nowhere, so
 * neither the step detector nor `frameDiff` can fail it. So the field's
 * displacement between a held camera's first frame and its last is measured
 * (phase 1 design §8.1): the shift that best registers the two frames'
 * luminance over the cloud pixels, searched to ±64 pixels on frames reduced
 * by two, and held against the level's turn `ω·a·cos φ·Δt` through the lens.
 *
 * **Cloud pixels only.** The camera is held on the surface, so the ground
 * does not move in the frame, and a registration over the whole frame finds
 * the ground's zero. The cloud pixels are where the frame differs from the
 * clouds-off control of the same pose by more than the presets' 3% level.
 */

import path from 'node:path'
import { parseArgs } from 'node:util'
import { decode, lumaPlane, readCast } from '../castSteps.mjs'

/**
 * The measure's numbers. `radius` and the reduction are the design's;
 * `tolerance` is the rubric's 10% (proposed there); `cloud` is the presets'
 * per-pixel level (`scripts/presets/compare.mjs`); `overlap` is provisional,
 * the share of the cloud pixels a shift must keep in frame to be scored.
 */
export const DRIFT = Object.freeze({
  radius: 64,
  reduce: 2,
  tolerance: 0.1,
  cloud: 0.03 * 255,
  overlap: 0.25,
})

/** Reduce a plane, or a mask, by `factor` on each side, by the box mean. */
export function shrink(plane, width, height, factor) {
  const w = Math.floor(width / factor)
  const h = Math.floor(height / factor)
  const out = new Float64Array(w * h)
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      let sum = 0
      for (let v = 0; v < factor; v += 1)
        for (let u = 0; u < factor; u += 1)
          sum += plane[(y * factor + v) * width + x * factor + u]
      out[y * w + x] = sum / (factor * factor)
    }
  return { plane: out, width: w, height: h }
}

/**
 * The mean squared difference of `a` and `b` displaced by `(dx, dy)`, over
 * the pixels that are cloud at both ends of the shift, or null where too few
 * stay in frame. Both ends, because a cloud pixel compared with the ground
 * beside the mask's edge costs more on one side of the true shift than the
 * other, and the parabola through the three then leans: with the mask taken
 * at one end alone, the test's frozen field reads a third of a pixel off zero.
 */
function cost(a, b, mask, width, height, dx, dy, least) {
  let sum = 0
  let n = 0
  for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y += 1)
    for (let x = Math.max(0, -dx); x < Math.min(width, width - dx); x += 1) {
      const i = y * width + x
      const j = i + dy * width + dx
      if (mask[i] < 0.5 || mask[j] < 0.5) continue
      const d = a[i] - b[j]
      sum += d * d
      n += 1
    }
  return n >= least ? sum / n : null
}

/** The best integer shift in a square, around a center. */
function search(a, b, mask, width, height, center, reach, least) {
  let best = { dx: center.dx, dy: center.dy, cost: Infinity }
  for (let dy = center.dy - reach; dy <= center.dy + reach; dy += 1)
    for (let dx = center.dx - reach; dx <= center.dx + reach; dx += 1) {
      const c = cost(a, b, mask, width, height, dx, dy, least)
      if (c !== null && c < best.cost) best = { dx, dy, cost: c }
    }
  return best
}

/** The vertex of the parabola through three costs, as an offset in (−½, ½). */
const vertex = (left, middle, right) => {
  if (left === null || right === null) return 0
  const curve = left - 2 * middle + right
  return curve > 0
    ? Math.max(-0.5, Math.min(0.5, (left - right) / (2 * curve)))
    : 0
}

/**
 * The shift that carries `a`'s masked pixels onto `b`, in `a`'s pixels:
 * `b(x + shift) ≈ a(x)`. Coarse to fine, because the whole square at ±64 is
 * 16,641 shifts over every pixel: first on planes reduced four times more at
 * a sixteenth of the reach, then a few pixels around it at full size, then
 * the parabola through the neighbors for the fraction.
 */
export function register(a, b, mask, width, height, reach = DRIFT.radius) {
  const total = mask.reduce((sum, one) => sum + (one >= 0.5 ? 1 : 0), 0)
  if (total === 0) return null
  const coarse = 4
  const sa = shrink(a, width, height, coarse)
  const sb = shrink(b, width, height, coarse)
  const sm = shrink(mask, width, height, coarse)
  const smTotal = sm.plane.reduce((sum, one) => sum + (one >= 0.5 ? 1 : 0), 0)
  const rough = search(
    sa.plane,
    sb.plane,
    sm.plane,
    sa.width,
    sa.height,
    { dx: 0, dy: 0 },
    Math.ceil(reach / coarse),
    Math.max(1, DRIFT.overlap * smTotal),
  )
  const least = Math.max(1, DRIFT.overlap * total)
  const fine = search(
    a,
    b,
    mask,
    width,
    height,
    { dx: rough.dx * coarse, dy: rough.dy * coarse },
    coarse,
    least,
  )
  if (!Number.isFinite(fine.cost)) return null
  const at = (dx, dy) => cost(a, b, mask, width, height, dx, dy, least)
  return {
    dx:
      fine.dx +
      vertex(at(fine.dx - 1, fine.dy), fine.cost, at(fine.dx + 1, fine.dy)),
    dy:
      fine.dy +
      vertex(at(fine.dx, fine.dy - 1), fine.cost, at(fine.dx, fine.dy + 1)),
    cost: fine.cost,
  }
}

/** Cloud pixels: where the frame differs from its clouds-off control. */
export function cloudMask(frame, control) {
  const mask = new Float64Array(frame.length)
  for (let i = 0; i < frame.length; i += 1)
    mask[i] = Math.abs(frame[i] - control[i]) > DRIFT.cloud ? 1 : 0
  return mask
}

/**
 * The CPU turn's displacement in the frame's pixels. The level turns
 * eastward by `ω·a·cos φ·Δt` meters; seen from `range` meters through a
 * lens of `focal` pixels, that is meters over range times focal. The screen
 * direction is a camera looking straight down with `heading` (degrees east
 * of north) at the frame's top: east is to the right at heading 0 and up at
 * 90°. A stance that looks obliquely passes `--expect` instead, from its own
 * projection.
 */
export function turnShift({
  omega,
  radius,
  latitude,
  seconds,
  range,
  focal,
  heading,
}) {
  const meters = omega * radius * Math.cos((latitude * Math.PI) / 180) * seconds
  const pixels = (meters / range) * focal
  const h = (heading * Math.PI) / 180
  return { dx: pixels * Math.cos(h), dy: -pixels * Math.sin(h), meters }
}

/**
 * C7's comparison: the measured shift against the turn's, within 10% in
 * size and in direction. The direction's 10% is the angle a perpendicular
 * error of a tenth of the size makes, 5.7°. A frozen field measures zero
 * and fails on size; one that moves the wrong way fails on direction.
 */
export function checkDrift(measured, expected, tolerance = DRIFT.tolerance) {
  const size = Math.hypot(expected.dx, expected.dy)
  const got = Math.hypot(measured.dx, measured.dy)
  const ratio = size > 0 ? got / size : null
  const angle =
    got > 0 && size > 0
      ? Math.abs(
          Math.atan2(
            measured.dx * expected.dy - measured.dy * expected.dx,
            measured.dx * expected.dx + measured.dy * expected.dy,
          ),
        )
      : null
  const limit = Math.atan(tolerance)
  return {
    measured: { dx: measured.dx, dy: measured.dy, size: got },
    expected: { dx: expected.dx, dy: expected.dy, size },
    ratio,
    angle: angle === null ? null : (angle * 180) / Math.PI,
    holds:
      ratio !== null &&
      Math.abs(ratio - 1) <= tolerance &&
      angle !== null &&
      angle <= limit,
  }
}

/** A frame as a luma plane, reduced by two as the design reads it. */
async function planeOf(file) {
  const { pixels, width, height, channels } = await decode(file)
  const full = lumaPlane(pixels, width, height, channels)
  return shrink(full, width, height, DRIFT.reduce)
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      expect: { type: 'string' },
      control: { type: 'string' },
      first: { type: 'string' },
      last: { type: 'string' },
      omega: { type: 'string' },
      radius: { type: 'string' },
      latitude: { type: 'string' },
      seconds: { type: 'string' },
      range: { type: 'string' },
      focal: { type: 'string' },
      heading: { type: 'string', default: '0' },
    },
  })
  const [dir] = positionals
  let expected = null
  if (values.expect !== undefined) {
    const [dx, dy] = values.expect.split(',').map(Number)
    expected = { dx, dy }
  } else if (values.omega !== undefined) {
    const shift = turnShift(
      Object.fromEntries(
        [
          'omega',
          'radius',
          'latitude',
          'seconds',
          'range',
          'focal',
          'heading',
        ].map((key) => [key, Number(values[key])]),
      ),
    )
    // Full-size pixels: the registration's shift is scaled back up to them.
    expected = { dx: shift.dx, dy: shift.dy }
  }
  if (dir === undefined || expected === null) {
    console.error(
      'usage: node scripts/weather/drift.mjs <cast dir> (--expect dx,dy | --omega … --radius … --latitude … --seconds … --range … --focal … --heading …) [--control <frame>] [--first i] [--last j]',
    )
    return 1
  }
  const cast = await readCast(dir)
  const first = cast.frames[Number(values.first ?? 0)]
  const last = cast.frames[Number(values.last ?? cast.frames.length - 1)]
  const a = await planeOf(first)
  const b = await planeOf(last)
  const mask =
    values.control === undefined
      ? new Float64Array(a.plane.length).fill(1)
      : cloudMask(a.plane, (await planeOf(values.control)).plane)
  const shift = register(a.plane, b.plane, mask, a.width, a.height)
  if (shift === null) {
    console.error('no cloud pixels to register: the frame matches its control')
    return 1
  }
  const measured = { dx: shift.dx * DRIFT.reduce, dy: shift.dy * DRIFT.reduce }
  const verdict = checkDrift(measured, expected)
  console.log(
    JSON.stringify(
      {
        cast: dir,
        frames: [path.basename(first), path.basename(last)],
        mask:
          values.control === undefined
            ? 'every pixel: no control given'
            : 'cloud pixels by the control',
        ...verdict,
      },
      null,
      1,
    ),
  )
  return verdict.holds ? 0 : 2
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
