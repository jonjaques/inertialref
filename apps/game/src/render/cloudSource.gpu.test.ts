import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Node, StorageBufferAttribute } from 'three/webgpu'
import {
  bool,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  storage,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import {
  halfBitsOf,
  halfFloatsFromBase64,
  depthCoordinate,
  diffusionExtension,
  resolvedSlab as resolvedSlabOf,
  skySource as skySourceOf,
  SLAB_SUN_HOLD,
  SLAB_VIEW_SOURCE,
  type SlabSourceTable,
  SOURCE_SUN_FLOOR,
  sourceAt,
  statisticalSlab as statisticalSlabOf,
  stepRamp as stepRampOf,
  UNSPREAD_SHAPE,
  viewReads,
  sunFactorPair,
} from '@inertialref/rendering'
import { SLAB_VIEW_SOURCE_TEXELS } from '@inertialref/rendering/slabSourceTexels'
import {
  resolvedSlab,
  skySource,
  statisticalSlab,
  stepRamp,
  stepWeights,
} from './cloudMix.ts'
import {
  CLOUD_ICE_ROWS,
  type CloudSource,
  createCloudSource,
} from './cloudSource.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The source table's node on the GPU, held to the CPU read the table's
 * header figures were taken through (`slabSourceRead.ts`) before it lights
 * anything, and the two rules that form a slab, each held to its twin
 * (`cloudOverlap.ts`).
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu(8, 8)
})

afterAll(() => {
  gpu.dispose()
})

const TABLE = SLAB_VIEW_SOURCE
const SLABS = 2 * TABLE.cosines.length

/** A seeded uniform draw, so a failure reproduces. */
function draws(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A kernel that reads `width` floats a case, hands them to `build`, and
 * writes the floats it answers: one thread a case.
 */
async function evaluate(
  width: number,
  cases: readonly (readonly number[])[],
  build: (read: (k: number) => Node<'float'>) => readonly Node<'float'>[],
): Promise<number[][]> {
  const capacity = cases.length
  const input = new StorageBufferAttribute(
    new Float32Array(cases.flatMap((row) => [...row])),
    1,
  )
  const from = storage(input, 'float', capacity * width)
  const count = uniform(capacity, 'uint')
  let answers = 0
  let output: StorageBufferAttribute | null = null
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(count), () => {
      const values = build((k) => from.element(instanceIndex.mul(width).add(k)))
      answers = values.length
      output = new StorageBufferAttribute(
        new Float32Array(capacity * answers),
        1,
      )
      const into = storage(output, 'float', capacity * answers)
      values.forEach((value, k) => {
        into.element(instanceIndex.mul(answers).add(k)).assign(value)
      })
    })
  })().compute(capacity)
  await gpu.compute(kernel)
  const out = new Float32Array(await gpu.readBuffer(output!))
  kernel.dispose()
  input.dispose()
  output!.dispose()
  return cases.map((_, i) => [...out.subarray(i * answers, (i + 1) * answers)])
}

/**
 * How far the sky's node may stand from its CPU reference: a handful of
 * float32 steps of a sum of terms of order one. 2.0e-7 at worst on the Mac
 * mini, over 3,780 cases in three bands.
 */
const SKY_STEP = 2e-6

/**
 * How far a ramp's step may stand from its CPU reference, as a share of
 * its larger end times its depth: a float32's step under one, 1.2e-7, in
 * `1 − e^(−τ)` at a depth of 10⁻⁴ is 1.2e-3 of it. 5.0e-4 at worst on the
 * Mac mini and 8.1e-4 on the hosted adapter.
 */
const RAMP_STEP = 2e-3

