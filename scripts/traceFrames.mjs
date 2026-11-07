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
import { analyzeFrames, differenceMap, reportFrames } from './frameDiff.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))

/** The events of a trace file, gzipped or plain, wrapped or bare. */
export function readTrace(raw) {
  // Sniffed rather than taken from the extension: Chrome hands out `.json.gz`
  // from the DevTools download button and `.json` from the file-system export,
  // and a reporter renames neither.
  const text =
    raw[0] === 0x1f && raw[1] === 0x8b
      ? gunzipSync(raw).toString('utf8')
      : raw.toString('utf8')
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : parsed.traceEvents
}

/** The composited frames, in the order they were shown. */
export const screenshots = (events) =>
  events
    .filter((e) => e.name === 'Screenshot' && typeof e.ts === 'number')
    .sort((a, b) => a.ts - b.ts)

/**
 * The command: write a trace's frames to a directory, difference them, and
 * name the ones that stand alone.
 *
 * `argv` is the command line after the script name, and the return is the
 * exit code, so a test runs the whole command without a child process.
 * `changed` reaches `analyzeFrames` as its pixel count, which is ImageMagick's
 * when it is not given.
 */
export async function traceFrames(
  argv,
  { stdout = process.stdout, stderr = process.stderr, changed } = {},
) {
  const [input, target] = argv
  if (input === undefined) {
    stderr.write(
      'usage: node scripts/traceFrames.mjs <trace.json[.gz]> [outdir]\n',
    )
    return 1
  }

  const out = target ?? path.join(ROOT, '.data/drive/trace')

  const events = readTrace(await readFile(input))
  const shots = screenshots(events)

  if (shots.length === 0) {
    stderr.write(
      'no Screenshot events — the trace was recorded without the Screenshots checkbox\n',
    )
    return 1
  }

  /* The page the trace was taken of, which is half of what makes it reproducible. */
  const started = events.find((e) => e.name === 'TracingStartedInBrowser')
  const frame = started?.args?.data?.frames?.[0]
  if (frame?.url !== undefined) stdout.write(`url: ${frame.url}\n`)

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

  stdout.write(
    `${paths.length} frames at ${identified}, ${span.toFixed(2)}s (${fps.toFixed(1)} fps) -> ${path.relative(ROOT, out)}\n`,
  )

  const analysis = await analyzeFrames(paths, timestamps, { changed })
  stdout.write(`${reportFrames(analysis, fps)}\n`)

  const first = analysis.events[0]
  if (first !== undefined) {
    const map = await differenceMap(
      paths[first.frame - 1],
      paths[first.frame],
      path.join(out, 'difference.png'),
    )
    stdout.write(`where: ${path.relative(ROOT, map)}\n`)
    stdout.write(
      `pair:  ${path.relative(ROOT, paths[first.frame - 1])} and ${path.relative(ROOT, paths[first.frame])}\n`,
    )
  }
  return 0
}

// `import.meta.main` rather than `process.argv[1]` against this file's path:
// run through a symlink, argv names the link and the loader resolved the
// target, so the comparison is false and the command exits 0 having done
// nothing.
if (import.meta.main)
  process.exitCode = await traceFrames(process.argv.slice(2))
