/*
 * The decision rules of phase 1 (design §7.4) and the rubric's budget bars
 * (`design/plans/weather/mvp.md` §5), each computed from the runner's batch
 * documents rather than applied by hand: phase 0's were each read off a
 * table, and its council found the readings could not be checked.
 *
 * A rule is a function of the documents, by batch name, and of the inputs a
 * batch cannot carry: the casts' verdicts, the footprint disagreement
 * `cloudHandover` measures, and the GPU tests' equalities. Its outcome is one
 * of `pass`, `miss`, `chosen` (with the value), `recorded` (a figure with no
 * bar), or `undecided` (with what it is missing), and it carries the figures
 * it was computed from, so the summary prints the outcome beside them.
 *
 * Only a row that stands is read (`measured`: quiet, every figure there), at
 * its latest attempt, and never one recorded as not taken. A Δ over its bar by less than its row's allowance, twice
 * its pairs' spread and at least 0.05 ms, is not a miss (rubric §5); the
 * runner already took again every row whose allowance would pass 0.25 ms.
 *
 * Rules that read an instrument's own output and no batch (the two gates, the
 * winner, the octave count, the dark edge, the volume's cut, the bake under
 * the horizon, the phase's radius) are listed with the file they read and
 * left to that instrument's package: its format is not this runner's.
 */
import { latest, measured } from './page.mjs'
import { CLIPS, BANDS } from './noise.mjs'
import { CAPS } from './sequence.mjs'
import { ACCEPTANCE_ROWS, HELD_HZ } from './frame.mjs'

const ms = (x) => (Number.isFinite(x) ? `${x.toFixed(2)} ms` : '—')
const pc = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '—')

/** The rows of a batch that stand, at their latest attempt. */
export const standing = (docs, batch) =>
  latest(docs[batch]?.rows ?? []).filter(
    (r) => measured(r) && r.notTaken == null,
  )

const find = (rows, match) =>
  rows.find((r) => Object.entries(match).every(([k, v]) => r[k] === v))

const undecided = (id, title, missing) => ({
  id,
  title,
  outcome: 'undecided',
  figures: [`missing: ${missing}`],
})

/**
 * A steady Δ against a bar: a pass where it is under the bar by more than
 * nothing, or over it by less than its allowance.
 */
export function underBar(row, bar) {
  const { delta, allowance } = row.summary
  return delta <= bar + allowance
}

/* -------------------------------------------------------------- the bars ---- */

const STEADY_BARS = [
  ['B1', 'Steady Δ on ground', ['ground'], 5.0],
  ['B2', 'Steady Δ on horizon', ['horizon'], 4.0],
  ['B3', 'Steady Δ on inside', ['inside'], 4.0],
  ['B4', 'Steady Δ from orbit at a 60° lens', ['orbit', 'earth-orbit'], 1.6],
]

function steadyBar([id, title, stances, bar], docs) {
  const rows = standing(docs, 'targets')
  const read = stances.map((scenario) =>
    rows.find(
      (r) =>
        r.scenario === scenario &&
        r.size === '1080p' &&
        r.kind === 'steady' &&
        r.group === 'landed',
    ),
  )
  const gone = stances.filter((_, i) => read[i] === undefined)
  if (gone.length > 0)
    return undecided(id, title, `targets at ${gone.join(', ')}`)
  return {
    id,
    title,
    outcome: read.every((r) => underBar(r, bar)) ? 'pass' : 'miss',
    figures: read.map(
      (r) =>
        `${r.scenario}: Δ ${ms(r.summary.delta)} ± ${ms(r.summary.allowance)} against ${bar} ms`,
    ),
  }
}

function b5(docs) {
  const r = find(standing(docs, 'targets'), {
    scenario: 'earth-orbit-long',
    size: '1080p',
    kind: 'steady',
  })
  return r === undefined
    ? undecided('B5', 'Steady Δ at E1’s lens', 'targets at earth-orbit-long')
    : {
        id: 'B5',
        title: 'Steady Δ at E1’s lens',
        outcome: 'recorded',
        figures: [`Δ ${ms(r.summary.delta)} ± ${ms(r.summary.allowance)}`],
      }
}

