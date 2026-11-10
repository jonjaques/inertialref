import { describe, expect, it } from 'vitest'
import './measure.mjs'
import {
  bandRule,
  capsRule,
  chainRule,
  clipRule,
  cpuRule,
  evaluate,
  holdAccepted,
  jitterRule,
  ladderRule,
  leanRule,
  overRecords,
  placementRule,
  rampRule,
  rulesTable,
  underBar,
} from './rules.mjs'

/*
 * Each rule of §7.4 and each bar of the rubric the runner computes, from
 * fixture documents shaped as the runner writes them: a rule firing, and the
 * same rule not firing, a figure apart.
 */

const stands = { scene: { settled: true }, quiet: { ok: true } }
let serial = 0
const doc = (...rows) => ({
  rows: rows.map((r) => ({ id: `r${serial++}`, ...stands, ...r })),
})
const ab = (scenario, size, delta, over = {}) => ({
  type: 'ab',
  kind: 'steady',
  group: 'landed',
  scenario,
  size,
  summary: {
    delta,
    spread: 0.02,
    allowance: 0.05,
    base: 6,
    candidate: 6 + delta,
  },
  ...over,
})
const byId = (rules, id) => rules.find((r) => r.id === id)

describe('a steady Δ against its bar', () => {
  it('is a miss only over the bar by more than its allowance', () => {
    expect(underBar(ab('horizon', '1080p', 4.04), 4.0)).toBe(true)
    expect(underBar(ab('horizon', '1080p', 4.06), 4.0)).toBe(false)
  })

  it('reads B1 to B4 off the targets, and a row that does not stand nowhere', () => {
    const targets = (horizon) =>
      doc(
        ab('ground', '1080p', 4.9),
        ab('horizon', '1080p', horizon),
        ab('inside', '1080p', 3.9),
        ab('orbit', '1080p', 1.5),
        ab('earth-orbit', '1080p', 1.62, { group: 'landed' }),
      )
    const pass = evaluate({ targets: targets(3.98) })
    expect(byId(pass, 'B2').outcome).toBe('pass')
    expect(byId(pass, 'B4').outcome).toBe('pass')
    expect(byId(pass, 'B2').figures[0]).toBe(
      'horizon: Δ 3.98 ms ± 0.05 ms against 4 ms',
    )
    expect(byId(evaluate({ targets: targets(4.2) }), 'B2').outcome).toBe('miss')
    // Marked under load: no row to read, so the bar says what is missing.
    const loud = doc({ ...ab('horizon', '1080p', 3.0), quiet: { ok: false } })
    expect(byId(evaluate({ targets: loud }), 'B2')).toMatchObject({
      outcome: 'undecided',
      figures: ['missing: targets at horizon'],
    })
  })

  it('holds B11 to horizon’s Δ plus 1 ms, and B10 Retina to 1080p’s plus 0.5', () => {
    const at = (overlay) =>
      evaluate({
        targets: doc(
          ab('horizon', '1080p', 3.5),
          ab('overlay', '1080p', overlay),
        ),
      })
    expect(byId(at(4.5), 'B11').outcome).toBe('pass')
    expect(byId(at(4.6), 'B11').outcome).toBe('miss')
    const sizes = (retina) =>
      evaluate({
        targets: doc(
          ...['ground', 'horizon', 'inside', 'orbit', 'earth-orbit'].flatMap(
            (s) => [ab(s, '1080p', 3), ab(s, 'retina', retina)],
          ),
        ),
      })
    expect(byId(sizes(3.5), 'B10').outcome).toBe('pass')
    expect(byId(sizes(3.6), 'B10').outcome).toBe('miss')
  })
})

