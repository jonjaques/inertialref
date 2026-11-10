/*
 * The runner's whole-frame and presentation steps and their tables (phase 1
 * design §7.2, §7.5): the GPU frame's median and 95th percentile, the frame
 * log a presentation rate is read from, and the pacing study that finds what
 * sets that rate before anything holds it.
 *
 * **The whole frame** is one loop a row: `ir.passes(1)` 180 times in a held
 * pose, each a frame the page draws for the reading and times pass by pass,
 * summed. A held loop still steps the caches' refresh and the jitter, so the
 * percentile sees the frame that bakes a block. B6 and B8 read it, and B9's
 * two sides.
 *
 * **A frame log** is 3 s of the page: every `requestAnimationFrame`
 * timestamp, and `ir.profile` over the same window, whose frame spans are the
 * frames the engine drew, its late frames and the `sensor` span's mean. The
 * two rates differ exactly when something skips a callback without drawing,
 * which is how the page's own hold works; both are kept.
 *
 * **Every row that reads a rate is paced, or says it is not.** `--hold`
 * names how: by the display, awake in a 60 Hz mode, or by the page under
 * `pace=60`, which the game's frame loop reads. Neither exists until the
 * study says which can: a row taken without one records its rate and binds
 * nothing (rubric §5, B13 to B15).
 *
 * **The study** runs a clouds-off `horizon` at 1080p, 3 s at a time, in each
 * arm it can take: the display asleep and awake, the window in front and
 * where the rig puts it, and the page told it is occluded and not. An arm the
 * machine cannot give is recorded as not taken, with the reason; the study
 * never unlocks anything, and leaves a dark display dark.
 */
import { execFileSync, spawn } from 'node:child_process'
import { connect } from '../cdp.mjs'
import {
  NAMED,
  OPERATING,
  SETTLE_CAP,
  addKind,
  fixed,
  median,
  pageStep,
  plan,
  standing,
  table,
} from './page.mjs'

/** Frames a whole-frame side reads. */
export const FRAME_FRAMES = 180
/** A frame log's window: B14's and B15's 3 s. */
export const WINDOW_MS = 3000
/** The hold's band (§7.5): every row of the acceptance presents inside it. */
export const HELD_HZ = Object.freeze([58, 62])
/** A cell's samples pool only within this of the cell's median rate. */
export const CELL_SPREAD = 0.02

/**
 * @param {{kind: string} & Record<string, unknown>} step
 */
export async function frameStep(step) {
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
  const sorted = (xs) => [...xs].sort((a, b) => a - b)
  const at = (xs, q) => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))]

  const steps = {
    async whole() {
      set(step.levers)
      const settled = await settle(step.settleCap)
      const totals = []
      for (let i = 0; i < step.frames; i += 1) {
        const read = await ir.passes(1)
        if (read === null)
          throw new Error(
            'ir.passes answered null: no timestamp-query, or no presenting chain',
          )
        if (read.dropped > 0)
          throw new Error(`ir.passes dropped ${read.dropped}`)
        totals.push(read.passes.reduce((sum, p) => sum + p.ms, 0))
      }
      const s = sorted(totals)
      return {
        settled,
        frames: totals.length,
        median: at(s, 0.5),
        p95: at(s, 0.95),
        worst: s.at(-1),
        leversHash: report()?.leversHash ?? null,
      }
    },
    async window() {
      if (step.levers != null) set(step.levers)
      if (step.lit != null && typeof ir.lightEngine === 'function')
        ir.lightEngine(step.lit)
      const settled = await settle(step.settleCap)
      const stamps = []
      let sampling = true
      const tick = (t) => {
        stamps.push(t)
        if (sampling) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
      const profile = await ir.profile(step.ms)
      sampling = false
      const gaps = sorted(stamps.slice(1).map((t, i) => t - stamps[i]))
      const sensor = profile.spans.find((s) => s.name === 'sensor')
      return {
        settled,
        presentedHz:
          stamps.length > 1
            ? ((stamps.length - 1) * 1000) / (stamps.at(-1) - stamps[0])
            : null,
        intervalMs: gaps.length > 0 ? at(gaps, 0.5) : null,
        drawnHz:
          profile.windowMs > 0
            ? (profile.frames * 1000) / profile.windowMs
            : null,
        frames: profile.frames,
        late: profile.late.length,
        sensorMs: sensor?.meanMs ?? null,
      }
    },
  }
  const run = steps[step.kind]
  if (run === undefined) throw new Error(`no frame step ${String(step.kind)}`)
  return await run()
}