/** B6 and B8: the whole frame's 95th percentile under a bar on every row of a size. */
function wholeBar(id, title, size, bar, docs, only = null) {
  const rows = standing(docs, 'frame').filter(
    (r) => r.size === size && (only === null || only.includes(r.scenario)),
  )
  if (rows.length === 0) return undecided(id, title, `frame at ${size}`)
  const over = rows.filter((r) => !(r.sides.on.p95 < bar))
  return {
    id,
    title,
    outcome: over.length === 0 ? 'pass' : 'miss',
    figures: [
      `${rows.length} stances; worst p95 ${ms(Math.max(...rows.map((r) => r.sides.on.p95)))} against ${bar} ms`,
      ...over.map((r) => `${r.scenario}: p95 ${ms(r.sides.on.p95)}`),
    ],
  }
}

/** B7 from the landed sequences: the event's frame, every later frame, and whole by 48. */
function b7(docs) {
  const rows = standing(docs, 'sequences').filter((r) => r.size === '1080p')
  if (rows.length === 0)
    return undecided('B7', 'A reset, as a sequence', 'sequences at 1080p')
  const all = rows.flatMap((r) => r.sequences)
  const fails = all.filter(
    (s) =>
      !(s.eventOver <= 4) ||
      !(s.laterOver <= 2) ||
      s.wholeAt === null ||
      s.wholeAt > 48,
  )
  return {
    id: 'B7',
    title: 'A reset, as a sequence',
    outcome: fails.length === 0 ? 'pass' : 'miss',
    figures: all.map(
      (s) =>
        `${s.event}: event +${ms(s.eventOver)}, later +${ms(s.laterOver)}, whole at ${s.wholeAt ?? 'none'}`,
    ),
  }
}

/** B9: at Retina, a stance whose clouds-off frame holds 60 Hz and whose clouds-on one does not. */
function b9(docs) {
  const rows = standing(docs, 'frame').filter((r) => r.size === 'retina')
  if (rows.length === 0)
    return undecided('B9', 'Retina against 60 Hz', 'frame at retina')
  const frame = 1000 / 60
  const misses = rows.filter(
    (r) => r.sides.off.p95 <= frame && !(r.sides.on.p95 <= frame),
  )
  return {
    id: 'B9',
    title: 'Retina against 60 Hz',
    outcome: misses.length === 0 ? 'pass' : 'miss',
    figures: misses.map(
      (r) =>
        `${r.scenario}: off p95 ${ms(r.sides.off.p95)}, on p95 ${ms(r.sides.on.p95)}`,
    ),
  }
}

/** B10: Retina's steady Δ within 0.5 ms of 1080p's, on B1 to B4's stances. */
function b10(docs) {
  const rows = standing(docs, 'targets').filter(
    (r) => r.kind === 'steady' && r.group === 'landed',
  )
  const stances = ['ground', 'horizon', 'inside', 'orbit', 'earth-orbit']
  const pairs = stances.map((s) => [
    s,
    find(rows, { scenario: s, size: '1080p' }),
    find(rows, { scenario: s, size: 'retina' }),
  ])
  const gone = pairs.filter(([, a, b]) => !a || !b).map(([s]) => s)
  if (gone.length > 0)
    return undecided('B10', 'Retina’s Δ against 1080p’s', gone.join(', '))
  const over = pairs.filter(
    ([, a, b]) =>
      b.summary.delta - a.summary.delta >
      0.5 + Math.max(a.summary.allowance, b.summary.allowance),
  )
  return {
    id: 'B10',
    title: 'Retina’s Δ against 1080p’s',
    outcome: over.length === 0 ? 'pass' : 'miss',
    figures: pairs.map(
      ([s, a, b]) => `${s}: ${ms(a.summary.delta)} and ${ms(b.summary.delta)}`,
    ),
  }
}

