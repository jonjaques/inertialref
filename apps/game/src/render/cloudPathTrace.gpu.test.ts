import { mkdirSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Node, StorageBufferAttribute } from 'three/webgpu'
import { Fn, instanceIndex, storage, uvec4 } from 'three/tsl'
import { Rng, rootSeed } from '@inertialref/procedural'
import {
  analyticCumulus,
  CUMULUS_FIELD_SUN,
  CUMULUS_REFERENCE,
  CUMULUS_VIEWS,
  type CumulusCase,
  cumulusFixture,
  type CumulusProbe,
  type CumulusSubject,
  fixtureMedium,
  isolateCumulus,
  mediumAt,
  mediumDepth,
  mieDroplets,
  phaseDensity,
  phaseNodeAt,
  phaseRow,
  subjectWeather,
  type TraceMedium,
  tracePhase,
  viewRay,
  viewSun,
} from '@inertialref/rendering'
import {
  createCloudPathTracer,
  pathTraceDone,
  pathTraceEstimate,
  pathTraceRandom,
  type PathTraceScene,
} from './cloudPathTrace.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The WebGPU path tracer, on the GPU it runs on.
 *
 * Always: the furnace, the uncollided beam and one order of scattering
 * against forms written down here, and every order against the float64
 * tracer's committed pixels of the analytic cumulus, by §5.11's count. The
 * two tiers draw different paths, so a pixel is held at three of the two
 * errors together and the image at how many pixels may pass that by chance.
 *
 * Under IR_CLOUD_MEASURE: the reference's own cases at its resolution, held
 * to its pixels by the same count, with the images and
 * `.data/clouds/pathTrace.json`; and what a sample costs on today's field.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
const OUT = '.data/clouds'
const PHASE = tracePhase(mieDroplets())
const SEED = rootSeed('cloudPathTrace.gpu.test')
const { analytic } = CUMULUS_REFERENCE
const ANALYTIC = fixtureMedium(analyticCumulus(analytic.fixture))
const PIXELS = 32
const DARK_SKY = { mean: [0, 0, 0], up: [0, 0, 0], sunward: [0, 0, 0] } as const
const uniformSky = (radiance: number) =>
  ({
    mean: [radiance, radiance, radiance],
    up: [0, 0, 0],
    sunward: [0, 0, 0],
  }) as const

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(8, 8)
})

afterAll(() => {
  gpu?.dispose()
})

/**
 * Events a dispatch for a thread, by how many threads there are: about four
 * million events a dispatch. A dispatch costs a submit and a wait whatever
 * it holds, so a small image at a small count spends the run on that; a
 * large one at a large count holds the device for seconds.
 */
const eventsFor = (pixels: number): number =>
  Math.max(64, Math.min(4096, Math.round((4 * 2 ** 20) / (pixels * pixels))))
/** Dispatches between two readbacks of the sums. */
const BURST = 4

/** A scene traced to its last sample: every pixel's sums, and the dispatches it took. */
async function trace(
  scene: PathTraceScene,
  budget = 4000,
): Promise<{ sums: Float32Array; dispatches: number; events: number }> {
  const events = eventsFor(scene.pixels)
  const tracer = createCloudPathTracer(scene, events)
  for (let dispatches = BURST; dispatches <= budget; dispatches += BURST) {
    for (let i = 0; i < BURST; i += 1) await gpu.compute(tracer.kernel)
    const sums = new Float32Array(await gpu.readBuffer(tracer.sums))
    if (pathTraceDone(sums, scene.samples)) return { sums, dispatches, events }
  }
  throw new Error(
    `cloudPathTrace: ${budget} dispatches of ${events} events did not finish ${scene.samples} samples`,
  )
}

const sceneOf = (
  medium: TraceMedium,
  rest: Partial<PathTraceScene>,
): PathTraceScene => ({
  medium,
  phase: PHASE,
  pixels: PIXELS,
  sun: null,
  sky: DARK_SKY,
  ground: null,
  orders: Infinity,
  samples: 64,
  seed: SEED,
  ...rest,
})

