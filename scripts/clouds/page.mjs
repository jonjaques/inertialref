/*
 * The weather's measurement protocol: the steps a run takes in the rig's
 * page, the figures they come back as, and the tables those print in.
 * `scripts/clouds/measure.mjs` runs it; this file is what it runs.
 *
 * `cloudStep` travels as text. The runner installs its source in the page once
 * an invocation and calls it once a step, so it may name its argument, the
 * page's own globals (`engine`, `ir`, `requestAnimationFrame`) and nothing of
 * this module: every helper is declared inside it, and `measure.test.mjs`
 * runs its source in a context that holds nothing else. A committed `--file`
 * body would need a top-level `return`, which oxlint does not parse. The rest
 * is the protocol's Node half: `plan`, the drive.mjs steps of a run;
 * `figures`, what their results say; and the tables the ADRs copy.
 *
 * A step is small on purpose. The rig's DevTools channel times every command
 * out at 120 s (`scripts/cdp.mjs`), and five A/B pairs in one evaluation take
 * about three minutes, so a pair is two steps, one a side, run in order in one
 * invocation and one boot. A side is a settle of at most `SETTLE_CAP` frames
 * and three reads of `ir.gpu(135)`: under 25 s at 50 ms a frame.
 */
import { DEFAULT_CLOUD_LEVERS } from '../../apps/game/src/render/cloudLevers.ts'
import { histogramStats } from './diff.mjs'

/*
 * Every read spans whole cycles of the far bake, which draws one of its 45
 * blocks a frame (`FAR_CYCLE`, `cloudFarAtlas.ts`) and whose blocks cost what
 * the layer rows under them hold: at far-shore over fair-cumulus, 2.6–2.9 ms
 * for a block of the first layer's rows and 0–0.13 ms for each of the 27 over
 * the two layers the scenario does not have (measured, one frame a read). A
 * read of 120 frames carries 30 blocks past its two cycles, ±0.15 ms by
 * where the cursor stood, and a read of 4 frames inside the 27 cheap ones
 * reads the bake as nothing.
 */
const FAR_CYCLE = 45
/**
 * One `ir.passes` read stays under one query set's 2,048 passes and spans one
 * far cycle; a frame of more than 44 passes cannot, and is read as far as fits.
 */
export const PASS_LIMIT = Object.freeze({ passes: 2000, frames: FAR_CYCLE })
/** Frames a side waits for the report's settle: past the far atlas's 45-frame cycle. */
export const SETTLE_CAP = 240
const GPU_READS = { reads: 3, n: 3 * FAR_CYCLE }
/** Captures a radiance side averages, and the frames it waits past the settle first: see the `radiance` step. */
export const RADIANCE_FRAMES = 64
const RADIANCE_CONVERGE = 32
const MARK = 'clouds on'

/**
 * @param {{kind: string} & Record<string, unknown>} step
 */
