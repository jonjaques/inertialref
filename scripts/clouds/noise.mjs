/*
 * The runner's `noise` step and its table (phase 1 design §7.1, §7.2): what
 * a lever does to the picture over time, with the trace's jitter moving.
 *
 * The ladders (`radiance`, `page.mjs`) hold the jitter, because a held still
 * differs by one lever alone. Three of phase 1's choices are about the jitter
 * itself, or about what the history makes of it, so they cannot hold it:
 *
 * - `jitter`: `stbn` against `ign`. Each arm's converged noise, the temporal
 *   RMS over 64 captures of the cloud texels, and the error of the eighth
 *   frame after a reset against that 64-frame mean.
 * - `handover`: `handoverBand` 1, 1.5 and 2 against 3, on the stances where
 *   the band is in frame. Held, the dither's pattern is frozen, and two bands
 *   differ wherever their patterns differ by the two marches' disagreement,
 *   which no band brings under 1%; their 64-frame means do not.
 * - `clip`: 1.25, 1.5 and 2, each by its bias, the 64-frame mean of the
 *   history against the mean of its samples, at the worst cloud texel. A
 *   converged pixel's own deviation is near 5% at any width, so the rule
 *   reads the bias and not the deviation (§7.4).
 *
 * The page offers no readback of the trace's own samples beside the
 * history's, so a clip's bias is read against an arm whose clip holds
 * nothing: `UNCLIPPED` standard deviations, where the history is the plain
 * exponential mean of its samples and so has their mean. That stand-in is
 * this file's, and the report that would make it unnecessary is a capture of
 * the trace's output before the history.
 *
 * `noiseStep` travels as text, as `cloudStep` does: it names its argument
 * and the page's globals and nothing of this module. An arm keeps its means
 * in the page (`irNoise`) for the comparisons after it, one step an arm, so
 * no step outlasts the DevTools channel's 120 s.
 */
import {
  NAMED,
  OPERATING,
  SETTLE_CAP,
  addKind,
  pageStep,
  pct,
  standing,
  table,
} from './page.mjs'

/** Captures an arm averages: the history's mean correlates over about 32 frames. */
export const NOISE_FRAMES = 64
/** Frames past the settle before the means start, as the ladders wait (`RADIANCE_CONVERGE`). */
const CONVERGE = 32
/** The frame after a reset whose error the jitter's rule reads. */
export const EIGHTH = 8
/**
 * A clip this wide holds nothing: a sample sixteen standard deviations from
 * its neighborhood's mean does not occur over a converged cloud, so the
 * history is the exponential mean of its samples, and its mean is theirs.
 */
export const UNCLIPPED = 16

/**
 * @param {{kind: string} & Record<string, unknown>} step
 */
