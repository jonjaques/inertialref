#!/usr/bin/env node
/**
 * The glory on a plate: where its first red ring is, against the table's.
 *
 *   node scripts/weather/glory.mjs <plate.png> --radius <µm>
 *     (--center <x,y> | --sun-view <x,y,z>) [--fov <deg> | --record <record.json> --id <still>]
 *
 * G4 looks down on a deck with the sun behind, so the glory sits about the
 * antisolar point (phase 1 design §8.3). From that point's pixel this takes
 * the radial profile of red's share, `R/(R + G + B)`, in 0.1° bins to 10°,
 * and reports the first red maximum past the first interior minimum: the
 * rule the Mie table's own test reads the series by
 * (`packages/rendering/src/mieTable.test.ts`), so the plate and the table are
 * read alike. Beside it: the ring's peak over its trough in brightness,
 * which the angle alone does not pin, and the cloudbow's peak where the frame
 * reaches it. Row 8 of the rubric holds the ring within 0.2° of the table's
 * for the deck top's droplet radius, two of these bins; it gates from phase
 * 2, when G4 is judged, and phase 1 records it.
 *
 * **Where the antisolar point is.** A still's record carries the lens and the
 * sun's elevation and phase angle, which fix how far the point is from the
 * frame's center and not which way. So the point comes from `--center`, or
 * from the sun's direction in the camera's frame, `--sun-view` (x right, y
 * up, the camera looking down −z), until the record carries one of them.
 */

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import {
  mieDroplets,
  radiusIndex,
} from '../../packages/rendering/src/mieTable.ts'
import { decode } from '../castSteps.mjs'

/**
 * The profiler's numbers: the design's bins and reach, and row 8's 0.2°.
 * The cloudbow's span, 30° to 45° at 0.5°, is provisional: the bow's first
 * maximum sits near 40° from the antisolar point for droplets of 5 to 20 µm,
 * and the span is wide enough to hold it at either end.
 */
export const GLORY = Object.freeze({
  bin: 0.1,
  reach: 10,
  ring: 0.2,
  bow: Object.freeze({ from: 30, to: 45, bin: 0.5 }),
})

const DEG = Math.PI / 180

/** The focal length in pixels of a vertical field of view over `height`. */
export const focalPixels = (height, fovDegrees) =>
  height / 2 / Math.tan((fovDegrees * DEG) / 2)

/** The pixel of the antisolar point, from the sun in the camera's frame; null behind the camera. */
export function antisolarPixel(sunView, width, height, focal) {
  const [x, y, z] = sunView.map((one) => -one)
  if (z >= 0) return null
  return { x: width / 2 + (focal * x) / -z, y: height / 2 - (focal * y) / -z }
}

/**
 * A radial profile about a pixel, by each pixel's true angle from the
 * point's direction rather than its distance in pixels, so a ring off the
 * frame's center is not stretched by the projection. Each bin holds the sums
 * of its pixels' channels and their count.
 */
export function radialProfile(
  pixels,
  width,
  height,
  channels,
  { center, focal, from = 0, to = GLORY.reach, bin = GLORY.bin },
) {
  const bins = Math.round((to - from) / bin)
  const sums = Array.from({ length: bins }, () => ({ r: 0, g: 0, b: 0, n: 0 }))
  const ax = (center.x - width / 2) / focal
  const ay = (height / 2 - center.y) / focal
  const al = Math.hypot(ax, ay, 1)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const px = (x + 0.5 - width / 2) / focal
      const py = (height / 2 - y - 0.5) / focal
      const dot = (px * ax + py * ay + 1) / (Math.hypot(px, py, 1) * al)
      const angle = Math.acos(Math.min(1, dot)) / DEG
      const i = Math.floor((angle - from) / bin)
      if (i < 0 || i >= bins) continue
      const at = (y * width + x) * channels
      sums[i].r += pixels[at]
      sums[i].g += pixels[at + 1]
      sums[i].b += pixels[at + 2]
      sums[i].n += 1
    }
  return sums.map((one, i) => ({
    angle: from + (i + 0.5) * bin,
    red: one.n > 0 ? one.r / (one.r + one.g + one.b || 1) : null,
    brightness: one.n > 0 ? (one.r + one.g + one.b) / (3 * one.n) : null,
    pixels: one.n,
  }))
}

/**
 * The first red maximum past the first interior minimum, on the profile's
 * red share smoothed over three bins: a plate's bin holds a few hundred
 * pixels at the center and its noise would otherwise make a minimum of every
 * grain. Null where the profile has no such pair.
 */