describe('the kernel’s stream', () => {
  it('is xoshiro128**, value for value and state for state with the CPU’s', async () => {
    // Sixty-four states along one CPU stream, a thread each: every thread
    // writes its state's output and the state after it.
    const draws = 64
    const states = new Uint32Array(draws * 4)
    const expected = new Uint32Array(draws * 8)
    let state = { a: 0x9e3779b9, b: 0x243f6a88, c: 0xb7e15162, d: 0xdeadbeef }
    for (let k = 0; k < draws; k += 1) {
      states.set([state.a, state.b, state.c, state.d], k * 4)
      const stream = Rng.fromSeed(state)
      const value = stream.nextUint32()
      // `Rng` keeps its state to itself, so the step is written out here
      // and held to the generator: a stream seeded with the stepped state
      // draws what the first stream draws next.
      const t = (state.b << 9) >>> 0
      const c = (state.c ^ state.a) >>> 0
      const d = (state.d ^ state.b) >>> 0
      const next = {
        a: (state.a ^ d) >>> 0,
        b: (state.b ^ c) >>> 0,
        c: (c ^ t) >>> 0,
        d: ((d << 11) | (d >>> 21)) >>> 0,
      }
      expect(Rng.fromSeed(next).nextUint32()).toBe(stream.nextUint32())
      expected.set([value, 0, 0, 0, next.a, next.b, next.c, next.d], k * 8)
      state = next
    }
    const output = new StorageBufferAttribute(new Uint32Array(draws * 8), 4)
    const from = storage(new StorageBufferAttribute(states, 4), 'uvec4', draws)
    const into = storage(output, 'uvec4', draws * 2)
    const kernel = Fn(() => {
      const held = from.element(instanceIndex).toVar()
      into
        .element(instanceIndex.mul(2))
        .assign(
          uvec4(
            pathTraceRandom.value({ s: held }) as unknown as Node<'uint'>,
            0,
            0,
            0,
          ),
        )
      into
        .element(instanceIndex.mul(2).add(1))
        .assign(pathTraceRandom.step({ s: held }))
    })().compute(draws)
    await gpu.compute(kernel)
    expect(new Uint32Array(await gpu.readBuffer(output))).toEqual(expected)
  })
})

describe('the furnace', () => {
  it('returns the sky from every pixel with no variance, under a ground of albedo one', async () => {
    // A radiance float32 holds exactly, so four samples sum to four of it.
    const sky = 0.375
    const { sums } = await trace(
      sceneOf(ANALYTIC, {
        sky: uniformSky(sky),
        ground: { height: -500, albedo: 1 },
        samples: 4,
      }),
    )
    for (let pixel = 0; pixel < PIXELS * PIXELS; pixel += 1) {
      const estimate = pathTraceEstimate(sums, pixel)
      expect(estimate.samples).toBe(4)
      expect(estimate.truncated).toBe(0)
      expect(estimate.mean).toEqual([sky, sky, sky])
      expect(estimate.error).toEqual([0, 0, 0])
    }
  })

  it('is lost by a ground that absorbs: the paths met the cloud and the ground', async () => {
    const { sums } = await trace(
      sceneOf(ANALYTIC, {
        sky: uniformSky(1),
        ground: { height: -500, albedo: 0.5 },
        samples: 256,
      }),
    )
    // Through the core, where the float64 tracer returns 0.80: a path that
    // scatters down meets the ground and comes back at half.
    const core = pathTraceEstimate(sums, 14 * PIXELS + 16)
    expect(core.mean[0]).toBeLessThan(0.95)
    expect(core.mean[0]).toBeGreaterThan(0.5)
    // And clear sky beside the cloud is the sky.
    expect(pathTraceEstimate(sums, 0).mean).toEqual([1, 1, 1])
  })
})

describe('the flights', () => {
  it('pass the uncollided beam at e^(−τ), pixel by pixel', async () => {
    const samples = 4096
    const { sums } = await trace(
      sceneOf(ANALYTIC, { sky: uniformSky(1), orders: 0, samples }),
    )
    let beyond = 0
    let cloudy = 0
    for (let py = 0; py < PIXELS; py += 1)
      for (let px = 0; px < PIXELS; px += 1) {
        const depth = mediumDepth(
          ANALYTIC,
          viewRay(ANALYTIC, PIXELS, px, py),
          [0, 0, 1],
        )
        const { mean } = pathTraceEstimate(sums, py * PIXELS + px)
        const expected = Math.exp(-depth)
        if (depth === 0) {
          expect(mean[1]).toBe(1)
          continue
        }
        cloudy += 1
        // A sample is one or nothing, so the mean's error is the binomial's.
        const error = Math.sqrt((expected * (1 - expected)) / samples)
        const off = Math.abs(mean[1] - expected) / error
        expect(off).toBeLessThan(5)
        if (off > 3) beyond += 1
      }
    expect(cloudy).toBeGreaterThan(200)
    // Three errors hold 99.73% of pixels: of some 290, one in a run.
    expect(beyond).toBeLessThanOrEqual(4)
  })
})

