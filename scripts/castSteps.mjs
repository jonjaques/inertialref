#!/usr/bin/env node
/**
 * The steps a moving camera's cast holds and its clouds-off control does not.
 *
 *   node scripts/castSteps.mjs <cast dir> [--against <control dir>]
 *     [--held <held cast dir>] [--path-frames <n>] [--out <dir>] [--json]
 *     [--no-changed]
 *
 * `frameDiff.mjs` finds a strobe: a frame that departs from both neighbors
 * while they match. A pop does not revert, so the frame after it matches it
 * and the strobe test passes it over, and a moving camera raises the median
 * every count is judged against. So this reads a cast as series (phase 1
 * design §8.1, rubric §4): the whole frame's mean luminance, each cell's of a
 * 4 × 3 grid, each pair's changed pixels by `frameDiff`'s count, and the
 * served opacity from the page's log. A first difference that leaves its
 * neighborhood is a step in that series, and a step in any one is a step: a
 * whole-frame mean alone misses a seam that crosses one cell.
 *
 * **A cast has gaps.** A captured frame is matched to the log's path frame
 * by its screencast instant, so two neighbors may be more than one path frame
 * apart. A difference is judged against what its neighborhood predicts for
 * the span it covers, `span × median rate`, never divided by the span: the
 * noise of a difference is its two ends' and does not grow with the span,
 * while a moving camera's change does. So a gap in smooth motion flags
 * nothing, and a real step across a gap is judged at its whole size.
 *
 * **Against its control,** only the steps the control lacks are reported,
 * within 3% of the path's progress, or over the same path span where the
 * control's own difference there would be a step. What the control shares is
 * the scene's (a terrain patch that pops) and is listed apart.
 *
 * A flagged step fails nothing here: `weather/classify.mjs` decides what it
 * is. The trail measure (C8) and the reading after a cut (C9) are here too,
 * as functions over the same frames.
 */

import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { analyzeFrames, changedPixels } from './frameDiff.mjs'

/**
 * The detector's numbers, each with its source. "Rubric" is
 * `design/plans/weather/mvp.md` §4, "design" phase 1's §8.1, "ruling" the
 * orchestrator's ruling on dropped frames. None is from a measurement of
 * this package's: the held-cast noise that sets the floor in practice is
 * window 1b's, and `held` takes it.
 */
export const STEP = Object.freeze({
  /** Frames around a step its neighborhood is taken over (rubric). */
  window: 16,
  /** MADs a first difference leaves its neighborhood by (rubric). */
  mads: 6,
  /** The floor's least value, a share of full scale (rubric). */
  floorShare: 0.004,
  /** The floor's multiple of a held cast's noise (rubric). */
  heldNoise: 3,
  /** A pair's changed pixels against its window's median (design). */
  changedTimes: 4,
  /**
   * The changed-pixel floor: `frameDiff.mjs`'s own for a static scene, where
   * four times a zero median admits every stray pixel. Provisional: it was
   * set on a lunar strobe, and window 2's casts set this one.
   */
  changedFloor: 200,
  /** The control's reach, a share of the path's frames (design). */
  control: 0.03,
  /** A cast under this share of its path's frames is taken again (rubric). */
  coverage: 2 / 3,
  /** A cast's missing path frames may not pass this share (ruling). */
  gapShare: 0.03,
  /** Nor may this many fall in a row (ruling). */
  gapRun: 3,
  /** Rates a neighborhood needs before it can judge anything. */
  least: 4,
})

/** Full scale of each kind of series: 8-bit luma, and opacity's unit. */
export const FULL_SCALE = Object.freeze({ luminance: 255, opacity: 1 })

/** The grid the cells are read on (rubric). */
export const GRID = Object.freeze({ columns: 4, rows: 3 })

/** MAD to a normal's standard deviation. */
const MAD_SIGMA = 1.4826

export const median = (values) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Median absolute deviation about the median. */
export const mad = (values) => {
  const center = median(values)
  return center === null
    ? null
    : median(values.map((value) => Math.abs(value - center)))
}

/* ------------------------------------------------------------ frames --- */

/**
 * Mean luma of a frame and of each cell of the grid, from interleaved 8-bit
 * pixels. Rec. 709's weights on the encoded values: the instrument compares
 * a frame with its neighbors and its control, and a linear-light mean would
 * weight the sky's highlights over the shadow a seam crosses.
 */
