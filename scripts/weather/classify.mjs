#!/usr/bin/env node
/**
 * What each flagged step of a cast is.
 *
 *   node scripts/weather/classify.mjs <steps.json> --stills <dir>
 *     [--record <record.json> --name <cast>] [--out <file>]
 *
 * A step `castSteps.mjs` flags fails nothing on sight (rubric §4). Each is
 * taken through three questions (phase 1 design §8.1):
 *
 * 1. **Do settled samples at the same poses and times hold the change?** The
 *    settled stills at the path frames either side, read as the cast's
 *    frames are: the same series, against the same motion the cast's
 *    neighborhood predicts for the span.
 * 2. **If they do, is the eye at a cloud's boundary?** The log's range
 *    readout crossing 2 km between the frames, or the CPU field at the eye
 *    turning from clear to cloud.
 * 3. **So what is it?** A real entry or exit only if both hold. An error step
 *    if the samples lack the change, or hold it with the eye at no boundary.
 *    Unresolved if a sample cannot be taken.
 *
 * Agreement with the settled samples does not prove a physical cause: a
 * switch that depends on pose sits in the cast and in the stills alike, which
 * is why the second question exists. An error step names its likely cause
 * beside the verdict, for whoever fixes it: a change the stills hold away
 * from a boundary is a switch that depends on pose, such as the handover
 * band; one they lack is the history's (a reconstruction error) or a stale
 * cache's (the cast behind its still before the step and level with it
 * after). The cause is a reading, never the verdict.
 *
 * A drop the record marks `cloudsOnly` is a finding of its own kind, listed
 * and never masked: the clouds-on arm missed a frame where the clouds-off arm
 * did not.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { changedPixels } from '../frameDiff.mjs'
import { decode, GRID, lumaGrid, readCast } from '../castSteps.mjs'
import { checkTake } from './sheet.mjs'

/**
 * The classifier's numbers. `boundary` is the design's 2 km. `holds` and
 * `within` are provisional: a share of the cast's step a still must carry to
 * hold it, and the reach in path frames over which a drop is matched across
 * arms (the ruling's ten). Window 2's casts set `holds`.
 */
export const CLASSIFY = Object.freeze({
  boundary: 2000,
  holds: 0.5,
  within: 10,
})

/** Whether the eye is inside a cloud's range at a log entry, or null. */
const inside = (entry) =>
  typeof entry.opacity !== 'number'
    ? null
    : typeof entry.range === 'number' && entry.range < CLASSIFY.boundary

/**
 * Whether the eye crosses a cloud's boundary over log entries in path order.
 * By the range readout where the log carries it live (an opacity a frame:
 * a null range then means the center ray never reaches ln 50), else by the
 * CPU field at the eye, `fieldAt(entry)` returning a density or null. Null
 * when neither can answer.
 */
export function boundaryOf(entries, fieldAt = null) {
  const byRange = entries.map(inside)
  if (entries.length > 1 && byRange.every((one) => one !== null)) {
    for (let i = 1; i < byRange.length; i += 1)
      if (byRange[i] !== byRange[i - 1])
        return {
          crossed: true,
          kind: byRange[i] ? 'entry' : 'exit',
          by: 'range',
        }
    return { crossed: false, kind: null, by: 'range' }
  }
  if (fieldAt !== null && entries.length > 1) {
    const cloud = entries.map(fieldAt)
    if (cloud.every((one) => typeof one === 'number')) {
      for (let i = 1; i < cloud.length; i += 1)
        if (cloud[i] > 0 !== cloud[i - 1] > 0)
          return {
            crossed: true,
            kind: cloud[i] > 0 ? 'entry' : 'exit',
            by: 'field',
          }
      return { crossed: false, kind: null, by: 'field' }
    }
  }
  return null
}

/**
 * Classify one step.
 *
 * `step` is `castSteps`' (its `residual` past the motion its neighborhood
 * expects, and that `expected`). `cast` and `settled` are the flagged
 * series' values at the two frames, `{ a, b }`; for the changed-pixel series
 * `settled.d` is the stills' own count and `cast.a`/`cast.b` each frame's
 * count against its still. A settled value is null where no sample exists.
 * `entries` are the log's entries from the step's first path frame to its
 * last; `resets` changing among them is the history starting over.
 */