/** B11: the Δ on `overlay` at most 1.0 ms over `horizon`'s at 1080p. */
function b11(docs) {
  const rows = standing(docs, 'targets').filter(
    (r) => r.kind === 'steady' && r.size === '1080p',
  )
  const [o, h] = ['overlay', 'horizon'].map((s) => find(rows, { scenario: s }))
  if (!o || !h)
    return undecided(
      'B11',
      'Something drawn over the clouds',
      'overlay and horizon',
    )
  const over = o.summary.delta - h.summary.delta
  const allowance = Math.max(o.summary.allowance, h.summary.allowance)
  return {
    id: 'B11',
    title: 'Something drawn over the clouds',
    outcome: over <= 1.0 + allowance ? 'pass' : 'miss',
    figures: [`overlay ${ms(over)} over horizon, allowance ${ms(allowance)}`],
  }
}

/** B12: the declared bytes with one served body, the median of its boots. */
function b12(docs) {
  const rows = standing(docs, 'memory').filter(
    (r) => r.flag && r.bodies === 1 && Number.isFinite(r.bytes),
  )
  if (rows.length === 0)
    return undecided('B12', 'Memory, one served body', 'memory boots')
  const worst = Math.max(...rows.map((r) => r.bytes)) / 1e6
  return {
    id: 'B12',
    title: 'Memory, one served body',
    outcome: worst <= 80 ? 'pass' : 'miss',
    figures: [
      `${worst.toFixed(2)} MB declared, the largest of ${rows.length} boots`,
    ],
  }
}

/* ------------------------------------------------------------ the hold ---- */

const inBand = (hz) => hz >= HELD_HZ[0] && hz <= HELD_HZ[1]

/**
 * The hold's acceptance (§7.5): three consecutive clouds-off rows on
 * `horizon` at 1080p, each presenting at 58 to 62 Hz over 3 s by the page's
 * frame log. Read in the order they were taken.
 */
export function holdAccepted(docs) {
  const rows = standing(docs, 'hold')
  const rates = rows.map((r) => r.arms[0]?.rate.median ?? null)
  if (rows.length < ACCEPTANCE_ROWS)
    return {
      ...undecided(
        'hold',
        'The 60 Hz hold',
        `${ACCEPTANCE_ROWS - rows.length} acceptance rows`,
      ),
      accepted: false,
    }
  const accepted = rates.every(inBand)
  return {
    id: 'hold',
    title: 'The 60 Hz hold',
    outcome: accepted ? 'pass' : 'miss',
    accepted,
    figures: [
      `${rates.map((x) => x?.toFixed(1) ?? '—').join(', ')} Hz, held by ${rows[0].hold}`,
    ],
  }
}

/** A rate-bound bar: recorded only, with its rate, until the hold is accepted. */
const bound = (rule, docs) =>
  holdAccepted(docs).accepted || rule.outcome === 'undecided'
    ? rule
    : {
        ...rule,
        outcome: 'recorded',
        figures: [...rule.figures, 'no 60 Hz hold: recorded only'],
      }

/** B13: the largest of the first five intervals within 16.7 ms of the steady median. */
function b13(docs) {
  const rows = standing(docs, 'pace').filter((r) => r.type === 'cold')
  if (rows.length === 0)
    return undecided('B13', 'The first frames', 'pace cold boots')
  const over = rows.filter((r) => !(r.hitch.first - r.hitch.steady <= 16.7))
  return bound(
    {
      id: 'B13',
      title: 'The first frames',
      outcome: over.length === 0 ? 'pass' : 'miss',
      figures: rows.map(
        (r) =>
          `boot ${r.boot}: ${ms(r.hitch.first)} against ${ms(r.hitch.steady)} at ${r.operatingPoint.presentHz?.toFixed(0) ?? '—'} Hz`,
      ),
    },
    docs,
  )
}