/** A table of scales against radius, linear in ln r and held at its ends: the node's `scaleAt`, in float64. */
function scaleOf(
  table: {
    readonly radii: readonly number[]
    readonly scales: readonly number[]
  },
  radius: number,
): number {
  const { radii, scales } = table
  const last = radii.length - 1
  if (radius <= radii[0]!) return scales[0]!
  if (radius >= radii[last]!) return scales[last]!
  let k = 0
  while (radii[k + 1]! < radius) k += 1
  const share =
    (Math.log(radius) - Math.log(radii[k]!)) /
    (Math.log(radii[k + 1]!) - Math.log(radii[k]!))
  return scales[k]! + (scales[k + 1]! - scales[k]!) * share
}

/** Ice's scale as the node reads it: through `CLOUD_ICE_ROWS` of its rows. */
const ICE_ROWS = {
  radii: CLOUD_ICE_ROWS.map((row) => TABLE.iceTransport.radii[row]),
  scales: CLOUD_ICE_ROWS.map((row) => TABLE.iceTransport.scales[row]),
}

/** The committed table as the CPU read takes it. */
function committed(): SlabSourceTable {
  return {
    nodes: TABLE.nodes,
    suns: TABLE.suns,
    sunMuMin: TABLE.sunMuMin,
    depthScale: TABLE.depthScale,
    depthMax: TABLE.depthMax,
    slabs: SLABS,
    terms: halfFloatsFromBase64(
      SLAB_VIEW_SOURCE_TEXELS.texels,
      TABLE.texelCount,
      'the slab source',
    ),
  }
}

/** The levels a test's source reads: droplets, droplets, ice; cumulus's factor on the first. */
function placeLevels(source: CloudSource): void {
  const { l, a } = sunFactorPair('cumulus')
  source.levels.ice.value.set(0, 0, 1)
  source.levels.factor.value.set(l, 1, 1)
  source.levels.slope.value.set(a, 0, 0)
}

/** One read: a slab, a radius, a level, a view and the column's cumuliform share. */
interface Read {
  readonly sunMu: number
  readonly top: number
  readonly bottom: number
  readonly radius: number
  readonly level: 0 | 1 | 2
  readonly mu: number
  readonly bearing: number
  readonly convective: number
}

const asRow = (read: Read): number[] => [
  read.sunMu,
  read.top,
  read.bottom,
  read.radius,
  read.level,
  read.mu,
  read.bearing,
  read.convective,
]

/** The node at a list of reads. */
async function nodeAt(
  source: CloudSource,
  reads: readonly Read[],
): Promise<number[]> {
  const out = await evaluate(8, reads.map(asRow), (read) => [
    source.source(
      {
        sunMu: read(0),
        depth: vec2(read(1), read(2)),
        convective: read(7),
      },
      read(3),
      source.level(int(read(4))),
      source.view(read(5), read(6)),
    ),
  ])
  return out.map((row) => row[0]!)
}

/**
 * The spread of the eight texels a slab's read blends, each summed by the
 * read's weights: the most a sampler's own rounding of its three weights
 * can move the read by, a weight's step an axis.
 */
function texelSpread(
  table: SlabSourceTable,
  slab: number,
  weights: readonly number[],
  top: number,
  bottom: number,
  sunMu: number,
): number {
  const last = table.nodes - 1
  const x0 = Math.min(last - 1, Math.floor(depthCoordinate(table, top) * last))
  const y0 = Math.min(
    last - 1,
    Math.floor(depthCoordinate(table, bottom) * last),
  )
  const z = Math.min(
    table.suns - 1 - SLAB_SUN_HOLD,
    Math.max(
      SLAB_SUN_HOLD,
      ((sunMu - table.sunMuMin) / (1 - table.sunMuMin)) * (table.suns - 1),
    ),
  )
  const z0 = Math.min(table.suns - 2, Math.floor(z))
  let least = Infinity
  let most = -Infinity
  for (let corner = 0; corner < 8; corner += 1) {
    const cell =
      (((slab * table.suns + z0 + (corner >> 2)) * table.nodes +
        y0 +
        ((corner >> 1) & 1)) *
        table.nodes +
        x0 +
        (corner & 1)) *
      4
    let sum = 0
    for (let channel = 0; channel < 4; channel += 1)
      sum += table.terms[cell + channel]! * weights[channel]!
    least = Math.min(least, sum)
    most = Math.max(most, sum)
  }
  return most - least
}