export function classifyStep({ step, cast, settled, entries, fieldAt = null }) {
  const at = { from: step.from, to: step.to, series: step.series }
  if (settled === null || settled.a === null || settled.b === null)
    return {
      ...at,
      kind: 'unresolved',
      cause: null,
      fails: true,
      reason: `no settled sample at path frame ${settled?.a === null ? step.from : step.to}, so the step cannot be read against one`,
    }
  const changed = step.series === 'changed'
  // The stills' change past the same motion, signed as the cast's step is.
  const stillResidual = changed
    ? settled.d - step.expected
    : settled.b - settled.a - step.expected
  const holds =
    Math.sign(stillResidual) === Math.sign(step.residual) &&
    Math.abs(stillResidual) >= CLASSIFY.holds * Math.abs(step.residual)
  if (!holds) {
    const resets = new Set(entries.map((entry) => entry.resets))
    // Each frame's distance from its own still, in the step's units.
    const apart = (which) =>
      changed ? cast[which] : Math.abs(cast[which] - settled[which])
    const near = CLASSIFY.holds * Math.abs(step.residual)
    const cause =
      resets.size > 1
        ? 'reconstruction'
        : apart('a') >= near && apart('b') < near
          ? 'cache'
          : 'reconstruction'
    return {
      ...at,
      kind: 'error',
      cause,
      fails: true,
      reason:
        `the settled samples carry ${stillResidual.toFixed(2)} of the cast's ${step.residual.toFixed(2)}, so the cast stepped where the picture does not` +
        (resets.size > 1
          ? '; the history reset across it'
          : cause === 'cache'
            ? '; the cast sat off its still before the step and on it after, as a stale cache refreshed'
            : '; the cast left its still at the step, as the history does'),
    }
  }
  const boundary = boundaryOf(entries, fieldAt)
  if (boundary === null)
    return {
      ...at,
      kind: 'unresolved',
      cause: null,
      fails: true,
      reason:
        'the settled samples hold the change, and neither the range readout nor the CPU field is in the log to say whether the eye is at a boundary',
    }
  if (boundary.crossed)
    return {
      ...at,
      kind: boundary.kind,
      cause: null,
      fails: false,
      reason: `the settled samples hold the change and the eye crosses a boundary by the ${boundary.by}`,
    }
  return {
    ...at,
    kind: 'error',
    cause: 'handover',
    fails: true,
    reason: `the settled samples hold the change with the eye at no boundary by the ${boundary.by}: a switch that depends on pose, such as the handover band`,
  }
}

/**
 * Mark the clouds-on arm's drops that the clouds-off arm lacks within ten
 * path frames, the ruling's `cloudsOnly`, where a record has not.
 */
export function markCloudsOnly(onDrops, offDrops, within = CLASSIFY.within) {
  return onDrops.map((drop) => ({
    ...drop,
    cloudsOnly:
      drop.cloudsOnly ??
      !offDrops.some((other) => Math.abs(other.frame - drop.frame) <= within),
  }))
}

/** The `cloudsOnly` drops, each a finding of its own kind. */
export const dropFindings = (drops) =>
  drops
    .filter((drop) => drop.cloudsOnly === true)
    .map((drop) => ({
      from: drop.frame,
      to: drop.frame,
      series: null,
      kind: 'clouds-only-drop',
      cause: null,
      fails: false,
      reason: `the clouds-on arm dropped path frame ${drop.frame} and the clouds-off arm dropped none within ${CLASSIFY.within}; the rubric's §4 holds no verdict for a drop, so it is listed for the ruling and never folded into a step`,
    }))

/**
 * C6's range: 2 km or more ahead at the path's first frame and its last, and
 * under 2 km somewhere between (§8.5). A null range is the center ray never
 * reaching ln 50, which is clear. The least range is recorded and gates
 * nothing. Null where the log carries no live readout.
 */
export function rangeCheck(log, pathFrames) {
  const path = log.filter((entry) => entry.k < pathFrames)
  if (path.length < 2 || path.some((entry) => inside(entry) === null))
    return null
  const ranges = path.map((entry) => entry.range)
  const known = ranges.filter((range) => typeof range === 'number')
  return {
    first: ranges[0],
    last: ranges.at(-1),
    least: known.length > 0 ? Math.min(...known) : null,
    passes: !inside(path[0]) && !inside(path.at(-1)) && path.some(inside),
  }
}

/** A cast's verdict from its findings: an error fails, and so does an unresolved one. */
export function verdictOf(findings) {
  const count = (kind) => findings.filter((one) => one.kind === kind).length
  return {
    passes: findings.every((one) => !one.fails),
    errors: count('error'),
    unresolved: count('unresolved'),
    entries: count('entry') + count('exit'),
    drops: count('clouds-only-drop'),
  }
}

/* ---------------------------------------------------------------- I/O --- */

/**
 * The settled stills along a path, by path frame: `stills.json` mapping a
 * path frame to a file (and optionally the still's read opacity), or files
 * named by their path frame, `0123.png`.
 */
export async function readStills(dir) {
  const index = path.join(dir, 'stills.json')
  if (existsSync(index)) {
    const map = JSON.parse(await readFile(index, 'utf8'))
    return new Map(
      Object.entries(map).map(([k, one]) => [
        Number(k),
        typeof one === 'string'
          ? { file: path.join(dir, one), opacity: null }
          : { file: path.join(dir, one.file), opacity: one.opacity ?? null },
      ]),
    )
  }
  return new Map(
    (await readdir(dir))
      .filter((name) => /^\d+\.(png|jpe?g)$/.test(name))
      .map((name) => [
        Number.parseInt(name, 10),
        { file: path.join(dir, name), opacity: null },
      ]),
  )
}