export async function cloudStep(step) {
  const frame = () =>
    new Promise((done) => requestAnimationFrame(() => done(undefined)))
  const report = () => (typeof ir.clouds === 'function' ? ir.clouds() : null)
  // Whole, never merged over the page's: a run inherits no lever from the one
  // before it, and the runner checked every set against the contract.
  const set = (levers) => {
    engine.clouds = { ...levers }
  }
  /*
   * Frames until the report's own settle says the caches and the history are
   * done, or the cap. A forced path (cut, scrub, warp, fly) never settles and
   * waits all of it, which is longer than the far atlas's 45-frame cycle. Four
   * frames first, so a report from before the levers moved cannot answer.
   */
  const settle = async (cap) => {
    for (let i = 0; i < cap; i += 1) {
      await frame()
      const s = report()?.settle ?? null
      if (i >= 4 && (s === null || !s.pending)) return i + 1
    }
    return cap
  }
  const gpu = async (reads, n) => {
    let best = Infinity
    for (let r = 0; r < reads; r += 1)
      best = Math.min(best, (await ir.gpu(n))?.ms ?? Infinity)
    return Number.isFinite(best) ? best : null
  }
  /*
   * The frame's pass count first, then as many frames as fit `limit.passes`,
   * at most `limit.frames`. One query set holds 2,048 passes, and `summarize`
   * divides every label by the frames asked for, so a read that dropped
   * passes reports every label low and is refused rather than kept. Reads are
   * sequential: two at once throw.
   */
  const readPasses = async (limit) => {
    const one = await ir.passes(1)
    if (one === null)
      throw new Error(
        'ir.passes answered null: no timestamp-query, or no presenting chain',
      )
    const perFrame = one.passes.reduce((sum, p) => sum + p.count, 0)
    const frames = Math.max(
      1,
      Math.min(limit.frames, Math.floor(limit.passes / Math.max(perFrame, 1))),
    )
    const read = await ir.passes(frames)
    if (read.dropped > 0)
      throw new Error(`ir.passes dropped ${read.dropped} at ${frames} frames`)
    const labels = {}
    for (const p of read.passes)
      labels[p.label] = { count: p.count, ms: p.ms, latencyMs: p.latencyMs }
    return {
      perFrame,
      frames,
      wallMs: read.wallMs,
      busyMs: read.busyMs,
      labels,
    }
  }
  const processing = () => engine.exposure?.processing ?? null
  const degrees = (radians) => (radians * 180) / Math.PI

  const steps = {
    stance() {
      if (typeof ir.clouds !== 'function' || engine.cloudsAvailable !== true)
        throw new Error(
          'this page has no cloud system: the URL needs clouds=1, and the build ir.clouds()',
        )
      set(step.levers)
      const at = step.stance
      /*
       * Every stance from its preset's picture: its lens, its time and its
       * processing, as the page booted to them. One page serves every run of
       * its size and preset in turn, and `ir.visit` sets no lens, so a stance
       * that only visited would stand at whatever lens the run before it
       * left: the moon's rise fits its own, and every run after it on that
       * page measured through it.
       */
      const { picture: preset } = ir.preset(step.preset)
      // The lens the preset left, before anything moves: a picture with no
      // lens of its own (a composition) names its lens this way.
      const composed = ir.lens()?.focalLength ?? null
      if (at.kind === 'preset') {
        // The picture is the stance: its pose, its lens and its instant.
      } else if (at.kind === 'visit') ir.visit(at.address, at.options)
      else if (at.kind === 'rise') {
        // `ir.rise()` solves the lens and leaves it unapplied; a picture with
        // a rise framing wears it, so the moon's rise is the preset's picture
        // with its address and framing swapped and no lens of its own.
        const picture = { ...preset }
        delete picture.lens
        ir.takePicture({
          ...picture,
          id: 'clouds-rise',
          label: 'Clouds rise',
          why: '',
          address: at.address,
          framing: { kind: 'rise' },
        })
      } else if (at.kind === 'raise') {
        // The preset's own stance, raised: `ir.visit` sets every field it is
        // not given to its default, so each is read back and passed again.
        const was = ir.observatory.status().surface?.stance
        if (was == null) throw new Error(`${step.preset} leaves no stance`)
        ir.visit(at.address, {
          latitude: degrees(was.latitude),
          longitude: degrees(was.longitude),
          height: at.height,
          heading: degrees(was.heading),
          pitch: degrees(was.pitch),
        })
      } else throw new Error(`no stance kind ${String(at.kind)}`)
      // The game's own clock, for a row about warp: the lever alone moves
      // the clouds' instant and not the sun's or the world's. What it was is
      // kept for the run's last step, so the next run on the page does not
      // stand in a running clock.
      if (step.clock != null) {
        globalThis.irClockWas = ir.status().world.timeScale
        ir.timeWarp(step.clock)
      }
      // Nothing lights an engine at a stance from a script yet. A row that
      // asks for one is then recorded as not taken, with the reason, rather
      // than failed: failing, it would refuse its batch after three tries.
      // Set on every stance, lit or not: the light is the harness's and
      // outlives the run, so the run after an overlay's would stand lit.
      let unlit = null
      if (typeof ir.lightEngine === 'function')
        ir.lightEngine(step.lit === true)
      else if (step.lit === true)
        unlit =
          'this page offers no ir.lightEngine(), so nothing is drawn over the clouds at this stance'
      const lens = ir.lens()
      return {
        light: ir.light(),
        stance: ir.observatory.status().surface?.stance ?? null,
        processing: processing(),
        lens:
          lens === null
            ? null
            : {
                focalLength: lens.focalLength,
                verticalFovDegrees: lens.verticalFovDegrees,
              },
        composed,
        unlit,
      }
    },
    unwarp() {
      ir.timeWarp(globalThis.irClockWas ?? 1)
      return { timeScale: ir.status().world.timeScale }
    },
    async side() {
      set(step.levers)
      const settled = await settle(step.settleCap)
      return { ms: await gpu(step.reads, step.n), settled }
    },
    async timeline() {
      set(step.levers)
      const settled = await settle(step.settleCap)
      return { ...(await readPasses(step.limit)), settled, clouds: report() }
    },
    async report() {
      set(step.levers)
      await settle(step.settleCap)
      return {
        clouds: report(),
        light: ir.light(),
        lens: ir.lens(),
        picture: ir.picture(),
        build: ir.build(),
        processing: processing(),
      }
    },
    async residual() {
      // Enhanced is a mode of the sensor's settings; the processing the frame
      // was drawn under is read back, so a mode that did not take is caught.
      engine.requestSensorSettings({
        ...engine.sensorSettings,
        mode: step.mode,
      })
      set(step.levers)
      const settled = await settle(step.settleCap)
      let residual = null
      for (let i = 0; i < step.readbackFrames; i += 1) {
        await frame()
        residual = report()?.residual ?? null
        if (residual !== null && residual.total.samples > 0) break
      }
      // What the residual was drawn under, read before the hold below
      // requests settings again.
      const drawnUnder = processing()
      // The display pair's two shots, held at the exposure the meter reached
      // here: under a meter still settling between them, the pair differed by
      // 0.068 to 0.111 display RMSE where the residual said 0.1%.
      if (step.holdExposure === true)
        engine.requestSensorSettings({
          ...engine.sensorSettings,
          mode: step.mode,
          rate: 0,
        })
      return { residual, processing: drawnUnder, settled }
    },
    exposure() {
      engine.requestSensorSettings({
        ...engine.sensorSettings,
        rate: step.rate,
      })
      return { rate: engine.sensorSettings.rate }
    },
    async show() {
      set(step.levers)
      return { settled: await settle(step.settleCap) }
    },
    async radiance() {
      /*
       * Each side from a reset: maxSteps and lightTaps move no reset key, so
       * a history settled under one value and carried into the next blends
       * the two, and the capture would read some of the other's light.
       *
       * Each side the mean of `step.frames` captures. One capture carries the
       * trace's jitter through the history, whose average correlates over
       * about 32 frames: at far-shore, two frames apart differ by 3.5%, two
       * means of 16 by 2.6%, of 32 by 0.54% and of 64 by 0.44% (measured),
       * against thresholds of 3% and 1%. The first side's two halves give the
       * floor the figure stands on. The means start `step.converge` frames
       * past the settle: the settle releases 16 frames after the reset, while
       * each pixel's mean gains samples until the 32nd, and captured from the
       * 16th the halves differ by 2.1% where a converged page's differ by
       * 0.54%.
       *
       * Capture k comes from a frame ≡ k (mod 4) by the report's own count,
       * so every half holds each of the interleave's four phases alike. A
       * pixel takes its fresh sample one frame in four and the clip holds it
       * to its neighbors the other three, so consecutive frames are four
       * different images even of a held still: in the system's GPU rig, with
       * the jitter held, frames 1, 2 and 3 apart differ by 33%, 3.7% and 32%
       * and frames 4 apart by nothing. A capture is of the first frame drawn
       * after the ask, so the ask waits for the frame before the one it
       * wants; captures at whatever gap the readback leaves would weight the
       * phases differently in each mean.
       */
      const drawn = () => report()?.frames ?? 0
      const captureAt = async (residue) => {
        for (let tick = 0; tick < 16; tick += 1) {
          if ((drawn() + 1) % 4 === residue) return await ir.cloudRadiance()
          await frame()
        }
        throw new Error(`no frame ≡ ${residue} (mod 4) drawn in 16 ticks`)
      }
      const mean = (shots) => {
        const { width, height } = shots[0]
        const luminance = new Float32Array(width * height)
        const cloud = new Uint8Array(width * height)
        for (const shot of shots)
          for (let i = 0; i < luminance.length; i += 1) {
            luminance[i] += shot.luminance[i] / shots.length
            cloud[i] |= shot.cloud[i]
          }
        return { width, height, luminance, cloud }
      }
      const capture = async (levers) => {
        set({ ...levers, force: 'reset' })
        await frame()
        await frame()
        set(levers)
        const settled = await settle(step.settleCap)
        for (let i = 0; i < step.converge; i += 1) await frame()
        const shots = []
        for (let i = 0; i < step.frames; i += 1) {
          const shot = await captureAt(i % 4)
          if (shot === null) return { settled, shots: null }
          shots.push(shot)
        }
        return { settled, shots }
      }
      const a = await capture(step.a)
      const b = await capture(step.b)
      if (a.shots === null || b.shots === null)
        return {
          settled: [a.settled, b.settled],
          extent: null,
          difference: null,
          floor: null,
        }
      const half = a.shots.length >> 1
      return {
        settled: [a.settled, b.settled],
        extent: [a.shots[0].width, a.shots[0].height],
        difference: ir.cloudRadianceDifference(mean(a.shots), mean(b.shots)),
        floor: ir.cloudRadianceDifference(
          mean(a.shots.slice(0, half)),
          mean(a.shots.slice(half)),
        ),
      }
    },
    boot() {
      // Every boot span, and nothing else: at `full` the timeline holds about
      // 2,800 entries a second, which is no payload for a DevTools reply.
      const spans = ir.timing.drain().filter((e) => e.track === 'Boot')
      const span = (name) =>
        spans.find((e) => e.name === name)?.durationMs ?? null
      return {
        warmUp: span('warm-up'),
        clouds: span(step.label),
        spans: spans.map((e) => ({ name: e.name, ms: e.durationMs })),
      }
    },
    on() {
      ir.timing.mark(step.mark)
      set(step.levers)
      /*
       * Each animation frame's own timestamp, from the frame the levers first
       * draw in, which `hitch` differences into frame times. The sampler
       * starts here, in the task that set the levers: one a later step starts
       * is a DevTools round trip behind them, and where the first frame has
       * drawn by then, its length — the hitch — lies between no two samples.
       * The engine's `frameMs` is no substitute: it is the step averaged over
       * about ten frames, without the draw.
       */
      const frames = []
      globalThis.irCloudFrames = new Promise((done) => {
        const tick = (at) => {
          frames.push(at)
          if (frames.length < step.frames) requestAnimationFrame(tick)
          else done(frames)
        }
        requestAnimationFrame(tick)
      })
      return { at: step.mark }
    },
    async first() {
      // Waits out the frames `on` began sampling. The first `sensor` span
      // after the mark is the first frame the levers drew.
      const frames = (await globalThis.irCloudFrames) ?? null
      const entries = ir.timing.drain()
      const mark = entries.find((e) => e.name === step.mark)
      const sensor = entries.find(
        (e) =>
          e.track === 'Render' &&
          e.name === 'sensor' &&
          mark !== undefined &&
          e.startMs >= mark.startMs,
      )
      const r = report()
      return {
        sensorMs: sensor?.durationMs ?? null,
        pipelines: r?.pipelines ?? null,
        bytes: r?.bytes ?? null,
        frames,
      }
    },
    async rate() {
      // The rate the page presents at, from rAF's own timestamps: the
      // display's refresh where a frame fits in it, less where it does not.
      // The median interval beside it, which one long frame does not move.
      // And the build the page is, which the runner holds to the tree's.
      const at = []
      for (let i = 0; i <= step.frames; i += 1)
        at.push(await new Promise((done) => requestAnimationFrame(done)))
      const gaps = at
        .slice(1)
        .map((t, i) => t - at[i])
        .sort((a, b) => a - b)
      return {
        hz: (step.frames * 1000) / (at[step.frames] - at[0]),
        intervalMs: gaps[gaps.length >> 1],
        build: ir.build()?.id ?? null,
      }
    },
    async verify() {
      set(step.levers)
      const settled = await settle(step.settleCap)
      const one = await ir.passes(1)
      const r = report()
      return {
        settled,
        light: ir.light(),
        labels: one === null ? null : one.passes.map((p) => [p.label, p.count]),
        served: r?.served ?? null,
        second: r?.second ?? null,
        regime: r?.regime ?? null,
        extents: r?.extents ?? null,
        processing: processing(),
      }
    },
  }
  const run = steps[step.kind]
  if (run === undefined) throw new Error(`no cloud step ${String(step.kind)}`)
  return await run()
}