describe('the whole frame', () => {
  const frame = (scenario, size, off, on) => ({
    type: 'frame',
    scenario,
    size,
    sides: {
      off: { median: off * 0.9, p95: off },
      on: { median: on * 0.9, p95: on },
    },
  })

  it('reads B6 at 1080p and B8 at Retina on the cornerstones', () => {
    const at = (p95) =>
      evaluate({
        frame: doc(
          frame('ground', '1080p', 6, p95),
          frame('g1', 'retina', 12, 30),
        ),
      })
    expect(byId(at(14.6), 'B6').outcome).toBe('pass')
    expect(byId(at(14.7), 'B6')).toMatchObject({
      outcome: 'miss',
      figures: expect.arrayContaining(['ground: p95 14.70 ms']),
    })
    expect(byId(at(14.6), 'B8').outcome).toBe('pass')
  })

  it('names a Retina stance a B9 miss where off holds 60 Hz and on does not', () => {
    const at = (on) =>
      evaluate({ frame: doc(frame('ground', 'retina', 15, on)) })
    expect(byId(at(16.5), 'B9').outcome).toBe('pass')
    expect(byId(at(19), 'B9')).toMatchObject({
      outcome: 'miss',
      figures: ['ground: off p95 15.00 ms, on p95 19.00 ms'],
    })
  })
})

describe('the hold and the bars that wait for it', () => {
  const window = (hz, late = 0) => ({
    drawnHz: hz,
    presentedHz: hz,
    late,
    frames: hz * 3,
    sensorMs: 7,
  })
  const pace = (group, scenario, arms, extra = {}) => ({
    type: 'pace',
    group,
    scenario,
    size: '1080p',
    hold: 'page',
    arms: arms.map(([name, hz, late]) => ({
      name,
      samples: [window(hz, late)],
      rate: { median: hz, one: true, outside: [] },
      late,
      frames: hz * 3,
      sensorMs: 7,
    })),
    ...extra,
  })
  const hold = (...rates) =>
    doc(...rates.map((hz) => pace('acceptance', 'horizon', [['off', hz, 0]])))

  it('is accepted on three rows inside 58 to 62 Hz, and not on one outside', () => {
    expect(holdAccepted({ hold: hold(59.8, 60.1, 60.0) })).toMatchObject({
      outcome: 'pass',
      accepted: true,
    })
    expect(holdAccepted({ hold: hold(59.8, 63.0, 60.0) }).accepted).toBe(false)
    // Slower than the band: the record says the hold was not reached.
    expect(holdAccepted({ hold: hold(59.8, 51.2, 60.0) }).figures).toEqual([
      '59.8, 51.2, 60.0 Hz, held by the page: frames drawn, not frames presented',
      'the hold was not reached: the frames came slower than 58 Hz',
    ])
    expect(holdAccepted({ hold: hold(59.8, 60.0) })).toMatchObject({
      outcome: 'undecided',
      accepted: false,
    })
  })

  it('binds B14 at the hold, and records it only without one', () => {
    const late = (on) =>
      doc(
        pace('late', 'orbit', [
          ['off', 60, 1],
          ['on', 60, on],
        ]),
      )
    const held = hold(60, 60, 60)
    expect(byId(evaluate({ hold: held, pace: late(3) }), 'B14').outcome).toBe(
      'pass',
    )
    // Held by the page, the reading says it is the page's.
    expect(
      byId(evaluate({ hold: held, pace: late(3) }), 'B14').figures,
    ).toContain(
      "held by the page: the rate is the page's, frames drawn and not frames the compositor presented",
    )
    expect(byId(evaluate({ hold: held, pace: late(4) }), 'B14').outcome).toBe(
      'miss',
    )
    const loose = hold(118, 119, 118)
    expect(byId(evaluate({ hold: loose, pace: late(4) }), 'B14')).toMatchObject(
      {
        outcome: 'recorded',
        figures: expect.arrayContaining(['no 60 Hz hold: recorded only']),
      },
    )
  })

  it('binds B15 at 58 Hz and B13 at the steady median plus 16.7 ms', () => {
    const held = hold(60, 60, 60)
    const rate = (hz) => doc(pace('rate', 'g1', [['on', hz, 0]]))
    expect(
      byId(evaluate({ hold: held, pace: rate(58.4) }), 'B15').outcome,
    ).toBe('pass')
    expect(
      byId(evaluate({ hold: held, pace: rate(57.9) }), 'B15').outcome,
    ).toBe('miss')
    const cold = (first) =>
      doc({
        type: 'cold',
        boot: 1,
        flag: true,
        spans: { warmUp: 4000 },
        bytes: 8e7,
        hitch: { first, steady: 16.7 },
        operatingPoint: { presentHz: 60 },
      })
    expect(
      byId(evaluate({ hold: held, pace: cold(33.3) }), 'B13').outcome,
    ).toBe('pass')
    expect(
      byId(evaluate({ hold: held, pace: cold(33.5) }), 'B13').outcome,
    ).toBe('miss')
  })

  it('sends the placement back on late frames or frames presented, at one rate a cell', () => {
    const cell = (scenario, lean) =>
      pace('placement', scenario, [
        ['passes', 60, 1],
        ['lean', 60, lean],
        ['chain, nothing over', 60, 0],
      ])
    const held = hold(60, 60, 60)
    expect(
      placementRule({
        hold: held,
        over: doc(cell('inside', 2), cell('overlay', 1)),
      }).outcome,
    ).toBe('pass')
    expect(
      placementRule({
        hold: held,
        over: doc(cell('inside', 3), cell('overlay', 1)),
      }),
    ).toMatchObject({
      outcome: 'miss',
      figures: expect.arrayContaining(['goes back: inside: lean']),
    })
    // A cell of two rates is read by no rule.
    const split = cell('inside', 0)
    split.arms[0].rate = { median: 60, one: false, outside: [57] }
    expect(
      placementRule({ hold: held, over: doc(split, cell('overlay', 1)) })
        .outcome,
    ).toBe('recorded')
  })

  it('names a form cheaper on the CPU only past 0.3 ms and twice its spread', () => {
    const sensor = (ms) =>
      Array.from({ length: 9 }, (_, k) => ({ sensorMs: ms + (k % 2) * 0.01 }))
    const row = (lean) => ({
      type: 'pace',
      scenario: 'inside',
      size: 'retina',
      arms: [
        {
          name: 'passes',
          samples: sensor(10),
          rate: { median: 60, one: true },
        },
        {
          name: 'lean',
          samples: sensor(lean),
          rate: { median: 60, one: true },
        },
        {
          name: 'chain, nothing over',
          samples: sensor(10),
          rate: { median: 60, one: true },
        },
      ],
    })
    expect(cpuRule({ over: doc(row(9.5)) }).figures[0]).toMatch(/, cheaper$/)
    expect(cpuRule({ over: doc(row(9.8)) }).figures[0]).not.toMatch(/cheaper/)
  })
})