export function lumaGrid(pixels, width, height, channels = 3) {
  const { columns, rows } = GRID
  const sums = new Float64Array(columns * rows)
  const counts = new Float64Array(columns * rows)
  let total = 0
  for (let y = 0; y < height; y += 1) {
    const row = Math.min(rows - 1, Math.floor((y * rows) / height))
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * channels
      const luma =
        0.2126 * pixels[at] + 0.7152 * pixels[at + 1] + 0.0722 * pixels[at + 2]
      const cell =
        row * columns + Math.min(columns - 1, Math.floor((x * columns) / width))
      sums[cell] += luma
      counts[cell] += 1
      total += luma
    }
  }
  return {
    whole: total / (width * height),
    cells: Array.from(sums, (sum, cell) => sum / counts[cell]),
  }
}

/**
 * Each captured frame's path frame. By the screencast's instant where the
 * cast has one: the last log entry that began at or before the frame was
 * presented. A frame shows the pose its tick applied, so the match may sit
 * one path frame early, by the same amount in a cast and its control, which
 * moves no step against the other. Without instants the frames are taken as
 * one a path frame from the first, which a gap breaks; the report says so.
 */
export function alignFrames(count, instants, log) {
  if (instants === null || instants.length !== count || log.length === 0)
    return { ks: Array.from({ length: count }, (_, i) => i), by: 'assumed' }
  const ks = []
  let entry = 0
  for (const seconds of instants) {
    const ms = seconds * 1000
    while (entry + 1 < log.length && log[entry + 1].at <= ms) entry += 1
    ks.push(log[entry].k)
  }
  return { ks, by: 'instants' }
}

/**
 * Where a cast's captured frames skip path frames, and whether the ruling
 * keeps it: under 3% of its path missing, none three in a row, and at least
 * two thirds of the path captured.
 */
export function gapsOf(ks, pathFrames) {
  const gaps = []
  let missing = 0
  let longest = 0
  for (let i = 1; i < ks.length; i += 1) {
    const skipped = Math.min(ks[i], pathFrames) - ks[i - 1] - 1
    if (ks[i - 1] >= pathFrames || skipped <= 0) continue
    gaps.push({ after: ks[i - 1], missing: skipped })
    missing += skipped
    longest = Math.max(longest, skipped)
  }
  const captured = new Set(ks.filter((k) => k >= 0 && k < pathFrames)).size
  const coverage = pathFrames > 0 ? captured / pathFrames : 0
  const share = pathFrames > 0 ? missing / pathFrames : 0
  return {
    gaps,
    missing,
    longest,
    share,
    coverage,
    retake:
      coverage < STEP.coverage ||
      share > STEP.gapShare ||
      longest >= STEP.gapRun,
  }
}

/* ------------------------------------------------------------- steps --- */

/** The pairs' indices around `p`, `window` of them, shifted at the ends. */
function around(p, count, window) {
  const half = window >> 1
  const start = Math.max(0, Math.min(p - half, count - window - 1))
  const out = []
  for (let q = start; q < count && out.length < window; q += 1)
    if (q !== p) out.push(q)
  return out
}

/** The first differences of a series over its captured frames, with spans. */
export function pairsOf(ks, values) {
  const pairs = []
  for (let i = 1; i < values.length; i += 1) {
    const span = ks[i] - ks[i - 1]
    const ends = values[i] !== null && values[i - 1] !== null
    const d = ends ? values[i] - values[i - 1] : null
    pairs.push({
      frame: i,
      from: ks[i - 1],
      to: ks[i],
      span,
      d,
      rate: d !== null && span > 0 ? d / span : null,
    })
  }
  return pairs
}

/**
 * Judge one difference against its neighborhood: what the rates around it
 * predict for its span, and how far it lands from that. Null where there are
 * too few rates to say.
 */
export function judge(pairs, p, floor, window = STEP.window) {
  const pair = pairs[p]
  if (pair.d === null) return null
  const rates = around(p, pairs.length, window)
    .map((q) => pairs[q].rate)
    .filter((rate) => rate !== null)
  if (rates.length < STEP.least) return null
  const center = median(rates)
  const expected = pair.span * center
  const residual = pair.d - expected
  const threshold = Math.max(STEP.mads * mad(rates), floor)
  return { expected, residual, threshold, step: Math.abs(residual) > threshold }
}

