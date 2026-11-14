import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { uniform } from 'three/tsl'
import { type CloudField, createCloudField } from './cloudField.ts'
import {
  FAR_CASES,
  FAR_FOOTPRINTS,
  FAR_RIG_CSS,
  FAR_RIG_HEIGHT,
  FAR_RIG_PIXEL_ANGLE,
  FAR_RIG_WIDTH,
  type FarCase,
  type FarFootprint,
  farReads,
  type FarScore,
  farSession,
  farStance,
  fineVariant,
  handoverVariant,
  marchSummary,
  NO_SCENE,
  PITCH_BIN_RAYS,
  PITCH_EDGES,
  type PitchBin,
  ROW_11,
  scoreFar,
  SHIPPED_STEPS,
} from './cloudFarRig.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import landedDocument from './cloudHandover.landed.json' with { type: 'json' }
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The handover's two marches (the rubric's row 11): what a pixel in the
 * band can draw, against the fine march alone. A ray's fine march stops at
 * `farDistance·band^ξ` and the far march takes it from there, composed as
 * the trace composes them (`marchFar`); the reference is the same fine
 * march over the whole ray. ξ of 0, ½ and 1 are the band's near edge, its
 * middle and its far edge: footprints of `farFootprint`, √2 and 2 times it.
 *
 * **A figure is of the rays the far march ran on.** A ray the fine march
 * carries to its end, or under 1% before its stop, is the fine march's own
 * in both records, and a bin of them agrees with itself.
 *
 * **By footprint, pitch bin and regime** (`cloudFarRig.ts`): the pitch is
 * the ray's angle to the local horizontal at its stop, and a bin's figure
 * is its rays' mean transmittance, and mean radiance, over the fine
 * march's, less one. Row 11's bars are 10% and 15%. It is a declared row:
 * every bin is a ceiling at its landed figure
 * (`cloudHandover.landed.json`, taken on the Mac mini, Mac18,5, Apple M6;
 * the transmittance as `PitchBin.held` has it), and the document counts
 * the bins inside the bars two ways, the transmittance within the larger
 * of a tenth of the fine march's and 0.01, and within the plain tenth.
 *
 * **Forms are chosen on two regimes and judged on the rest.** Broken
 * cumulus and fair cumulus at 800 m are the tuning rows (`tuned`). Cirrus
 * over cumulus, the anvil, the overcast, grazing at sunset, and every case
 * at 400 m and 1,600 m are run and reported, and no form is chosen on them.
 *
 * One case runs in every `pnpm test:gpu`, broken cumulus at 800 m; the
 * whole table under IR_CLOUD_MEASURE=1, which writes
 * `.data/clouds/handover.json` before it asserts anything.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/handover.json'
/** The same run as the landed document holds it: what replaces `cloudHandover.landed.json` when a figure moves. */
const OUT_LANDED = '.data/clouds/handover.landed.json'
const ALWAYS = { case: 'broken cumulus', footprintMeters: 800 } as const
/** Where in the band a ray stops: its near edge, its middle, its far edge. */
const XI = [0, 0.5, 1] as const
const BAND = DEFAULT_CLOUD_LEVERS.handoverBand
/** A bin is held where the landed one holds twice the rays a figure needs (`cloudFarCompare.gpu.test.ts`). */
const HELD_RAYS = 2 * PITCH_BIN_RAYS
/** What a figure may pass its landed size by: a tenth of it, or half a point. */
const ceiling = (was: number): number =>
  Math.max(Math.abs(was) * 1.1, Math.abs(was) + 0.005)

let gpu: GpuSession
let field: CloudField