/* ------------------------------------------------------------- the Node half ---- */

const INSTALL = `(globalThis.irCloudStep = ${cloudStep.toString()}, typeof globalThis.irCloudStep)`
/**
 * Seconds each kind of step takes, for the plan's estimate and nothing else.
 * Phase 0's pace sets them: 78 A/B rows of three pairs in 78 minutes on the
 * mini, which is a stance, a rate and six sides, a timeline and a report in a
 * minute. A radiance comparison is two means of 64 captures past a reset.
 */
export const SECONDS = Object.freeze({
  boot: 25,
  install: 0,
  stance: 1,
  settle: 10,
  wait: 1,
  rate: 2,
  side: 7,
  timeline: 5,
  report: 3,
  residual: 6,
  show: 3,
  shot: 3,
  radiance: 30,
  verify: 4,
  on: 1,
  first: 2,
})
/** A step of one of the runner's page functions: `irCloudStep` here, another module's for its own. */
export const pageStep =
  (fn) =>
  (tag, step, seconds = SECONDS[step.kind] ?? 5) => ({
    tag,
    args: ['--js', `${fn}(${JSON.stringify(step)})`],
    seconds,
  })
const js = pageStep('irCloudStep')
export const flag = (tag, ...args) => ({
  tag,
  args,
  seconds: SECONDS[tag.split(':')[0]] ?? 0,
})
const at = { settleCap: SETTLE_CAP }
/**
 * Every run reads the rate its page presents at, with the clouds off, before
 * it measures. Campaign 1's profiles ran capped at 60 Hz where the same rows
 * by hand ran at 120, and every frame-paced figure moved with it (a base
 * `sensor` mean of 6.8 ms against 3.1) while `ir.gpu` did not; nothing in the
 * row said so. 120 frames is a second at the mini's panel.
 */