/** Every step in one series. */
export function stepsOf(ks, values, floor, window = STEP.window) {
  const pairs = pairsOf(ks, values)
  const steps = []
  for (let p = 0; p < pairs.length; p += 1) {
    const verdict = judge(pairs, p, floor, window)
    if (verdict?.step !== true) continue
    const { frame, from, to, span, d } = pairs[p]
    steps.push({
      frame,
      from,
      to,
      span,
      d,
      expected: verdict.expected,
      residual: verdict.residual,
      threshold: verdict.threshold,
    })
  }
  return steps
}

/**
 * The changed-pixel steps: a pair past four times its window's median for
 * its span, unless the strobe test claims either of its frames, which is
 * `frameDiff`'s finding and not a pop.
 */
export function changedStepsOf(ks, counts, isolated = []) {
  const claimed = new Set(isolated.flatMap((frame) => [frame - 1, frame]))
  // A count is already a pair's, so the pairs are built from it directly.
  const pairs = counts.map((d, p) => {
    const span = ks[p + 1] - ks[p]
    return {
      frame: p + 1,
      from: ks[p],
      to: ks[p + 1],
      span,
      d,
      rate: span > 0 ? d / span : null,
    }
  })
  const steps = []
  for (let p = 0; p < pairs.length; p += 1) {
    if (claimed.has(p)) continue
    const rates = around(p, pairs.length, STEP.window)
      .map((q) => pairs[q].rate)
      .filter((rate) => rate !== null)
    if (rates.length < STEP.least) continue
    const expected = pairs[p].span * median(rates)
    const threshold = Math.max(STEP.changedTimes * expected, STEP.changedFloor)
    if (pairs[p].d > threshold) {
      const { frame, from, to, span, d } = pairs[p]
      steps.push({
        frame,
        from,
        to,
        span,
        d,
        expected,
        residual: d - expected,
        threshold,
      })
    }
  }
  return steps
}

/** The series a cast is read as, keyed: `whole`, `cell r,c`, `opacity`. */
export function seriesOf(measures, ks, log) {
  const byK = new Map(log.map((entry) => [entry.k, entry]))
  const series = { whole: measures.map((one) => one.whole) }
  for (let cell = 0; cell < GRID.columns * GRID.rows; cell += 1)
    series[cellKey(cell)] = measures.map((one) => one.cells[cell])
  const opacity = ks.map((k) => {
    const value = byK.get(k)?.opacity
    return typeof value === 'number' ? value : null
  })
  if (opacity.some((value) => value !== null)) series.opacity = opacity
  return series
}

const cellKey = (cell) =>
  `cell ${Math.floor(cell / GRID.columns)},${cell % GRID.columns}`

/**
 * Each series' noise on a held cast: the spread of its first differences,
 * as a standard deviation. The floor is three of them (rubric).
 */
export function heldNoise(series) {
  const noise = {}
  for (const [key, values] of Object.entries(series)) {
    const d = []
    for (let i = 1; i < values.length; i += 1)
      if (values[i] !== null && values[i - 1] !== null)
        d.push(values[i] - values[i - 1])
    noise[key] = d.length > 0 ? MAD_SIGMA * mad(d) : null
  }
  return noise
}

/** A series' floor: 0.4% of full scale, or three held-cast noises. */
export function floorOf(key, noise = null) {
  const scale = key === 'opacity' ? FULL_SCALE.opacity : FULL_SCALE.luminance
  const held = noise?.[key]
  return Math.max(
    STEP.floorShare * scale,
    typeof held === 'number' ? STEP.heldNoise * held : 0,
  )
}

/**
 * Read a cast: every step in every series, the strobes, and the gaps.
 * `changed` is each captured pair's count and `isolated` the strobe test's
 * frames, both from `frameDiff`, or null where the counts were not taken.
 */
export function readSteps({ ks, series, changed = null, noise = null }) {
  const steps = []
  for (const [key, values] of Object.entries(series))
    for (const step of stepsOf(ks, values, floorOf(key, noise)))
      steps.push({ series: key, ...step })
  if (changed !== null)
    for (const step of changedStepsOf(ks, changed.pairs, changed.isolated))
      steps.push({ series: 'changed', ...step })
  return steps.sort(
    (a, b) => a.frame - b.frame || a.series.localeCompare(b.series),
  )
}