/** B14: the clouds add at most two late frames over matched 3 s windows. */
function b14(docs) {
  const rows = standing(docs, 'pace').filter((r) => r.group === 'late')
  if (rows.length === 0)
    return undecided('B14', 'Late frames', 'pace late rows')
  const read = rows.map((r) => {
    const [off, on] = ['off', 'on'].map((n) => r.arms.find((a) => a.name === n))
    return { r, off, on, added: on.late - off.late }
  })
  return bound(
    {
      id: 'B14',
      title: 'Late frames',
      outcome: read.every((x) => x.added <= 2) ? 'pass' : 'miss',
      figures: read.map(
        (x) =>
          `${x.r.scenario}: ${x.off.late} off, ${x.on.late} on, at ${x.on.rate.median?.toFixed(1) ?? '—'} Hz`,
      ),
    },
    docs,
  )
}

/** B15: each of B6's frames presents at 58 Hz or more over 3 s. */
function b15(docs) {
  const rows = standing(docs, 'pace').filter((r) => r.group === 'rate')
  if (rows.length === 0) return undecided('B15', 'Pacing', 'pace rate rows')
  const slow = rows.filter((r) => !(r.arms[0].rate.median >= HELD_HZ[0]))
  return bound(
    {
      id: 'B15',
      title: 'Pacing',
      outcome: slow.length === 0 ? 'pass' : 'miss',
      figures: [
        `${rows.length} stances`,
        ...slow.map(
          (r) => `${r.scenario}: ${r.arms[0].rate.median?.toFixed(1)} Hz`,
        ),
      ],
    },
    docs,
  )
}

/* ------------------------------------------------------------- the choices ---- */

/**
 * The jitter: `stbn` replaces `ign` only if its converged noise is at least
 * 20% lower on both stances at both sizes, its eighth-frame error is not
 * higher, and its steady Δ is under 0.02 ms over the resolution.
 */
export function jitterRule(docs) {
  const rows = standing(docs, 'jitter')
  const noise = rows.filter((r) => r.type === 'noise')
  const cost = rows.filter((r) => r.type === 'ab')
  if (noise.length < 4 || cost.length < 4)
    return undecided('jitter', 'The jitter', 'the jitter batch’s eight rows')
  const arm = (r, n) => r.arms.find((a) => a.name === n)
  const quieter = noise.every(
    (r) => arm(r, 'stbn').temporalRms <= 0.8 * arm(r, 'ign').temporalRms,
  )
  const settles = noise.every(
    (r) => arm(r, 'stbn').eighthError <= arm(r, 'ign').eighthError,
  )
  const cheap = cost.every((r) => r.summary.delta < r.summary.allowance + 0.02)
  return {
    id: 'jitter',
    title: 'The jitter',
    outcome: 'chosen',
    value: quieter && settles && cheap ? 'stbn' : 'ign',
    figures: [
      ...noise.map(
        (r) =>
          `${r.scenario} ${r.size}: noise ${pc(arm(r, 'ign').temporalRms)} → ${pc(arm(r, 'stbn').temporalRms)}, 8th ${pc(arm(r, 'ign').eighthError)} → ${pc(arm(r, 'stbn').eighthError)}`,
      ),
      ...cost.map(
        (r) =>
          `${r.scenario} ${r.size}: Δ ${ms(r.summary.delta)} ± ${ms(r.summary.allowance)}`,
      ),
    ],
  }
}

/**
 * The handover's band: the smallest band whose zoom and slow descent show no
 * step (C1, C2) and whose 64-frame mean is within `B` of band 3's over cloud
 * texels on both stances and sizes; 3 if none. `inputs.handoverB` is the
 * fine and far marches' footprint disagreement `cloudHandover` measures, and
 * `inputs.casts.band[b]` is `'clean'` or `'step'`.
 */
