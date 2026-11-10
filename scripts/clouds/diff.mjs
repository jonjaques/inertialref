#!/usr/bin/env node
/*
 * How far the thin composite is from the identity, in both of the error
 * batch's views: the residual meter's histograms, read in radiance, and two
 * screenshots differenced as a person sees them.
 *
 *     node scripts/clouds/diff.mjs identity.png thin.png
 *
 * The screenshots are ImageMagick's, as `presets:compare` differences its
 * plates, so a figure here can be re-run by pasting the command: `magick
 * compare -metric RMSE` for the root-mean-square difference over the frame as
 * a fraction of full scale, and the share of pixels whose gray difference
 * passes 3% and 8%, the presets' per-pixel `SAME` levels. That reads what the
 * sensor's tone curve leaves of an error; the meter reads the error itself.
 */
import { spawn } from 'node:child_process'
import { cloudHistogramEdge } from '../../packages/devtools/src/clouds.ts'

/** The presets' per-pixel levels: 3% against a PNG, 8% against a JPEG. */
export const LEVELS = ['3%', '8%']

/**
 * The residual meter's bins, by the report's own definition
 * (`packages/devtools/src/clouds.ts`), which the meter counts by on the GPU:
 * 64, a sixteenth of a decade each, over 10⁻⁴…1, bin 0 also holding
 * everything under 10⁻⁴ and bin 63 everything from 10^(−1/16) up. A
 * threshold inside a bin cannot be resolved, so every figure here is the
 * bin-resolved upper bound: 1% is an edge and exact, 2% and 5% fall inside
 * bins 36 and 43 and are not.
 */
export const binEdge = cloudHistogramEdge

/**
 * A histogram's share of texels over each threshold, its 95th percentile and
 * its worst, each as the upper edge of the bin it falls in; null for an empty
 * one. The share is of `samples`, the texels the meter counted.
 */
export function histogramStats(h, thresholds = [0.01, 0.02, 0.05]) {
  const bins = h?.bins ?? []
  const n = h?.samples > 0 ? h.samples : bins.reduce((s, c) => s + c, 0)
  if (!(n > 0)) return null
  let cumulative = 0
  let p95 = null
  let worst = null
  bins.forEach((count, i) => {
    cumulative += count
    if (p95 === null && cumulative >= 0.95 * n) p95 = binEdge(i + 1)
    if (count > 0) worst = binEdge(i + 1)
  })
  const over = (t) =>
    bins.reduce((s, count, i) => s + (binEdge(i + 1) > t ? count : 0), 0) / n
  return { samples: n, over: thresholds.map((t) => [t, over(t)]), p95, worst }
}

/** `magick` with its exit status, which `compare` sets to 1 for any
 *  difference at all: a status is an answer here, not a failure. */
export const magick = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('magick', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', (cause) =>
      reject(new Error(`is \`magick\` on PATH? (${cause.message})`)),
    )
    child.on('close', (status) =>
      resolve({ status, stdout: stdout.trim(), stderr: stderr.trim() }),
    )
  })

/**
 * The fraction of full scale `magick compare -metric RMSE` prints on stderr,
 * after the absolute figure: `4633.67 (0.0707053)`.
 */
export function parseRmse(text) {
  const found = /\(([-+0-9.eE]+)\)\s*$/.exec(text)
  if (found === null)
    throw new Error(`magick compare printed no RMSE: ${JSON.stringify(text)}`)
  return Number(found[1])
}

async function size(file, run) {
  const { status, stdout, stderr } = await run([
    'identify',
    '-format',
    '%w %h',
    file,
  ])
  if (status !== 0) throw new Error(`cannot read ${file}: ${stderr}`)
  const [width, height] = stdout.split(' ').map(Number)
  return { width, height }
}

/**
 * The difference between two images of one size. Two sizes are refused rather
 * than compared: `compare` scores a 64 × 32 frame against a 32 × 32 one at
 * 0.5, a figure about the crop and not about either picture.
 *
 * @param {string} a
 * @param {string} b
 * @param {{levels?: readonly string[], run?: typeof magick}} [options]
 */
export async function difference(a, b, { levels = LEVELS, run = magick } = {}) {
  const [one, two] = [await size(a, run), await size(b, run)]
  if (one.width !== two.width || one.height !== two.height)
    throw new Error(
      `${a} is ${one.width}×${one.height} and ${b} is ${two.width}×${two.height}`,
    )
  const compared = await run(['compare', '-metric', 'RMSE', a, b, 'null:'])
  if (compared.status !== 0 && compared.status !== 1)
    throw new Error(`magick compare failed: ${compared.stderr}`)
  const over = {}
  for (const level of levels) {
    const { status, stdout, stderr } = await run([
      a,
      b,
      '-compose',
      'difference',
      '-composite',
      '-colorspace',
      'Gray',
      '-threshold',
      level,
      '-format',
      '%[fx:mean]',
      'info:',
    ])
    if (status !== 0) throw new Error(`magick failed at ${level}: ${stderr}`)
    over[level] = Number(stdout)
  }
  return { rmse: parseRmse(compared.stderr), over, ...one }
}

if (import.meta.main) {
  const [a, b] = process.argv.slice(2)
  if (a === undefined || b === undefined) {
    console.error('Usage: node scripts/clouds/diff.mjs <a.png> <b.png>')
    process.exit(2)
  }
  console.log(JSON.stringify(await difference(a, b), null, 2))
}