/** The control's frames bracketing a path span: last at or before, first at or after. */
function bracket(ks, from, to) {
  let a = -1
  let b = -1
  for (let i = 0; i < ks.length; i += 1) {
    if (ks[i] <= from) a = i
    if (b < 0 && ks[i] >= to) b = i
  }
  return a >= 0 && b > a ? [a, b] : null
}

/**
 * Whether the control holds a step: one of its own in the same series within
 * 3% of the path's progress, or its difference over the cast step's path
 * span judged a step of the same sign by its own neighborhood. The second is
 * the ruling's: a step across a gap is compared with the control's change
 * over the same span, wherever the control's own frames fall.
 */
export function controlHolds(step, control, pathFrames, noise = null) {
  if (step.series === 'opacity') return false
  const reach = Math.max(1, Math.round(STEP.control * pathFrames))
  const near = control.steps.some(
    (one) =>
      one.series === step.series &&
      one.to >= step.from - reach &&
      one.from <= step.to + reach,
  )
  if (near || step.series === 'changed') return near
  const values = control.series[step.series]
  const ends =
    values === undefined ? null : bracket(control.ks, step.from, step.to)
  if (ends === null) return false
  const [a, b] = ends
  // The control's span as one pair among its own neighbors.
  const pairs = pairsOf(control.ks, values)
  const merged = [
    ...pairs.slice(0, a),
    {
      frame: b,
      from: control.ks[a],
      to: control.ks[b],
      span: control.ks[b] - control.ks[a],
      d: values[b] - values[a],
      rate: null,
    },
    ...pairs.slice(b),
  ]
  const verdict = judge(merged, a, floorOf(step.series, noise))
  return (
    verdict !== null &&
    verdict.step &&
    Math.sign(verdict.residual) === Math.sign(step.residual)
  )
}

/** Split a cast's steps into the ones its control lacks and the ones it holds. */
export function againstControl(steps, control, pathFrames, noise = null) {
  const lacked = []
  const shared = []
  for (const step of steps)
    (controlHolds(step, control, pathFrames, noise) ? shared : lacked).push(
      step,
    )
  return { lacked, shared }
}

/* ------------------------------------------------- the trail (C8) --- */

/** A separable box blur of `size` pixels over a luminance plane. */
export function boxBlur(plane, width, height, size) {
  if (size <= 1) return Float64Array.from(plane)
  const half = size >> 1
  const pass = (source, horizontal) => {
    const out = new Float64Array(width * height)
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        let sum = 0
        let n = 0
        for (let o = -half; o <= half; o += 1) {
          const u = horizontal ? x + o : x
          const v = horizontal ? y : y + o
          if (u < 0 || v < 0 || u >= width || v >= height) continue
          sum += source[v * width + u]
          n += 1
        }
        out[y * width + x] = sum / n
      }
    return out
  }
  return pass(pass(plane, true), false)
}

/**
 * The trail measure: the mean absolute difference of two frames at one pose,
 * each blurred by a box the size of a trace texel, as a share of full scale.
 * A ghost is a smear at a cloud's scale; the history's own work three frames
 * after a stop, one sample a pixel becoming eight, is noise at a pixel's, and
 * the blur takes it out.
 */
export function trailMeasure(a, b, width, height, texel) {
  const x = boxBlur(a, width, height, texel)
  const y = boxBlur(b, width, height, texel)
  let sum = 0
  for (let i = 0; i < x.length; i += 1) sum += Math.abs(x[i] - y[i])
  return sum / x.length / FULL_SCALE.luminance
}

/** The trail's floor: 0.5% of full scale, or twice a held cast's measure. */
export const trailFloor = (held = null) =>
  Math.max(0.005, held === null ? 0 : 2 * held)

/* --------------------------------------------- after a cut (C9) --- */

const rmse = (a, b) => {
  let sum = 0
  for (let i = 0; i < a.length; i += 1) sum += (a[i] - b[i]) ** 2
  return Math.sqrt(sum / a.length)
}

/**
 * The frames from a cut or a scrub against the settled plate (C9): no
 * frame's RMSE rises past the event's by more than the picture's RMSE floor,
 * and no cell's mean leaves the span from the event's frame to the plate by
 * more than the luminance floor. `frames` and `plate` are planes of one
 * size, the event's frame first; the cells are each frame's `lumaGrid`.
 * The floors are the picture's noise floor (window 1b's), and without them
 * the figures are reported and nothing is judged.
 */
