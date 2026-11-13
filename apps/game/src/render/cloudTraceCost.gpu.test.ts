import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import type { CloudLevers } from './cloudLevers.ts'
import { cloudRig } from './cloudSystemRig.ts'
import { adapterOffers, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * What the trace costs, where it hurts: GPU milliseconds a frame of every
 * pass on the timeline, in the system's own chain, at eight stances and two
 * sizes, each beside the same session's frame with the clouds off.
 *
 * **A row's figure of record is the whole frame's difference,** the frame's
 * busy time with the clouds on less the same session's with them off
 * (`delta`). A pass's label is recorded beside it and held to nothing: on
 * this GPU a label moves by 30% with how frames are submitted while the
 * frame's total does not. Under full cover the far atlas bakes a block of
 * 1.3 to 3.6 ms on a third of the frames, so `deltaLessAtlas`, the
 * difference with that pass taken out of both, is the steadier figure there.
 *
 * **The stances.** Three look straight up from 100 m, as the instrument
 * always has. Three stand in for the campaign's gated ones, under a 37.5°
 * sun: `ground` (fair cumulus from 2 m, 10° over the horizon), `horizon`
 * (broken cloud from 2 m, 2° over it) and `inside` (level, 1,200 m up in a
 * deck). Two look down on an overcast, from 12 km and from 150 km, where
 * the same nine steps a ray cost three times as much. A grazing stance is
 * where the trace is dearest: 9% of its rays take the whole budget, and this
 * GPU runs 32 rays at a time at the pace of the longest.
 *
 * **The sizes** are the rubric's two: 1920 × 1080 at a pixel ratio of one,
 * which traces 480 × 270, and the campaign's Retina, 1440 × 900 at a ratio
 * of two, which traces 360 × 225.
 *
 * **The protocol** is the cost reckoning's: 140 frames of settling, more
 * while the system reports work owed, then the median of five runs of eight
 * frames. The rays' counters are read from the same lever set afterward
 * (`steps`): the steps a ray by kind, the sun's samples, the taps taken and
 * skipped, and the mean over the GPU's batches of 32 rays of each batch's
 * longest ray.
 *
 * **A row is a stance and a lever set,** so a package that adds a cost adds
 * its lever set to `VARIANTS` and reads its row against the default's:
 * `IR_CLOUD_COST_ONLY` takes the words a session's key may hold, with
 * semicolons between them, and `IR_CLOUD_COST_TAPS` the tap counts in place
 * of none and four.
 *
 * A test's figures, of these stances on this adapter. A campaign's stances
 * and its protocol are not these. Written to `.data/clouds/traceCost.json`,
 * or to `IR_CLOUD_COST_OUT`, and held to nothing but being numbers.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const TIMESTAMPS = await adapterOffers('timestamp-query')
const COST_OUT = process.env.IR_CLOUD_COST_OUT ?? '.data/clouds/traceCost.json'
const ONLY = (process.env.IR_CLOUD_COST_ONLY ?? '')
  .split(';')
  .map((word) => word.trim())
  .filter((word) => word.length > 0)
const TAPS = (process.env.IR_CLOUD_COST_TAPS ?? '0,4')
  .split(',')
  .map((count) => Number(count))

/** Frames of settling before a row, the most more while work is owed, and the runs a row is the median of. */
const SETTLE = 140
const SETTLE_MORE = 400
const RUNS = 5
const FRAMES_A_RUN = 8
/** The far atlas's passes, the served body's and a second body's: what `deltaLessAtlas` leaves out. */
const ATLAS = /^cloud far atlas/

type Levers = Partial<CloudLevers>

interface Variant {
  readonly name: string
  readonly levers: Levers
}

interface Stance {
  readonly key: string
  readonly weather: CloudLevers['weather']
  /** Meters over the datum. */
  readonly eye: number
  /** Degrees over the horizon: 90 looks straight up, −90 down. */
  readonly pitch: number
  /** Toward the sun, render axes; the rig's own when absent. */
  readonly sun?: Vec3
}

interface Size {
  readonly key: string
  /** CSS pixels and the pixel ratio: the drawing buffer is their product. */
  readonly css: readonly [number, number]
  readonly dpr: number
  readonly variants: readonly Variant[]
}

const radians = (degrees: number): number => (degrees * Math.PI) / 180
/** A sun `elevation` degrees up, `azimuth` degrees off the view's heading, render axes at the eye's place. */
const sunAt = (elevation: number, azimuth: number): Vec3 => ({
  x: -Math.sin(radians(azimuth)) * Math.cos(radians(elevation)),
  y: Math.sin(radians(elevation)),
  z: -Math.cos(radians(azimuth)) * Math.cos(radians(elevation)),
})
const SUN = sunAt(37.5, 60)

const STANCES: readonly Stance[] = [
  { key: 'overcast, up', weather: 'overcast', eye: 100, pitch: 90 },
  { key: 'fair-cumulus, up', weather: 'fair-cumulus', eye: 100, pitch: 90 },
  {
    key: 'cirrus-over-cumulus, up',
    weather: 'cirrus-over-cumulus',
    eye: 100,
    pitch: 90,
  },
  { key: 'ground', weather: 'fair-cumulus', eye: 2, pitch: 10, sun: SUN },
  { key: 'horizon', weather: 'broken-horizon', eye: 2, pitch: 2, sun: SUN },
  { key: 'inside', weather: 'inside', eye: 1200, pitch: 0, sun: SUN },
  { key: 'overcast, 12 km down', weather: 'overcast', eye: 12_000, pitch: -90 },
  {
    key: 'overcast, 150 km down',
    weather: 'overcast',
    eye: 150_000,
    pitch: -90,
  },
]

const OFF: Variant = { name: 'off', levers: { on: false } }
const tapped = (lightTaps: number): Variant => ({
  name: `${lightTaps} taps`,
  levers: { lightTaps } as Levers,
})

/**
 * The light after first order with no factor of the sun by level: the
 * plane slab's source alone, at the default's four taps. Its row against
 * the four-tap row is what the factor costs; what the source's read costs
 * is the four-tap row against the tree before it, which no lever draws.
 */
const PLANE: Variant = {
  name: '4 taps, plane',
  levers: { lightTaps: 4, transport: 'plane' },
}

/**
 * The lever sets a stance is timed under, the clouds off first. A package
 * that adds a cost to the trace adds its lever set here.
 */
const VARIANTS: readonly Variant[] = [OFF, ...TAPS.map(tapped), PLANE]

const SIZES: readonly Size[] = [
  { key: '1080p', css: [1920, 1080], dpr: 1, variants: VARIANTS },
  // The default's row and the clouds-off frame alone: the taps' split is 1080p's.
  {
    key: 'retina',
    css: [1440, 900],
    dpr: 2,
    variants: [OFF, tapped(4)],
  },
]

const median = (values: readonly number[]): number =>
  [...values].sort((a, b) => a - b)[values.length >> 1] ?? Number.NaN

interface Timed {
  readonly busyMs: number
  readonly busyRuns: readonly number[]
  readonly wallMs: number
  /** Each pass's share of the frame: the median of the runs, and the runs. */
  readonly passes: Readonly<
    Record<string, { readonly ms: number; readonly runs: readonly number[] }>
  >
}

describe.skipIf(!MEASURE || !TIMESTAMPS)('the trace’s cost', () => {
  it('is timed at eight stances and two sizes, every pass beside the frame with the clouds off, and written', async () => {
    const rows: unknown[] = []
    for (const size of SIZES)
      for (const stance of STANCES) {
        const key = `${size.key} ${stance.key}`
        if (ONLY.length > 0 && !ONLY.some((word) => key.includes(word)))
          continue
        const [cssWidth, cssHeight] = size.css
        const width = cssWidth * size.dpr
        const height = cssHeight * size.dpr
        const own = await openGpu(cssWidth, cssHeight)
        if (size.dpr !== 1) own.renderer.setPixelRatio(size.dpr)
        const chain = cloudRig(own, width, height, {
          eye: stance.eye,
          looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, radians(stance.pitch)),
          air: true,
          ...(stance.sun === undefined ? {} : { sun: stance.sun }),
          levers: { weather: stance.weather, on: true },
        })
        await chain.system!.warm()
        const base = chain.levers
        const load = loadavg()
        const stop = installPassTimeline(own.renderer)
        try {
          const timeline = passTimelineOf(own.renderer)!
          let off: Timed | null = null
          for (const variant of size.variants) {
            chain.levers = { ...base, ...variant.levers, stats: false }
            for (let k = 0; k < SETTLE; k += 1) chain.frame()
            await own.read(chain.target)
            // Until the caches hold the field and the history its samples:
            // a lever that resets the field rebuilds them.
            let more = 0
            while (
              chain.levers.on &&
              chain.system!.report.settle?.pending === true &&
              more < SETTLE_MORE
            ) {
              for (let k = 0; k < 20; k += 1) chain.frame()
              await own.read(chain.target)
              more += 20
            }
            const runs: {
              busyMs: number
              wallMs: number
              passes: Record<string, number>
            }[] = []
            for (let n = 0; n < RUNS; n += 1) {
              const read = await timeline.measure(
                () => chain.frame(),
                FRAMES_A_RUN,
              )
              const passes: Record<string, number> = {}
              for (const pass of read.passes)
                passes[pass.label] = (passes[pass.label] ?? 0) + pass.ms
              runs.push({ busyMs: read.busyMs, wallMs: read.wallMs, passes })
            }
            const labels = [
              ...new Set(runs.flatMap((run) => Object.keys(run.passes))),
            ]
            const timed: Timed = {
              busyMs: median(runs.map((run) => run.busyMs)),
              busyRuns: runs.map((run) => run.busyMs),
              wallMs: median(runs.map((run) => run.wallMs)),
              passes: Object.fromEntries(
                labels.map((label) => {
                  const each = runs.map((run) => run.passes[label] ?? 0)
                  return [label, { ms: median(each), runs: each }]
                }),
              ),
            }
            expect(Number.isFinite(timed.busyMs)).toBe(true)
            if (!chain.levers.on) off = timed
            const atlas = (of: Timed): number =>
              Object.entries(of.passes).reduce(
                (sum, [label, pass]) =>
                  ATLAS.test(label) ? sum + pass.ms : sum,
                0,
              )
            let report: unknown = null
            if (chain.levers.on) {
              chain.levers = { ...chain.levers, stats: true }
              for (let k = 0; k < 12; k += 1) {
                chain.frame()
                await new Promise((resolve) => setTimeout(resolve, 5))
              }
              const got = chain.system!.report
              report = {
                trace: got.extents.trace,
                steps: got.steps,
                settle: got.settle,
              }
            }
            rows.push({
              key,
              size: size.key,
              render: [width, height],
              stance: stance.key,
              weather: stance.weather,
              eye: stance.eye,
              pitch: stance.pitch,
              variant: variant.name,
              levers: variant.levers,
              load,
              settledAfter: SETTLE + more,
              // The figure of record: the whole frame, clouds on less off.
              delta:
                chain.levers.on && off !== null
                  ? timed.busyMs - off.busyMs
                  : null,
              deltaLessAtlas:
                chain.levers.on && off !== null
                  ? timed.busyMs - atlas(timed) - (off.busyMs - atlas(off))
                  : null,
              traceMs: timed.passes['cloud trace']?.ms ?? null,
              ...timed,
              report,
            })
          }
        } finally {
          stop()
          chain.dispose()
          own.dispose()
        }
      }
    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      COST_OUT,
      `${JSON.stringify(
        {
          note: 'cloudTraceCost.gpu.test.ts: GPU ms a frame of every pass on the timeline in the system’s chain, and the whole frame’s busy time with the clouds on less the same session’s with them off; a test’s figures at these stances, not a campaign’s',
          protocol: `60° lens, air on, converging, the median of ${RUNS} runs of ${FRAMES_A_RUN} frames after ${SETTLE} and while work is owed`,
          at: new Date().toISOString(),
          rows,
        },
        null,
        2,
      )}\n`,
    )
    expect(rows.length).toBeGreaterThan(0)
  }, 1_800_000)
})