export function bandRule(docs, inputs = {}) {
  const rows = standing(docs, 'handover')
  if (rows.length === 0)
    return undecided('band', 'The handover’s band', 'the handover batch')
  if (!Number.isFinite(inputs.handoverB))
    return undecided('band', 'The handover’s band', 'cloudHandover’s B')
  const casts = inputs.casts?.band ?? {}
  const near = (band) =>
    rows.every(
      (r) =>
        band === BANDS.at(-1) ||
        r.compares.find((c) => c.a === `band ${band}`).relative <=
          inputs.handoverB,
    )
  const passing = BANDS.filter((b) => casts[b] === 'clean' && near(b))
  const unread = BANDS.filter((b) => casts[b] === undefined)
  if (unread.length > 0 && passing.length === 0)
    return undecided(
      'band',
      'The handover’s band',
      `casts at ${unread.join(', ')}`,
    )
  return {
    id: 'band',
    title: 'The handover’s band',
    outcome: 'chosen',
    value: passing[0] ?? BANDS.at(-1),
    figures: rows.flatMap((r) =>
      r.compares.map(
        (c) =>
          `${r.scenario} ${r.size} ${c.a}: ${pc(c.relative)} against B ${pc(inputs.handoverB)}, casts ${casts[Number(c.a.split(' ')[1])] ?? 'unread'}`,
      ),
    ),
  }
}

/**
 * The clip: the smallest width whose bias is under 1% at the worst cloud
 * texel, on every stance and size, and whose two casts of C8 are under the
 * trail floor (`inputs.casts.clip[c]`, `'clean'` or `'trail'`). If none does
 * both, the widest that passes the trail floor, its bias recorded.
 */
export function clipRule(docs, inputs = {}) {
  const rows = standing(docs, 'clip')
  if (rows.length === 0) return undecided('clip', 'The clip', 'the clip batch')
  const casts = inputs.casts?.clip ?? {}
  const bias = (clip) =>
    Math.max(
      ...rows.map((r) => r.compares.find((c) => c.a === `clip ${clip}`).worst),
    )
  const trails = CLIPS.filter((c) => casts[c] === 'clean')
  if (CLIPS.some((c) => casts[c] === undefined))
    return undecided('clip', 'The clip', 'C8’s casts at every width')
  const both = trails.find((c) => bias(c) < 0.01)
  return {
    id: 'clip',
    title: 'The clip',
    outcome: both === undefined && trails.length === 0 ? 'undecided' : 'chosen',
    value: both ?? trails.at(-1) ?? null,
    figures: CLIPS.map(
      (c) => `clip ${c}: worst bias ${pc(bias(c))}, casts ${casts[c]}`,
    ),
  }
}

/**
 * The ladders: the smallest value whose image is within 1% of the next
 * larger one's, at every size, in `horizon` and `inside`, and for
 * `farFootprint` on `earth-limb` as well. A ladder whose every rung fails has
 * no value the rule sets: its top rung has no larger neighbor.
 */
export function ladderRule(docs, lever) {
  const rows = standing(docs, 'ladders').filter((r) => r.label === lever)
  const stances =
    lever === 'farFootprint'
      ? ['horizon', 'inside', 'earth-limb']
      : ['horizon', 'inside']
  const read = rows.filter((r) => stances.includes(r.scenario))
  const gone = stances.filter((s) => !read.some((r) => r.scenario === s))
  if (gone.length > 0)
    return undecided(`ladder ${lever}`, `The ${lever} ladder`, gone.join(', '))
  const names = read[0].differences.map((d) => d.name)
  const first = names.find((name) =>
    read.every(
      (r) => r.differences.find((d) => d.name === name).relative < 0.01,
    ),
  )
  return {
    id: `ladder ${lever}`,
    title: `The ${lever} ladder`,
    outcome: first === undefined ? 'undecided' : 'chosen',
    value: first === undefined ? null : Number(first.split(' ')[0]),
    figures: names.map(
      (name) =>
        `${name}: worst ${pc(Math.max(...read.map((r) => r.differences.find((d) => d.name === name).relative)))}`,
    ),
  }
}

/** A form's Δ against `passes` under the resolution, on every row asked. */
const cheaper = (rows) =>
  rows.length > 0 && rows.every((r) => r.summary.delta < -r.summary.allowance)

/**
 * The composite in the chain: `chain` is the form on a frame with nothing
 * over the clouds if its frame equals pass B's within a half-float step
 * (`inputs.chainEqual`, the GPU test) and its steady Δ is under `passes`'s
 * by more than the resolution on `orbit` and `horizon` at both sizes.
 */