export function afterEvent({ frames, cells, plate, plateCells, floors = {} }) {
  const errors = frames.map((frame) => rmse(frame, plate))
  const rise = Math.max(0, ...errors.map((error) => error - errors[0]))
  // The furthest each cell strays outside its span, over every frame.
  let beyond = { by: 0, frame: null, cell: null }
  for (let c = 0; c < plateCells.length; c += 1) {
    const low = Math.min(cells[0][c], plateCells[c])
    const high = Math.max(cells[0][c], plateCells[c])
    for (let i = 1; i < cells.length; i += 1) {
      const by = Math.max(low - cells[i][c], cells[i][c] - high)
      if (by > beyond.by) beyond = { by, frame: i, cell: cellKey(c) }
    }
  }
  const { rmse: rmseFloor = null, luminance = null } = floors
  return {
    errors,
    rise,
    overshoot: beyond,
    passes:
      typeof rmseFloor === 'number' && typeof luminance === 'number'
        ? rise <= rmseFloor && beyond.by <= luminance
        : null,
  }
}

/* ---------------------------------------------------------------- I/O --- */

/** A cast directory: its frames in order, its log, and their instants. */
export async function readCast(dir) {
  const frames = (await readdir(dir))
    .filter((name) => /^\d{4}\.(jpe?g|png)$/.test(name))
    .sort()
    .map((name) => path.join(dir, name))
  const log = JSON.parse(await readFile(path.join(dir, 'log.json'), 'utf8'))
  /*
   * The screencast's instant a frame, seconds, in the frames' order. The
   * capture does not keep it yet (`drive.mjs`'s cast step holds it in memory
   * and writes the frames alone), so it is read from `timestamps.json` or a
   * `captured` array in the log when either exists, and the alignment is
   * assumed otherwise.
   */
  const file = path.join(dir, 'timestamps.json')
  const instants = existsSync(file)
    ? JSON.parse(await readFile(file, 'utf8'))
    : Array.isArray(log.captured)
      ? log.captured
      : null
  return {
    dir,
    frames,
    log: log.log ?? [],
    path: log.path ?? null,
    stopAt: log.stopAt ?? null,
    instants,
  }
}

/** Decode a frame to its interleaved pixels, by `sharp`, as the rig does. */
export async function decode(file, { width = null } = {}) {
  const sharp = (await import('sharp')).default
  let image = sharp(file).removeAlpha()
  if (width !== null) image = image.resize({ width })
  const { data, info } = await image.raw().toBuffer({ resolveWithObject: true })
  return {
    pixels: data,
    width: info.width,
    height: info.height,
    channels: info.channels,
  }
}

/** Run `task` over `items`, `limit` at a time, in order. */
export async function pool(items, limit, task) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next
      next += 1
      out[i] = await task(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  )
  return out
}

/**
 * Measure a cast: its series, its alignment and its gaps, and with
 * `changed`, each pair's count and the strobe test's isolated frames.
 */
export async function measureCast(cast, { pathFrames, changed = true } = {}) {
  const measures = await pool(cast.frames, 4, async (file) => {
    const { pixels, width, height, channels } = await decode(file)
    return lumaGrid(pixels, width, height, channels)
  })
  const { ks, by } = alignFrames(cast.frames.length, cast.instants, cast.log)
  const series = seriesOf(measures, ks, cast.log)
  let counts = null
  if (changed) {
    // Every adjacent pair counted four at a time; the strobe test's skip
    // comparisons then reach only the frames it asks about.
    const pairs = await pool(cast.frames.slice(1), 4, (file, i) =>
      changedPixels(cast.frames[i], file),
    )
    const memo = new Map(
      pairs.map((count, i) => [
        `${cast.frames[i]}|${cast.frames[i + 1]}`,
        count,
      ]),
    )
    const analysis = await analyzeFrames(cast.frames, null, {
      changed: (a, b) => memo.get(`${a}|${b}`) ?? changedPixels(a, b),
    })
    counts = {
      pairs: analysis.pairs,
      isolated: analysis.isolated.map((one) => one.frame),
    }
  }
  return {
    ks,
    by,
    series,
    changed: counts,
    gaps: gapsOf(ks, pathFrames ?? cast.log.length),
  }
}