/** A frame's value in one series: the whole frame's mean or a cell's. */
async function valueOf(file, series, width) {
  const { pixels, width: w, height, channels } = await decode(file, { width })
  const grid = lumaGrid(pixels, w, height, channels)
  if (series === 'whole') return grid.whole
  const [row, column] = series.slice('cell '.length).split(',').map(Number)
  return grid.cells[row * GRID.columns + column]
}

/**
 * Gather one step's evidence from its frames, its stills and its log: the
 * flagged series' values at the cast's two frames and at the stills of the
 * same path frames, with the stills null where none was taken.
 */
async function evidenceOf(step, stills, log) {
  const [castA, castB] = step.pair
  const a = stills.get(step.from) ?? null
  const b = stills.get(step.to) ?? null
  const entries = log.filter((one) => one.k >= step.from && one.k <= step.to)
  const missing = { a: a === null ? null : 0, b: b === null ? null : 0 }
  if (a === null || b === null)
    return { step, cast: null, settled: missing, entries }
  if (step.series === 'changed')
    return {
      step,
      cast: {
        a: await changedPixels(castA, a.file),
        b: await changedPixels(castB, b.file),
      },
      settled: { a: 0, b: 0, d: await changedPixels(a.file, b.file) },
      entries,
    }
  if (step.series === 'opacity')
    return {
      step,
      cast: {
        a: entries[0]?.opacity ?? null,
        b: entries.at(-1)?.opacity ?? null,
      },
      settled: { a: a.opacity, b: b.opacity },
      entries,
    }
  // The still is read at the cast frame's width, so a cell is the same
  // share of the picture in both.
  const { width } = await decode(castA)
  return {
    step,
    cast: {
      a: await valueOf(castA, step.series, null),
      b: await valueOf(castB, step.series, null),
    },
    settled: {
      a: await valueOf(a.file, step.series, width),
      b: await valueOf(b.file, step.series, width),
    },
    entries,
  }
}

/**
 * The record's drops for a kept clouds-on cast, marked against its control:
 * `dropped`, one entry a path frame the page did not present, as the ruling
 * lists them. The cast is held to the capture's own `checkTake` first, so a
 * classification is never written into a take the record would refuse.
 */
export function dropsOf(record, name) {
  const entry = record.casts?.find((one) => one.name === name)
  if (entry === undefined) throw new Error(`no cast named ${name}`)
  checkTake(entry, true)
  if (!entry.clouds) return { entry, drops: [] }
  // The capture names each cast's control: the climate and injected casts
  // are read against the slow descent's, which shares neither their speed
  // nor a clouds-off arm of their own.
  const control = record.casts.find((one) =>
    entry.control === undefined
      ? one.id === entry.id && one.speed === entry.speed && !one.clouds
      : one.name === entry.control,
  )
  return {
    entry,
    drops: markCloudsOnly(entry.dropped ?? [], control?.dropped ?? []),
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      stills: { type: 'string' },
      record: { type: 'string' },
      name: { type: 'string' },
      out: { type: 'string' },
    },
  })
  const [stepsFile] = positionals
  if (stepsFile === undefined || values.stills === undefined) {
    console.error(
      'usage: node scripts/weather/classify.mjs <steps.json> --stills <dir> [--record <record.json> --name <cast>] [--out <file>]',
    )
    return 1
  }
  const report = JSON.parse(await readFile(stepsFile, 'utf8'))
  const { log } = await readCast(report.cast)
  const stills = await readStills(values.stills)
  const findings = []
  for (const step of report.steps)
    findings.push({
      ...classifyStep(await evidenceOf(step, stills, log)),
      frames: {
        cast: step.pair,
        settled: [
          stills.get(step.from)?.file ?? null,
          stills.get(step.to)?.file ?? null,
        ],
      },
    })
  if (values.record !== undefined) {
    const record = JSON.parse(await readFile(values.record, 'utf8'))
    const { entry, drops } = dropsOf(record, values.name)
    findings.push(...dropFindings(drops))
    entry.classification = { findings, verdict: verdictOf(findings) }
    await writeFile(values.record, `${JSON.stringify(record, null, 1)}\n`)
  }
  const verdict = verdictOf(findings)
  // C6's range over the path, where the log carries the readout live.
  const range =
    (report.pathFrames ?? null) === null
      ? null
      : rangeCheck(log, report.pathFrames)
  if (range !== null) console.log(`range: ${JSON.stringify(range)}`)
  if (values.out !== undefined)
    await writeFile(
      values.out,
      `${JSON.stringify({ findings, verdict, range }, null, 1)}\n`,
    )
  console.log(JSON.stringify(verdict))
  for (const one of findings)
    console.log(
      `  ${one.kind}${one.cause === null ? '' : ` (${one.cause})`} at path ${one.from}→${one.to}${one.series === null ? '' : `, ${one.series}`}: ${one.reason}`,
    )
  return 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
