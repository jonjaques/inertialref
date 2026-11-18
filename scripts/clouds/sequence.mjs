/*
 * The runner's `sequence` step and its table (phase 1 design §4.7, §7.2):
 * an event and the 60 frames from it, each frame's GPU time by pass, and
 * the frame at which the field is whole again. B7 reads it, and §7.4's caps
 * and ramp are chosen from it.
 *
 * Four events on `horizon`: a cut and a scrub, each one frame under its
 * force; a change of weather; and a wake from orbit, the camera arriving at
 * the stance from 400 km. A forced path held on resets every frame and never
 * finishes a rebuild, so the force lasts the event's frame alone and the 59
 * after it draw the levers as they are.
 *
 * A frame is one `ir.passes(1)`: a frame the page draws for the reading,
 * with the loop held, timed pass by pass. Its GPU time does not move with
 * the presentation rate (§7.5), so a sequence needs no hold. Before the event
 * the step reads frames with the clouds off and steady frames with them on:
 * the steady Δ every frame after the event is held to is this sequence's
 * own, on the same page and the same levers.
 *
 * "Whole" is read from `ir.clouds()`: nothing pending and the history past
 * its settle window. The report carries no grid weight or count of the far
 * atlas's blocks in view beside `pending`, so whole is the settle the runner
 * already waits on (`cloudsSettled`), which owes the sun grid, the far atlas
 * and the history's 32 frames.
 */
import {
  NAMED,
  OPERATING,
  SETTLE_CAP,
  addKind,
  fixed,
  median,
  pageStep,
  standing,
  table,
} from './page.mjs'

/** Frames read from the event: 48, the bar's, and a margin. */
export const SEQUENCE_FRAMES = 60
/** Frames read before it, with the clouds off and then steady. */
const BEFORE = 8

/**
 * @param {{kind: string} & Record<string, unknown>} step
 */
export async function sequenceStep(step) {
  const frame = () =>
    new Promise((done) => requestAnimationFrame(() => done(undefined)))
  const report = () => (typeof ir.clouds === 'function' ? ir.clouds() : null)
  const set = (levers) => {
    engine.clouds = { ...levers }
  }
  const settle = async (cap) => {
    for (let i = 0; i < cap; i += 1) {
      await frame()
      const s = report()?.settle ?? null
      if (i >= 4 && (s === null || !s.pending)) return i + 1
    }
    return cap
  }
  // One drawn frame, its passes summed: the frame's total, the trace's own,
  // and every cloud pass, the bakes among them.
  const one = async () => {
    const read = await ir.passes(1)
    if (read === null)
      throw new Error(
        'ir.passes answered null: no timestamp-query, or no presenting chain',
      )
    if (read.dropped > 0) throw new Error(`ir.passes dropped ${read.dropped}`)
    let total = 0
    let clouds = 0
    let trace = 0
    for (const p of read.passes) {
      total += p.ms
      if (p.label.startsWith('cloud ')) clouds += p.ms
      if (p.label === 'cloud trace') trace = p.ms
    }
    const r = report()
    return {
      total,
      clouds,
      trace,
      whole: r?.settle != null && !r.settle.pending,
      regime: r?.regime ?? null,
      sinceReset: r?.sinceReset ?? null,
    }
  }
  const frames = async (n) => {
    const out = []
    for (let i = 0; i < n; i += 1) out.push(await one())
    return out
  }

  if (step.kind !== 'sequence')
    throw new Error(`no sequence step ${String(step.kind)}`)
  set(step.off)
  await settle(step.settleCap)
  const off = await frames(step.before)
  set(step.levers)
  await settle(step.settleCap)
  const steady = await frames(step.before)
  const event = step.event
  if (event.kind === 'wake') {
    // From orbit over the stance, settled there, then back in one frame.
    ir.visit(event.address, event.from)
    await settle(step.settleCap)
    ir.visit(event.address, event.to)
  } else if (event.kind === 'weather')
    set({ ...step.levers, weather: event.to })
  else set({ ...step.levers, force: event.kind })
  const after = [await one()]
  if (event.kind === 'cut' || event.kind === 'scrub') set(step.levers)
  after.push(...(await frames(step.frames - 1)))
  // The stance's own weather again, for the next sequence on this page.
  set(step.levers)
  return { off, steady, after }
}

/* ------------------------------------------------------------- the Node half ---- */

const INSTALL = `(globalThis.irSequenceStep = ${sequenceStep.toString()}, typeof globalThis.irSequenceStep)`
const js = pageStep('irSequenceStep')

/** A sequence's seconds: two settles and 76 timed frames, each its own readback. */
const SEQUENCE_SECONDS = 15