export async function noiseStep(step) {
  const frame = () =>
    new Promise((done) => requestAnimationFrame(() => done(undefined)))
  const report = () => (typeof ir.clouds === 'function' ? ir.clouds() : null)
  const set = (levers) => {
    engine.clouds = { ...levers }
  }
  const store = (globalThis.irNoise ??= {})
  const settle = async (cap) => {
    for (let i = 0; i < cap; i += 1) {
      await frame()
      const s = report()?.settle ?? null
      if (i >= 4 && (s === null || !s.pending)) return i + 1
    }
    return cap
  }
  // Capture k from a frame ≡ k (mod 4), so each phase of the interleave is
  // in the mean alike; the ladders' `radiance` step says why.
  const captureAt = async (residue) => {
    for (let tick = 0; tick < 16; tick += 1) {
      if (((report()?.frames ?? 0) + 1) % 4 === residue)
        return await ir.cloudRadiance()
      await frame()
    }
    throw new Error(`no frame ≡ ${residue} (mod 4) drawn in 16 ticks`)
  }

  const steps = {
    async arm() {
      set({ ...step.levers, force: 'reset' })
      await frame()
      set(step.levers)
      // The capture is of the first frame drawn after the ask, so the ask
      // waits for the frame before the one it wants.
      let eighth = null
      for (let i = 0; i < 64 && eighth === null; i += 1) {
        if ((report()?.sinceReset ?? 0) >= step.eighth - 1)
          eighth = await ir.cloudRadiance()
        else await frame()
      }
      const settled = await settle(step.settleCap)
      for (let i = 0; i < step.converge; i += 1) await frame()
      let mean = null
      let m2 = null
      let cloud = null
      let width = 0
      let height = 0
      for (let k = 0; k < step.frames; k += 1) {
        const shot = await captureAt(k % 4)
        if (shot === null) return { settled, texels: null }
        if (mean === null) {
          ;({ width, height } = shot)
          mean = new Float64Array(width * height)
          m2 = new Float64Array(width * height)
          cloud = new Uint8Array(width * height)
        }
        // Welford's running mean and sum of squares, a texel at a time.
        for (let i = 0; i < mean.length; i += 1) {
          const x = shot.luminance[i]
          const d = x - mean[i]
          mean[i] += d / (k + 1)
          m2[i] += d * (x - mean[i])
          cloud[i] |= shot.cloud[i]
        }
      }
      store[step.name] = { width, height, mean, cloud }
      let texels = 0
      let level = 0
      let variance = 0
      let eighthError = 0
      for (let i = 0; i < mean.length; i += 1) {
        if (!cloud[i]) continue
        texels += 1
        level += mean[i]
        variance += m2[i] / (step.frames - 1)
        if (eighth !== null) eighthError += (eighth.luminance[i] - mean[i]) ** 2
      }
      const scale = level / Math.max(texels, 1)
      return {
        settled,
        extent: [width, height],
        texels,
        level: scale,
        // Relative to the arm's own mean level, as the ladders' RMSE is.
        temporalRms:
          texels > 0 && scale > 0 ? Math.sqrt(variance / texels) / scale : null,
        eighthError:
          eighth === null || texels === 0 || scale <= 0
            ? null
            : Math.sqrt(eighthError / texels) / scale,
      }
    },
    compare() {
      const a = store[step.a]
      const b = store[step.b]
      if (a === undefined || b === undefined)
        throw new Error(
          `no arm ${a === undefined ? step.a : step.b} to compare`,
        )
      if (a.mean.length !== b.mean.length)
        throw new Error(`${step.a} and ${step.b} are of two extents`)
      let texels = 0
      let level = 0
      let squares = 0
      let worst = 0
      for (let i = 0; i < a.mean.length; i += 1) {
        if (!a.cloud[i] || !b.cloud[i]) continue
        const d = a.mean[i] - b.mean[i]
        texels += 1
        level += b.mean[i]
        squares += d * d
        if (b.mean[i] > 0) worst = Math.max(worst, Math.abs(d) / b.mean[i])
      }
      const scale = level / Math.max(texels, 1)
      return {
        texels,
        relative:
          texels > 0 && scale > 0 ? Math.sqrt(squares / texels) / scale : null,
        worst: texels > 0 ? worst : null,
      }
    },
    clear() {
      globalThis.irNoise = {}
      return { cleared: true }
    },
  }
  const run = steps[step.kind]
  if (run === undefined) throw new Error(`no noise step ${String(step.kind)}`)
  return await run()
}

/* ------------------------------------------------------------- the Node half ---- */

const INSTALL = `(globalThis.irNoiseStep = ${noiseStep.toString()}, typeof globalThis.irNoiseStep)`
const js = pageStep('irNoiseStep')

/** An arm's seconds: a reset, the settle, 32 frames and 64 aligned captures with their readbacks. */
const ARM_SECONDS = 20

const steps = (run) => [
  ...run.arms.map((arm) =>
    js(
      `arm:${arm.name}`,
      {
        kind: 'arm',
        name: arm.name,
        levers: arm.levers,
        frames: NOISE_FRAMES,
        converge: CONVERGE,
        eighth: EIGHTH,
        settleCap: SETTLE_CAP,
      },
      ARM_SECONDS,
    ),
  ),
  ...run.compares.map(([a, b]) =>
    js(`compare:${a}:${b}`, { kind: 'compare', a, b }, 1),
  ),
  js('clear', { kind: 'clear' }, 0),
]

const read = (run, value) => ({
  arms: run.arms.map((arm) => {
    const r = value(`arm:${arm.name}`) ?? null
    return {
      name: arm.name,
      temporalRms: r?.temporalRms ?? null,
      eighthError: r?.eighthError ?? null,
      texels: r?.texels ?? null,
      settled: r?.settled ?? null,
    }
  }),
  compares: run.compares.map(([a, b]) => {
    const r = value(`compare:${a}:${b}`) ?? null
    return {
      a,
      b,
      relative: r?.relative ?? null,
      worst: r?.worst ?? null,
      texels: r?.texels ?? null,
    }
  }),
})