/* ------------------------------------------------------------- the Node half ---- */

const INSTALL = `(globalThis.irFrameStep = ${frameStep.toString()}, typeof globalThis.irFrameStep)`
const js = pageStep('irFrameStep')

/** A whole-frame side: the settle and 180 timed frames, each its own readback. */
const WHOLE_SECONDS = 12
/** A window: the settle, then 3 s of the page. */
const WINDOW_SECONDS = 5

/** The 95th percentile and median of one side, as the page sorted them. */
const side = (value) =>
  value == null
    ? null
    : { median: value.median, p95: value.p95, worst: value.worst }

addKind('frame', {
  install: INSTALL,
  steps: (run) =>
    ['off', 'on'].map((name) =>
      js(
        `whole:${name}`,
        {
          kind: 'whole',
          levers: run[name],
          frames: FRAME_FRAMES,
          settleCap: SETTLE_CAP,
        },
        WHOLE_SECONDS,
      ),
    ),
  read: (run, value) => ({
    sides: { off: side(value('whole:off')), on: side(value('whole:on')) },
    pageHash: value('whole:on')?.leversHash ?? null,
  }),
  unfit: (row) =>
    row.sides.off === null || row.sides.on === null
      ? 'the whole frame was not read'
      : null,
  table: (rows) =>
    table(rows, [
      ...NAMED,
      ['off: median ms', (r) => fixed(r.sides.off?.median)],
      ['off: p95 ms', (r) => fixed(r.sides.off?.p95)],
      ['on: median ms', (r) => fixed(r.sides.on?.median)],
      ['on: p95 ms', (r) => fixed(r.sides.on?.p95)],
      ['on: worst ms', (r) => fixed(r.sides.on?.worst)],
      ...OPERATING,
      ['quiet', standing],
    ]),
  progress: (r) =>
    `off ${fixed(r.sides.off?.median)}/${fixed(r.sides.off?.p95)}, on ${fixed(r.sides.on?.median)}/${fixed(r.sides.on?.p95)} ms (median/p95)`,
})

/**
 * Whether a cell's samples are one rate: each within 2% of their median
 * (§7.5). A cell of two rates is reported as two cells and no rule reads it.
 */
export function oneRate(rates) {
  const xs = rates.filter(Number.isFinite)
  if (xs.length === 0) return { median: null, one: false, outside: [] }
  const mid = median(xs)
  const outside = xs.filter((x) => Math.abs(x - mid) > CELL_SPREAD * mid)
  return { median: mid, one: outside.length === 0, outside }
}

/** The windows of a pace run, its arms interleaved sample by sample. */
const windows = (run) =>
  Array.from({ length: run.samples }, (_, k) =>
    run.arms.map((arm) =>
      js(
        `window:${arm.name}:${k}`,
        {
          kind: 'window',
          levers: arm.levers,
          lit: arm.lit ?? null,
          ms: WINDOW_MS,
          settleCap: SETTLE_CAP,
        },
        WINDOW_SECONDS,
      ),
    ),
  ).flat()

