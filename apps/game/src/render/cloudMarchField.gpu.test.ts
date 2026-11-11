import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Quaternion as Q, type Vec3 } from '@inertialref/spatial'
import { type CloudField, createCloudField } from './cloudField.ts'
import { type CloudFrame, cloudFrame } from './cloudFrame.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { depthTexture, NO_BUDGET, readTexels, SKY_KM } from './cloudMarchRig.ts'
import { LOOKING_UP, type RigStance, rigFrameInputs } from './cloudSystemRig.ts'
import { CloudTrace, type CloudTraceSteps } from './cloudTrace.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The march on the field the frame draws, at two of the cost instrument's
 * stances: what a change to the schedule does to the picture where the
 * instrument times it. The slab cases in `cloudTrace.gpu.test.ts` hold the
 * march's closed forms; these hold one march to another on real cloud.
 */

const CSS = { width: 256, height: 144 } as const
const [W, H] = [CSS.width / 4, CSS.height / 4]

const radians = (degrees: number): number => (degrees * Math.PI) / 180
/** The cost instrument's sun at its stand-ins: 37.5° up, 60° off the view's heading. */
const SUN: Vec3 = {
  x: -Math.sin(radians(60)) * Math.cos(radians(37.5)),
  y: Math.sin(radians(37.5)),
  z: -Math.cos(radians(60)) * Math.cos(radians(37.5)),
}

let gpu: GpuSession
let field: CloudField
let previous: CloudFrame | null = null

beforeAll(async () => {
  gpu = await openGpu(CSS.width, CSS.height)
  field = createCloudField()
  for (const bake of field.bakes) await bake.warm(gpu.renderer)
}, 120_000)

afterAll(() => {
  field?.dispose()
  gpu?.dispose()
})

/** A frame of the field at a stance, as the system builds and bakes one. */
function frameAt(stance: RigStance, levers: CloudLevers): CloudFrame {
  const frame = cloudFrame(rigFrameInputs(stance, levers, CSS), previous)
  if (frame === null) throw new Error('no frame: nothing served')
  previous = frame
  field.write(frame)
  field.render(gpu.renderer, frame, {
    slices: levers.sunSlices,
    tiles: 1,
    jump: frame.jump,
    sunSlices: levers.sunSlices,
  })
  return frame
}

/** Frames until the maps hold the weather and every bake has rested eight in a row with nothing owed. */
function settled(stance: RigStance, levers: CloudLevers): CloudFrame {
  let frame = frameAt(stance, levers)
  for (let n = 0; n < 64; n += 1) frame = frameAt(stance, levers)
  for (let n = 0, rest = 0; n < 400 && rest < 8; n += 1) {
    frame = frameAt(stance, levers)
    rest = field.bakes.some((bake) => bake.pending) ? 0 : rest + 1
  }
  return frame
}

interface Traced {
  /** (L_c.rgb, T_c) a texel. */
  readonly light: (x: number, y: number) => [number, number, number, number]
  /** (B.rgb, the reprojection depth) a texel. */
  readonly air: (x: number, y: number) => [number, number, number, number]
  readonly steps: CloudTraceSteps
}

/** One dispatch of the system's trace over the field, with its counters. */
async function traced(
  frame: CloudFrame,
  options: { readonly unstrided?: boolean } = {},
): Promise<Traced> {
  const depth = depthTexture(CSS.width, CSS.height, () => SKY_KM)
  const trace = new CloudTrace({
    uniforms: field.uniforms,
    medium: field.medium,
    sun: field.sun,
    phase: field.phase,
    far: field.farAtlas.far,
    depth: () => depth,
    sky: field.sky,
    source: field.source,
    jitter: field.jitter,
    ...options,
  })
  await trace.warm(gpu.renderer)
  trace.render(gpu.renderer, frame, NO_BUDGET)
  const light = await readTexels(gpu, trace.outputs.light, W, H)
  const aux = await readTexels(gpu, trace.outputs.aux, 2 * W, H)
  for (let turn = 0; turn < 400 && trace.steps === null; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  const steps = trace.steps
  trace.dispose()
  depth.dispose()
  if (steps === null) throw new Error('the trace counted no ray')
  return { light, air: (x, y) => aux(2 * x, y), steps }
}

/** The largest share by which two traces' texels differ, a texel's band against the larger of itself and `floor`. */
function apart(
  a: (x: number, y: number) => readonly number[],
  b: (x: number, y: number) => readonly number[],
  bands: readonly number[],
  floor: number,
): number {
  let worst = 0
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1)
      for (const band of bands) {
        const one = a(x, y)[band]!
        const other = b(x, y)[band]!
        worst = Math.max(
          worst,
          Math.abs(one - other) / Math.max(Math.abs(other), floor),
        )
      }
  return worst
}