beforeAll(async () => {
  gpu = await openGpu(FAR_RIG_CSS.width, FAR_RIG_CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

/** One stop in the band of one case at one footprint. */
interface Stop {
  readonly xi: number
  readonly stopKm: number
  /** Meters a trace texel spans at the stop. */
  readonly footprintMeters: number
  /** Which statistics each march read of each level there. */
  readonly reads: ReturnType<typeof farReads>
  readonly score: FarScore
}

interface Row {
  readonly case: string
  readonly scenario: string
  readonly tuned: boolean
  readonly farFootprintMeters: number
  readonly eyeMeters: number
  readonly pitchDegrees: number
  readonly sun: FarCase['sun']
  readonly reference: ReturnType<typeof marchSummary>
  readonly band: readonly Stop[]
}

/** What the landed document keeps of a row: each stop's bins, their rays and their two figures. */
interface LandedRow {
  readonly case: string
  readonly farFootprintMeters: number
  readonly band: readonly {
    readonly xi: number
    readonly bins: readonly Pick<
      PitchBin,
      'bin' | 'rays' | 'transmittance' | 'radiance' | 'held'
    >[]
  }[]
}

const landed = landedDocument as unknown as {
  readonly cases: readonly LandedRow[]
}

/** A run's rows as the landed document holds them. */
const landedOf = (rows: readonly Row[]): readonly LandedRow[] =>
  rows.map((row) => ({
    case: row.case,
    farFootprintMeters: row.farFootprintMeters,
    band: row.band.map((stop) => ({
      xi: stop.xi,
      bins: stop.score.bins.map(
        ({ bin, rays, transmittance, radiance, held }) => ({
          bin,
          rays,
          transmittance,
          radiance,
          held,
        }),
      ),
    })),
  }))

const figures = (value: unknown, path: string): [string, number][] =>
  typeof value === 'number'
    ? [[path, value]]
    : typeof value === 'object' && value !== null
      ? Object.entries(value).flatMap(([key, inner]) =>
          figures(inner, `${path}.${key}`),
        )
      : []

/** Hold a row's bins to their landed ceilings, and every figure of it finite. */
function hold(found: Row): void {
  const what = `${found.case} at ${found.farFootprintMeters} m`
  for (const [path, value] of figures(found, what)) {
    expect(Number.isFinite(value), path).toBe(true)
  }
  const pinned = landed.cases.find(
    (row) =>
      row.case === found.case &&
      row.farFootprintMeters === found.farFootprintMeters,
  )
  // A row with no landed figures is a row that cannot fail.
  if (pinned === undefined) throw new Error(`no landed figures for ${what}`)
  for (const then of pinned.band) {
    const now = found.band.find((stop) => stop.xi === then.xi)
    for (const was of then.bins) {
      if (was.rays < HELD_RAYS) continue
      const bin = now?.score.bins.find((held) => held.bin === was.bin)
      for (const figure of ['held', 'radiance'] as const) {
        const landedFigure = was[figure]
        if (landedFigure === null) continue
        const path = `${what}, ξ ${then.xi}, ${was.bin}: ${figure}`
        const read = bin?.[figure] ?? null
        // A bin that held a figure and holds none has lost its cloud or its rays.
        expect(read, path).not.toBeNull()
        expect(Math.abs(read!), path).toBeLessThanOrEqual(ceiling(landedFigure))
      }
    }
  }
}

describe('the handover’s two marches', () => {
  async function measure(
    cases: readonly FarCase[],
    footprints: readonly FarFootprint[],
  ): Promise<Row[]> {
    const session = farSession(gpu, field)
    const xi = uniform(0)
    const kernels = {
      fine: session.kernel(fineVariant(field)),
      both: session.kernel(handoverVariant(field, xi)),
    }
    const results: Row[] = []
    for (const c of cases)
      for (const footprint of footprints) {
        const { eye, pitch } = farStance(c, footprint)
        const tFar = footprint / FAR_RIG_PIXEL_ANGLE
        const frame = session.settle(c, footprint)
        expect(frame.extents.trace).toEqual({
          width: FAR_RIG_WIDTH,
          height: FAR_RIG_HEIGHT,
        })
        expect(field.uniforms.trace.farDistance.value).toBeCloseTo(tFar, 0)
        expect(field.uniforms.trace.maxSteps.value).toBe(SHIPPED_STEPS)
        const reference = await session.dispatch(kernels.fine, {
          farDistance: NO_SCENE,
        })
        const band: Stop[] = []
        for (const at of XI) {
          xi.value = at
          const stop = tFar * BAND ** at
          // The pitch and the far texel are the ray's at its own stop.
          session.handover.value = stop
          const both = await session.dispatch(kernels.both)
          band.push({
            xi: at,
            stopKm: stop / 1000,
            footprintMeters: footprint * BAND ** at,
            reads: farReads(frame, footprint * BAND ** at, footprint),
            score: scoreFar(reference, both, true),
          })
        }
        results.push({
          case: c.id,
          scenario: c.scenario,
          tuned: c.tuned && footprint === 800,
          farFootprintMeters: footprint,
          eyeMeters: eye,
          pitchDegrees: -pitch,
          sun: c.sun,
          reference: marchSummary(reference),
          band,
        })
      }
    session.dispose()
    return results
  }

  const describeBins = (stop: Stop): string =>
    stop.score.bins
      .filter((bin) => bin.transmittance !== null)
      .map(
        (bin) =>
          `${bin.bin} T ${(bin.transmittance! * 100).toFixed(1)}%` +
          (bin.radiance === null
            ? ''
            : ` L ${(bin.radiance * 100).toFixed(1)}%`),
      )
      .join('; ')

  it('holds broken cumulus at 800 m across the band, bin by bin, no worse than landed, in every run of the suite and on every adapter', async () => {
    const [found] = await measure(
      FAR_CASES.filter((c) => c.id === ALWAYS.case),
      [ALWAYS.footprintMeters],
    )
    expect(found?.case).toBe(ALWAYS.case)
    for (const stop of found!.band)
      console.info(
        `${found!.case} at ${found!.farFootprintMeters} m, ξ ${stop.xi}, the two marches over the fine march less one: ${describeBins(stop)}`,
      )
    hold(found!)
  }, 180_000)

  it.skipIf(!MEASURE)(
    'writes all six cases at three footprints and three stops in the band, then holds every bin no worse than landed',
    async () => {
      const results = await measure(FAR_CASES, FAR_FOOTPRINTS)
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudHandover.gpu.test.ts: the fine march to farDistance·band^ξ and the far march from there, against the fine march over the whole ray, on the real field, by pitch bin, over the rays the far march ran on',
            body: 'Earth',
            trace: {
              width: FAR_RIG_WIDTH,
              height: FAR_RIG_HEIGHT,
              pixelAngle: FAR_RIG_PIXEL_ANGLE,
            },
            band: BAND,
            pitchEdgesDegrees: PITCH_EDGES,
            row11: ROW_11,
            units: {
              bins: 'the two marches’ mean over the fine march’s, less one; null under 256 rays, and the radiance null where the fine march’s opacity is 0.02 or less',
              count:
                'bins inside row 11’s bars of the bins that hold a figure: transmittance within the larger of a tenth of the fine march’s and 0.01, transmittancePlain within the tenth, radiance within 15%',
            },
            cases: results,
          },
          null,
          2,
        )}\n`,
      )
      writeFileSync(
        OUT_LANDED,
        `${JSON.stringify(
          {
            note: 'cloudHandover.gpu.test.ts on the Mac mini (Mac18,5, Apple M6): at each stop in the band, each pitch bin’s rays, and the two marches’ mean transmittance and radiance over the fine march’s, less one, over the rays the far march ran on',
            pitchEdgesDegrees: PITCH_EDGES,
            cases: landedOf(results),
          },
          null,
          1,
        )}\n`,
      )
      expect(results).toHaveLength(FAR_CASES.length * FAR_FOOTPRINTS.length)
      for (const found of results) hold(found)
    },
    900_000,
  )
})
