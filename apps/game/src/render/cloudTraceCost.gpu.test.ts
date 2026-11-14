import { mkdirSync, writeFileSync } from 'node:fs'
import { loadavg } from 'node:os'
import { describe, expect, it } from 'vitest'
import { farBlockPlans, WEATHER_SCENARIOS } from '@inertialref/rendering'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import { FAR_BLOCK, FAR_LAYOUT } from './cloudFarAtlas.ts'
import type { CloudLevers } from './cloudLevers.ts'
import { cloudRig, RIG_EARTH_RADIUS } from './cloudSystemRig.ts'
import { adapterOffers, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * What the trace costs, where it hurts: GPU milliseconds a frame of every
 * pass on the timeline, in the system's own chain, at ten stances and two
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
 * Two stand 400 km up over broken cloud, where through this lens the
 * handover is 206 km out and the nearest cloud in frame further, so every
 * ray is the far march's: `orbit`, 40° under the horizon beneath a 37.5°
 * sun, and `limb`, the frame's middle row tangent to the level's top beneath
 * a 15° sun, where a ray's chord through the level is its longest.
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
 * **The sky's light on a cloud is a build of the system, not a lever:**
 * `IR_CLOUD_COST_SKY=ambient` builds every chain of a session without the
 * sky's term (`CloudSystemDeps.skyTable`), the march's placeholder in its
 * place and no sky table in the kernel. What the term costs is that
 * session's rows against one's built as the system ships, taken in turn.
 *
 * **The far atlas's bake is timed a frame at a time, under a clock that
 * runs** (`the far atlas’s bake`, written to `.data/clouds/farPace.json`).
 * The rig's clock stands still, and a whole atlas then bakes nothing, so
 * every row above is a frame without it. On the three stances whose cover
 * is whole, each frame is timed by itself twice over: at 1×, the frame's
 * 95th percentile against its median over 640 frames, and under a warp
 * that owes a block every few frames, until every block of the body's
 * levels has been baked, the dearest frame against the median of that
 * cycle. The volume and the sun grid pace themselves by the same clock, so
 * a frame's other bakes are recorded beside the atlas's.
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
/** The sky's term as the system ships it, or the march's placeholder in its place. */
const SKY: 'table' | 'ambient' =
  process.env.IR_CLOUD_COST_SKY === 'ambient' ? 'ambient' : 'table'

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
/** The far march's two stances stand this high, meters. */
const ORBIT = 400_000
/**
 * Degrees over the horizon of the ray from `ORBIT` that is tangent to the
 * top of broken-horizon's level: the middle row of `limb`.
 */
const LIMB_PITCH =
  (-Math.acos(
    (RIG_EARTH_RADIUS + WEATHER_SCENARIOS['broken-horizon'].layers[0]!.top) /
      (RIG_EARTH_RADIUS + ORBIT),
  ) *
    180) /
  Math.PI

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
  { key: 'orbit', weather: 'broken-horizon', eye: ORBIT, pitch: -40, sun: SUN },
  {
    key: 'limb',
    weather: 'broken-horizon',
    eye: ORBIT,
    pitch: LIMB_PITCH,
    sun: sunAt(15, 60),
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
  it('is timed at ten stances and two sizes, every pass beside the frame with the clouds off, and written', async () => {
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
          ...(SKY === 'ambient' ? { skyTable: false } : {}),
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
              sky: SKY,
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

/* ------------------------------------------------------------------------- */
/* The far atlas's bake, a frame at a time                                    */
/* ------------------------------------------------------------------------- */

const PACE_OUT = process.env.IR_CLOUD_PACE_OUT ?? '.data/clouds/farPace.json'
/** The stances whose cover is whole: where a block of the atlas is dearest. */
const PACE_STANCES = ['overcast, up', 'inside', 'cirrus-over-cumulus, up']
/** Frames timed at 1×. */
const PACE_FRAMES = 640
/** The warp a cycle is timed under, and the most frames it is given. */
const PACE_WARP = Number(process.env.IR_CLOUD_PACE_WARP ?? 120)
const PACE_CYCLE_MOST = 6000
/** Every bake a frame may hold besides the trace's own passes. */
const BAKES =
  /^cloud (noise|maps|clipmap|volume|sun grid|far atlas|far second)$/

const percentile = (values: readonly number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b)
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ??
    Number.NaN
  )
}

describe.skipIf(!MEASURE || !TIMESTAMPS)('the far atlas’s bake', () => {
  it('is timed a frame at a time under a running clock, at 1× and through a cycle, and written', async () => {
    const rows: unknown[] = []
    for (const stance of STANCES.filter((s) => PACE_STANCES.includes(s.key))) {
      const own = await openGpu(1920, 1080)
      const chain = cloudRig(own, 1920, 1080, {
        eye: stance.eye,
        looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, radians(stance.pitch)),
        air: true,
        ...(stance.sun === undefined ? {} : { sun: stance.sun }),
        levers: { weather: stance.weather, on: true },
      })
      await chain.system!.warm()
      const stop = installPassTimeline(own.renderer)
      try {
        const timeline = passTimelineOf(own.renderer)!
        /** One frame by itself: its busy time, and its bakes by pass. */
        const one = async () => {
          const read = await timeline.measure(() => chain.frame(), 1)
          const bakes: Record<string, number> = {}
          for (const pass of read.passes)
            if (BAKES.test(pass.label))
              bakes[pass.label] = (bakes[pass.label] ?? 0) + pass.ms
          return { busyMs: read.busyMs, bakes }
        }
        const settle = async (levers: Levers) => {
          chain.levers = { ...chain.levers, ...levers, stats: false }
          for (let k = 0; k < SETTLE; k += 1) chain.frame()
          await own.read(chain.target)
        }
        const summary = (frames: Awaited<ReturnType<typeof one>>[]) => {
          const busy = frames.map((frame) => frame.busyMs)
          const baking = frames.filter(
            (frame) => (frame.bakes['cloud far atlas'] ?? 0) > 0,
          )
          const idle = frames.filter(
            (frame) => Object.keys(frame.bakes).length === 0,
          )
          const middle = median(busy)
          return {
            frames: frames.length,
            medianMs: middle,
            p95Ms: percentile(busy, 0.95),
            maxMs: Math.max(...busy),
            p95OverMedianMs: percentile(busy, 0.95) - middle,
            dearestOverMedianMs: Math.max(...busy) - middle,
            // A frame with no bake at all, and the frames that bake a block.
            idleFrames: idle.length,
            idleMedianMs: median(idle.map((frame) => frame.busyMs)),
            atlasFrames: baking.length,
            atlasFrameMs: baking.map((frame) => frame.busyMs),
            atlasPassMs: baking.map((frame) => frame.bakes['cloud far atlas']),
            dearestAtlasFrameOverMedianMs:
              baking.length === 0
                ? null
                : Math.max(...baking.map((frame) => frame.busyMs)) - middle,
            otherBakes: Object.fromEntries(
              [...new Set(frames.flatMap((f) => Object.keys(f.bakes)))].map(
                (label) => [
                  label,
                  frames.filter((f) => (f.bakes[label] ?? 0) > 0).length,
                ],
              ),
            ),
          }
        }
        // Whole and still first: what the clock then moves is all a frame bakes.
        await settle({ lightTaps: 4 })
        let more = 0
        while (
          chain.system!.report.settle?.pending === true &&
          more < SETTLE_MORE
        ) {
          for (let k = 0; k < 20; k += 1) chain.frame()
          await own.read(chain.target)
          more += 20
        }
        const still: Awaited<ReturnType<typeof one>>[] = []
        for (let k = 0; k < 64; k += 1) still.push(await one())
        await settle({ force: 'warp', warp: 1 })
        const steady: Awaited<ReturnType<typeof one>>[] = []
        for (let k = 0; k < PACE_FRAMES; k += 1) steady.push(await one())
        // A cycle: until the atlas has baked as many blocks as hold a row
        // of the body's levels.
        const levels =
          stance.weather === 'climate'
            ? 3
            : WEATHER_SCENARIOS[stance.weather].layers.length
        const held = farBlockPlans(FAR_LAYOUT).filter((plan) =>
          plan.levels.some((level) => level < levels),
        ).length
        await settle({ force: 'warp', warp: PACE_WARP })
        const cycle: Awaited<ReturnType<typeof one>>[] = []
        let baked = 0
        while (baked < held && cycle.length < PACE_CYCLE_MOST) {
          const frame = await one()
          cycle.push(frame)
          if ((frame.bakes['cloud far atlas'] ?? 0) > 0) baked += 1
        }
        expect(Number.isFinite(median(steady.map((f) => f.busyMs)))).toBe(true)
        rows.push({
          stance: stance.key,
          weather: stance.weather,
          block: FAR_BLOCK,
          heldBlocks: held,
          load: loadavg(),
          still: summary(still),
          steady: summary(steady),
          cycle: { warp: PACE_WARP, ...summary(cycle) },
        })
      } finally {
        stop()
        chain.dispose()
        own.dispose()
      }
    }
    mkdirSync('.data/clouds', { recursive: true })
    writeFileSync(
      PACE_OUT,
      `${JSON.stringify(
        {
          note: 'cloudTraceCost.gpu.test.ts: the frame’s GPU busy time a frame at a time at 1920 × 1080, 60° lens, air on, four taps: the clock still, running at 1×, and under a warp until the far atlas has baked every block of the body’s levels',
          at: new Date().toISOString(),
          rows,
        },
        null,
        2,
      )}\n`,
    )
    expect(rows.length).toBe(PACE_STANCES.length)
  }, 1_800_000)
})