/** Why a noise row cannot stand: an arm that captured nothing, or a comparison that read nothing. */
function unfit(row) {
  const empty = row.arms.find((a) => !Number.isFinite(a.temporalRms))
  if (empty !== undefined) return `no noise capture for ${empty.name}`
  const blind = row.compares.find((c) => !Number.isFinite(c.relative))
  if (blind !== undefined) return `no comparison of ${blind.a} with ${blind.b}`
  return null
}

const COLUMNS = [
  ...NAMED,
  ['Batch', (r) => r.batch],
  ['Arm', (r) => r.arm],
  ['temporal RMS', (r) => pct(r.temporalRms, 2)],
  ['8th frame error', (r) => pct(r.eighthError, 2)],
  ['against', (r) => r.against ?? '—'],
  ['mean difference RMS', (r) => pct(r.relative, 2)],
  ['worst texel', (r) => pct(r.worst, 2)],
  ['cloud texels', (r) => r.texels ?? '—'],
  ...OPERATING,
  ['quiet', standing],
]

/** One line an arm, then one a comparison, under the row's stance and size. */
export const noiseTable = (rows) =>
  table(
    rows.flatMap((r) => [
      ...r.arms.map((a) => ({ ...r, ...a, arm: a.name })),
      ...r.compares.map((c) => ({ ...r, ...c, arm: c.a, against: c.b })),
    ]),
    COLUMNS,
  )

const progress = (r) =>
  [
    ...r.arms.map(
      (a) =>
        `${a.name} ${pct(a.temporalRms, 2)} (8th ${pct(a.eighthError, 2)})`,
    ),
    ...r.compares.map(
      (c) => `${c.a}−${c.b} ${pct(c.relative, 2)} (worst ${pct(c.worst, 2)})`,
    ),
  ].join(', ')

addKind('noise', {
  install: INSTALL,
  steps,
  read,
  unfit,
  table: noiseTable,
  progress,
})

/* --------------------------------------------------------------- the batches ---- */

/** The handover's bands, each against the widest. */
export const BANDS = Object.freeze([1, 1.5, 2, 3])
/** The clip's widths, each against `UNCLIPPED`. */
export const CLIPS = Object.freeze([1.25, 1.5, 2])

/**
 * The noise batches, from the runner's kit (`measure.mjs`): a run of arms
 * and comparisons at one stance and size.
 */
export function noiseBatches(kit) {
  const { ab, stood, levers, ON } = kit
  const noise = (batch, scenario, size, arms, compares) => ({
    id: [batch, 'noise', scenario, size].join('/'),
    type: 'noise',
    batch,
    group: 'noise',
    label: batch,
    ...stood(scenario, size),
    arms: arms.map(([name, over]) => ({
      name,
      levers: levers(scenario, { ...ON, ...over }),
    })),
    compares,
  })
  const at = (stances, size, make) => stances.flatMap((s) => make(s, size))
  return {
    jitter: (size) =>
      at(['horizon', 'inside'], size, (s) => [
        ab('jitter', 'cost', 'stbn', s, size, 'steady', {
          base: { ...ON, jitter: 'ign' },
          candidate: { ...ON, jitter: 'stbn' },
        }),
        noise(
          'jitter',
          s,
          size,
          [
            ['ign', { jitter: 'ign' }],
            ['stbn', { jitter: 'stbn' }],
          ],
          [],
        ),
      ]),
    handover: (size) =>
      at(['earth-limb', 'descent-150'], size, (s) => [
        noise(
          'handover',
          s,
          size,
          BANDS.map((band) => [`band ${band}`, { handoverBand: band }]),
          BANDS.slice(0, -1).map((band) => [
            `band ${band}`,
            `band ${BANDS.at(-1)}`,
          ]),
        ),
      ]),
    clip: (size) =>
      at(['horizon', 'inside'], size, (s) => [
        noise(
          'clip',
          s,
          size,
          [
            ...CLIPS.map((clip) => [`clip ${clip}`, { clip }]),
            ['unclipped', { clip: UNCLIPPED }],
          ],
          CLIPS.map((clip) => [`clip ${clip}`, 'unclipped']),
        ),
      ]),
  }
}