describe('one order of scattering', () => {
  it('lights the cumulus as a quadrature of its own field does', async () => {
    const sun = [
      0.5 / Math.sqrt(0.99),
      0.7 / Math.sqrt(0.99),
      -0.5 / Math.sqrt(0.99),
    ] as const
    const samples = 2048
    const { sums } = await trace(
      sceneOf(ANALYTIC, {
        sun: { direction: sun, irradiance: [1, 1, 1], angularRadius: 0 },
        orders: 1,
        samples,
      }),
    )
    const [vx, , vz] = ANALYTIC.cell
    const at = new Float64Array(2)
    let beyond = 0
    let held = 0
    for (const [px, py] of [
      [16, 14],
      [11, 17],
      [20, 12],
      [14, 20],
      [22, 16],
      [9, 15],
    ] as const) {
      const origin = viewRay(ANALYTIC, PIXELS, px, py)
      const steps = 2000
      const dz = 2200 / steps
      const expected = [0, 0, 0]
      let behind = 0
      for (let i = 0; i < steps; i += 1) {
        const z = origin[2] + (i + 0.5) * dz
        mediumAt(
          ANALYTIC,
          origin[0] / vx + 0.5,
          origin[1] / ANALYTIC.cell[1] + 0.5,
          z / vz + 0.5,
          at,
        )
        const sigma = at[0]!
        if (sigma > 0) {
          const [row, share] = phaseRow(PHASE, at[1]!)
          const toSun = mediumDepth(ANALYTIC, [origin[0], origin[1], z], sun)
          const through = Math.exp(-toSun - behind - (sigma * dz) / 2)
          for (let band = 0; band < 3; band += 1) {
            const low = phaseDensity(
              PHASE,
              phaseNodeAt(PHASE, row, band),
              1 - sun[2],
              1 + sun[2],
            )
            const high = phaseDensity(
              PHASE,
              phaseNodeAt(PHASE, row + 1, band),
              1 - sun[2],
              1 + sun[2],
            )
            expected[band]! +=
              sigma * (low + (high - low) * share) * through * dz
          }
        }
        behind += sigma * dz
      }
      const estimate = pathTraceEstimate(sums, py * PIXELS + px)
      for (let band = 0; band < 3; band += 1) {
        expect(estimate.error[band]).toBeGreaterThan(0)
        const off =
          Math.abs(estimate.mean[band]! - expected[band]!) /
          estimate.error[band]!
        expect(off).toBeLessThan(5)
        if (off > 3) beyond += 1
        held += 1
      }
    }
    expect(held).toBe(18)
    expect(beyond).toBeLessThanOrEqual(1)
  })
})

/** How far a traced pixel stands from its reference, in their errors together, by band. */
function offsets(
  sums: Float32Array,
  pixels: number,
  probes: readonly CumulusProbe[],
): number[] {
  return probes.flatMap((probe) => {
    const estimate = pathTraceEstimate(
      sums,
      probe.pixel[1] * pixels + probe.pixel[0],
    )
    return probe.radiance.map(
      (value, band) =>
        Math.abs(estimate.mean[band]! - value) /
        Math.hypot(estimate.error[band]!, probe.error[band]!),
    )
  })
}

const sceneOfCase = (
  medium: TraceMedium,
  spec: CumulusCase,
  samples: number,
): PathTraceScene => ({
  medium,
  phase: PHASE,
  pixels: spec.pixels,
  sun: {
    direction: viewSun(CUMULUS_VIEWS.find(({ id }) => id === spec.view)!),
    irradiance: [1, 1, 1],
    angularRadius: spec.sunRadius,
  },
  sky: spec.sky,
  ground: spec.ground,
  orders: Infinity,
  samples,
  seed: SEED,
})

describe('every order', () => {
  it('holds the analytic cumulus to the float64 tracer’s pixels, by the count', async () => {
    expect(analytic.cases.length).toBeGreaterThanOrEqual(3)
    const off: number[] = []
    for (const spec of analytic.cases) {
      const { sums } = await trace(sceneOfCase(ANALYTIC, spec, 1024))
      const probes = analytic.probes.filter((probe) => probe.case === spec.id)
      expect(probes.length).toBeGreaterThan(30)
      off.push(...offsets(sums, spec.pixels, probes))
    }
    // Of some 400 values, three errors hold all but one or two by chance
    // (99.73% each), and five hold every one of them.
    expect(Math.max(...off)).toBeLessThan(5)
    expect(off.filter((value) => value > 3).length).toBeLessThanOrEqual(4)
    // Not a comparison of two zeros: the values' spread is a normal's.
    const mean = off.reduce((sum, value) => sum + value, 0) / off.length
    expect(mean).toBeGreaterThan(0.5)
    expect(mean).toBeLessThan(1.1)
  }, 240_000)
})

/** A subject's fixture as the generator cuts it (`cumulusTables.ts`, `subjectFixture`). */
function subjectMedium(subject: CumulusSubject): TraceMedium {
  const { weather, clock } = subjectWeather(subject)
  return fixtureMedium(
    isolateCumulus(
      cumulusFixture(weather, clock, CUMULUS_FIELD_SUN, subject.place),
    ).fixture,
  )
}