addKind('pace', {
  install: INSTALL,
  steps: windows,
  read: (run, value) => ({
    hold: run.hold ?? null,
    arm: run.arm ?? null,
    refresh: run.refresh ?? null,
    arms: run.arms.map((arm) => {
      const samples = Array.from(
        { length: run.samples },
        (_, k) => value(`window:${arm.name}:${k}`) ?? null,
      )
      const drawn = samples.map((s) => s?.drawnHz)
      return {
        name: arm.name,
        samples,
        rate: oneRate(drawn),
        late: median(samples.map((s) => s?.late).filter(Number.isFinite)),
        sensorMs: median(
          samples.map((s) => s?.sensorMs).filter(Number.isFinite),
        ),
        frames: median(samples.map((s) => s?.frames).filter(Number.isFinite)),
      }
    }),
  }),
  unfit: (row) => {
    if (row.notTaken != null) return null
    const blind = row.arms.find((a) => a.samples.some((s) => s === null))
    return blind === undefined ? null : `no frame log for ${blind.name}`
  },
  table: (rows) =>
    table(
      rows.flatMap((r) =>
        r.notTaken != null
          ? [{ ...r, armName: '—', armRate: null }]
          : r.arms.map((a) => ({
              ...r,
              ...a,
              armName: a.name,
              armRate: a.rate,
            })),
      ),
      [
        ...NAMED,
        ['Batch', (r) => r.batch],
        ['Arm', (r) => r.armName],
        ['held by', (r) => r.hold ?? '—'],
        ['study arm', (r) => (r.arm ? armName(r.arm) : '—')],
        ['drawn Hz (median)', (r) => fixed(r.armRate?.median, 1)],
        ['one rate', (r) => (r.armRate ? (r.armRate.one ? 'yes' : 'no') : '—')],
        [
          'presented Hz',
          (r) =>
            r.samples?.map((s) => fixed(s?.presentedHz, 1)).join(', ') ?? '—',
        ],
        ['late (median)', (r) => fixed(r.late, 0)],
        ['frames (median)', (r) => fixed(r.frames, 0)],
        ['sensor ms', (r) => fixed(r.sensorMs)],
        ['not taken', (r) => r.notTaken ?? '—'],
        ...OPERATING,
        ['quiet', standing],
      ],
    ),
  progress: (r) =>
    r.notTaken ??
    r.arms
      .map(
        (a) =>
          `${a.name} ${fixed(a.rate.median, 1)} Hz, late ${fixed(a.late, 0)}`,
      )
      .join('; '),
})

/* ------------------------------------------------------------ the pacing study ---- */

/** The study's arms: every way the rate might be set that the study can name. */
export const STUDY = Object.freeze({
  display: ['asleep', 'awake'],
  window: ['occluded', 'front'],
  presentation: ['occluded', 'presented'],
})
/** Windows an arm takes: enough that one late window does not decide its rate. */
export const STUDY_WINDOWS = 5
/** The display's hold, as an arm: awake, the rig's window where it is, the page told it is occluded. */
export const DISPLAY_HOLD = Object.freeze({
  display: 'awake',
  window: 'occluded',
  presentation: 'occluded',
})

const armName = (arm) =>
  `display ${arm.display}, window ${arm.window}, presentation ${arm.presentation}`

/** Where the rig's window goes for the window-in-front arm: the top left, then raised. */
const FRONT = Object.freeze({ left: 0, top: 0, windowState: 'normal' })

/** Whether `ioreg -n Root -d1 -a` says the console session is locked. */
export const screenLocked = (text) =>
  /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(text ?? '')

const quietly = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

/**
 * What the study does to the machine, each a function so a test can stand in
 * for it. Waking is `caffeinate -u`, held for the arm and let go after; the
 * campaign's own `caffeinate` leaves `-u` out for the reason the study
 * exists to test, that a lit lock screen over the rig paces it.
 */
export const MACHINE = Object.freeze({
  locked: () => screenLocked(quietly('ioreg', ['-n', 'Root', '-d1', '-a'])),
  asleep: () =>
    quietly('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'ObjC.import("CoreGraphics"); ObjC.bindFunction("CGDisplayIsAsleep", ["bool", ["uint32"]]); ObjC.bindFunction("CGMainDisplayID", ["uint32", []]); $.CGDisplayIsAsleep($.CGMainDisplayID())',
    ]) === 'true',
  sleep: () => quietly('pmset', ['displaysleepnow']),
  wake: () => {
    const held = spawn('caffeinate', ['-u', '-t', '600'], { stdio: 'ignore' })
    return () => held.kill('SIGTERM')
  },
  front: (port) => placeWindow(port, FRONT),
})