/**
 * The same read on the CPU, through `slabSourceRead.ts`, and the spread of
 * the texels it blends.
 */
function cpuAt(
  table: SlabSourceTable,
  read: Read,
): { readonly value: number; readonly spread: number } {
  const ice = read.level === 2
  const scale = scaleOf(ice ? ICE_ROWS : TABLE.transport, read.radius)
  const sunMu = Math.min(Math.max(read.sunMu, TABLE.sunMuMin), 1)
  const mu = Math.max(-1, Math.min(1, read.mu))
  const bearing = Math.max(-1, Math.min(1, read.bearing))
  const reads = viewReads(
    { cosines: TABLE.cosines, stretch: TABLE.stretch },
    {
      sunMu,
      muV: mu,
      along: bearing * Math.sqrt(Math.max(0, 1 - mu * mu)),
      nu: 0,
    },
  )
  // Straight along the normal `viewReads` gives a ray a right angle, and
  // the node takes the bearing it is handed: the cases below hand it one.
  const top = scale * Math.max(read.top, 0)
  const bottom = scale * Math.max(read.bottom, 0)
  const value = sourceAt(table, reads, top, bottom, sunMu)
  const spread = reads.reduce(
    (sum, { slab, weights }) =>
      sum + texelSpread(table, slab, weights, top, bottom, sunMu),
    0,
  )
  const pair = read.level === 0 ? sunFactorPair('cumulus') : { l: 1, a: 0 }
  const lean = Math.sqrt(Math.max(0, 1 - sunMu * sunMu)) / sunMu
  const factor =
    (1 + read.convective * (pair.l * (1 + pair.a * lean) - 1)) *
    diffusionExtension(table, top, bottom)
  return {
    value: value * (1 + read.convective * (pair.l * (1 + pair.a * lean) - 1)),
    spread: spread * factor,
  }
}

