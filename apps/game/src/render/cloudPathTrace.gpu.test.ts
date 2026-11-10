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
  cumulusAir,
  type CumulusCase,
  cumulusFixture,
  type CumulusProbe,
  cumulusSky,
  cumulusSkyHeight,
  cumulusSkyRadiance,
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
import { type AirUniforms, createAirUniforms } from './air.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import {
  createCloudPathTracer,
  createPathTraceSkyProbe,
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
 * Under IR_CLOUD_MEASURE, once the reference has cases: each case's own
 * pixels traced on the device and held to the float64 tracer's by the same
 * count (`.data/clouds/pathTrace.json`), and what a sample of each case
 * costs at 256² (`pathTraceCost.json`). With IR_CLOUD_IMAGES as well, the
 * images traced whole, which is the campaign's long run.
 */

const MEASURE = process.env.IR_CLOUD_MEASURE !== undefined
/** With `IR_CLOUD_MEASURE`: the images traced whole, which is the campaign's long run. */
const IMAGES = process.env.IR_CLOUD_IMAGES !== undefined
const OUT = '.data/clouds'
const PHASE = tracePhase(mieDroplets())
const SEED = rootSeed('cloudPathTrace.gpu.test')
const { analytic } = CUMULUS_REFERENCE
const ANALYTIC = fixtureMedium(analyticCumulus(analytic.fixture))
const PIXELS = 32
const DARK_SKY = { mean: [0, 0, 0], up: [0, 0, 0], sunward: [0, 0, 0] } as const
/**
 * The most the device's sky may stand from the CPU's, as a share of the
 * sky's mean. Measured at 0.46% over 96 directions and the three suns: a
 * half float's step on ln L̄ near −4 is 0.2% of the mean, and the two
 * differences' steps and the sampler's weights are the rest.
 */
const SKY_STEP = 0.01
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
 * it holds, so a few threads at a small count spend the run on that; many
 * at a large count hold the device for seconds.
 */
const eventsFor = (threads: number): number =>
  Math.max(64, Math.min(4096, Math.round((4 * 2 ** 20) / threads)))
const threadsOf = (scene: PathTraceScene): number =>
  scene.threads?.length ?? scene.pixels * scene.pixels
/** Dispatches between two readbacks of the sums. */
const BURST = 4