export function chainRule(docs, inputs = {}) {
  const rows = standing(docs, 'over').filter(
    (r) =>
      r.type === 'ab' &&
      r.group === 'form' &&
      r.label === 'chain' &&
      ['orbit', 'horizon'].includes(r.scenario),
  )
  if (rows.length < 4)
    return undecided('chain', 'The composite in the chain', 'four `over` rows')
  if (typeof inputs.chainEqual !== 'boolean')
    return undecided(
      'chain',
      'The composite in the chain',
      'cloudOverPass’s equality',
    )
  return {
    id: 'chain',
    title: 'The composite in the chain',
    outcome: inputs.chainEqual && cheaper(rows) ? 'pass' : 'miss',
    figures: rows.map(
      (r) =>
        `${r.scenario} ${r.size}: Δ ${ms(r.summary.delta)} ± ${ms(r.summary.allowance)}`,
    ),
  }
}

/** Pass B's store: `lean` stays if its frame is equal on and off and it is cheaper on `overlay` at Retina. */
export function leanRule(docs, inputs = {}) {
  const row = find(standing(docs, 'over'), {
    type: 'ab',
    group: 'form',
    label: 'lean',
    scenario: 'overlay',
    size: 'retina',
  })
  if (row === undefined)
    return undecided(
      'lean',
      'Pass B’s store',
      'the `over` row on overlay at Retina',
    )
  if (typeof inputs.leanEqual !== 'boolean')
    return undecided('lean', 'Pass B’s store', 'cloudOverPass’s equality')
  return {
    id: 'lean',
    title: 'Pass B’s store',
    outcome: inputs.leanEqual && cheaper([row]) ? 'pass' : 'miss',
    figures: [
      `overlay Retina: Δ ${ms(row.summary.delta)} ± ${ms(row.summary.allowance)}`,
    ],
  }
}

/**
 * The placement: A goes back to the orchestrator if, on `overlay` and
 * `inside` at Retina, `passes` or `lean` has a median of late frames over
 * 3 s higher than `chain`'s without the overlay by more than 2, or presents
 * fewer frames by more than 2%. Read at the hold; at another rate it is
 * recorded only, and a cell of two rates is read by no rule.
 */
export function placementRule(docs) {
  const rows = standing(docs, 'over').filter((r) => r.type === 'pace')
  if (rows.length < 2)
    return undecided('placement', 'The placement', 'the two placement cells')
  const base = 'chain, nothing over'
  const split = rows.filter((r) => r.arms.some((a) => !a.rate.one))
  if (split.length > 0)
    return {
      id: 'placement',
      title: 'The placement',
      outcome: 'recorded',
      figures: split.map(
        (r) => `${r.scenario}: two rates in one cell, read by no rule`,
      ),
    }
  const back = rows.flatMap((r) => {
    const ref = r.arms.find((a) => a.name === base)
    return r.arms
      .filter((a) => a.name !== base)
      .filter(
        (a) => a.late - ref.late > 2 || a.frames < ref.frames * (1 - 0.02),
      )
      .map((a) => `${r.scenario}: ${a.name}`)
  })
  return bound(
    {
      id: 'placement',
      title: 'The placement',
      outcome: back.length === 0 ? 'pass' : 'miss',
      figures: [
        ...rows.flatMap((r) =>
          r.arms.map(
            (a) =>
              `${r.scenario} ${a.name}: late ${a.late}, frames ${a.frames}, sensor ${ms(a.sensorMs)}, ${a.rate.median?.toFixed(1)} Hz`,
          ),
        ),
        ...back.map((x) => `goes back: ${x}`),
      ],
    },
    docs,
  )
}

/**
 * The forms' CPU cost: a form whose `sensor` mean at Retina on `inside` is
 * under `passes`'s by more than 0.3 ms and by more than twice the spread of
 * the nine paired differences. It breaks a tie and decides nothing alone.
 */