function describe(step, cast, measured) {
  const entry = cast.log.find((one) => one.k === step.to)
  return {
    ...step,
    height: entry?.height ?? null,
    pair: [cast.frames[step.frame - 1], cast.frames[step.frame]],
    via: measured.by,
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      against: { type: 'string' },
      held: { type: 'string' },
      'path-frames': { type: 'string' },
      out: { type: 'string' },
      json: { type: 'boolean', default: false },
      changed: { type: 'boolean', default: true },
    },
    allowNegative: true,
  })
  const [dir] = positionals
  if (dir === undefined) {
    console.error(
      'usage: node scripts/castSteps.mjs <cast dir> [--against <control>] [--held <held cast>] [--path-frames n] [--out dir] [--json] [--no-changed]',
    )
    return 1
  }
  const pathFrames =
    values['path-frames'] === undefined ? null : Number(values['path-frames'])
  const cast = await readCast(dir)
  const measured = await measureCast(cast, {
    pathFrames,
    changed: values.changed,
  })
  let noise = null
  if (values.held !== undefined) {
    const held = await readCast(values.held)
    noise = heldNoise((await measureCast(held, { changed: false })).series)
  }
  const steps = readSteps({ ...measured, noise })
  let lacked = steps
  let shared = []
  let control = null
  if (values.against !== undefined) {
    const other = await readCast(values.against)
    control = await measureCast(other, { pathFrames, changed: values.changed })
    const split = againstControl(
      steps,
      {
        ks: control.ks,
        series: control.series,
        steps: readSteps({ ...control, noise }),
      },
      pathFrames ?? cast.log.length,
      noise,
    )
    lacked = split.lacked
    shared = split.shared
  }
  const report = {
    cast: dir,
    against: values.against ?? null,
    frames: cast.frames.length,
    alignment: measured.by,
    gaps: measured.gaps,
    floor:
      noise === null
        ? 'provisional: 0.4% of full scale, no held cast'
        : 'held cast',
    strobes: measured.changed?.isolated ?? null,
    steps: lacked.map((step) => describe(step, cast, measured)),
    shared: shared.map((step) => describe(step, cast, measured)),
    control:
      control === null
        ? null
        : {
            frames: control.ks.length,
            alignment: control.by,
            gaps: control.gaps,
          },
  }
  if (values.out !== undefined) {
    await mkdir(values.out, { recursive: true })
    for (const step of report.steps) {
      const [a, b] = step.pair
      const stem = `step-${String(step.to).padStart(4, '0')}-${step.series.replace(/[ ,]/g, '-')}`
      await copyFile(a, path.join(values.out, `${stem}-a${path.extname(a)}`))
      await copyFile(b, path.join(values.out, `${stem}-b${path.extname(b)}`))
    }
    await writeFile(
      path.join(values.out, 'steps.json'),
      `${JSON.stringify(report, null, 1)}\n`,
    )
  }
  if (values.json) console.log(JSON.stringify(report, null, 1))
  else console.log(summarize(report))
  return 0
}

/** One block of prose for a terminal. */
export function summarize(report) {
  const { gaps } = report
  const lines = [
    `${report.frames} frames, aligned by ${report.alignment === 'instants' ? 'the screencast’s instants' : 'assumption, one a path frame (no instants kept)'}`,
    `path: ${(gaps.coverage * 100).toFixed(1)}% captured, ${gaps.missing} path frames missing in ${gaps.gaps.length} gaps, longest ${gaps.longest}${gaps.retake ? ' — outside the ruling: take it again' : ''}`,
    `floor: ${report.floor}`,
  ]
  if (report.strobes !== null)
    lines.push(
      `strobes by frameDiff: ${report.strobes.length === 0 ? 'none' : report.strobes.join(', ')}`,
    )
  const what =
    report.against === null ? 'steps (no control)' : 'steps the control lacks'
  lines.push(`${what}: ${report.steps.length}`)
  for (const step of report.steps.slice(0, 20))
    lines.push(
      `  frame ${step.frame} (path ${step.from}→${step.to}${step.height === null ? '' : `, ${step.height.toFixed(0)} m`}): ${step.series} ${step.residual.toFixed(2)} past ${step.threshold.toFixed(2)}`,
    )
  if (report.steps.length > 20)
    lines.push(`  …and ${report.steps.length - 20} more`)
  if (report.against !== null)
    lines.push(`shared with the control, the scene’s: ${report.shared.length}`)
  return lines.join('\n')
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