/** A scene traced to its last sample: every thread's sums, and the dispatches it took. */
async function trace(
  scene: PathTraceScene,
  budget = 4000,
): Promise<{ sums: Float32Array; dispatches: number; events: number }> {
  const events = eventsFor(threadsOf(scene))
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
    expect(cloudy).toBe(268)
    // Three errors hold 99.73% of pixels: of 268, one in a run.
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

/**
 * How far a traced pixel stands from its reference, in their errors
 * together, by band. `threadsOf` names the threads that traced a pixel: the
 * pixel's own index in an image traced whole.
 */
function offsets(
  sums: Float32Array,
  probes: readonly CumulusProbe[],
  threadsOf: (pixel: readonly [number, number]) => number | readonly number[],
): number[][] {
  return probes.map((probe) => {
    const estimate = pathTraceEstimate(sums, threadsOf(probe.pixel))
    return probe.radiance.map(
      (value, band) =>
        Math.abs(estimate.mean[band]! - value) /
        Math.hypot(estimate.error[band]!, probe.error[band]!),
    )
  })
}

/**
 * Earth's air on the device, as the page binds it: the three tables of
 * `scatteringFor`, the sky's among them as the half-float texture the
 * march's node reads.
 */
function earthAir(): AirUniforms {
  const { haze, topRatio, heights } = cumulusAir()
  const air = createAirUniforms({ ownStandIns: true })
  air.bind(scatteringFor(haze, topRatio, heights, { sky: true }))
  return air
}

/**
 * A case's scene. A case of the field stands under the table's sky, read on
 * the device where the CPU read it; a case with no table under it takes its
 * three numbers.
 */
const sceneOfCase = (
  medium: TraceMedium,
  spec: CumulusCase,
  samples: number,
  air: AirUniforms | null = null,
): PathTraceScene => ({
  medium,
  phase: PHASE,
  pixels: spec.pixels,
  sun: {
    direction: viewSun(CUMULUS_VIEWS.find(({ id }) => id === spec.view)!),
    irradiance: [1, 1, 1],
    angularRadius: spec.sunRadius,
  },
  sky:
    spec.skyAt === null || air === null
      ? spec.sky
      : {
          air,
          sunMu: spec.skyAt.sunMu,
          height01: cumulusSkyHeight(spec.skyAt.height),
        },
  ground: spec.ground,
  orders: Infinity,
  samples,
  seed: SEED,
})

describe('the sky', () => {
  it('is the table’s on the device as on the CPU, at a half float’s step', async () => {
    // The CPU tier's sky is `skyMomentsAt` of the table's float32 data; the
    // kernel's is `skyTableAt` of the texture the page uploads, half floats.
    // The mean is stored as its logarithm, near −4, so a half float's
    // eleven bits are 0.2% of the mean itself. Held in every direction of
    // a sphere, each view's sun, as a share of the mean: where the linear
    // sky falls to nothing there is no ratio to take.
    const air = earthAir()
    const count = 96
    const directions = new Float32Array(count * 3)
    const golden = Math.PI * (3 - Math.sqrt(5))
    for (let i = 0; i < count; i += 1) {
      const y = 1 - (2 * (i + 0.5)) / count
      const r = Math.sqrt(1 - y * y)
      directions.set(
        [r * Math.cos(golden * i), y, r * Math.sin(golden * i)],
        i * 3,
      )
    }
    let worst = 0
    for (const view of CUMULUS_VIEWS) {
      const { sky, at } = cumulusSky(view, 1700)
      const spec: CumulusCase = {
        id: `sky:${view.id}`,
        subject: 'sky',
        view: view.id,
        pixels: 8,
        samples: 1,
        sunRadius: 0,
        sky,
        skyAt: at,
        ground: null,
      }
      const probe = createPathTraceSkyProbe(
        sceneOfCase(ANALYTIC, spec, 1, air),
        directions,
      )
      await gpu.compute(probe.kernel)
      const drawn = new Float32Array(await gpu.readBuffer(probe.output))
      for (let i = 0; i < count; i += 1) {
        const direction = [
          directions[i * 3]!,
          directions[i * 3 + 1]!,
          directions[i * 3 + 2]!,
        ] as const
        const expected = cumulusSkyRadiance(sky, viewSun(view), direction)
        for (let band = 0; band < 3; band += 1)
          worst = Math.max(
            worst,
            Math.abs(drawn[i * 4 + band]! - expected[band]!) / sky.mean[band]!,
          )
      }
      // The sky is one: in some direction it is over half its mean.
      expect(Math.max(...drawn)).toBeGreaterThan(0.5 * sky.mean[1])
    }
    expect(worst).toBeLessThan(SKY_STEP)
    air.dispose()
  })
})

describe('every order', () => {
  it('holds the analytic cumulus to the float64 tracer’s pixels, by the count', async () => {
    expect(analytic.cases.length).toBeGreaterThanOrEqual(3)
    const off: number[] = []
    for (const spec of analytic.cases) {
      const { sums } = await trace(sceneOfCase(ANALYTIC, spec, 1024))
      const probes = analytic.probes.filter((probe) => probe.case === spec.id)
      expect(probes.length).toBeGreaterThan(30)
      off.push(...offsets(sums, probes, ([x, y]) => y * spec.pixels + x).flat())
    }
    // Of 432 values, three errors hold all but one or two by chance (99.73%
    // each), and five hold every one of them. Measured: two beyond three,
    // the farthest at 3.93, and a mean of 0.81 where a normal's is 0.80.
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

/** An image as a portable float map, bottom row first as the format has it. */
function writeImage(name: string, sums: Float32Array, pixels: number): void {
  const data = new Float32Array(pixels * pixels * 3)
  for (let py = 0; py < pixels; py += 1)
    for (let px = 0; px < pixels; px += 1)
      data.set(
        pathTraceEstimate(sums, py * pixels + px).mean,
        ((pixels - 1 - py) * pixels + px) * 3,
      )
  mkdirSync(OUT, { recursive: true })
  writeFileSync(
    `${OUT}/${name}.pfm`,
    Buffer.concat([
      Buffer.from(`PF\n${pixels} ${pixels}\n-1.0\n`),
      Buffer.from(data.buffer),
    ]),
  )
}

/** The samples the two tiers are held to each other at, as on the analytic cumulus. */
const COMPARE_SAMPLES = 1024
/** Threads a pixel's samples are shared among where only the reference's pixels are traced. */
const STREAMS = 64
const { cases, subjects } = CUMULUS_REFERENCE

describe.skipIf(!MEASURE || cases.length === 0)(
  'the instrument (IR_CLOUD_MEASURE)',
  () => {
    const media = new Map<string, TraceMedium>()
    const mediumOf = (id: string): TraceMedium => {
      let medium = media.get(id)
      if (medium === undefined) {
        medium = subjectMedium(subjects.find((subject) => subject.id === id)!)
        media.set(id, medium)
      }
      return medium
    }

    it('holds the reference’s cases to their own pixels, by the count', async () => {
      // Only the reference's pixels are traced, sixty-four threads each. An
      // image traced whole is as slow as its deepest pixel, a line of sight
      // of some hundreds here, and the pixels the two tiers are compared at
      // are 288 of its 65,536.
      const air = earthAir()
      const rows = []
      for (const spec of cases) {
        const probes = CUMULUS_REFERENCE.probes.filter(
          (probe) => probe.case === spec.id,
        )
        const pixels = [
          ...new Set(
            probes.map(({ pixel }) => pixel[1] * spec.pixels + pixel[0]),
          ),
        ]
        const start = performance.now()
        const { sums, dispatches, events } = await trace(
          {
            ...sceneOfCase(
              mediumOf(spec.subject),
              spec,
              COMPARE_SAMPLES / STREAMS,
              air,
            ),
            threads: pixels.flatMap((pixel) =>
              new Array<number>(STREAMS).fill(pixel),
            ),
          },
          4_000_000,
        )
        const seconds = (performance.now() - start) / 1000
        const off = offsets(sums, probes, ([x, y]) => {
          const at = pixels.indexOf(y * spec.pixels + x) * STREAMS
          return Array.from({ length: STREAMS }, (_, k) => at + k)
        })
        const band = (b: number): number[] => off.map((values) => values[b]!)
        const beyondThree = [0, 1, 2].map(
          (b) => band(b).filter((value) => value > 3).length,
        )
        const worst = Math.max(...off.flat())
        const all = off.flat()
        rows.push({
          case: spec.id,
          probes: probes.length,
          pixels: pixels.length,
          samples: COMPARE_SAMPLES,
          seconds,
          dispatches,
          events,
          beyondThree,
          beyondTwo: all.filter((value) => value > 2).length,
          worst,
          meanOffset: all.reduce((sum, value) => sum + value, 0) / all.length,
        })
        // §5.11: of a case's 288 pixels at most three beyond three combined
        // standard errors, and none beyond five, a band at a time. A bound
        // on every pixel at three would fail one run in two by chance.
        for (const count of beyondThree) expect(count).toBeLessThanOrEqual(3)
        expect(worst).toBeLessThan(5)
      }
      mkdirSync(OUT, { recursive: true })
      writeFileSync(
        `${OUT}/pathTrace.json`,
        JSON.stringify(
          { samples: COMPARE_SAMPLES, streams: STREAMS, rows },
          null,
          2,
        ),
      )
      air.dispose()
    }, 3_600_000)

    it('prices a sample of each case at the reference’s resolution', async () => {
      // A case traced whole for a fixed time with no last sample, so every
      // thread is at work for all of it, and then read: a pixel's samples
      // in that time are its rate. A run to a fixed count would be priced
      // by its one deepest pixel and say nothing of the rest.
      const air = earthAir()
      const budget = 10
      const rows = []
      for (const spec of cases) {
        const scene = sceneOfCase(mediumOf(spec.subject), spec, 2 ** 30, air)
        const threads = spec.pixels * spec.pixels
        const events = eventsFor(threads)
        const tracer = createCloudPathTracer(scene, events)
        const start = performance.now()
        let dispatches = 0
        while (performance.now() - start < budget * 1000) {
          for (let i = 0; i < BURST; i += 1) await gpu.compute(tracer.kernel)
          dispatches += BURST
        }
        const sums = new Float32Array(await gpu.readBuffer(tracer.sums))
        const seconds = (performance.now() - start) / 1000
        // Thread-seconds one sample of the image costs: each pixel's seconds
        // a sample, summed. A pixel that finished none is counted at one.
        let cost = 0
        let fewest = Infinity
        let none = 0
        const spread: number[] = []
        for (let pixel = 0; pixel < threads; pixel += 1) {
          const { mean, error, samples } = pathTraceEstimate(sums, pixel)
          cost += seconds / Math.max(samples, 1)
          fewest = Math.min(fewest, samples)
          if (samples === 0) none += 1
          // One sample's relative deviation, green, where a path's light is
          // drawn: over a tenth. Clear sky is one value summed 10⁵ times in
          // float32, and the last bits of that sum and of its squares read
          // as a deviation of a hundredth.
          const one =
            mean[1] > 0 ? (error[1] / mean[1]) * Math.sqrt(samples) : 0
          if (samples > 8 && one > 0.1) spread.push(one)
        }
        spread.sort((x, y) => x - y)
        rows.push({
          case: spec.id,
          seconds,
          dispatches,
          events,
          eventsASecond: (threads * events * dispatches) / seconds,
          threadSecondsASample: cost,
          secondsASampleShared: cost / threads,
          fewestSamples: fewest,
          pixelsWithNone: none,
          pixelsWithSpread: spread.length,
          medianDeviationOfOne: spread[spread.length >> 1] ?? 0,
          ninetiethDeviationOfOne: spread[Math.floor(0.9 * spread.length)] ?? 0,
        })
      }
      mkdirSync(OUT, { recursive: true })
      writeFileSync(
        `${OUT}/pathTraceCost.json`,
        JSON.stringify({ budget, rows }, null, 2),
      )
      for (const row of rows) expect(row.pixelsWithSpread).toBeGreaterThan(1000)
      air.dispose()
    }, 600_000)

    it.skipIf(!IMAGES)(
      'draws each case whole, and holds the image to the reference’s pixels',
      async () => {
        // The campaign's long run: every pixel of 256² a thread, to the
        // count the tiers are compared at. It is as slow as each image's
        // deepest pixel.
        const air = earthAir()
        for (const spec of cases) {
          const { sums } = await trace(
            sceneOfCase(mediumOf(spec.subject), spec, COMPARE_SAMPLES, air),
            40_000_000,
          )
          writeImage(
            `pathTrace-${spec.id.replace(':', '-')}`,
            sums,
            spec.pixels,
          )
          const probes = CUMULUS_REFERENCE.probes.filter(
            (probe) => probe.case === spec.id,
          )
          const off = offsets(sums, probes, ([x, y]) => y * spec.pixels + x)
          for (let b = 0; b < 3; b += 1)
            expect(
              off.filter((values) => values[b]! > 3).length,
            ).toBeLessThanOrEqual(3)
          expect(Math.max(...off.flat())).toBeLessThan(5)
        }
        air.dispose()
      },
      14_400_000,
    )
  },
)
