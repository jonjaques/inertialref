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
 * `figures`, what their results say; and the sweep's fit and the tables the
 * ADRs copy.
 *
 * A step is small on purpose. The rig's DevTools channel times every command
 * out at 120 s (`scripts/cdp.mjs`), and five A/B pairs in one evaluation take
 * about three minutes, so a pair is two steps, one a side, run in order in one
 * invocation and one boot. A side is a settle of at most `SETTLE_CAP` frames
 * and three reads of `ir.gpu(120)`: under a minute at 50 ms a frame.
 */
import { histogramStats } from './diff.mjs'

/** One `ir.passes` read stays under one query set's 2,048 passes, at most 40 frames. */
export const PASS_LIMIT = Object.freeze({ passes: 2000, frames: 40 })
/** Frames a side waits for the report's settle: past the far atlas's 45-frame cycle. */
export const SETTLE_CAP = 240
const GPU_READS = { reads: 3, n: 120 }
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
    async profile() {
      set(step.levers)
      await settle(step.settleCap)
      const p = await ir.profile(step.ms)
      const sensor =
        p.spans.find((s) => s.track === 'Render' && s.name === 'sensor') ?? null
      return { frames: p.frames, late: p.late.length, sensor }
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
    async sweep() {
      // Accepted only once an untimed frame with stats on counts exactly
      // `fixedSteps` a ray, mean and max; the timed read runs with stats off,
      // because its atomics cost.
      set({ ...step.levers, stats: true })
      let stats = null
      for (let i = 0; i < step.statsFrames; i += 1) {
        await frame()
        const r = report()
        if (i < 4 || r?.steps == null || r.levers?.stats !== true) continue
        stats = r.steps
        if (stats.mean === stats.max && stats.max === step.levers.fixedSteps)
          break
      }
      const accepted =
        stats !== null &&
        stats.mean === step.levers.fixedSteps &&
        stats.max === step.levers.fixedSteps
      set({ ...step.levers, stats: false })
      const settled = await settle(step.settleCap)
      const read = await readPasses(step.limit)
      return {
        accepted,
        stats,
        settled,
        trace: read.labels['cloud trace'] ?? null,
        perFrame: read.perFrame,
        frames: read.frames,
        extents: report()?.extents ?? null,
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
    ...(run.profileMs > 0 ? ['candidate', 'base'] : []).map((arm) =>
      js(`profile:${arm}`, {
        kind: 'profile',
        levers: run[arm],
        ms: run.profileMs,
        ...at,
      }),
    ),
    js('report', { kind: 'report', levers: run.base, ...at }),
  ],
  sweep: (run) =>
    run.cells.map((levers, i) =>
      js(`cell:${i}`, {
        kind: 'sweep',
        levers,
        statsFrames: 64,
        limit: PASS_LIMIT,
        ...at,
      }),
    ),
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
  /^cloud (noise|maps|clipmap|volume|volume bound|sun cascade|sun grid|far atlas|far spheres|far second)$/

/** `a − b`, or null when either is missing: a run with no profile has no CPU Δ. */
const minus = (a, b) =>
  Number.isFinite(a) && Number.isFinite(b) ? a - b : null

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
    const profile = (arm) => value(`profile:${arm}`) ?? null
    const [candidate, base] = [profile('candidate'), profile('base')]
    return {
      levers: { base: run.base, candidate: run.candidate },
      pairs,
      summary: summarize(pairs),
      passes,
      cpu: run.profileMs > 0 ? { candidate, base } : null,
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
      sensor: minus(candidate?.sensor?.meanMs, base?.sensor?.meanMs),
      late: minus(candidate?.late, base?.late),
    }
  },
  sweep(run, value) {
    const cells = run.cells.map((levers, i) => {
      const r = value(`cell:${i}`)
      const [w, h] = r?.extents?.trace ?? [NaN, NaN]
      const ms = r?.trace?.ms ?? NaN
      return {
        size: run.size,
        run: run.label,
        scale: levers.traceScale,
        rays: w * h,
        steps: levers.fixedSteps,
        reads: levers.sweepReads,
        format: levers.noiseFormat,
        extra: levers.sweepExtra,
        ms,
        fetchesPerSecond:
          (w * h * levers.fixedSteps * levers.sweepReads) / (ms * 1e-3),
        accepted: r?.accepted === true,
        stats: r?.stats ?? null,
      }
    })
    return { cells }
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
    operatingPoint: out.operatingPoint ?? null,
    errors: out.errors ?? [],
    ...READ[run.type](run, value),
  }
}

