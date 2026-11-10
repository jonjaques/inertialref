import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CLOUD_GENERA,
  type CloudGenus,
  GENUS_TABLE,
  genusDiffractionShare,
  scaledExtinction,
} from '@inertialref/rendering'
import {
  depthTexture,
  marchLight,
  NO_BUDGET,
  placeBody,
  relative,
  sizeTrace,
  SKY_KM,
  testSun,
  traceFrame,
} from './cloudMarchRig.ts'
import { CLOUD_STAND_INS, type CloudSlab, slabMedium } from './cloudNodes.ts'
import { CloudTrace, type CloudTraceSteps } from './cloudTrace.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The range inside a cloud (phase 1 design §8.5, the rubric's row 21): the
 * distance at which the optical depth accumulated along the frame's central
 * ray reaches ln 50, which is Koschmieder's 2% of contrast, read from the
 * trace's counters under `stats`.
 *
 * It is held where it is a closed form: in a uniform medium at each genus's
 * own scaled extinction, with the eye inside, the range is `3.912/σ′`. The
 * readout places the crossing inside the step that makes it by the step's
 * own extinction, so in a uniform medium it does not depend on the step's
 * length: the rubric's 25% is the gate, and a hundredth of that is what the
 * kernel gives, on the schedule's steps and on a budget that lengthens them.
 * In a cloud that is not uniform the readout is the distance the eye sees
 * through that cloud, and `3.912/σ′` of nothing.
 */

const SIZE = 4
const LN_50 = Math.log(50)
/** A deck the eye stands in the middle of: 20 km thick, so a level ray stays in it past any genus's range. */
const DECK = { base: 100, top: 20_100 } as const
const EYE = 10_100

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(8, 8)
})

afterAll(() => {
  gpu.dispose()
})

/** A genus's scaled extinction at its own reference radius, 1/m: what its transmittance is formed from. */
function scaledSigma(genus: CloudGenus): number {
  const { sigma, radius } = GENUS_TABLE[genus]
  return scaledExtinction(sigma, genusDiffractionShare(genus, radius))
}

/** The image a thousandth of a radian across, level toward +X or straight up. */
function look(uniforms: CloudUniforms, up: boolean): void {
  const camera = uniforms.camera
  if (up) {
    camera.forward.value.set(0, 1, 0)
    camera.right.value.set(1, 0, 0)
    camera.up.value.set(0, 0, -1)
  } else {
    camera.forward.value.set(1, 0, 0)
    camera.right.value.set(0, 0, 1)
    camera.up.value.set(0, 1, 0)
  }
  camera.plane.value.set(1e-3, 1e-3)
  camera.pixelAngle.value = 1e-3
}

interface Stance {
  /** The cloud, and the level it lies in. */
  readonly slab: CloudSlab | null
  readonly level: readonly [number, number]
  /** The eye over the datum, meters, looking level, or straight up. */
  readonly eye: number
  readonly up?: boolean
  readonly maxSteps?: number
  /** Meters at which the fine march hands over; never, by default. */
  readonly farDistance?: number
}

/** The trace's counters over one frame at a stance. */
async function counted(stance: Stance): Promise<CloudTraceSteps> {
  const uniforms = createCloudUniforms()
  placeBody(uniforms, { eye: stance.eye, layers: [stance.level] })
  look(uniforms, stance.up === true)
  sizeTrace(uniforms, SIZE, SIZE)
  uniforms.trace.maxSteps.value = stance.maxSteps ?? 192
  uniforms.trace.farDistance.value = stance.farDistance ?? 1e9
  const depth = depthTexture(4 * SIZE, 4 * SIZE, () => SKY_KM)
  const field = CLOUD_STAND_INS.field(
    slabMedium(stance.slab === null ? [] : [stance.slab]),
  )
  const trace = new CloudTrace({
    uniforms,
    medium: field,
    sun: testSun(field, CLOUD_STAND_INS.sunDepth()),
    phase: CLOUD_STAND_INS.phase(),
    far: CLOUD_STAND_INS.far(),
    depth: () => depth,
    ...marchLight(uniforms),
  })
  await trace.warm(gpu.renderer)
  const frame = traceFrame({ width: SIZE, height: SIZE }, { stats: true })
  trace.render(gpu.renderer, frame, NO_BUDGET)
  // The counters' readback lands a few frames late.
  for (let turn = 0; turn < 400 && trace.steps === null; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const steps = trace.steps
  trace.dispose()
  depth.dispose()
  uniforms.dispose()
  if (steps === null) throw new Error('the counters were never read back')
  return steps
}

/** Inside the deck, looking level. */
const inside = (sigma: number): Stance => ({
  slab: { ...DECK, sigma },
  level: [DECK.base, DECK.top],
  eye: EYE,
})

describe('the range inside a uniform cloud', () => {
  it.each(CLOUD_GENERA)(
    '%s: is 3.912/σ′ with the eye inside, within the rubric’s 25% and within a quarter of a percent on any steps',
    async (genus) => {
      const sigma = scaledSigma(genus)
      const expected = LN_50 / sigma
      // The genus table's range, from an anvil's core to a cirrus.
      expect(expected).toBeGreaterThan(50)
      expect(expected).toBeLessThan(40_000)
      for (const maxSteps of [192, 24]) {
        const steps = await counted({ ...inside(sigma), maxSteps })
        const what = `${maxSteps} steps`
        expect(steps.range, what).not.toBeNull()
        expect(relative(steps.range!, expected), what).toBeLessThan(0.25)
        expect(relative(steps.range!, expected), what).toBeLessThan(2.5e-3)
        expect(steps.opacity, what).toBeGreaterThan(0.98)
      }
    },
    60_000,
  )

  it('is the distance to a cloud and then the cloud’s own: 645 m from half a kilometer under cumulus', async () => {
    // Looking straight up at a deck's base from 500 m under it: the clear
    // air, and then ln 50/σ′ of the cloud.
    const sigma = scaledSigma('cumulus')
    const expected = 500 + LN_50 / sigma
    expect(expected).toBeGreaterThan(640)
    expect(expected).toBeLessThan(650)
    const steps = await counted({
      slab: { base: 1000, top: 6000, sigma },
      level: [1000, 6000],
      eye: 500,
      up: true,
    })
    expect(relative(steps.range!, expected)).toBeLessThan(2.5e-3)
  })

  it('is null where the fine march never reaches a depth of ln 50: clear air, and a handover nearer than the range', async () => {
    const clear = await counted({ ...inside(0), slab: null })
    expect(clear.range).toBeNull()
    expect(clear.opacity).toBe(0)
    const sigma = scaledSigma('cumulus')
    // The fine march's own depth: a ray handed over at 100 m has crossed 2.7.
    const handed = await counted({ ...inside(sigma), farDistance: 100 })
    expect(handed.range).toBeNull()
    expect(handed.opacity).toBeGreaterThan(0.9)
    expect(handed.opacity).toBeLessThan(0.95)
  })
})