export const RATE = js('rate', { kind: 'rate', frames: 120 })

/**
 * Each kind of run's steps after the stance, tagged so a result is found by
 * name. A kind another module owns adds itself here (`addSteps`), with its
 * reader in `READ`: `noise.mjs`, `sequence.mjs` and `frame.mjs` each carry a
 * step and a table of their own, which keeps this file under fta's cap.
 */
const STEPS = {
  ab: (run) => [
    ...Array.from({ length: run.pairs }, (_, p) =>
      ['base', 'candidate'].map((arm) =>
        js(`${arm}:${p}`, {
          kind: 'side',
          levers: run[arm],
          ...at,
          ...GPU_READS,
        }),
      ),
    ).flat(),
    js('timeline', {
      kind: 'timeline',
      levers: run.candidate,
      limit: PASS_LIMIT,
      ...at,
    }),
    // The base's passes too where two forms are compared: `scene over
    // clouds` is the base's, and `cloud composite` the candidate's.
    ...(run.timelineBase
      ? [
          js('timeline:base', {
            kind: 'timeline',
            levers: run.base,
            limit: PASS_LIMIT,
            ...at,
          }),
        ]
      : []),
    js('report', { kind: 'report', levers: run.base, ...at }),
  ],
  residual: (run, shots) => [
    js('residual', {
      kind: 'residual',
      levers: run.levers,
      mode: run.mode,
      readbackFrames: 30,
      holdExposure: run.exposure === 'held',
      ...at,
    }),
    js('show:identity', { kind: 'show', levers: run.identity, ...at }),
    flag('shot:identity', '--shot', shots.identity),
    js('show:thin', { kind: 'show', levers: run.thin, ...at }),
    flag('shot:thin', '--shot', shots.thin),
    // The meter moves again for the runs after this one on the page.
    js('release', { kind: 'exposure', rate: 1 }),
  ],
  verify: (run, shots) => [
    js('verify', { kind: 'verify', levers: run.levers, ...at }),
    flag('shot', '--shot', shots.still),
  ],
  // One step a comparison, its two sides' means under the DevTools timeout.
  radiance: (run) =>
    run.comparisons
      .map((c, i) =>
        js(`radiance:${i}`, {
          kind: 'radiance',
          a: c.a,
          b: c.b,
          frames: RADIANCE_FRAMES,
          converge: RADIANCE_CONVERGE,
          ...at,
        }),
      )
      .concat(
        // Each rung's cost: the trace's own milliseconds, then its step
        // counts under `stats`, which costs an atomic a ray and so is read
        // apart from the timing.
        (run.costs ?? []).flatMap((c, i) => [
          js(`cost:${i}`, {
            kind: 'timeline',
            levers: c.levers,
            limit: PASS_LIMIT,
            ...at,
          }),
          js(`steps:${i}`, {
            kind: 'report',
            levers: { ...c.levers, stats: true },
            ...at,
          }),
        ]),
      ),
}

/**
 * A run's drive.mjs steps, in order. The stance goes first with the clouds
 * off, then the scene's own settle (the sky's cubes and the ground) and a
 * quiet second for what no readout reports, before any cloud lever moves. A
 * cold boot takes no stance: the boot is the measurement, and its first
 * lever-on frame is read at the preset the page booted to.
 */
export function plan(run, shots = {}) {
  const install = flag('install', '--js', INSTALL)
  const kind = KINDS.get(run.type)
  if (kind !== undefined)
    return [
      install,
      flag('install:kind', '--js', kind.install),
      ...(kind.stance === false ? [] : stance(run)),
      RATE,
      ...kind.steps(run, shots),
    ]
  if (run.type === 'cold')
    return [
      install,
      js('boot', { kind: 'boot', label: 'warming the clouds' }),
      RATE,
      ...(run.flag
        ? [
            js('on', {
              kind: 'on',
              mark: MARK,
              levers: run.levers,
              frames: HITCH_FRAMES + 1,
            }),
            js('first', { kind: 'first', mark: MARK }),
          ]
        : []),
    ]
  return [
    install,
    ...stance(run),
    RATE,
    ...STEPS[run.type](run, shots),
    ...(run.clock ? [js('unwarp', { kind: 'unwarp' }, 0)] : []),
  ]
}

/** The stance, with the clouds off, then the scene's settle and a quiet second. */
const stance = (run) => [
  js('stance', {
    kind: 'stance',
    stance: run.stance,
    preset: run.preset,
    levers: run.off,
    clock: run.clock ?? null,
    lit: run.lit ?? false,
  }),
  flag('settle', '--settle', '30000'),
  flag('wait', '--wait', '1000'),
]

/**
 * The kinds of run other modules carry: each its steps, the source of its
 * page function, its reader, why a row of it cannot stand, its table and its
 * progress line. `stance: false` for a kind that boots to its measurement.
 */