/** The mean of some bands over a trace's texels. */
function mean(
  of: (x: number, y: number) => readonly number[],
  bands: readonly number[],
): number {
  let sum = 0
  for (let y = 0; y < H; y += 1)
    for (let x = 0; x < W; x += 1)
      for (const band of bands) sum += of(x, y)[band]!
  return sum / (W * H * bands.length)
}

describe('between two levels a step is a stride (§5.8)', () => {
  /*
   * Under cirrus over cumulus a ray from the ground crosses 6.6 km where no
   * level is, 71 of its 106 steps at the schedule's 50 to 100 m. A stride is
   * the eight steps the air is sampled once in, taken as one. Held here to
   * the march that takes them one at a time (`unstrided`), on the same frame
   * and the same draws: the cloud's light and transmittance and the blocked
   * air, texel by texel.
   */
  const levers = (weather: CloudLevers['weather']): CloudLevers => ({
    ...DEFAULT_CLOUD_LEVERS,
    on: true,
    stats: true,
    weather,
  })

  it('draws cirrus over cumulus from 100 m, looking up, within 0.5% of the unstrided march in a quarter of its steps between the levels', async () => {
    const frame = settled(
      { eye: 100, looking: LOOKING_UP, air: true },
      levers('cirrus-over-cumulus'),
    )
    const strided = await traced(frame)
    const plain = await traced(frame, { unstrided: true })
    // A texel's light against the larger of itself and the frame's mean:
    // near the sun a cirrus texel is a thousand times the mean.
    const light = mean(plain.light, [0, 1, 2])
    const air = Math.abs(mean(plain.air, [0, 1, 2]))
    expect(light).toBeGreaterThan(0)
    const lightApart = apart(strided.light, plain.light, [0, 1, 2], light)
    const throughApart = apart(strided.light, plain.light, [3], 0.05)
    const airApart = apart(strided.air, plain.air, [0, 1, 2], air)
    const airMeans = Math.abs(mean(strided.air, [0, 1, 2])) / air - 1
    console.log(
      `strides, cirrus over cumulus: steps ${strided.steps.mean.toFixed(2)} against ${plain.steps.mean.toFixed(2)}, between the levels ${strided.steps.kinds.gap.toFixed(2)} against ${plain.steps.kinds.gap.toFixed(2)}; light apart ${lightApart.toExponential(2)}, transmittance ${throughApart.toExponential(2)}, blocked air ${airApart.toExponential(2)} a texel and ${airMeans.toExponential(2)} in the mean`,
    )
    // The cloud's steps are the same steps, so its transmittance is the
    // same number and its light differs by the air in front of it alone.
    expect(throughApart).toBeLessThan(0.005)
    expect(lightApart).toBeLessThan(0.005)
    // The blocked air is the air's own quadrature, a sample a stride where
    // it was a sample every eighth step of the ray: a term a sixteenth of
    // the light, within 2% a texel (0.9% here) and 0.5% in the mean.
    expect(airApart).toBeLessThan(0.02)
    expect(Math.abs(airMeans)).toBeLessThan(0.005)
    // The steps, on every adapter. The schedule gives 71 between the levels
    // and a stride is eight of them; the bars stand a fifth off each.
    expect(plain.steps.kinds.gap).toBeGreaterThan(55)
    expect(strided.steps.kinds.gap).toBeLessThan(12)
    expect(strided.steps.mean).toBeLessThan(plain.steps.mean - 45)
    // The control: the rays hold cloud in both levels.
    expect(plain.steps.kinds.cloud).toBeGreaterThan(1)
    expect(plain.steps.opacity).toBeGreaterThan(0.1)
  }, 120_000)

  it('leaves the horizon stand-in as it was: one level, and no step outside it', async () => {
    const frame = settled(
      {
        eye: 2,
        looking: Q.fromAxisAngle({ x: 1, y: 0, z: 0 }, radians(2)),
        air: true,
        sun: SUN,
      },
      levers('broken-horizon'),
    )
    const strided = await traced(frame)
    const plain = await traced(frame, { unstrided: true })
    // One program but for a test that is never true: the same frame.
    expect(apart(strided.light, plain.light, [0, 1, 2, 3], 1e-6)).toBe(0)
    expect(apart(strided.air, plain.air, [0, 1, 2], 1e-6)).toBe(0)
    expect(strided.steps.kinds.gap).toBe(0)
    expect(plain.steps.kinds.gap).toBe(0)
    expect(strided.steps.mean).toBe(plain.steps.mean)
    expect(plain.steps.kinds.cloud).toBeGreaterThan(1)
  }, 120_000)
})