export function cpuRule(docs) {
  const row = find(standing(docs, 'over'), { type: 'pace', scenario: 'inside' })
  if (row === undefined)
    return undecided(
      'cpu',
      'The forms’ CPU cost',
      'the placement cell on inside',
    )
  const sensor = (name) =>
    row.arms.find((a) => a.name === name).samples.map((s) => s.sensorMs)
  const passes = sensor('passes')
  const figures = ['lean', 'chain, nothing over'].map((name) => {
    const diffs = sensor(name).map((x, k) => x - passes[k])
    const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length
    const spread = Math.max(...diffs) - Math.min(...diffs)
    return { name, mean, spread, cheaper: -mean > 0.3 && -mean > 2 * spread }
  })
  return {
    id: 'cpu',
    title: 'The forms’ CPU cost',
    outcome: 'recorded',
    figures: figures.map(
      (f) =>
        `${f.name}: ${ms(f.mean)} against passes, spread ${ms(f.spread)}${f.cheaper ? ', cheaper' : ''}`,
    ),
  }
}

/**
 * The caps (B7's clauses, a quarter tighter): the largest `sunSlices` with a
 * `farBlocks` for which, in all four sequences on `horizon` at 1080p, the
 * event's frame is within 4 ms of the steady Δ and no later frame is over it
 * by more than 1.5 ms. Of two `farBlocks` that pass, the larger, which
 * finishes the atlas sooner for the ramp's rule. If none, 4 and 1.
 */
export function capsRule(docs) {
  const rows = standing(docs, 'reset').filter((r) => r.size === '1080p')
  if (rows.length === 0)
    return undecided('caps', 'The caps', 'the reset batch at 1080p')
  const holds = (r) =>
    r.sequences.every((s) => s.eventOver <= 4 && s.laterOver <= 1.5)
  const passing = rows
    .filter(holds)
    .sort(
      (a, b) =>
        b.caps.sunSlices - a.caps.sunSlices ||
        b.caps.farBlocks - a.caps.farBlocks,
    )
  const pick = passing[0]?.caps ?? {
    sunSlices: CAPS.sunSlices[0],
    farBlocks: CAPS.farBlocks[0],
  }
  return {
    id: 'caps',
    title: 'The caps',
    outcome: 'chosen',
    value: { sunSlices: pick.sunSlices, farBlocks: pick.farBlocks },
    figures: rows.map(
      (r) =>
        `slices ${r.caps.sunSlices}, blocks ${r.caps.farBlocks}: ${holds(r) ? 'holds' : 'fails'}; worst event +${ms(Math.max(...r.sequences.map((s) => s.eventOver)))}, later +${ms(Math.max(...r.sequences.map((s) => s.laterOver)))}`,
    ),
  }
}

/**
 * The grid's ramp: the smallest `sunRamp` of 8, 16 and 32 that, at the caps
 * chosen, leaves the field whole within 44 frames, and whose wake and cut
 * casts show no step (`inputs.casts.ramp[r]`). The batch takes the ramp at
 * 16 alone, so another ramp's frame is the measured one shifted by the ramp's
 * difference, which holds where the grid's weight is the last thing to
 * finish, and the figure says it is derived.
 */
export function rampRule(docs, inputs = {}) {
  const caps = capsRule(docs)
  if (caps.outcome !== 'chosen')
    return undecided('ramp', 'The grid’s ramp', 'the caps')
  const at = standing(docs, 'reset').find(
    (r) =>
      r.size === '1080p' &&
      r.caps.sunSlices === caps.value.sunSlices &&
      r.caps.farBlocks === caps.value.farBlocks,
  )
  if (at === undefined)
    return undecided(
      'ramp',
      'The grid’s ramp',
      'the reset row at the caps chosen',
    )
  const measuredAt = at.caps.sunRamp
  const last = Math.max(...at.sequences.map((s) => s.wholeAt ?? Infinity))
  const casts = inputs.casts?.ramp ?? {}
  const whole = (ramp) => last - measuredAt + ramp
  const pass = [8, 16, 32].find((r) => whole(r) <= 44 && casts[r] === 'clean')
  return {
    id: 'ramp',
    title: 'The grid’s ramp',
    outcome: pass === undefined ? 'undecided' : 'chosen',
    value: pass ?? null,
    figures: [8, 16, 32].map(
      (r) =>
        `ramp ${r}: whole at ${whole(r)}${r === measuredAt ? '' : ' (derived)'}, casts ${casts[r] ?? 'unread'}`,
    ),
  }
}