describe('the source’s node against the CPU read', () => {
  /*
   * 4,096 seeded reads, the ends of every axis among them. A view cosine
   * of zero is a tie between the two hemispheres, and a depth of exactly
   * the table's last node a tie between the read and its extension: the
   * seeded draws stand off both, and the named ends stand a thousandth to
   * each side of the first.
   *
   * **The bound is 10⁻³ of the read and the sampler's own weights.** The
   * read is a linear 3D texture's, and this adapter forms a filter's
   * weights in steps of a 256th. Over most of the table that is under the
   * thousandth. Within a hundredth of a transport depth of a face it is
   * not: the source there is a few 10⁻⁴ sr⁻¹ and rises several fold to the
   * next node, so a weight's step is percents of a read that is itself
   * nothing in a ray's sum (3.6% of 2.7 × 10⁻⁴ sr⁻¹ at worst, on this Mac's
   * adapter). So each read is allowed a 256th of the spread of the eight
   * texels it blends on each of its three axes, which is what a sampler
   * that floors its weights can move it by, and a read that takes a wrong
   * slice, a wrong slab or a wrong depth is off by that spread whole.
   */
  it('reads the committed table within a thousandth and the sampler’s own weights, at 4,096 seeded slabs and views', async () => {
    const source = createCloudSource()
    await source.load()
    placeLevels(source)
    const table = committed()
    const random = draws(0x51ab)
    const pick = <T>(values: readonly T[]): T =>
      values[Math.floor(random() * values.length)]!
    const depthEnds = [0, 1e-4, 0.3, 5, 30, 62, 64, 200, 400]
    const sunEnds = [0.01, 0.05, 0.0501, 0.2, 0.5, 0.999, 1]
    const muEnds = [
      -1,
      -0.999,
      -1e-3,
      1e-3,
      0.999,
      1,
      ...TABLE.cosines,
      ...TABLE.cosines.map((cosine) => -cosine),
    ]
    const bearingEnds = [-1, -0.5, 0, 0.5, 1]
    const reads: Read[] = []
    while (reads.length < 4096) {
      const level = pick([0, 1, 2] as const)
      const end = reads.length % 4 === 0
      const mu = end ? pick(muEnds) : (random() * 2 - 1) * 0.9999
      // Along the normal a ray has no bearing: a right angle, as the CPU
      // read takes it.
      const upright = Math.abs(mu) > 1 - 1e-9
      reads.push({
        sunMu: end ? pick(sunEnds) : 0.03 + 0.97 * random(),
        top: end ? pick(depthEnds) : 300 * random() ** 4,
        bottom: end ? pick(depthEnds) : 300 * random() ** 4,
        radius:
          level === 2
            ? pick([4, 5, 12.5, 33, 60, 70, 5 + 55 * random()])
            : pick([1, 2, 3.5, 10, 13, 32, 40, 2 + 30 * random()]),
        level,
        mu,
        bearing: upright ? 0 : end ? pick(bearingEnds) : random() * 2 - 1,
        convective: pick([0, 0, 1, random()]),
      })
    }
    const got = await nodeAt(source, reads)
    // The read over its bound, the worst of them; and for the record the
    // worst relative error and how many reads are past a thousandth.
    let worst = 0
    let relative = 0
    let over = 0
    let at = -1
    got.forEach((value, i) => {
      expect(Number.isFinite(value)).toBe(true)
      const want = cpuAt(table, reads[i]!)
      const error = Math.abs(value - want.value)
      const bound = 1e-3 * Math.abs(want.value) + (3 / 256) * want.spread + 1e-7
      if (error / Math.max(Math.abs(want.value), 1e-6) > 1e-3) over += 1
      if (error / Math.max(Math.abs(want.value), 1e-6) > relative) {
        relative = error / Math.max(Math.abs(want.value), 1e-6)
        at = i
      }
      worst = Math.max(worst, error / bound)
    })
    console.info(
      `cloudSource: the node against the CPU read: ${(worst * 100).toFixed(1)}% of its bound at worst; ${over} of ${reads.length} reads past a thousandth, the worst ${(relative * 100).toFixed(2)}% at ${JSON.stringify(reads[at])}`,
    )
    expect(worst).toBeLessThan(1)
    source.dispose()
  }, 120_000)

  /*
   * A table whose slab k holds the constant k reads back k at both ends of
   * the sun's coordinate and of each depth, in every slab. A wrap that
   * repeats gives the last slab's last slice the first slab's first as its
   * neighbor; a sampler that floors its weight puts a 256th of the next
   * slab's slice in a read at either end of the sun's coordinate; a wrong
   * slice reads another slab's constant. **This is the test that holds
   * `SLAB_SUN_HOLD`:** if a read leaves its slab on an adapter, the
   * constant is what moves, and not this bound.
   *
   * The view stands on each cosine, where the blend's second slab has a
   * share of a float32's rounding of an angle over the gap to the next,
   * under 10⁻⁵; the bound is a quarter of the 256th a flooring sampler
   * would add.
   */
  it('reads a slab’s own constant at both ends of the sun’s coordinate and of each depth, in every slab', async () => {
    const source = createCloudSource()
    placeLevels(source)
    const halves = new Uint16Array(TABLE.texelCount)
    const perSlab = TABLE.suns * TABLE.nodes * TABLE.nodes * 4
    for (let slab = 0; slab < SLABS; slab += 1)
      for (let at = 0; at < perSlab; at += 4)
        halves[slab * perSlab + at] = halfBitsOf(slab)
    source.land(halves)
    const count = TABLE.cosines.length
    // An unscaled depth that is the table's last node at 10 µm, a float32
    // step to either side of which the read and its extension agree.
    const scale = scaleOf(TABLE.transport, 10)
    const deep = TABLE.depthMax / scale
    const reads: Read[] = []
    const slabs: number[] = []
    for (let slab = 0; slab < SLABS; slab += 1)
      for (const sunMu of [0.01, TABLE.sunMuMin, 1])
        for (const top of [0, deep])
          for (const bottom of [0, deep]) {
            const cosine = TABLE.cosines[slab % count]!
            reads.push({
              sunMu,
              top,
              bottom,
              radius: 10,
              level: 1,
              mu: slab < count ? cosine : -cosine,
              // cos ψ = 0: the first channel alone, and the third's sign.
              bearing: 0,
              convective: 0,
            })
            slabs.push(slab)
          }
    const got = await nodeAt(source, reads)
    let worst = 0
    got.forEach((value, i) => {
      worst = Math.max(worst, Math.abs(value - slabs[i]!))
    })
    console.info(
      `cloudSource: a slab's constant read back, worst ${worst.toExponential(2)} of a slab's step`,
    )
    expect(worst).toBeLessThan(1 / 1024)
    source.dispose()
  }, 120_000)

  it('answers nothing before its texels land, and a finite number at every degenerate read', async () => {
    const pending = createCloudSource()
    placeLevels(pending)
    const degenerate: Read[] = []
    for (const sunMu of [-1, 0, 0.01, TABLE.sunMuMin, 1, 2])
      for (const [top, bottom] of [
        [0, 0],
        [-1, -1],
        [0, 1e6],
        [1e6, 0],
        [1e6, 1e6],
      ] as const)
        for (const [mu, bearing] of [
          [1, 0],
          [-1, 1],
          [0, -1],
          [1, 5],
          [2, -5],
        ] as const)
          for (const level of [0, 2] as const)
            degenerate.push({
              sunMu,
              top,
              bottom,
              radius: level === 2 ? 0 : 1e-9,
              level,
              mu,
              bearing,
              convective: 1,
            })
    for (const value of await nodeAt(pending, degenerate)) expect(value).toBe(0)
    const source = createCloudSource()
    await source.load()
    placeLevels(source)
    for (const value of await nodeAt(source, degenerate)) {
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
    }
    pending.dispose()
    source.dispose()
  }, 120_000)

  /*
   * The factor of the sun is exactly one where a column has no cumuliform
   * share, at every sun: a bit's equality, the factored read against the
   * read with no share handed to it, so a stratiform level and the slab
   * gate are the plane slab's source untouched.
   */
  it('takes no factor of the sun at a cumuliform share of zero, to the bit, and the fitted one at a share of one', async () => {
    const source = createCloudSource()
    await source.load()
    placeLevels(source)
    const suns = [0.01, 0.05, 0.12, 0.26, 0.5, 0.77, 0.94, 1]
    const out = await evaluate(
      2,
      suns.flatMap((sunMu) => [0, 1].map((share) => [sunMu, share])),
      (read) => {
        const slab = { sunMu: read(0), depth: vec2(1.5, 4) }
        const view = source.view(float(0.4), float(0.3))
        return [
          source.source(slab, float(10), source.level(int(0)), view),
          source.source(
            { ...slab, convective: read(1) },
            float(10),
            source.level(int(0)),
            view,
          ),
        ]
      },
    )
    const { l, a } = sunFactorPair('cumulus')
    suns.forEach((sunMu, i) => {
      const [plain, none] = out[2 * i]!
      const [, whole] = out[2 * i + 1]!
      expect(plain).toBeGreaterThan(0)
      expect(none).toBe(plain)
      const mu = Math.max(sunMu, SOURCE_SUN_FLOOR)
      const factor = l * (1 + (a * Math.sqrt(1 - mu * mu)) / mu)
      expect(Math.abs(whole! / plain! - factor)).toBeLessThan(1e-5 * factor)
    })
    source.dispose()
  }, 120_000)
})

