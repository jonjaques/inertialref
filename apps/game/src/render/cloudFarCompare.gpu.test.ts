import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { StorageBufferAttribute, type Texture } from 'three/webgpu'
import {
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  storage,
  textureLoad,
  uint,
} from 'three/tsl'
import { cubeFaceOf } from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
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
  farVariant,
  fineVariant,
  LONG_STEPS,
  marchSummary,
  NO_SCENE,
  PITCH_BIN_RAYS,
  PITCH_EDGES,
  type PitchBin,
  scoreFar,
  SHIPPED_STEPS,
} from './cloudFarRig.ts'
import { RIG_EARTH_RADIUS } from './cloudSystemRig.ts'
import landedDocument from './cloudFarCompare.landed.json' with { type: 'json' }
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The far atlas against the fine march on the real field (§5.9): six cases
 * at three footprints, every ray marched by the far march alone from t₀ and
 * scored against the fine march over the whole ray, by pitch bin
 * (`cloudFarRig.ts`).
 *
 * **Its reference is the fine march the far one takes over from:** the
 * trace's own, at the shipped budget of 192 steps, with the handover pushed
 * past every span. The same march at a budget no ray spends is recorded
 * beside it, with the count of rays whose floor lengthened a step in cloud
 * at each budget. That count is a record: a ray that grazes a level from
 * orbit has its steps lengthened at any budget, and nothing here is held to
 * it.
 *
 * **The document is written before anything is asserted,** to
 * `.data/clouds/farCompare.json` under IR_CLOUD_MEASURE=1, so a case past
 * its ceiling still leaves the run's figures. One case runs in every
 * `pnpm test:gpu`, broken cumulus at 800 m.
 *
 * **Every bin is a ceiling at its landed figure.**
 * `cloudFarCompare.landed.json` is this instrument's document on the tree
 * that holds it, taken on the Mac mini (Mac18,5, Apple M6): each bin's rays
 * and its figures, written beside the whole document as
 * `.data/clouds/farCompare.landed.json`. A bin's transmittance and its
 * radiance, each the far march's mean over the fine march's less one, may
 * pass the landed figure's size by a tenth of it, or by half a point where
 * the figure is small. The transmittance is held as `PitchBin.held` has it:
 * under an opaque deck it is a difference, where the plain figure is a
 * ratio of two numbers near nothing. A change that moves a figure replaces
 * the landed document in the commit that moves it, so the diff shows the
 * old figure and the new. The bars a bin is counted against are the
 * rubric's row 11, 10% and 15%; a ceiling says the bin gets no worse, and
 * the document says whether it is inside.
 *
 * The radiance is the cloud's own light, L_c's luminance per unit of the
 * sun's irradiance; the transmittance is T_c. The reference takes its sun
 * from the sun grid inside the grid's window and from the levels' own
 * statistics past it, where every case's content lies (55 to 220 km out).
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds/farCompare.json'
/** The same run as the landed document holds it: what replaces `cloudFarCompare.landed.json` when a figure moves. */
const OUT_LANDED = '.data/clouds/farCompare.landed.json'
/** The case and footprint every run of the suite takes. */
const ALWAYS = { case: 'broken cumulus', footprintMeters: 800 } as const
/**
 * A bin is held where the landed one holds twice the rays a figure needs:
 * a bin that stands at the count's edge can lose its figure to one ray's
 * rounding on another adapter.
 */
const HELD_RAYS = 2 * PITCH_BIN_RAYS
/** What a figure may pass its landed size by: a tenth of it, or half a point. */
const ceiling = (was: number): number =>
  Math.max(Math.abs(was) * 1.1, Math.abs(was) + 0.005)
/** A far tile's interior texels a face edge, and its gutter (`cloudFarAtlas.ts`). */
const FAR_TILE = 256
const FAR_SPAN = FAR_TILE + 2
const FAR_PROBE_ARC = 1_800_000

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