/** What reads an instrument's own output, and so is that instrument's package's to compute. */
export const INSTRUMENT_RULES = Object.freeze([
  ['gate 1', 'cloudSlab.gpu.test.ts'],
  ['gate 2', '.data/clouds/cumulus.json (cloudCumulus)'],
  ['the winner', 'gates 1 and 2'],
  ['the octave count', 'cloudSlab.gpu.test.ts, if O was built'],
  ['the dark edge', 'gates 1 and 2 with the term'],
  ['the phase’s radius', '.data/clouds/glory.json (cloudGlory)'],
  ['the volume’s cut', '.data/clouds/sunAccuracy.json (cloudSunAccuracy)'],
  ['the bake under the horizon', '.data/clouds/sunAccuracy.json at G3’s sun'],
])

/** Every rule a campaign's documents can decide, in §7.4's order, then the bars. */
export function evaluate(docs, inputs = {}) {
  return [
    holdAccepted(docs),
    jitterRule(docs),
    bandRule(docs, inputs),
    clipRule(docs, inputs),
    ...['maxSteps', 'lightTaps', 'farFootprint'].map((l) =>
      ladderRule(docs, l),
    ),
    chainRule(docs, inputs),
    leanRule(docs, inputs),
    placementRule(docs),
    cpuRule(docs),
    capsRule(docs),
    rampRule(docs, inputs),
    ...STEADY_BARS.map((b) => steadyBar(b, docs)),
    b5(docs),
    wholeBar('B6', 'The whole frame, clouds on', '1080p', 14.7, docs),
    b7(docs),
    wholeBar(
      'B8',
      'Retina, the whole frame',
      'retina',
      33.3,
      docs,
      PRESET_TAGS,
    ),
    b9(docs),
    b10(docs),
    b11(docs),
    b12(docs),
    b13(docs),
    b14(docs),
    b15(docs),
  ].filter((rule) => rule.outcome !== 'undecided' || relevant(rule, docs))
}

/** B8 is on the cornerstones alone. */
const PRESET_TAGS = [
  'e1',
  'e2',
  'e3',
  'g1',
  'g2',
  'g3',
  'g4',
  'g5',
  'g6',
  'guard',
]

/** An undecided rule is printed only where a batch it reads was in the campaign. */
const READS = {
  hold: ['hold'],
  jitter: ['jitter'],
  band: ['handover'],
  clip: ['clip'],
  chain: ['over'],
  lean: ['over'],
  placement: ['over'],
  cpu: ['over'],
  caps: ['reset'],
  ramp: ['reset'],
  B6: ['frame'],
  B7: ['sequences'],
  B8: ['frame'],
  B9: ['frame'],
  B12: ['memory'],
  B13: ['pace'],
  B14: ['pace'],
  B15: ['pace'],
}
const relevant = (rule, docs) =>
  (
    READS[rule.id] ?? (rule.id.startsWith('ladder') ? ['ladders'] : ['targets'])
  ).some((batch) => docs[batch] !== undefined)

/** The summary's table: each rule's outcome beside the figures it was computed from. */
export function rulesTable(rules) {
  const value = (r) =>
    r.value === undefined
      ? ''
      : `: ${
          typeof r.value === 'object' && r.value !== null
            ? Object.entries(r.value)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')
            : r.value
        }`
  return [
    '| Rule | Outcome | Figures |',
    '| --- | --- | --- |',
    ...rules.map(
      (r) =>
        `| ${r.id}: ${r.title} | ${r.outcome}${value(r)} | ${r.figures.join('; ')} |`,
    ),
    '',
    `Read by their instruments, not here: ${INSTRUMENT_RULES.map(([rule, from]) => `${rule} (${from})`).join('; ')}.`,
  ].join('\n')
}