describe('the slab a sample stands in', () => {
  const close = (value: number, want: number): void => {
    expect(Number.isFinite(value)).toBe(true)
    expect(Math.abs(value - want)).toBeLessThanOrEqual(
      2e-6 * Math.max(Math.abs(want), 1e-3),
    )
  }

  it('is the sun’s two depths times its cosine at a resolved step, over and under the horizon', async () => {
    const cases: [number, number, number][] = []
    for (const sunMu of [1, 0.6, 0.2, 0.05, 0.01, 0, -0.01, -0.052, -0.6, -1])
      for (const [toSun, whole] of [
        [0, 0],
        [0, 12],
        [3, 12],
        [12, 12],
        // A whole depth under the depth to the sun leaves nothing behind.
        [12, 3],
        [64, 80],
      ] as const)
        cases.push([toSun, whole, sunMu])
    const out = await evaluate(3, cases, (read) => {
      const slab = resolvedSlab(vec2(read(0), read(1)), read(2))
      return [slab.sunMu, slab.depth.x, slab.depth.y]
    })
    cases.forEach(([toSun, whole, sunMu], i) => {
      const want = resolvedSlabOf(toSun, whole, sunMu)
      close(out[i]![0]!, want.sunMu)
      close(out[i]![1]!, want.top)
      close(out[i]![2]!, want.bottom)
      expect(out[i]![2]!).toBeGreaterThanOrEqual(0)
    })
  }, 120_000)

  it('is a Gauss point of the tilted gamma at a statistical step, at one point and at two', async () => {
    const cases: number[][] = []
    for (const shape of [0.54, 0.82, 3, 31.5, UNSPREAD_SHAPE])
      for (const mean of [0, 0.4, 9.4, 36.7])
        for (const seen of [-0.2, 0, 0.3, 1, 1.4])
          for (const viewMu of [0, 0.02, 0.3, 1])
            for (const litSide of [0, 1])
              cases.push([shape, mean, seen, viewMu, litSide, 0.4])
    const out = await evaluate(6, cases, (read) => {
      const answers: Node<'float'>[] = []
      for (const [point, points] of [
        [0, 1],
        [0, 2],
        [1, 2],
      ] as const) {
        const { slab, weight } = statisticalSlab(
          { shape: read(0), mean: read(1) },
          read(2),
          read(3),
          read(4).greaterThan(0.5),
          read(5).negate(),
          point,
          points,
        )
        answers.push(slab.sunMu, slab.depth.x, slab.depth.y, weight)
      }
      return answers
    })
    cases.forEach(([shape, mean, seen, viewMu, litSide], i) => {
      ;(
        [
          [0, 1],
          [0, 2],
          [1, 2],
        ] as const
      ).forEach(([point, points], k) => {
        const want = statisticalSlabOf(
          { shape: shape!, mean: mean! },
          seen!,
          viewMu!,
          litSide === 1,
          -0.4,
          point,
          points,
        )
        const got = out[i]!.slice(4 * k, 4 * k + 4)
        close(got[0]!, want.slab.sunMu)
        // A depth is a quotient of two sums a float32 forms to its step.
        expect(Math.abs(got[1]! - want.slab.top)).toBeLessThanOrEqual(
          1e-5 * Math.max(want.slab.top, 1e-3),
        )
        expect(Math.abs(got[2]! - want.slab.bottom)).toBeLessThanOrEqual(
          1e-5 * Math.max(want.slab.bottom, 1e-3),
        )
        close(got[3]!, want.weight)
        expect(got[1]!).toBeGreaterThanOrEqual(0)
        expect(got[2]!).toBeGreaterThanOrEqual(0)
      })
    })
  }, 120_000)

  it('gives a level of one depth that depth, split where the sample stands', async () => {
    // A slab is a level whose columns do not spread: both rules must hand
    // the node one slab, or the two marches differ on a deck.
    const [[top, bottom, low, high]] = (await evaluate(1, [[0.25]], (read) => {
      const statistics = {
        shape: float(UNSPREAD_SHAPE),
        mean: float(20),
      }
      const at = (point: 0 | 1) =>
        statisticalSlab(
          statistics,
          read(0),
          float(0.5),
          bool(true),
          float(0.5),
          point,
          2,
        )
      const first = at(0)
      const second = at(1)
      return [
        first.slab.depth.x
          .mul(first.weight)
          .add(second.slab.depth.x.mul(second.weight)),
        first.slab.depth.y
          .mul(first.weight)
          .add(second.slab.depth.y.mul(second.weight)),
        first.slab.depth.x.add(first.slab.depth.y),
        second.slab.depth.x.add(second.slab.depth.y),
      ]
    })) as [[number, number, number, number]]
    // The columns' mean under the ray's weight is the one depth to a part
    // in the shape, 10⁻⁴, and the two points stand 1/√k to each side of it.
    expect(Math.abs(top + bottom - 20)).toBeLessThan(20 * 3e-3)
    expect(Math.abs(top / (top + bottom) - 0.25)).toBeLessThan(1e-5)
    expect(low).toBeLessThan(20)
    expect(high).toBeGreaterThan(20)
    expect(high - low).toBeLessThan(20 * 0.03)
  }, 120_000)
})