const steps = (run) =>
  run.events.map((event) =>
    js(
      `sequence:${event.kind}`,
      {
        kind: 'sequence',
        event,
        off: run.off,
        levers: run.levers,
        before: BEFORE,
        frames: SEQUENCE_FRAMES,
        settleCap: SETTLE_CAP,
      },
      SEQUENCE_SECONDS,
    ),
  )

/**
 * One sequence's figures: the steady Δ, each frame's Δ from the clouds-off
 * frame, the event's frame over the steady Δ, the worst later frame over it,
 * and the first frame from which the field stays whole.
 */
export function readSequence(event, value) {
  if (!Array.isArray(value?.after) || value.after.length === 0)
    return { event: event.kind, frames: null }
  const off = median(value.off.map((f) => f.total))
  const steadyDelta = median(value.steady.map((f) => f.total)) - off
  const deltas = value.after.map((f) => f.total - off)
  const broken = value.after.findLastIndex((f) => !f.whole)
  return {
    event: event.kind,
    off,
    steadyDelta,
    frames: value.after.map((f, i) => ({ ...f, delta: deltas[i] })),
    eventOver: deltas[0] - steadyDelta,
    laterOver: Math.max(...deltas.slice(1)) - steadyDelta,
    // Null where the last frame read is still not whole.
    wholeAt: broken === value.after.length - 1 ? null : broken + 1,
  }
}

const read = (run, value) => ({
  // The caps the run drew with, the landed ones included.
  caps: {
    sunSlices: run.levers.sunSlices,
    farBlocks: run.levers.farBlocks,
    sunRamp: run.levers.sunRamp,
  },
  sequences: run.events.map((e) =>
    readSequence(e, value(`sequence:${e.kind}`)),
  ),
})

function unfit(row) {
  const empty = row.sequences.find((s) => s.frames === null)
  return empty === undefined ? null : `no frames read for the ${empty.event}`
}

const COLUMNS = [
  ...NAMED,
  ['sunSlices', (r) => r.caps.sunSlices],
  ['farBlocks', (r) => r.caps.farBlocks],
  ['sunRamp', (r) => r.caps.sunRamp],
  ['Event', (r) => r.event],
  ['steady Δ ms', (r) => fixed(r.steadyDelta)],
  ['event frame over it ms', (r) => fixed(r.eventOver)],
  ['worst later frame over it ms', (r) => fixed(r.laterOver)],
  ['whole at frame', (r) => r.wholeAt ?? 'not in 60'],
  ...OPERATING,
  ['quiet', standing],
]

export const sequenceTable = (rows) =>
  table(
    rows.flatMap((r) => r.sequences.map((s) => ({ ...r, ...s }))),
    COLUMNS,
  )

const progress = (r) =>
  r.sequences
    .map(
      (s) =>
        `${s.event} +${fixed(s.eventOver)} then +${fixed(s.laterOver)}, whole at ${s.wholeAt ?? '—'}`,
    )
    .join('; ')

addKind('sequence', {
  install: INSTALL,
  steps,
  read,
  unfit,
  table: sequenceTable,
  progress,
})

/* --------------------------------------------------------------- the batches ---- */

/** The caps §7.4 chooses among: the largest that holds B7 at 1080p. */
export const CAPS = Object.freeze({
  sunSlices: [4, 8, 16],
  farBlocks: [1, 2],
})

/**
 * The four events on a stance: a cut, a scrub, the weather changed to
 * another regime, and a wake from orbit over the stance's own site.
 */
const events = (stance, weather) => [
  { kind: 'cut' },
  { kind: 'scrub' },
  { kind: 'weather', to: weather },
  {
    kind: 'wake',
    address: stance.address,
    from: { ...stance.options, height: 400_000, pitch: -40 },
    to: stance.options,
  },
]

export function sequenceBatches(kit) {
  const { stood, levers, ON } = kit
  const run = (batch, size, caps) => ({
    id: [
      batch,
      'sequence',
      'horizon',
      size,
      ...Object.entries(caps).map(([k, v]) => `${k} ${v}`),
    ].join('/'),
    type: 'sequence',
    batch,
    group: 'sequence',
    label: batch,
    ...stood('horizon', size),
    caps,
    levers: levers('horizon', { ...ON, ...caps }),
    events: events(stood('horizon', size).stance, 'fair-cumulus'),
  })
  return {
    // Choices: every pair of caps at `sunRamp` 16, the ramp's own rule
    // reading the casts beside them.
    reset: (size) =>
      CAPS.sunSlices.flatMap((sunSlices) =>
        CAPS.farBlocks.map((farBlocks) =>
          run('reset', size, { sunSlices, farBlocks, sunRamp: 16 }),
        ),
      ),
    // Landed: the four at the caps the commit carries, B7's own row. A
    // name of its own, since a batch's name keys one list of runs.
    sequences: (size) => [run('sequences', size, {})],
  }
}
