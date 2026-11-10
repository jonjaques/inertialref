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
      if (at.kind === 'visit') ir.visit(at.address, at.options)
      else if (at.kind === 'rise') {
        // `ir.rise()` solves the lens and leaves it unapplied; a picture with
        // a rise framing wears it, so the moon's rise is far-shore's picture
        // with its address and framing swapped and no lens of its own.
        const picture = { ...ir.preset(at.preset).picture }
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
        ir.preset(at.preset)
        const was = ir.observatory.status().surface?.stance
        if (was == null) throw new Error(`${at.preset} leaves no stance`)
        ir.visit(at.address, {
          latitude: degrees(was.latitude),
          longitude: degrees(was.longitude),
          height: at.height,
          heading: degrees(was.heading),
          pitch: degrees(was.pitch),
        })
      } else throw new Error(`no stance kind ${String(at.kind)}`)
      return {
        light: ir.light(),
        stance: ir.observatory.status().surface?.stance ?? null,
        processing: processing(),
      }
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
      return { residual, processing: processing(), settled }
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
      const at = []
      for (let i = 0; i <= step.frames; i += 1)
        at.push(await new Promise((done) => requestAnimationFrame(done)))
      return { hz: (step.frames * 1000) / (at[step.frames] - at[0]) }
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
const js = (tag, step) => ({
  tag,
  args: ['--js', `irCloudStep(${JSON.stringify(step)})`],
})
const flag = (tag, ...args) => ({ tag, args })
const at = { settleCap: SETTLE_CAP }
/**
 * Every run reads the rate its page presents at, with the clouds off, before
 * it measures. Campaign 1's profiles ran capped at 60 Hz where the same rows
 * by hand ran at 120, and every frame-paced figure moved with it (a base
 * `sensor` mean of 6.8 ms against 3.1) while `ir.gpu` did not; nothing in the
 * row said so. 120 frames is a second at the mini's panel.
 */
const RATE = js('rate', { kind: 'rate', frames: 120 })

/** Each kind of run's steps after the stance, tagged so a result is found by name. */
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
    js('report', { kind: 'report', levers: run.base, ...at }),
  ],
  residual: (run, shots) => [
    js('residual', {
      kind: 'residual',
      levers: run.levers,
      mode: run.mode,
      readbackFrames: 30,
      ...at,
    }),
    js('show:identity', { kind: 'show', levers: run.identity, ...at }),
    flag('shot:identity', '--shot', shots.identity),
    js('show:thin', { kind: 'show', levers: run.thin, ...at }),
    flag('shot:thin', '--shot', shots.thin),
  ],
  verify: (run, shots) => [
    js('verify', { kind: 'verify', levers: run.levers, ...at }),
    flag('shot', '--shot', shots.still),
  ],
  // One step a comparison, its two sides' means under the DevTools timeout.
  radiance: (run) =>
    run.comparisons.map((c, i) =>
      js(`radiance:${i}`, {
        kind: 'radiance',
        a: c.a,
        b: c.b,
        frames: RADIANCE_FRAMES,
        converge: RADIANCE_CONVERGE,
        ...at,
      }),
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
    js('stance', { kind: 'stance', stance: run.stance, levers: run.off }),
    flag('settle', '--settle', '30000'),
    flag('wait', '--wait', '1000'),
    RATE,
    ...STEPS[run.type](run, shots),
  ]
}

export const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  if (s.length === 0) return null
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** A run's pairs: the medians, the median Δ, and the spread, max − min of
 *  the Δs, which twice over (and at least 0.05 ms) is what a difference has
 *  to exceed to count. */
export function summarize(pairs) {
  const deltas = pairs.map((p) => p.delta)
  return {
    base: median(pairs.map((p) => p.base)),
    candidate: median(pairs.map((p) => p.candidate)),
    delta: median(deltas),
    spread: Math.max(...deltas) - Math.min(...deltas),
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
    }
  },
  residual(run, value) {
    const r = value('residual')
    const wanted = run.mode === 'enhanced' ? 'enhanced' : 'photographic'
    const residual = r?.residual ?? null
    return {
      mode: run.mode,
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

/** The figures of one invocation: `out` is drive.mjs's `--json`, whose
 *  results are in the order of `steps`. */
export function figures(run, steps, out) {
  const by = new Map(steps.map((s, i) => [s.tag, out.results?.[i]]))
  const value = (tag) => by.get(tag)?.value
  return {
    id: run.id,
    type: run.type,
    batch: run.batch,
    group: run.group ?? null,
    label: run.label ?? null,
    scenario: run.scenario,
    size: run.size,
    kind: run.kind ?? null,
    stance: value('stance') ?? null,
    scene: by.get('settle') ?? null,
    operatingPoint: {
      ...out.operatingPoint,
      presentHz: value('rate')?.hz ?? null,
    },
    errors: out.errors ?? [],
    ...READ[run.type](run, value),
  }
}

/* --------------------------------------------------------------- the tables ---- */

const fixed = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : '—')
const pct = (x, digits = 1) =>
  Number.isFinite(x) ? `${(x * 100).toFixed(digits)}%` : '—'
const mb = (bytes) => fixed(bytes == null ? NaN : bytes / 1e6)
const yes = (x) => (x ? 'yes' : 'no')
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

const NAMED = [
  ['Scenario', (r) => r.scenario],
  ['Size', (r) => r.size],
]

export const AB_COLUMNS = [
  ...NAMED,
  ['Kind', (r) => r.kind],
  ['Lever', (r) => r.label],
  ['Base ms', (r) => fixed(r.summary.base)],
  ['Candidate ms', (r) => fixed(r.summary.candidate)],
  [
    'Δ ms (spread)',
    (r) => `${fixed(r.summary.delta)} (${fixed(r.summary.spread)})`,
  ],
  ['scene over clouds', (r) => fixed(r.sceneOver)],
  ['cloud trace', (r) => fixed(r.trace)],
  ['cloud history', (r) => fixed(r.history)],
  ['cloud depth', (r) => fixed(r.depth)],
  ['bakes', (r) => fixed(r.bakes)],
  ['passes/frame', (r) => r.perFrame ?? '—'],
  ['bytes MB', (r) => mb(r.bytes)],
  ['quiet', (r) => yes(r.quiet.ok)],
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
  ['quiet', (r) => r.refused ?? yes(r.quiet.ok)],
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
  ['quiet', (d) => yes(d.quiet.ok)],
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
const latest = (rows) => [...new Map(rows.map((r) => [r.id, r])).values()]

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
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A row in one line, as the runner prints it after each run. */
export const progress = (r) =>
  ({
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
  })[r.type]()