describe('the light a step adds of a ramp', () => {
  it('is its CPU reference from a wisp of a step to a wall of one', async () => {
    const cases: number[][] = []
    for (const start of [0, 0.2, 1, 2.5])
      for (const end of [0, 0.2, 1, 2.5])
        for (const depth of [1e-4, 0.005, 0.0099, 0.0101, 0.3, 1.16, 5, 40])
          cases.push([start, end, depth])
    const out = await evaluate(3, cases, (read) => {
      const light = stepRamp(
        vec3(read(0)),
        vec3(read(1), read(1).mul(0.5), 0),
        stepWeights(read(2)),
      )
      return [light.x, light.y, light.z]
    })
    let worst = 0
    cases.forEach(([start, end, depth], i) => {
      ;[end!, end! * 0.5, 0].forEach((far, band) => {
        const want = stepRampOf(start!, far, depth!)
        const got = out[i]![band]!
        expect(Number.isFinite(got)).toBe(true)
        worst = Math.max(
          worst,
          Math.abs(got - want) / Math.max(start!, far, 1e-3) / depth!,
        )
      })
    })
    console.info(
      `cloudSource: a ramp's step against its CPU reference, ${cases.length} cases by three bands: ${worst.toExponential(2)} of the larger end times the depth at worst`,
    )
    // A step's light is its depth's size where the step is thin, so the
    // bound is a share of the larger end times the depth, no more than it.
    expect(worst).toBeLessThan(RAMP_STEP)
  }, 120_000)
})