/* ------------------------------------------------------------------ the fit ---- */

/** `x` solving `a·x = b` by elimination with partial pivoting; null when singular. */
function solve(a, b) {
  const m = a.map((row, i) => [...row, b[i]])
  const n = b.length
  for (let c = 0; c < n; c += 1) {
    const p = m.reduce(
      (best, row, r) =>
        r >= c && Math.abs(row[c]) > Math.abs(m[best][c]) ? r : best,
      c,
    )
    if (Math.abs(m[p][c]) < 1e-12) return null
    ;[m[c], m[p]] = [m[p], m[c]]
    for (let r = c + 1; r < n; r += 1) {
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k += 1) m[r][k] -= f * m[c][k]
    }
  }
  const x = Array(n).fill(0)
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = m[r][n]
    for (let k = r + 1; k < n; k += 1) s -= m[r][k] * x[k]
    x[r] = s / m[r][r]
  }
  return x
}

/**
 * The sweep's fit, `ms = α·rays + β·rays·steps + γ·rays·steps·reads`, by least
 * squares over accepted cells of one format: per-ray overhead, the per-step
 * floor, and the base fetch, whose inverse is the base noise's fetch rate.
 * Each column is scaled to unit norm first, because rays and ray-steps differ
 * by two orders and the normal equations square that.
 */
export function fitSweep(cells) {
  const xs = cells.map((c) => [
    c.rays,
    c.rays * c.steps,
    c.rays * c.steps * c.reads,
  ])
  const norm = [0, 1, 2].map((j) => Math.hypot(...xs.map((x) => x[j])) || 1)
  const z = xs.map((x) => x.map((v, j) => v / norm[j]))
  const gram = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => z.reduce((s, x) => s + x[i] * x[j], 0)),
  )
  const solved =
    cells.length < 3
      ? null
      : solve(
          gram,
          [0, 1, 2].map((i) =>
            z.reduce((s, x, k) => s + x[i] * cells[k].ms, 0),
          ),
        )
  if (solved === null) return null
  const [alpha, beta, gamma] = solved.map((v, j) => v / norm[j])
  const miss = cells.map(
    (c, k) => c.ms - (alpha * xs[k][0] + beta * xs[k][1] + gamma * xs[k][2]),
  )
  return {
    alpha,
    beta,
    gamma,
    residual: Math.sqrt(miss.reduce((s, d) => s + d * d, 0) / miss.length),
    // γ is milliseconds a fetch.
    fetchesPerSecond: gamma > 0 ? 1e3 / gamma : null,
  }
}

/* --------------------------------------------------------------- the tables ---- */

const fixed = (x, digits = 2) => (Number.isFinite(x) ? x.toFixed(digits) : '—')
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : '—')
const mb = (bytes) => fixed(bytes == null ? NaN : bytes / 1e6)
const rate = (x) => (Number.isFinite(x) ? x.toExponential(3) : '—')
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
  ['sensor ms Δ', (r) => fixed(r.sensor)],
  ['late Δ', (r) => fixed(r.late, 0)],
  ['quiet', (r) => yes(r.quiet.ok)],
]