/** One case at one footprint, as the document holds it. */
interface Row {
  readonly case: string
  readonly scenario: string
  readonly tuned: boolean
  readonly footprintMeters: number
  readonly tFarKm: number
  readonly eyeMeters: number
  readonly pitchDegrees: number
  readonly sun: FarCase['sun']
  /** Which statistics each march read of each level, where a texel spans the footprint. */
  readonly reads: ReturnType<typeof farReads>
  readonly reference: {
    readonly fine: ReturnType<typeof marchSummary>
    readonly long: ReturnType<typeof marchSummary>
  }
  /** The far march alone against the fine march at the shipped budget. */
  readonly atlas: FarScore
  /** The same against the long march. */
  readonly atlasAgainstLong: FarScore
  readonly farTexel1800km: {
    readonly fraction: number
    readonly logTau: number
  }
}

/** What the landed document keeps of a row: each bin's rays and its two figures. */
interface LandedRow {
  readonly case: string
  readonly footprintMeters: number
  readonly bins: readonly Pick<
    PitchBin,
    'bin' | 'rays' | 'transmittance' | 'radiance' | 'held'
  >[]
}

const landed = landedDocument as unknown as {
  readonly cases: readonly LandedRow[]
}

/** A run's rows as the landed document holds them. */
const landedOf = (rows: readonly Row[]): readonly LandedRow[] =>
  rows.map((row) => ({
    case: row.case,
    footprintMeters: row.footprintMeters,
    bins: row.atlas.bins.map(
      ({ bin, rays, transmittance, radiance, held }) => ({
        bin,
        rays,
        transmittance,
        radiance,
        held,
      }),
    ),
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
  const what = `${found.case} at ${found.footprintMeters} m`
  for (const [path, value] of figures(found, what)) {
    expect(Number.isFinite(value), path).toBe(true)
  }
  // The case holds cloud: a bin with a figure, and a far texel 1,800 km out
  // under a field of uniform cover.
  expect(
    found.atlas.bins.some((bin) => bin.transmittance !== null),
    what,
  ).toBe(true)
  if (found.case === 'broken cumulus')
    expect(found.farTexel1800km.fraction, what).toBeGreaterThan(0)
  const pinned = landed.cases.find(
    (row) =>
      row.case === found.case && row.footprintMeters === found.footprintMeters,
  )
  // A row with no landed figures is a row that cannot fail.
  if (pinned === undefined) throw new Error(`no landed figures for ${what}`)
  for (const was of pinned.bins) {
    if (was.rays < HELD_RAYS) continue
    const now = found.atlas.bins.find((bin) => bin.bin === was.bin)
    for (const figure of ['held', 'radiance'] as const) {
      const then = was[figure]
      if (then === null) continue
      const path = `${what}, ${was.bin}: ${figure}`
      const read = now?.[figure] ?? null
      // A bin that held a figure and holds none has lost its cloud or its rays.
      expect(read, path).not.toBeNull()
      expect(Math.abs(read!), path).toBeLessThanOrEqual(ceiling(then))
    }
  }
}

/** The atlas texel at a body-fixed direction, layer 0, by `textureLoad`. */
async function atlasTexel(
  atlas: Texture,
  direction: Vec3,
): Promise<readonly [number, number, number, number]> {
  const { face, a, b } = cubeFaceOf(direction)
  const index = (w: number) =>
    Math.min(FAR_TILE - 1, Math.floor(((w + 1) / 2) * FAR_TILE))
  const x = face * FAR_SPAN + 1 + index(a)
  const y = 1 + index(b)
  const out = new StorageBufferAttribute(new Float32Array(4), 1)
  const into = storage(out, 'float', 4)
  const kernel = Fn(() => {
    If(instanceIndex.equal(uint(0)), () => {
      const read = textureLoad(atlas, ivec2(int(x), int(y)))
      into.element(uint(0)).assign(read.x)
      into.element(uint(1)).assign(read.y)
      into.element(uint(2)).assign(read.z)
      into.element(uint(3)).assign(read.w)
    })
  })().compute(1)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  kernel.dispose()
  out.dispose()
  return [values[0]!, values[1]!, values[2]!, values[3]!]
}

describe('the far field against the fine march', () => {
  /** Score the atlas by pitch bin on the real field, a case at a footprint at a time. */
  async function measure(
    cases: readonly FarCase[],
    footprints: readonly FarFootprint[],
  ): Promise<Row[]> {
    const session = farSession(gpu, field)
    const kernels = {
      fine: session.kernel(fineVariant(field)),
      atlas: session.kernel(farVariant(field)),
    }
    const results: Row[] = []
    for (const c of cases)
      for (const footprint of footprints) {
        const { eye, pitch } = farStance(c, footprint)
        const tFar = footprint / FAR_RIG_PIXEL_ANGLE
        session.handover.value = tFar
        const frame = session.settle(c, footprint)
        expect(frame.extents.trace).toEqual({
          width: FAR_RIG_WIDTH,
          height: FAR_RIG_HEIGHT,
        })
        expect(frame.camera.pixelAngle).toBeCloseTo(FAR_RIG_PIXEL_ANGLE, 9)
        const fine = await session.dispatch(kernels.fine, {
          farDistance: NO_SCENE,
          maxSteps: SHIPPED_STEPS,
        })
        const long = await session.dispatch(kernels.fine, {
          farDistance: NO_SCENE,
          maxSteps: LONG_STEPS,
        })
        const atlas = await session.dispatch(kernels.atlas)
        // The far texel 1,800 km from the eye along the view's heading.
        const arc = FAR_PROBE_ARC / RIG_EARTH_RADIUS
        const probe = await atlasTexel(field.farAtlas.textures()[0]!, {
          x: 0,
          y: Math.cos(arc),
          z: -Math.sin(arc),
        })
        results.push({
          case: c.id,
          scenario: c.scenario,
          tuned: c.tuned && footprint === 800,
          footprintMeters: footprint,
          tFarKm: tFar / 1000,
          eyeMeters: eye,
          pitchDegrees: -pitch,
          sun: c.sun,
          reads: farReads(frame, footprint, footprint),
          reference: { fine: marchSummary(fine), long: marchSummary(long) },
          atlas: scoreFar(fine, atlas, false),
          atlasAgainstLong: scoreFar(long, atlas, false),
          farTexel1800km: { fraction: probe[0], logTau: probe[1] },
        })
      }
    session.dispose()
    return results
  }

  const describeBins = (found: Row): string =>
    found.atlas.bins
      .filter((bin) => bin.transmittance !== null)
      .map(
        (bin) =>
          `${bin.bin} T ${(bin.transmittance! * 100).toFixed(1)}%` +
          (bin.radiance === null
            ? ''
            : ` L ${(bin.radiance * 100).toFixed(1)}%`),
      )
      .join('; ')

  /*
   * Ceiling tests, both, asserted on every adapter. The first prints its
   * bins, which is how a hosted run's are read.
   */
  it('holds broken cumulus at 800 m, bin by bin, no worse than landed, in every run of the suite and on every adapter', async () => {
    const [found] = await measure(
      FAR_CASES.filter((c) => c.id === ALWAYS.case),
      [ALWAYS.footprintMeters],
    )
    expect(found).toMatchObject(ALWAYS)
    console.info(
      `${found!.case} at ${found!.footprintMeters} m, the far march over the fine march less one: ${describeBins(found!)}`,
    )
    hold(found!)
  }, 180_000)

  it.skipIf(!MEASURE)(
    'writes all six cases at three footprints, then holds every bin no worse than landed',
    async () => {
      const results = await measure(FAR_CASES, FAR_FOOTPRINTS)
      mkdirSync('.data/clouds', { recursive: true })
      writeFileSync(
        OUT,
        `${JSON.stringify(
          {
            note: 'cloudFarCompare.gpu.test.ts: the far march alone from t₀ against the fine march over the whole ray, on the real field, by pitch bin',
            body: 'Earth',
            trace: {
              width: FAR_RIG_WIDTH,
              height: FAR_RIG_HEIGHT,
              pixelAngle: FAR_RIG_PIXEL_ANGLE,
            },
            pitchEdgesDegrees: PITCH_EDGES,
            units: {
              bins: 'the scored march’s mean over the fine march’s, less one; null under 256 rays, and the radiance null where the fine march’s opacity is 0.02 or less',
              reference: `the trace’s fine march over the whole ray at ${SHIPPED_STEPS} steps (fine) and at ${LONG_STEPS} (long)`,
              moments: 'km, RMS over rays both marches find over 10% opaque',
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
            note: 'cloudFarCompare.gpu.test.ts on the Mac mini (Mac18,5, Apple M6): each pitch bin’s rays, and the far march’s mean transmittance and radiance over the fine march’s at the shipped budget, less one',
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