const KINDS = new Map()
export function addKind(type, spec) {
  KINDS.set(type, spec)
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  if (s.length === 0) return null
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** The protocol's resolution: twice the pairs' spread, at least this. */
export const ALLOWANCE_FLOOR = 0.05
/**
 * And at most this: twice the largest steady spread the landed campaign had
 * at 1080p, 0.12 ms (rubric §5). A row whose spread would allow more is
 * taken again rather than allowed it, so a noisy row cannot enlarge a bar.
 */
export const ALLOWANCE_CAP = 0.25

/**
 * A run's pairs: the two sides' medians, the median of the pairs' own Δs, the
 * spread, max − min of those Δs, and the allowance a difference has to exceed
 * to count. The Δ is the pairs' median and not the medians' difference: the
 * two need not agree (18.83 and 18.92 beside a Δ of −0.06 in phase 0), and
 * the Δ is the paired figure.
 */
export function summarize(pairs) {
  const deltas = pairs.map((p) => p.delta)
  const spread = Math.max(...deltas) - Math.min(...deltas)
  return {
    base: median(pairs.map((p) => p.base)),
    candidate: median(pairs.map((p) => p.candidate)),
    delta: median(deltas),
    spread,
    allowance: Math.max(2 * spread, ALLOWANCE_FLOOR),
  }
}

/** Frame times a cold boot reads, from the frame the levers first draw in. */
const HITCH_FRAMES = 60

/**
 * A cold boot's first lever-on frames: the largest of the first five frame
 * times against the median of the last thirty. A sample is one animation
 * frame's timestamp, the first the frame the levers first drew in, and a
 * frame time the step from one to the next, so a frame that ran long shows
 * whole, as the delay of the frame after it.
 */
export function hitch(samples) {
  const at = samples.filter(Number.isFinite)
  const ms = at.slice(1).map((t, i) => t - at[i])
  if (ms.length < 35) return null
  return { first: Math.max(...ms.slice(0, 5)), steady: median(ms.slice(-30)) }
}

/** The passes that bake a cache, a map or the far field rather than draw the frame. */
const BAKES =
  /^cloud (noise|maps|clipmap|volume|sun grid|far atlas|far second)$/

/** What each kind of run's results say, flat, so a table only formats. */
const READ = {
  ab(run, value) {
    const pairs = Array.from({ length: run.pairs }, (_, p) => {
      const [b, c] = [value(`base:${p}`), value(`candidate:${p}`)]
      if (!Number.isFinite(b?.ms) || !Number.isFinite(c?.ms))
        throw new Error(`${run.id}: ir.gpu answered no figure in pair ${p}`)
      return {
        base: b.ms,
        candidate: c.ms,
        delta: c.ms - b.ms,
        settled: [b.settled, c.settled],
      }
    })
    const passes = value('timeline') ?? null
    const labels = Object.entries(passes?.labels ?? {})
    const pass = (name) => labels.find(([n]) => n === name)?.[1].ms ?? null
    const base = value('timeline:base') ?? null
    const basePass = (name) => base?.labels?.[name]?.ms ?? null
    return {
      levers: { base: run.base, candidate: run.candidate },
      pairs,
      summary: summarize(pairs),
      passes,
      report: value('report') ?? null,
      sceneOver: pass('scene over clouds'),
      trace: pass('cloud trace'),
      history: pass('cloud history'),
      depth: pass('cloud depth'),
      bakes: labels
        .filter(([n]) => BAKES.test(n))
        .reduce((s, [, p]) => s + p.ms, 0),
      perFrame: passes?.perFrame ?? null,
      bytes: passes?.clouds?.bytes?.total ?? null,
      // The candidate's hash as the page resolved it, read under its levers.
      pageHash: passes?.clouds?.leversHash ?? null,
      composite: pass('cloud composite'),
      ...(run.timelineBase
        ? {
            baseSceneOver: basePass('scene over clouds'),
            baseComposite: basePass('cloud composite'),
          }
        : {}),
      // The form each side's frame drew, where the report says (§4.12).
      form: {
        base: formOf(value('report')?.clouds),
        candidate: formOf(passes?.clouds),
      },
    }
  },
  residual(run, value) {
    const r = value('residual')
    const wanted = run.mode === 'enhanced' ? 'enhanced' : 'photographic'
    const residual = r?.residual ?? null
    return {
      mode: run.mode,
      exposure: run.exposure ?? null,
      processing: r?.processing ?? null,
      // A mode the sensor did not take is a row about the other mode.
      refused:
        r?.processing === wanted
          ? null
          : `drawn under ${r?.processing ?? 'no'} processing, not ${wanted}`,
      residual,
      classDisagreement: residual?.classDisagreement ?? null,
      thin: histogramStats(residual?.thin),
      light: histogramStats(residual?.light),
      total: histogramStats(residual?.total),
      limb: histogramStats(residual?.limb),
    }
  },
  cold(run, value) {
    const first = value('first') ?? {}
    return {
      flag: run.flag,
      boot: run.boot,
      spans: value('boot') ?? null,
      hitch: run.flag ? hitch(first.frames ?? []) : null,
      sensorMs: first.sensorMs ?? null,
      pipelines: first.pipelines ?? null,
      bytes: first.bytes?.total ?? null,
    }
  },
  verify(run, value) {
    return { verify: value('verify') ?? null }
  },
  radiance(run, value) {
    return {
      // The share of rays the far march took is not in the report: the
      // contract counts steps and exhausted rays, not hand-overs.
      costs: (run.costs ?? []).map((c, i) => ({
        value: c.value,
        trace: value(`cost:${i}`)?.labels?.['cloud trace']?.ms ?? null,
        steps: value(`steps:${i}`)?.clouds?.steps ?? null,
      })),
      differences: run.comparisons.map((c, i) => {
        const r = value(`radiance:${i}`) ?? null
        return {
          name: c.name,
          threshold: c.threshold,
          jitter:
            c.a.jitterFrame === null && c.b.jitterFrame === null
              ? 'moving'
              : `held at ${c.a.jitterFrame}`,
          relative: r?.difference?.relative ?? null,
          floor: r?.floor?.relative ?? null,
          texels: r?.difference?.texels ?? null,
          settled: r?.settled ?? null,
          extent: r?.extent ?? null,
        }
      }),
    }
  },
}

/**
 * The composite's form a frame drew, from the report's `overPass`, `{ form,
 * depth }`: `form` one of `passes`, `lean` and `chain` (a `chain` lever that
 * gave the frame back to pass B reads `passes`), and `depth` pass B's,
 * `read-only` or `stored`, null where there is no pass B. The report does not
 * carry it until integration writes it, and a row is not failed for that: it
 * reads `unknown`.
 */
export const formOf = (report) => ({
  form: report?.overPass?.form ?? 'unknown',
  depth: report?.overPass?.depth ?? (report?.overPass ? null : 'unknown'),
})

/** The figures of one invocation: `out` is drive.mjs's `--json`, whose
 *  results are in the order of `steps`. */
export function figures(run, steps, out) {
  const by = new Map(steps.map((s, i) => [s.tag, out.results?.[i]]))
  const value = (tag) => by.get(tag)?.value
  const rate = value('rate') ?? null
  const stood = value('stance') ?? null
  const notTaken = out.notTaken ?? stood?.unlit ?? null
  const read = KINDS.get(run.type)?.read ?? READ[run.type]
  return {
    id: run.id,
    type: run.type,
    batch: run.batch,
    group: run.group ?? null,
    label: run.label ?? null,
    scenario: run.scenario,
    size: run.size,
    kind: run.kind ?? null,
    stance: stood,
    scene: by.get('settle') ?? null,
    // The lens the stance names, and the one the page wore once it stood.
    lens: {
      named: run.lens ?? null,
      worn: stood?.lens ?? null,
      composed: stood?.composed ?? null,
    },
    leversHash: run.leversHash ?? null,
    build: rate?.build ?? null,
    operatingPoint: {
      ...out.operatingPoint,
      presentHz: rate?.hz ?? null,
      intervalMs: rate?.intervalMs ?? null,
    },
    errors: out.errors ?? [],
    notTaken,
    ask: out.ask ?? null,
    ...(out.window ? { window: out.window } : {}),
    // A row not taken keeps whatever its steps read, and owes nothing.
    ...(notTaken === null ? read(run, value) : readable(read, run, value)),
  }
}

const readable = (read, run, value) => {
  try {
    return read(run, value)
  } catch {
    return {}
  }
}

/**
 * Why the lens a row was taken through is not its stance's, or null. A
 * stance names a focal length, or the composition its picture solves, or a
 * rise's; a rise names none to hold it to. A cold boot stands nowhere.
 */
export function lensRefusal(row) {
  const { named, worn, composed } = row.lens ?? {}
  if (named == null || named === 'rise') return null
  const want = named === 'composition' ? composed : named
  const got = worn?.focalLength
  if (!Number.isFinite(got) || !Number.isFinite(want))
    return 'the lens was not read back'
  return Math.abs(got - want) <= 1e-6 * want
    ? null
    : `the lens is ${got.toFixed(2)} mm, not the stance's ${want.toFixed(2)} mm`
}

/** The plan's estimate of a run, in seconds: its steps', and a boot where it boots. */
export const estimate = (steps, boots) =>
  steps.reduce((sum, s) => sum + (s.seconds ?? 0), boots ? SECONDS.boot : 0)

export const minutes = (seconds) =>
  seconds < 5400
    ? `${Math.round(seconds / 60)} min`
    : `${(seconds / 3600).toFixed(1)} h`

/* ------------------------------------------------------------- the plan ---- */

const lensText = (lens) =>
  typeof lens === 'number' ? `${lens.toFixed(2)} mm` : `the ${lens}'s`

function stanceText(run) {
  if (run.type === 'cold') return `${run.preset}, booted cold`
  const at = run.stance
  const where =
    at.kind === 'visit'
      ? `${at.address} ${Object.entries(at.options)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')}`
      : at.kind === 'preset'
        ? 'its picture'
        : `${at.kind} ${at.address}`
  return `${run.scenario} (${run.preset}: ${where}${run.lit ? ', engine lit' : ''}${run.clock ? `, clock ${run.clock}×` : ''})`
}

/** A lever set as what it changes from the defaults. */
const changed = (set) =>
  Object.entries(set)
    .filter(([k, v]) => v !== DEFAULT_CLOUD_LEVERS[k])
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || 'defaults'

function leverText(run) {
  if (run.base !== undefined)
    return `{${changed(run.base)}} against {${changed(run.candidate)}}`
  if (run.arms !== undefined)
    return run.arms.map((a) => `${a.name} {${changed(a.levers)}}`).join(', ')
  if (run.comparisons !== undefined)
    return `${run.comparisons.length} comparisons over {${changed(run.comparisons[0].a)}}`
  return `{${changed(run.levers ?? run.off)}}`
}

/** A run as the plan prints it: where it stands, through which lens, with which levers. */
export const describe = (run) =>
  `stance ${stanceText(run)}; lens ${lensText(run.lens)}; levers ${run.leversHash} ${leverText(run)}`

/* ------------------------------------------------------------ what stands ---- */

/**
 * Why a row's figures cannot stand, or null. A quiet machine says nothing
 * about the page: a residual drawn under the other processing comes back as
 * a `refused` string, a radiance comparison whose capture answered null comes
 * back as null figures, and a stance whose scene was still building when
 * drive.mjs's 30 s settle gave up measures that building. None of them
 * throws, so each would otherwise be kept as the run's row, and a continued
 * document and the campaign would count the run done.
 */
export function unfit(row) {
  // An arm the machine could not give is a finding of the study, not a row
  // to take again: its reason is the figure.
  if (row.notTaken != null) return null
  const kind = KINDS.get(row.type)
  if (kind?.stance !== false && row.type !== 'cold') {
    if (row.scene?.settled !== true)
      return 'the scene had not settled when the levers moved'
    const lens = lensRefusal(row)
    if (lens !== null) return lens
  }
  if (row.pageHash != null && row.leversHash != null)
    if (row.pageHash !== row.leversHash)
      return `the page drew levers ${row.pageHash}, not the run's ${row.leversHash}`
  if (kind !== undefined) return kind.unfit(row)
  if (row.type === 'ab' && 2 * (row.summary?.spread ?? 0) > ALLOWANCE_CAP)
    return `the pairs spread ${row.summary.spread.toFixed(3)} ms, which would allow more than ${ALLOWANCE_CAP} ms; taken again`
  if (row.type === 'residual') {
    if (row.refused != null) return row.refused
    if (!(row.residual?.total?.samples > 0)) return 'no residual was read back'
  }
  if (row.type === 'radiance') {
    const missing = row.differences.find(
      (d) => !Number.isFinite(d.relative) || !Number.isFinite(d.floor),
    )
    if (missing !== undefined) return `no radiance capture for ${missing.name}`
  }
  if (row.type === 'cold') {
    if (!Number.isFinite(row.spans?.warmUp))
      return 'the boot recorded no warm-up span'
    if (row.flag && (row.hitch === null || !Number.isFinite(row.bytes)))
      return 'the first frames with the clouds on were not read'
  }
  if (row.type === 'verify' && row.verify === null)
    return 'the stance was not read back'
  return null
}

/** Whether a row finishes its run: measured quiet, and every figure it owes there. */
export const measured = (row) => row.quiet?.ok === true && unfit(row) === null

/* --------------------------------------------------------------- the tables ---- */

export const fixed = (x, digits = 2) =>
  Number.isFinite(x) ? x.toFixed(digits) : '—'
export const pct = (x, digits = 1) =>
  Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—'
const mb = (bytes) => fixed(bytes == null ? NaN : bytes / 1e6)
const yes = (x) => (x ? 'yes' : 'no')
/** The `quiet` column: why a row does not stand, or whether it was measured quiet. */
export const standing = (r) =>
  r.notTaken != null
    ? `not taken: ${r.notTaken}`
    : (unfit(r) ?? yes(r.quiet.ok))
const unique = (xs) => [...new Set(xs)]

/** A Markdown table of `rows`, one column per `[header, cell]`. */
export const table = (rows, columns) =>
  [
    columns.map(([header]) => header),
    columns.map(() => '---'),
    ...rows.map((row) => columns.map(([, cell]) => String(cell(row)))),
  ]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n')

export const NAMED = [
  ['Scenario', (r) => r.scenario],
  ['Size', (r) => r.size],
]

/** What every row is taken at: its rate, the lens it wore and its levers' hash. */
export const OPERATING = [
  ['Hz', (r) => fixed(r.operatingPoint?.presentHz, 0)],
  ['lens mm', (r) => fixed(r.lens?.worn?.focalLength, 1)],
  ['levers', (r) => r.leversHash ?? '—'],
]

export const AB_COLUMNS = [
  ...NAMED,
  ['Kind', (r) => r.kind],
  ['Lever', (r) => r.label],
  ['base: median of sides ms', (r) => fixed(r.summary?.base)],
  ['candidate: median of sides ms', (r) => fixed(r.summary?.candidate)],
  [
    'Δ: median of pairs ms (spread)',
    (r) => `${fixed(r.summary?.delta)} (${fixed(r.summary?.spread)})`,
  ],
  ['allowance ms', (r) => fixed(r.summary?.allowance)],
  ['cloud composite', (r) => fixed(r.composite)],
  [
    'form drawn (pass B depth)',
    (r) =>
      r.batch === 'over' && r.form
        ? `${r.form.candidate.form} (${r.form.candidate.depth ?? 'none'})`
        : '—',
  ],
  ...OPERATING,
  ['scene over clouds', (r) => fixed(r.sceneOver)],
  ['cloud trace', (r) => fixed(r.trace)],
  ['cloud history', (r) => fixed(r.history)],
  ['cloud depth', (r) => fixed(r.depth)],
  ['bakes', (r) => fixed(r.bakes)],
  ['passes/frame', (r) => r.perFrame ?? '—'],
  ['bytes MB', (r) => mb(r.bytes)],
  ['quiet', standing],
]

const share = (stats, threshold) =>
  stats?.over.find(([t]) => t === threshold)?.[1]

export const ERROR_COLUMNS = [
  ...NAMED,
  ['Enhanced', (r) => (r.mode === 'enhanced' ? 'on' : 'off')],
  ['thin >1%', (r) => pct(share(r.thin, 0.01))],
  ['thin >2%', (r) => pct(share(r.thin, 0.02))],
  ['thin >5%', (r) => pct(share(r.thin, 0.05))],
  ['thin p95', (r) => pct(r.thin?.p95)],
  ['thin worst', (r) => pct(r.thin?.worst)],
  ['residual light p95', (r) => pct(r.light?.p95)],
  ['residual total p95', (r) => pct(r.total?.p95)],
  ['limb ring p95', (r) => pct(r.limb?.p95)],
  ['class disagreement', (r) => r.classDisagreement ?? '—'],
  ['RMSE (display)', (r) => fixed(r.display?.rmse, 4)],
  ['>3%', (r) => pct(r.display?.over?.['3%'])],
  ['>8%', (r) => pct(r.display?.over?.['8%'])],
  ['display pair', (r) => r.exposure ?? 'free'],
  ...OPERATING,
  ['quiet', standing],
]

const MEMORY_COLUMNS = [
  ['Size', (r) => r.size],
  ['Clouds', (r) => yes(r.flag)],
  ['Boot', (r) => r.boot],
  ['warm-up ms', (r) => fixed(r.spans?.warmUp)],
  ['warming the clouds ms', (r) => fixed(r.spans?.clouds)],
  ['first frames ms (max of 5)', (r) => fixed(r.hitch?.first)],
  ['steady ms (median of 30)', (r) => fixed(r.hitch?.steady)],
  ['first sensor ms', (r) => fixed(r.sensorMs)],
  [
    'pipelines render/compute',
    (r) => (r.pipelines ? `${r.pipelines.render}/${r.pipelines.compute}` : '—'),
  ],
  ['bytes MB', (r) => mb(r.bytes)],
]

export function memoryTable(rows) {
  const lines = unique(rows.map((r) => r.size)).map((size) => {
    const warm = (flag) =>
      median(
        rows
          .filter((r) => r.size === size && r.flag === flag)
          .map((r) => r.spans?.warmUp)
          .filter(Number.isFinite),
      ) ?? NaN
    return `${size}: the flag adds ${fixed(warm(true) - warm(false))} ms to the warm-up, as the median of its boots`
  })
  return [
    table(rows, MEMORY_COLUMNS),
    '',
    ...lines,
    'Fresh Chrome profile; the OS Metal cache may be warm.',
  ].join('\n')
}

/**
 * §8.7's image inputs, one row a comparison: a ladder's value against the
 * next under 1%.
 */
const RADIANCE_COLUMNS = [
  ...NAMED,
  ['Group', (d) => d.group],
  ['Lever', (d) => d.label],
  ['Comparison', (d) => d.name],
  ['jitter', (d) => d.jitter],
  // Hundredths: a ladder's 1% is read against figures a tenth of it apart.
  ['radiance RMSE', (d) => pct(d.relative, 2)],
  ['noise floor', (d) => pct(d.floor, 2)],
  ['under', (d) => pct(d.threshold)],
  [
    'passes',
    (d) => (Number.isFinite(d.relative) ? yes(d.relative < d.threshold) : '—'),
  ],
  ['cloud texels', (d) => d.texels ?? '—'],
  ...OPERATING,
  ['quiet', standing],
]

const labelsOf = (r) => r.verify?.labels ?? []

const STANCE_COLUMNS = [
  ['Scenario', (r) => r.scenario],
  ['sun °', (r) => fixed(r.verify?.light?.sun, 1)],
  ['phase °', (r) => fixed(r.verify?.light?.phase, 1)],
  ['lit', (r) => yes(r.verify?.light?.lit)],
  ['served', (r) => r.verify?.served ?? '—'],
  ['second', (r) => r.verify?.second ?? '—'],
  [
    'sea split',
    (r) => yes(labelsOf(r).some(([n]) => n === 'scene after copy')),
  ],
  [
    'cloud passes',
    (r) =>
      labelsOf(r)
        .filter(([n]) => n.startsWith('cloud ') || n === 'scene over clouds')
        .map(([n, c]) => `${n} ×${c}`)
        .join(', ') || '—',
  ],
  ['still', (r) => r.still ?? '—'],
]

/** The latest attempt of every run, which is the one its table shows. */
export const latest = (rows) => [
  ...new Map(rows.map((r) => [r.id, r])).values(),
]

/** Rows of one scenario and size further apart in rate than this, over their median, are two operating points. */
const RATE_SPREAD = 0.15

/**
 * The rates a batch's rows presented at, a size at a time, and every scenario
 * whose rows at one size disagree: a frame time at 60 Hz and one at 120 are
 * figures about two machines, and a table pools them without a word. The
 * comparison stays within a scenario, because the rate also falls with the
 * scene's own load: Retina's clouds-off frames run 65–78 Hz by stance alone.
 * It reads the rows `tables` shows, each run's latest attempt: a run marked
 * at 60 Hz under load and taken again at 118 is one row at 118.
 */
export function rateNote(rows) {
  const hz = (r) => r.operatingPoint?.presentHz
  const timed = latest(rows).filter((r) => Number.isFinite(hz(r)))
  if (timed.length === 0) return 'No row recorded the rate it presented at.'
  const range = (rs) => {
    const xs = rs.map(hz)
    return `${fixed(Math.min(...xs), 0)}–${fixed(Math.max(...xs), 0)} Hz`
  }
  const lines = unique(timed.map((r) => r.size)).map(
    (size) =>
      `${size}: presented at ${range(timed.filter((r) => r.size === size))}.`,
  )
  for (const key of unique(timed.map((r) => `${r.size} ${r.scenario}`))) {
    const group = timed.filter((r) => `${r.size} ${r.scenario}` === key)
    const xs = group.map(hz)
    if ((Math.max(...xs) - Math.min(...xs)) / median(xs) > RATE_SPREAD)
      lines.push(
        `${key}: rows at ${range(group)} are two operating points, not one.`,
      )
  }
  return lines.join('\n')
}

export function tables(doc) {
  const rows = latest(doc.rows)
  const of = (type) => rows.filter((r) => r.type === type)
  return [
    of('ab').length > 0 && table(of('ab'), AB_COLUMNS),
    of('residual').length > 0 && table(of('residual'), ERROR_COLUMNS),
    of('cold').length > 0 && memoryTable(of('cold')),
    of('verify').length > 0 && table(of('verify'), STANCE_COLUMNS),
    of('radiance').length > 0 &&
      table(
        of('radiance').flatMap((r) =>
          r.differences.map((d) => ({ ...r, ...d })),
        ),
        RADIANCE_COLUMNS,
      ),
    ...[...KINDS].map(
      ([type, kind]) => of(type).length > 0 && kind.table(of(type)),
    ),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A row in one line, as the runner prints it after each run. */
export const progress = (r) =>
  (r.notTaken != null ? `not taken: ${r.notTaken}` : null) ??
  KINDS.get(r.type)?.progress(r) ??
  {
    ab: () =>
      `Δ ${fixed(r.summary.delta)} ms (spread ${fixed(r.summary.spread)}), base ${fixed(r.summary.base)}`,
    residual: () =>
      r.refused ??
      `thin p95 ${pct(r.thin?.p95)}, display RMSE ${fixed(r.display?.rmse, 4)}`,
    cold: () =>
      `warm-up ${fixed(r.spans?.warmUp)} ms, the clouds' ${fixed(r.spans?.clouds)} ms`,
    verify: () =>
      `sun ${fixed(r.verify?.light?.sun, 1)}°, served ${r.verify?.served ?? '—'}`,
    radiance: () =>
      r.differences
        .map(
          (d) => `${d.name} ${pct(d.relative, 2)} (floor ${pct(d.floor, 2)})`,
        )
        .join(', '),
  }[r.type]()