const CELL_COLUMNS = [
  ['Size', (c) => c.size],
  ['Rays', (c) => c.rays],
  ['Steps', (c) => c.steps],
  ['Reads', (c) => c.reads],
  ['Format', (c) => c.format],
  ['Extra', (c) => c.extra],
  ['trace ms', (c) => fixed(c.ms)],
  ['fetches/s', (c) => rate(c.fetchesPerSecond)],
  ['accepted', (c) => yes(c.accepted)],
]

const FIT_COLUMNS = [
  ['Size', (f) => f.size],
  ['Format', (f) => f.format],
  ['α ns a ray', (f) => fixed(f.alpha * 1e6, 3)],
  ['β ns a ray-step', (f) => fixed(f.beta * 1e6, 4)],
  ['γ ns a fetch', (f) => fixed(f.gamma * 1e6, 4)],
  ['residual ms', (f) => fixed(f.residual, 3)],
  ['fetches/s (1/γ)', (f) => rate(f.fetchesPerSecond)],
]

/** The sweep's cells, the fit per size and format, each other read type's
 *  marginal per ray-step, and RGBA8 against R8 per fetch. */
export function sweepTables(cells) {
  const fits = []
  const marginals = []
  for (const size of unique(cells.map((c) => c.size))) {
    const ok = cells.filter((c) => c.size === size && c.accepted)
    for (const format of ['r8', 'rgba8'])
      fits.push({
        size,
        format,
        ...fitSweep(
          ok.filter((c) => c.format === format && c.run !== 'marginals'),
        ),
      })
    const none = ok.find((c) => c.run === 'marginals' && c.extra === 'none')
    for (const c of ok.filter((c) => c.run === 'marginals' && c !== none))
      marginals.push([
        size,
        c.extra,
        ((c.ms - none?.ms) * 1e6) / (c.rays * c.steps),
      ])
    for (const reads of [2, 4]) {
      const pick = (format) =>
        ok.find(
          (c) =>
            c.run === 'scale-1' &&
            c.steps === 64 &&
            c.reads === reads &&
            c.format === format,
        )
      const [r8, rgba8] = [pick('r8'), pick('rgba8')]
      marginals.push([
        size,
        `rgba8 − r8 at ${reads} reads`,
        ((rgba8?.ms - r8?.ms) * 1e6) / (r8?.rays * 64 * reads),
      ])
    }
  }
  return [
    table(cells, CELL_COLUMNS),
    table(fits, FIT_COLUMNS),
    table(marginals, [
      ['Size', (m) => m[0]],
      ['Read', (m) => m[1]],
      ['ns a ray-step, or a fetch for the format', (m) => fixed(m[2], 4)],
    ]),
  ].join('\n\n')
}

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

export function tables(doc) {
  const rows = latest(doc.rows)
  const of = (type) => rows.filter((r) => r.type === type)
  return [
    of('ab').length > 0 && table(of('ab'), AB_COLUMNS),
    of('sweep').length > 0 && sweepTables(of('sweep').flatMap((r) => r.cells)),
    of('residual').length > 0 && table(of('residual'), ERROR_COLUMNS),
    of('cold').length > 0 && memoryTable(of('cold')),
    of('verify').length > 0 && table(of('verify'), STANCE_COLUMNS),
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** A row in one line, as the runner prints it after each run. */
export const progress = (r) =>
  ({
    ab: () =>
      `Δ ${fixed(r.summary.delta)} ms (spread ${fixed(r.summary.spread)}), base ${fixed(r.summary.base)}`,
    sweep: () =>
      `${r.cells.filter((c) => c.accepted).length} of ${r.cells.length} cells accepted`,
    residual: () =>
      r.refused ??
      `thin p95 ${pct(r.thin?.p95)}, display RMSE ${fixed(r.display?.rmse, 4)}`,
    cold: () =>
      `warm-up ${fixed(r.spans?.warmUp)} ms, the clouds' ${fixed(r.spans?.clouds)} ms`,
    verify: () =>
      `sun ${fixed(r.verify?.light?.sun, 1)}°, served ${r.verify?.served ?? '—'}`,
  })[r.type]()