describe('the sky’s light on a sample', () => {
  /** The scaled phase's g′ at 10 µm, to the node as a constant. */
  const ASYMMETRY = 0.740443
  /** How a band's sides stand to the case's: three bands, three skies. */
  const BAND = [
    [1, 1, 1],
    [0.5, -1, 0.5],
    [-1, 0.25, 0],
  ] as const
  /** A case's sky, column, share and view: Δ, Δ_s, c, t_d, t_b, v, the ray's rise and its cosine to the sun's side. */
  const cases: number[][] = []
  for (const up of [-1.3, -0.36, 0.09, 1.2])
    for (const sunward of [0, 0.45, 1.12])
      for (const upper of [0, -0.16, -0.38])
        for (const [over, under] of [
          [0, 0],
          [0.05, 0.05],
          [0, 3],
          [3, 0],
          [1, 9],
          [40, 0.5],
          [0, 400],
        ] as const)
          for (const convective of [0, 0.35, 1])
            for (const [rise, toward] of [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [0.5, -0.6],
            ] as const)
              cases.push([
                up,
                sunward,
                upper,
                over,
                under,
                convective,
                rise,
                toward,
                // A zero the kernel reads, where a literal one would fold
                // the term away and build another expression.
                0,
              ])
  /** A case's number in each band's place. */
  const banded = (value: Node<'float'>, k: 0 | 1 | 2): Node<'vec3'> =>
    vec3(value.mul(BAND[0][k]), value.mul(BAND[1][k]), value.mul(BAND[2][k]))
  /** The node at a case, with `upper` read from one of the case's floats. */
  const node = (read: (k: number) => Node<'float'>, upper: number) =>
    skySource(
      {
        up: banded(read(0), 0),
        sunward: banded(read(1), 1),
        upper: banded(read(upper), 2),
      },
      read(3),
      read(4),
      read(5),
      float(ASYMMETRY),
      read(6),
      read(7),
    )
  const want = (row: readonly number[], band: number, c = row[2]!): number =>
    skySourceOf(
      {
        up: row[0]! * BAND[band]![0],
        sunward: row[1]! * BAND[band]![1],
        upper: c * BAND[band]![2],
      },
      row[3]!,
      row[4]!,
      row[5]!,
      ASYMMETRY,
      row[6]!,
      row[7]!,
    )

  it('is its CPU reference in every band, and for a cumuliform column the same bits whatever c is', async () => {
    const out = await evaluate(9, cases, (read) => {
      const withC = node(read, 2)
      const without = node(read, 8)
      return [withC.x, withC.y, withC.z, without.x, without.y, without.z]
    })
    let worst = 0
    let moved = 0
    cases.forEach((row, i) => {
      for (const band of [0, 1, 2]) {
        const got = out[i]![band]!
        expect(Number.isFinite(got)).toBe(true)
        expect(got).toBeGreaterThanOrEqual(0)
        worst = Math.max(worst, Math.abs(got - want(row, band)))
        // The lean and the flux alone, in this same kernel.
        const plain = out[i]![3 + band]!
        expect(Math.abs(plain - want(row, band, 0))).toBeLessThan(SKY_STEP)
        if (row[5] === 1) expect(got).toBe(plain)
        else if (got !== plain) moved += 1
      }
    })
    console.info(
      `cloudSource: the sky's light, ${cases.length} cases by three bands: the node off its CPU reference by ${worst.toExponential(2)} at worst; c moves ${moved} values of a column not wholly cumuliform`,
    )
    expect(worst).toBeLessThan(SKY_STEP)
    // The term is there to be switched off: a stratiform column reads c.
    expect(moved).toBeGreaterThan(1000)
  }, 120_000)

  it('is one to the bit under a sky alike on every side', async () => {
    const flat = cases.map((row) => [0, 0, 0, ...row.slice(3)])
    const out = await evaluate(9, flat, (read) => {
      const light = node(read, 2)
      return [light.x, light.y, light.z]
    })
    for (const row of out) for (const value of row) expect(value).toBe(1)
  }, 120_000)

  it('is each side’s irradiance over π at the two faces of a thick stratiform column', async () => {
    const faces: number[][] = []
    for (const up of [-1.3, -0.36, 0.09, 1.2])
      for (const upper of [0, -0.16, -0.38])
        for (const thick of [100, 1000, 4000])
          for (const rise of [-1, 0, 1])
            for (const [over, under] of [
              [0, thick],
              [thick, 0],
            ] as const)
              faces.push([up, 0.45, upper, over, under, 0, rise, 0.3, 0])
    const out = await evaluate(9, faces, (read) => {
      const light = node(read, 2)
      return [light.x, light.y, light.z]
    })
    faces.forEach((row, i) => {
      const [up, sunward, upper, over, under, , rise, toward] = row as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ]
      const thick = over + under
      for (const band of [0, 1, 2]) {
        const [a, b, c] = BAND[band]!
        const side = over === 0 ? 1 : -1
        const face = Math.max(1 + (side * up * a) / 2 + upper * c, 0)
        // What a face of a column this deep is short of its limit by: the
        // lean and c by their share of the reach, and the flux.
        const short =
          ((2 / 3) * Math.abs(up * a) +
            (4 / 3) * Math.abs(upper * c) +
            ASYMMETRY * Math.abs(up * a * rise + sunward * b * toward)) /
          (thick + 4 / 3)
        expect(Math.abs(out[i]![band]! - face)).toBeLessThanOrEqual(
          short + SKY_STEP,
        )
      }
    })
  }, 120_000)
})