/** Moves the rig's window over DevTools and raises it; the bounds it ended at. */
async function placeWindow(port, bounds) {
  const base = `http://127.0.0.1:${port}`
  const page = (await (await fetch(`${base}/json/list`)).json()).find(
    (t) => t.type === 'page',
  )
  const { webSocketDebuggerUrl } = await (
    await fetch(`${base}/json/version`)
  ).json()
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((open, fail) => {
    ws.addEventListener('open', open, { once: true })
    ws.addEventListener('error', fail, { once: true })
  })
  const { send } = connect(ws)
  try {
    const { windowId } = await send('Browser.getWindowForTarget', {
      targetId: page.id,
    })
    await send('Browser.setWindowBounds', { windowId, bounds })
    await send('Target.activateTarget', { targetId: page.id })
    return (await send('Browser.getWindowBounds', { windowId })).bounds
  } finally {
    ws.close()
  }
}

/**
 * Why an arm cannot be taken on this machine now, or null. The page is told
 * it is occluded by drive.mjs on every URL (`scripts/driveUrl.mjs`), with no
 * flag to leave it off, so a presented arm needs a driver that offers one.
 * An awake display over a locked session shows the lock screen over the rig,
 * which phase 0 found paces it at 51 to 68 Hz, and the study unlocks nothing.
 */
export function armRefusal(arm, machine = MACHINE) {
  if (arm.presentation === 'presented')
    return 'drive.mjs sets ?presentation=occluded on every URL and offers no flag to leave it off'
  if (arm.display === 'awake' && machine.locked())
    return 'the session is locked, so an awake display shows the lock screen over the rig; the runner unlocks nothing'
  return null
}

/** An arm's steps in order: the plan, the window moved after the stance where the arm asks. */
export function armPlan(run) {
  return plan(run)
}

/**
 * One arm, from a machine set as the arm asks to the frame log, and the
 * machine put back: a display that was dark is dark again. With the window
 * in front, the page is booted and stood first, the window raised over
 * DevTools, and the windows taken on a second invocation that attaches.
 */
export async function studyArm(run, ctx, invoke, machine = MACHINE) {
  const arm = run.arm
  const why = armRefusal(arm, machine)
  if (why !== null)
    return {
      steps: [],
      out: { results: [], operatingPoint: {}, notTaken: why },
    }
  const dark = machine.asleep()
  const release = arm.display === 'awake' ? machine.wake() : null
  if (arm.display === 'asleep') machine.sleep()
  try {
    const steps = armPlan(run)
    if (arm.window !== 'front') return { steps, out: await invoke(steps) }
    const cut = steps.findIndex((s) => s.tag === 'rate')
    const head = steps.slice(0, cut)
    const first = await invoke(head)
    const bounds = await machine.front(ctx.port)
    // The page is the same document on the attach, and installs again all
    // the same: a step that finds no function would end the arm.
    const tail = [...steps.slice(0, 2), ...steps.slice(cut)]
    const second = await invoke(tail)
    return {
      steps: [...head, ...tail],
      out: {
        ...second,
        results: [...(first.results ?? []), ...(second.results ?? [])],
        window: bounds,
      },
    }
  } finally {
    release?.()
    if (dark && !machine.asleep()) machine.sleep()
  }
}

/* --------------------------------------------------------------- the batches ---- */

/** The forms of the composite the `over` batch prices against `passes`. */
export const FORMS = Object.freeze(['chain', 'lean'])

/** Rows the hold's acceptance takes, consecutively, each inside `HELD_HZ`. */
export const ACCEPTANCE_ROWS = 3