/** An image's green band as a portable float map, bottom row first as the format has it. */
function writeImage(name: string, sums: Float32Array, pixels: number): void {
  const data = new Float32Array(pixels * pixels * 3)
  for (let py = 0; py < pixels; py += 1)
    for (let px = 0; px < pixels; px += 1)
      data.set(
        pathTraceEstimate(sums, py * pixels + px).mean,
        ((pixels - 1 - py) * pixels + px) * 3,
      )
  writeFileSync(
    `${OUT}/${name}.pfm`,
    Buffer.concat([
      Buffer.from(`PF\n${pixels} ${pixels}\n-1.0\n`),
      Buffer.from(data.buffer),
    ]),
  )
}

/**
 * Today's fair-weather cumulus, where the generator's search finds it on
 * the field as it stands (`cumulusTables.ts place cumulus`): what a sample
 * is priced on until the reference has subjects of its own. The place is
 * the field's, so when the field's recipe moves this is another cloud or
 * none, and the instrument says so by its count of cloudy pixels.
 */
const TODAY: CumulusSubject = {
  id: 'cumulus',
  regime: 'fair-cumulus',
  thickness: null,
  time: 0,
  place: {
    corner: { x: 6_371_000, y: 7840, z: -11_360 },
    east: { x: 0, y: 0, z: -1 },
    north: { x: 0, y: 1, z: 0 },
    size: [160, 96, 160],
    voxel: 20,
    base: 880,
  },
}

describe.skipIf(!MEASURE)('the instrument (IR_CLOUD_MEASURE)', () => {
  it('prices a sample at the reference’s resolution, on today’s cumulus', async () => {
    const medium = subjectMedium(TODAY)
    const samples = 16
    const rows = []
    for (const view of CUMULUS_VIEWS) {
      const spec: CumulusCase = {
        id: `today:${view.id}`,
        subject: TODAY.id,
        view: view.id,
        pixels: 256,
        samples,
        sunRadius: (0.265 * Math.PI) / 180,
        sky: analytic.cases[0]!.sky,
        ground: null,
      }
      const start = performance.now()
      const { sums, dispatches, events } = await trace(
        sceneOfCase(medium, spec, samples),
        40_000,
      )
      const seconds = (performance.now() - start) / 1000
      // The mean relative error of the cloud's pixels, green, at this count.
      let relative = 0
      let cloudy = 0
      for (let pixel = 0; pixel < 256 * 256; pixel += 1) {
        const { mean, error } = pathTraceEstimate(sums, pixel)
        if (error[1] > 0 && mean[1] > 0) {
          relative += error[1] / mean[1]
          cloudy += 1
        }
      }
      mkdirSync(OUT, { recursive: true })
      writeImage(`pathTrace-today-${view.id}`, sums, 256)
      rows.push({
        case: spec.id,
        samples,
        seconds,
        dispatches,
        events,
        secondsASample: seconds / samples,
        cloudyPixels: cloudy,
        meanRelativeError: relative / Math.max(cloudy, 1),
      })
    }
    writeFileSync(
      `${OUT}/pathTraceCost.json`,
      JSON.stringify({ rows }, null, 2),
    )
    for (const row of rows) expect(row.cloudyPixels).toBeGreaterThan(1000)
  }, 1_800_000)

  it.skipIf(CUMULUS_REFERENCE.cases.length === 0)(
    'holds the reference’s cases to its 288 pixels each, by the count',
    async () => {
      const rows = []
      for (const spec of CUMULUS_REFERENCE.cases) {
        const subject = CUMULUS_REFERENCE.subjects.find(
          ({ id }) => id === spec.subject,
        )!
        const start = performance.now()
        const { sums } = await trace(
          sceneOfCase(subjectMedium(subject), spec, 1024),
          400_000,
        )
        const seconds = (performance.now() - start) / 1000
        const probes = CUMULUS_REFERENCE.probes.filter(
          (probe) => probe.case === spec.id,
        )
        const off = offsets(sums, spec.pixels, probes)
        mkdirSync(OUT, { recursive: true })
        writeImage(`pathTrace-${spec.id.replace(':', '-')}`, sums, spec.pixels)
        const beyondThree = off.filter((value) => value > 3).length
        rows.push({
          case: spec.id,
          seconds,
          probes: probes.length,
          beyondThree,
          worst: Math.max(...off),
        })
        // §5.11: of a case's 288 pixels at most three beyond three combined
        // standard errors, and none beyond five. A bound on every pixel at
        // three would fail one run in two by chance.
        expect(beyondThree).toBeLessThanOrEqual(3)
        expect(Math.max(...off)).toBeLessThan(5)
      }
      writeFileSync(
        `${OUT}/pathTrace.json`,
        JSON.stringify({ samples: 1024, rows }, null, 2),
      )
    },
    3_600_000,
  )
})