export function firstRing(profile) {
  const red = profile.map((one, i) => {
    const near = [profile[i - 1], one, profile[i + 1]]
      .filter((bin) => bin !== undefined && bin.red !== null)
      .map((bin) => bin.red)
    return near.length > 0 ? near.reduce((a, b) => a + b) / near.length : null
  })
  let trough = -1
  for (let i = 1; i + 1 < red.length; i += 1) {
    if (red[i] === null || red[i - 1] === null || red[i + 1] === null) continue
    if (trough < 0 && red[i] < red[i - 1] && red[i] <= red[i + 1]) trough = i
    else if (trough >= 0 && red[i] > red[i - 1] && red[i] >= red[i + 1])
      return {
        angle: profile[i].angle,
        trough: profile[trough].angle,
        peakOverTrough: profile[i].brightness / profile[trough].brightness,
      }
  }
  return null
}

/** The brightest bin of the bow's span, and its brightness over the span's median. */
export function bowPeak(profile) {
  const lit = profile.filter((one) => one.brightness !== null)
  if (lit.length < 3) return null
  const peak = lit.reduce((a, b) => (b.brightness > a.brightness ? b : a))
  const sorted = lit.map((one) => one.brightness).sort((a, b) => a - b)
  return {
    angle: peak.angle,
    overMedian: peak.brightness / sorted[sorted.length >> 1],
  }
}

/** The table's first red ring for a droplet radius, µm, between its rows. */
export function tableRing(radius, table = mieDroplets()) {
  const row = Math.min(table.radii - 1, Math.max(0, radiusIndex(table, radius)))
  const low = Math.floor(row)
  const high = Math.min(table.radii - 1, low + 1)
  const t = row - low
  return table.gloryRed[low] * (1 - t) + table.gloryRed[high] * t
}

/** Profile a plate and hold its ring to the table's. */
export function profileGlory(
  { pixels, width, height, channels },
  { center, focal, radius },
) {
  const profile = radialProfile(pixels, width, height, channels, {
    center,
    focal,
  })
  const ring = firstRing(profile)
  const table = radius === null ? null : tableRing(radius)
  const bow = bowPeak(
    radialProfile(pixels, width, height, channels, {
      center,
      focal,
      ...GLORY.bow,
    }),
  )
  const off = ring === null || table === null ? null : ring.angle - table
  return {
    center,
    ring,
    table,
    off,
    withinRow8: off === null ? null : Math.abs(off) <= GLORY.ring,
    bow,
  }
}

/** The vertical field of view of a still's lens, as `lens.ts` derives it. */
const fovOf = (lens) =>
  (2 * Math.atan(lens.gauge / (2 * lens.focalLength * lens.zoom))) / DEG

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      radius: { type: 'string' },
      center: { type: 'string' },
      'sun-view': { type: 'string' },
      fov: { type: 'string' },
      record: { type: 'string' },
      id: { type: 'string', default: 'weather-g4-over-deck' },
    },
  })
  const [plate] = positionals
  let fov = values.fov === undefined ? null : Number(values.fov)
  if (values.record !== undefined) {
    const record = JSON.parse(await readFile(values.record, 'utf8'))
    const still = record.stills?.find((one) => one.id === values.id)
    if (still?.read?.lens !== undefined) fov ??= fovOf(still.read.lens)
  }
  if (
    plate === undefined ||
    fov === null ||
    (values.center === undefined && values['sun-view'] === undefined)
  ) {
    console.error(
      'usage: node scripts/weather/glory.mjs <plate.png> --radius <µm> (--center x,y | --sun-view x,y,z) (--fov deg | --record <record.json> [--id <still>])',
    )
    return 1
  }
  const image = await decode(plate)
  const focal = focalPixels(image.height, fov)
  const center =
    values.center !== undefined
      ? (([x, y]) => ({ x, y }))(values.center.split(',').map(Number))
      : antisolarPixel(
          values['sun-view'].split(',').map(Number),
          image.width,
          image.height,
          focal,
        )
  if (center === null) {
    console.error('the antisolar point is behind the camera: no glory in frame')
    return 1
  }
  const radius = values.radius === undefined ? null : Number(values.radius)
  console.log(
    JSON.stringify(
      { plate, fov, focal, ...profileGlory(image, { center, focal, radius }) },
      null,
      1,
    ),
  )
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
