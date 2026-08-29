#!/usr/bin/env node
/**
 * The frames a Chrome performance trace is already carrying.
 *
 *   node scripts/traceFrames.mjs ~/Downloads/Trace-*.json.gz [outdir]
 *
 * A trace recorded with the Screenshots checkbox contains one JPEG per
 * composited frame, at the page's real rate, base64 in `args.snapshot` of every
 * `Screenshot` event. That is a 60 Hz recording of what the reporter actually
 * saw, on the reporter's own machine and window size, and it is the only
 * evidence in a bug report that cannot be argued with.
 *
 * It answered the lunar terrain strobe: 182 frames over 3.04 s, in which the
 * frame either side of the collapse differed by **zero** pixels while the
 * collapse frame differed from both by 30,050, recurring at 2.29 Hz — which is
 * the "two to three times a second" the report was filed with, measured.
 *
 * Ask for a trace before trying to reproduce a visual defect. Reproducing one
 * that follows the drawing buffer means matching the reporter's window and
 * device pixel ratio, and a trace states both without anyone having to ask.
 */

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { analyseFrames, differenceMap, reportFrames } from './frameDiff.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

const [input, target] = process.argv.slice(2)
if (input === undefined) {
  process.stderr.write(
    'usage: node scripts/traceFrames.mjs <trace.json[.gz]> [outdir]\n',
  )
  process.exit(1)
}

const out = target ?? path.join(ROOT, '.data/drive/trace')

const raw = await readFile(input)
// Sniffed rather than taken from the extension: Chrome hands out `.json.gz`
// from the DevTools download button and `.json` from the file-system export,
// and a reporter renames neither.
const text =
  raw[0] === 0x1f && raw[1] === 0x8b
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8')
const parsed = JSON.parse(text)
const events = Array.isArray(parsed) ? parsed : parsed.traceEvents

const shots = events
  .filter((e) => e.name === 'Screenshot' && typeof e.ts === 'number')
  .sort((a, b) => a.ts - b.ts)

if (shots.length === 0) {
  process.stderr.write(
    'no Screenshot events — the trace was recorded without the Screenshots checkbox\n',
  )
  process.exit(1)
}

/* The page the trace was taken of, which is half of what makes it reproducible. */
const started = events.find((e) => e.name === 'TracingStartedInBrowser')
const frame = started?.args?.data?.frames?.[0]
if (frame?.url !== undefined) process.stdout.write(`url: ${frame.url}\n`)

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const paths = []
for (const [i, shot] of shots.entries()) {
  const data = shot.args?.snapshot ?? shot.args?.data?.snapshot
  if (typeof data !== 'string') continue
  const file = path.join(out, `${String(i).padStart(4, '0')}.jpg`)
  await writeFile(file, Buffer.from(data, 'base64'))
  paths.push(file)
}

// Microseconds in the trace, seconds everywhere the analysis reports a rate.
const timestamps = shots.map((s) => s.ts / 1e6)
const span = timestamps[timestamps.length - 1] - timestamps[0]
const fps = span > 0 ? paths.length / span : 0

const { stdout: identified } = await promisify(execFile)('magick', [
  'identify',
  '-format',
  '%wx%h',
  paths[0],
]).catch(() => ({ stdout: '?' }))

process.stdout.write(
  `${paths.length} frames at ${identified}, ${span.toFixed(2)}s (${fps.toFixed(1)} fps) -> ${path.relative(ROOT, out)}\n`,
)

const analysis = await analyseFrames(paths, timestamps)
process.stdout.write(`${reportFrames(analysis, fps)}\n`)

const first = analysis.events[0]
if (first !== undefined) {
  const map = await differenceMap(
    paths[first.frame - 1],
    paths[first.frame],
    path.join(out, 'difference.png'),
  )
  process.stdout.write(`where: ${path.relative(ROOT, map)}\n`)
  process.stdout.write(
    `pair:  ${path.relative(ROOT, paths[first.frame - 1])} and ${path.relative(ROOT, paths[first.frame])}\n`,
  )
}