export function frameBatches(kit) {
  const { ab, stood, levers, ON, OFF, TARGETS, PRESETS } = kit
  const whole = (scenario, size) => ({
    id: ['frame', 'whole', scenario, size].join('/'),
    type: 'frame',
    batch: 'frame',
    group: 'whole',
    label: 'frame',
    ...stood(scenario, size),
    on: levers(scenario, ON),
  })
  /** A paced run of frame logs: `samples` windows of each arm, interleaved. */
  const pace = (batch, group, scenario, size, arms, samples, extra = {}) => ({
    id: [batch, group, scenario, size, ...(extra.idTail ?? [])].join('/'),
    type: 'pace',
    batch,
    group,
    label: group,
    ...stood(scenario, size),
    paced: true,
    samples,
    arms: arms.map(([name, over, lit]) => ({
      name,
      levers: levers(scenario, over),
      ...(lit === undefined ? {} : { lit }),
    })),
    ...extra,
  })
  const off = [['off', OFF]]
  const offOn = [
    ['off', OFF],
    ['on', ON],
  ]
  return {
    frame: (size) => [...TARGETS, ...PRESETS].map((s) => whole(s, size)),
    // Before a campaign's first batch: one profiled row, its rate recorded.
    pacing: (size) =>
      size === '1080p'
        ? [pace('pacing', 'check', 'horizon', size, off, 1)]
        : [],
    // The hold's acceptance: three consecutive rows, each inside 58 to 62 Hz.
    hold: (size) =>
      size === '1080p'
        ? Array.from({ length: ACCEPTANCE_ROWS }, (_, i) =>
            pace('hold', 'acceptance', 'horizon', size, off, 1, {
              idTail: [String(i + 1)],
            }),
          )
        : [],
    // B13 to B15, at 1080p: the first five intervals of three cold boots,
    // late frames over matched windows from orbit and the ground, and the
    // rate each of B6's frames presents at.
    pace: (size) =>
      size !== '1080p'
        ? []
        : [
            ...[1, 2, 3].map((boot) => ({
              id: `pace/cold/clouds/ground/${size}/${boot}`,
              type: 'cold',
              batch: 'pace',
              ...stood('ground', size),
              paced: true,
              flag: true,
              boot,
              levers: levers('ground', ON),
            })),
            ...['orbit', 'ground'].map((s) =>
              pace('pace', 'late', s, size, offOn, 3),
            ),
            ...[...TARGETS, ...PRESETS].map((s) =>
              pace('pace', 'rate', s, size, [['on', ON]], 1),
            ),
          ],
    // `chain` and `lean` each against `passes`; one row each under the
    // temporal picture on `horizon`; and at Retina the placement's cell,
    // nine samples a side at the hold, against `chain`'s frame without the
    // overlay.
    over: (size) => [
      ...['orbit', 'horizon', 'inside', 'shore', 'overlay'].flatMap((s) =>
        FORMS.map((form) =>
          ab('over', 'form', form, s, size, 'steady', {
            base: { ...ON, over: 'passes' },
            candidate: { ...ON, over: form },
          }),
        ),
      ),
      ...(size === '1080p'
        ? FORMS.map((form) => ({
            ...ab('over', 'temporal', form, 'horizon', size, 'steady', {
              base: { ...ON, over: 'passes' },
              candidate: { ...ON, over: form },
              query: ['picture=temporal:quality'],
            }),
          }))
        : []),
      ...(size === 'retina'
        ? ['inside', 'overlay'].map((s) =>
            pace(
              'over',
              'placement',
              s,
              size,
              [
                ['passes', { ...ON, over: 'passes' }],
                ['lean', { ...ON, over: 'lean' }],
                ['chain, nothing over', { ...ON, over: 'chain' }, false],
              ],
              9,
            ),
          )
        : []),
    ],
    // The study: clouds-off `horizon` at 1080p, three windows an arm.
    study: (size, held, options = {}) =>
      size !== '1080p'
        ? []
        : STUDY.display.flatMap((display) =>
            STUDY.window.flatMap((window) =>
              STUDY.presentation.map((presentation) =>
                pace('study', 'arm', 'horizon', size, off, STUDY_WINDOWS, {
                  idTail: [display, window, presentation],
                  arm: { display, window, presentation },
                  refresh: options.refresh ?? 'as set',
                  paced: false,
                }),
              ),
            ),
          ),
  }
}