describe('the choices', () => {
  const noise = (batch, scenario, size, arms, compares = []) => ({
    type: 'noise',
    batch,
    scenario,
    size,
    arms,
    compares,
  })
  const arm = (name, temporalRms, eighthError = 0.05) => ({
    name,
    temporalRms,
    eighthError,
    texels: 900,
  })

  it('replaces ign with stbn only where it is 20% quieter, settles as fast and costs nothing over', () => {
    const rows = (stbn, cost) =>
      doc(
        ...['horizon', 'inside'].flatMap((s) =>
          ['1080p', 'retina'].flatMap((size) => [
            noise('jitter', s, size, [arm('ign', 0.05), arm('stbn', stbn)]),
            ab(s, size, cost, { group: 'cost', label: 'stbn' }),
          ]),
        ),
      )
    expect(jitterRule({ jitter: rows(0.04, 0.06) }).value).toBe('stbn')
    // 19% quieter is not enough.
    expect(jitterRule({ jitter: rows(0.0405, 0.06) }).value).toBe('ign')
    // Nor is a cost 0.02 ms over the resolution.
    expect(jitterRule({ jitter: rows(0.04, 0.07) }).value).toBe('ign')
  })

  it('takes the smallest band within B of band 3 whose casts are clean', () => {
    const rows = doc(
      ...['earth-limb', 'descent-150'].map((s) =>
        noise(
          'handover',
          s,
          '1080p',
          [],
          [
            { a: 'band 1', b: 'band 3', relative: 0.03 },
            { a: 'band 1.5', b: 'band 3', relative: 0.008 },
            { a: 'band 2', b: 'band 3', relative: 0.004 },
          ],
        ),
      ),
    )
    const clean = { 1: 'clean', 1.5: 'clean', 2: 'clean', 3: 'clean' }
    expect(
      bandRule({ handover: rows }, { handoverB: 0.01, casts: { band: clean } })
        .value,
    ).toBe(1.5)
    expect(
      bandRule(
        { handover: rows },
        { handoverB: 0.01, casts: { band: { ...clean, 1.5: 'step' } } },
      ).value,
    ).toBe(2)
    expect(
      bandRule({ handover: rows }, { casts: { band: clean } }),
    ).toMatchObject({
      outcome: 'undecided',
      figures: ['missing: cloudHandover’s B'],
    })
  })

  it('takes the narrowest clip under 1% bias whose casts leave no trail', () => {
    const rows = (bias) =>
      doc(
        noise(
          'clip',
          'horizon',
          '1080p',
          [],
          [
            { a: 'clip 1.25', b: 'unclipped', relative: 0.01, worst: bias },
            { a: 'clip 1.5', b: 'unclipped', relative: 0.005, worst: 0.006 },
            { a: 'clip 2', b: 'unclipped', relative: 0.002, worst: 0.003 },
          ],
        ),
      )
    const clean = { clip: { 1.25: 'clean', 1.5: 'clean', 2: 'clean' } }
    expect(clipRule({ clip: rows(0.009) }, { casts: clean }).value).toBe(1.25)
    expect(clipRule({ clip: rows(0.021) }, { casts: clean }).value).toBe(1.5)
  })

  it('climbs a ladder to the smallest value within 1% of the next, at every stance', () => {
    const ladder = (scenario, worst) => ({
      type: 'radiance',
      label: 'maxSteps',
      scenario,
      size: '1080p',
      differences: [
        { name: '96 against 128', relative: 0.03, floor: 0.001 },
        { name: '128 against 192', relative: worst, floor: 0.001 },
        { name: '192 against 256', relative: 0.0002, floor: 0.001 },
      ],
    })
    expect(
      ladderRule(
        { ladders: doc(ladder('horizon', 0.008), ladder('inside', 0.009)) },
        'maxSteps',
      ).value,
    ).toBe(128)
    expect(
      ladderRule(
        { ladders: doc(ladder('horizon', 0.008), ladder('inside', 0.012)) },
        'maxSteps',
      ).value,
    ).toBe(192)
    // farFootprint reads earth-limb as well.
    expect(
      ladderRule(
        { ladders: doc(ladder('horizon', 0.008), ladder('inside', 0.009)) },
        'farFootprint',
      ),
    ).toMatchObject({ outcome: 'undecided' })
  })

  it('makes chain the form only cheaper, equal on the GPU, and inside B10’s growth', () => {
    // Y's rig: chain 0.42 ms under passes at 1080p and 1.34 at Retina, and
    // its Δ over the clouds off 2.68 at 1080p and 4.18 at Retina.
    const rows = ({
      delta = -0.42,
      retinaDelta = -1.34,
      off = 2.68,
      offRetina = 4.18,
    } = {}) =>
      doc(
        ...['orbit', 'horizon'].flatMap((s) => [
          ab(s, '1080p', delta, {
            group: 'chain',
            label: 'chain',
            batch: 'over',
            composite: 0.9,
          }),
          ab(s, 'retina', retinaDelta, {
            group: 'chain',
            label: 'chain',
            batch: 'over',
            composite: 2.24,
          }),
          ab(s, '1080p', off, {
            group: 'clouds',
            label: 'chain',
            batch: 'over',
          }),
          ab(s, 'retina', offRetina, {
            group: 'clouds',
            label: 'chain',
            batch: 'over',
          }),
        ]),
      )
    // Y's figures: 1.5 ms of growth against 0.5, a miss, and it says why.
    const ys = chainRule({ over: rows() }, { chainEqual: true })
    expect(ys.outcome).toBe('miss')
    expect(ys.figures).toEqual(
      expect.arrayContaining([
        "orbit: chain's steady Δ grows 1.50 ms from 1080p to Retina, against 0.5 ms ± 0.05 ms",
        'fails: B10: its steady Δ grows by at most 0.5 ms from 1080p to Retina',
      ]),
    )
    // The form a row drew is recorded, and unknown until the report says.
    expect(ys.figures[0]).toMatch(/; form unknown, depth unknown$/)
    // Inside the bound, by its allowance and no more.
    expect(
      chainRule({ over: rows({ offRetina: 3.23 }) }, { chainEqual: true })
        .outcome,
    ).toBe('pass')
    expect(
      chainRule({ over: rows({ offRetina: 3.24 }) }, { chainEqual: true })
        .outcome,
    ).toBe('miss')
    // Not cheaper by the resolution, or not equal on the GPU: a miss.
    expect(
      chainRule(
        { over: rows({ delta: -0.04, offRetina: 3.0 }) },
        { chainEqual: true },
      ).outcome,
    ).toBe('miss')
    expect(
      chainRule({ over: rows({ offRetina: 3.0 }) }, { chainEqual: false })
        .outcome,
    ).toBe('miss')
    // The equality unread: undecided where every clause read holds, and a
    // miss all the same where one read fails.
    expect(chainRule({ over: rows({ offRetina: 3.0 }) }).outcome).toBe(
      'undecided',
    )
    expect(chainRule({ over: rows() }).outcome).toBe('miss')
    const lean = (delta) =>
      doc(ab('overlay', 'retina', delta, { group: 'lean', label: 'lean' }))
    expect(leanRule({ over: lean(-0.6) }, { leanEqual: true }).outcome).toBe(
      'pass',
    )
    expect(leanRule({ over: lean(0.1) }, { leanEqual: true }).outcome).toBe(
      'miss',
    )
  })

  it('records chain on the overlay, which is passes by construction, and the guard', () => {
    const records = (delta) =>
      overRecords({
        over: doc(
          ...['1080p', 'retina'].map((size) =>
            ab('overlay', size, delta, { group: 'overlay', label: 'chain' }),
          ),
          ab('guard', '1080p', -1.2, {
            group: 'guard',
            label: 'chain',
            baseSceneOver: 5.5,
          }),
        ),
      })
    const [overlay, guard] = records(0.03)
    expect(overlay.outcome).toBe('recorded')
    expect(overlay.figures.some((f) => /differs from passes/.test(f))).toBe(
      false,
    )
    expect(records(0.3)[0].figures).toContain(
      '1080p: differs from passes by more than the resolution',
    )
    expect(guard.figures[0]).toMatch(
      /guard 1080p chain: Δ -1\.20 ms .*scene over clouds 5\.50 ms/,
    )
  })

  it('takes the largest caps that hold B7’s clauses a quarter tighter, and the ramp that fits 44 frames', () => {
    const seq = (eventOver, laterOver, wholeAt) =>
      ['cut', 'scrub', 'weather', 'wake'].map((event) => ({
        event,
        eventOver,
        laterOver,
        wholeAt,
      }))
    const row = (sunSlices, farBlocks, laterOver, wholeAt = 38) => ({
      type: 'sequence',
      scenario: 'horizon',
      size: '1080p',
      caps: { sunSlices, farBlocks, sunRamp: 16 },
      sequences: seq(3.2, laterOver, wholeAt),
    })
    const reset = doc(
      row(4, 1, 0.4),
      row(4, 2, 0.6),
      row(8, 1, 1.2),
      row(8, 2, 1.4, 30),
      row(16, 1, 1.6),
      row(16, 2, 1.9),
    )
    expect(capsRule({ reset }).value).toEqual({ sunSlices: 8, farBlocks: 2 })
    // Nothing holds: 4 and 1.
    const none = doc(row(4, 1, 1.6), row(8, 1, 1.7))
    expect(capsRule({ reset: none }).value).toEqual({
      sunSlices: 4,
      farBlocks: 1,
    })
    const casts = { ramp: { 8: 'clean', 16: 'clean', 32: 'clean' } }
    // Whole at 30 at ramp 16: 22 at 8, 46 at 32 (derived), so 8.
    expect(rampRule({ reset }, { casts })).toMatchObject({
      value: 8,
      figures: expect.arrayContaining([
        'ramp 32: whole at 46 (derived), casts clean',
      ]),
    })
    expect(
      rampRule({ reset }, { casts: { ramp: { ...casts.ramp, 8: 'step' } } })
        .value,
    ).toBe(16)
  })
})

describe('the summary', () => {
  it('prints each outcome beside the figures it was computed from, and only for batches taken', () => {
    const rules = evaluate({
      targets: doc(ab('horizon', '1080p', 3.98)),
    })
    // Only the rules that read targets are listed; nothing of the frame batch.
    expect(rules.some((r) => r.id === 'B6')).toBe(false)
    const text = rulesTable(rules)
    expect(text).toMatch(
      /^\| B2: Steady Δ on horizon \| pass \| horizon: Δ 3\.98 ms ± 0\.05 ms against 4 ms \|$/m,
    )
    expect(text).toMatch(/Read by their instruments, not here: gate 1/)
  })
})
