import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
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
import { logHub, RingBufferSink } from '@inertialref/shared'
import { cloudRadianceDifference } from '@inertialref/devtools'
import type { CloudHistory } from './cloudHistory.ts'
import type { CloudLevers } from './cloudLevers.ts'
import type { CloudResource } from './cloudNodes.ts'
import { type CloudRig, cloudRig } from './cloudSystemRig.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * The cloud system on the GPU (§9): every wave-2 module in one chain, run by
 * the sensor's own frame. The run order on the pass timeline under both
 * regimes; every texture at one level and every
 * resource's declared bytes its GPU textures'; the far atlas holding cloud
 * past the clipmap's reach; the trace stopping at the scene in true
 * kilometers at a compression that is not 1; the trace and the history on
 * one interleave; every lever set's frame drawn with no validation error
 * and no cloud work thrown away; and a warm-up that lands on whole caches
 * leaving them owing the slices it drew over.
 *
 * One rig for the file: the eye 100 m up under overcast's 300 m base, the
 * camera looking straight up, a ceiling over the image's top half 50 render
 * meters up, compression 0.5 — 100 true meters.
 */

const WIDTH = 64
const HEIGHT = 48
const COMPRESSION = 0.5
const CEILING = 50
/*
 * The ceiling's edge one history row over the middle, inside a 2 × 2 block:
 * trace row 5 holds history rows 10 and 11, the first under the ceiling and
 * the second under the sky, so which of the two a trace texel samples is
 * written in its depth.
 */
const HISTORY_ROWS = HEIGHT / 2
const CEILING_EDGE = 2 / HISTORY_ROWS
const SPLIT_ROW = 5
const TIMESTAMPS = await adapterOffers('timestamp-query')

let gpu: GpuSession
let rig: CloudRig

beforeAll(async () => {
  gpu = await openGpu(WIDTH, HEIGHT)
  rig = cloudRig(gpu, WIDTH, HEIGHT, {
    ceiling: CEILING,
    ceilingEdge: CEILING_EDGE,
    compression: COMPRESSION,
    levers: { scenario: 'overcast' },
  })
  await rig.system!.warm()
}, 120_000)

afterAll(() => {
  rig?.dispose()
  gpu?.dispose()
})

const set = (levers: Partial<CloudLevers>): void => {
  rig.levers = { ...rig.levers, on: true, ...levers }
}

const frames = (n: number): void => {
  for (let k = 0; k < n; k += 1) rig.frame()
}

const resource = <T extends CloudResource>(name: string): T => {
  const found = rig.system!.resources.find((held) => held.name === name)
  if (found === undefined) throw new Error(`no ${name}`)
  return found as T
}

/** Texels of a texture by `textureLoad`, so nothing filters or flips them: RGBA, in order. */
async function texels(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<[number, number, number, number][]> {
  const count = at.length
  const coordinates = new StorageBufferAttribute(
    new Uint32Array(at.flatMap(([x, y]) => [x, y])),
    1,
  )
  const out = new StorageBufferAttribute(new Float32Array(count * 4), 1)
  const from = storage(coordinates, 'uint', count * 2)
  const into = storage(out, 'float', count * 4)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const x = int(from.element(instanceIndex.mul(2)))
      const y = int(from.element(instanceIndex.mul(2).add(1)))
      const read = textureLoad(map, ivec2(x, y))
      const to = instanceIndex.mul(4)
      into.element(to).assign(read.x)
      into.element(to.add(1)).assign(read.y)
      into.element(to.add(2)).assign(read.z)
      into.element(to.add(3)).assign(read.w)
    })
  })().compute(count)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  kernel.dispose()
  return at.map((_, k) => [
    values[4 * k]!,
    values[4 * k + 1]!,
    values[4 * k + 2]!,
    values[4 * k + 3]!,
  ])
}

const grid = (width: number, height: number): [number, number][] =>
  Array.from({ length: width * height }, (_, k): [number, number] => [
    k % width,
    Math.floor(k / width),
  ])

/* ------------------------------------------------------------------------- */

describe('every lever set', () => {
  it('draws its frames with no validation error and no cloud work thrown away', async () => {
    const sink = new RingBufferSink()
    const detach = logHub.addSink(sink)
    const before = gpu.reported().filter((m) => m.type === 'error').length
    try {
      set({})
      frames(2)
      for (const force of ['reset', 'cut', 'scrub', 'warp', 'fly'] as const) {
        set({ force })
        frames(2)
      }
      set({ force: 'none', composite: 'thin' })
      frames(2)
      set({ composite: 'residual' })
      frames(2)
      set({ composite: 'identity', stats: true })
      frames(2)
      set({ stats: false })
      await gpu.read(rig.target)
    } finally {
      detach()
    }
    const errors = gpu.reported().filter((m) => m.type === 'error')
    expect(errors.slice(before)).toEqual([])
    const thrown = sink
      .records()
      .filter((record) => record.scope === 'game.clouds')
    expect(thrown).toEqual([])
  }, 120_000)
})

describe.skipIf(!TIMESTAMPS)('the run order', () => {
  /** The cloud passes of a frame on the timeline, in encode order, with their counts a frame. */
  async function order(levers: Partial<CloudLevers>, settle = 50) {
    set(levers)
    frames(settle)
    const stop = installPassTimeline(gpu.renderer as WebGPURenderer)
    try {
      const timeline = passTimelineOf(gpu.renderer as WebGPURenderer)!
      const read = await timeline.measure(() => rig.frame(), 4)
      expect(read.dropped).toBe(0)
      return read.passes
        .filter(
          (pass) =>
            pass.label.startsWith('cloud ') ||
            pass.label === 'scene over clouds',
        )
        .map((pass) => [pass.label, pass.count] as const)
    } finally {
      stop()
    }
  }

  it('is §4.2’s inside pass B, the converging frame tracing once and the immediate four times', async () => {
    const steady = await order({ force: 'none' })
    // The volume before the sun grid that sums through it, each refreshing
    // a share of its slices a frame: the volume's budget of 8, the grid's 4.
    expect(steady).toEqual([
      ['scene over clouds', 1],
      ['cloud maps', 1],
      ['cloud clipmap', 1],
      ['cloud volume', 8],
      ['cloud sun grid', 4],
      ['cloud far atlas', 1],
      ['cloud depth', 1],
      ['cloud trace', 1],
      ['cloud history', 1],
    ])
    const immediate = await order({ force: 'reset' }, 2)
    expect(immediate.map(([label]) => label)).toEqual(
      steady.map(([label]) => label),
    )
    expect(immediate.find(([label]) => label === 'cloud trace')?.[1]).toBe(4)
    expect(immediate.find(([label]) => label === 'cloud history')?.[1]).toBe(4)
  }, 120_000)
})

describe('what the resources hold', () => {
  const BYTES: Readonly<Record<string, number>> = {
    r8unorm: 1,
    rg8unorm: 2,
    rgba8unorm: 4,
    r16float: 2,
    rgba16float: 8,
    r32float: 4,
    rgba32float: 16,
  }
  const backend = () =>
    gpu.renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }

  it('every texture one level, every resource’s bytes its GPU textures’', async () => {
    set({ force: 'none' })
    frames(4)
    await gpu.read(rig.target)
    for (const held of rig.system!.resources) {
      let sum = 0
      for (const map of held.textures()) {
        const texture = backend().get(map).texture
        expect(texture, `${held.name}: ${map.name}`).toBeDefined()
        expect(texture!.mipLevelCount, `${held.name}: ${map.name}`).toBe(1)
        const bytes = BYTES[texture!.format]
        expect(bytes, `${held.name}: ${texture!.format}`).toBeDefined()
        sum +=
          texture!.width *
          texture!.height *
          texture!.depthOrArrayLayers *
          bytes!
      }
      expect(held.bytes, held.name).toBe(sum)
    }
  }, 60_000)

  it('bakes cloud into the far atlas at every face’s center, past the clipmap’s reach', async () => {
    // Overcast covers the whole body: a face's center 90° from the eye is
    // 10,000 km out, where only the cube's synoptic coverage reaches.
    set({ force: 'none' })
    frames(50)
    const atlas = resource('farAtlas').textures()[0]!
    const centers = Array.from({ length: 6 }, (_, face): [number, number] => [
      face * 258 + 129,
      129,
    ])
    for (const [fraction] of await texels(atlas, centers))
      expect(fraction).toBeGreaterThan(0.5)
  }, 60_000)
})

describe('the whole chain over a depth step', () => {
  it('stops the trace’s rows under the ceiling at it, in true kilometers', async () => {
    set({ force: 'none' })
    frames(4)
    const trace = resource('trace')
    const [width, height] = rig.system!.report.extents.trace
    const aux = trace.textures()[1]!
    const ends = await texels(
      aux,
      grid(width, height).map(([i, j]) => [2 * i + 1, j]),
    )
    // Straight up the ceiling is 100 true meters off, and at a corner of
    // the 4:3 image √(1 + tan²30°·(a² + 1)) times that, 1.39; the R16F copy
    // truncates a step short.
    const ceiling = CEILING / COMPRESSION / 1000
    const halfTan = Math.tan(Math.PI / 6)
    const reach = Math.sqrt(1 + halfTan ** 2 * ((WIDTH / HEIGHT) ** 2 + 1))
    const step = 2 ** -10
    expect(height).toBe(12)
    grid(width, height).forEach(([, j], k) => {
      const end = ends[k]![0]
      // The row the ceiling's edge splits is the interleave's test, below.
      if (j < SPLIT_ROW) {
        expect(end).toBeGreaterThanOrEqual(ceiling * (1 - 2 * step))
        expect(end).toBeLessThanOrEqual(ceiling * reach * (1 + step))
      } else if (j > SPLIT_ROW) {
        // The span's end: overcast's top, 900 m over the eye straight up.
        expect(end).toBeGreaterThanOrEqual(0.9 * (1 - 2 * step))
        expect(end).toBeLessThanOrEqual(0.9 * reach * (1 + 2 * step))
      }
    })
  }, 60_000)

  it('writes each trace texel’s sample into the history pixel of its own phase', async () => {
    const PHASES = [
      [0, 0],
      [1, 1],
      [1, 0],
      [0, 1],
    ] as const
    set({ force: 'none' })
    for (let turn = 0; turn < 4; turn += 1) {
      rig.frame()
      const history = resource<CloudHistory>('history')
      const [phaseX, phaseY] = PHASES[history.report.phase]!
      const [width, height] = rig.system!.report.extents.trace
      const aux = resource('trace').textures()[1]!
      const texelsOf = grid(width, height)
      const traced = await texels(
        aux,
        texelsOf.map(([i, j]) => [2 * i + 1, j]),
      )
      const kept = await texels(
        history.outputs.depth,
        texelsOf.map(([i, j]) => [2 * i + phaseX, 2 * j + phaseY]),
      )
      // d_end, which the history keeps from the trace texel as it is.
      texelsOf.forEach((_, k) => {
        expect(kept[k]![0]).toBe(traced[k]![0])
      })
      // And it is the ray of the pixel the history put it in: on the split
      // row the history's phase names the ceiling's row (0) or the sky's
      // (1), and the trace's sample there is the same one's, a ninefold
      // difference in depth.
      texelsOf.forEach(([, j], k) => {
        if (j !== SPLIT_ROW) return
        const end = traced[k]![0]
        if (phaseY === 0) expect(end).toBeLessThan(0.2)
        else expect(end).toBeGreaterThan(0.85)
      })
    }
  }, 60_000)
})

describe('the radiance capture', () => {
  it('reads one frame for two asks, at the trace’s extent, cloud where the ceiling does not stop the trace', async () => {
    set({ force: 'none', lightTaps: 2 })
    frames(20)
    const first = rig.system!.captureRadiance()
    const second = rig.system!.captureRadiance()
    rig.frame()
    const [a, b] = await Promise.all([first, second])
    expect(a).not.toBeNull()
    expect(b).toBe(a)
    const [width, height] = rig.system!.report.extents.trace
    expect([a!.width, a!.height]).toEqual([width, height])
    expect(cloudRadianceDifference(a!, b!)).toMatchObject({ rmse: 0 })
    // Under the ceiling the trace stops 100 m up, under overcast's 300 m
    // base, and holds no cloud; over it every texel looks into the deck.
    const marked = (j: number): number =>
      a!.cloud.subarray(j * width, (j + 1) * width).reduce((s, v) => s + v, 0)
    expect(marked(0)).toBe(0)
    expect(marked(height - 1)).toBe(width)
    expect(a!.luminance.every(Number.isFinite)).toBe(true)
  }, 60_000)

  it('differs where the light differs: lightTaps 0 against 4', async () => {
    const capture = async (lightTaps: 0 | 4) => {
      set({ force: 'none', lightTaps })
      frames(20)
      const asked = rig.system!.captureRadiance()
      rig.frame()
      return (await asked)!
    }
    const none = await capture(0)
    const four = await capture(4)
    const difference = cloudRadianceDifference(none, four)
    expect(difference.texels).toBeGreaterThan(0)
    expect(difference.relative).toBeGreaterThan(0)
    set({ lightTaps: 2 })
  }, 60_000)

  /*
   * A held still with the jitter held traces one sample pattern every frame,
   * and the history takes each pixel's fresh sample every fourth frame, so the
   * frame repeats every four: two captures sixteen frames apart are one
   * image to the bit. Under the moving jitter the same two hold the history's
   * means of different samples.
   */
  it('reads a held still twice sixteen frames apart as one image with the jitter held, and as two with it moving', async () => {
    const pair = async (jitterFrame: number | null) => {
      set({ lightTaps: 2, jitterFrame })
      set({ force: 'reset' })
      rig.frame()
      set({ force: 'none' })
      frames(40)
      const first = rig.system!.captureRadiance()
      rig.frame()
      const a = (await first)!
      frames(15)
      const second = rig.system!.captureRadiance()
      rig.frame()
      return cloudRadianceDifference(a, (await second)!)
    }
    const held = await pair(0)
    const moving = await pair(null)
    expect(held.texels).toBeGreaterThan(0)
    expect(held.rmse).toBe(0)
    expect(moving.texels).toBeGreaterThan(0)
    expect(moving.rmse).toBeGreaterThan(0)
  }, 60_000)

  it('answers null on a frame that draws no clouds', async () => {
    set({ on: false })
    const asked = rig.system!.captureRadiance()
    rig.frame()
    await expect(asked).resolves.toBeNull()
    set({ on: true })
  }, 60_000)
})

describe('a warm-up that arrives after the caches are whole', () => {
  /*
   * A chain rebuilt mid-session draws its first frames while its warm-up is
   * still awaiting the noise, so the volume and the sun grid can be whole by
   * the time theirs runs. Each warms by drawing into its target's first
   * slice with the last bake's uniforms: a slice the record calls current.
   */
  it('leaves the volume and the sun grid owing what it drew over, and the next frames bake it', async () => {
    const late = cloudRig(gpu, WIDTH, HEIGHT, {
      levers: { scenario: 'overcast', on: true },
    })
    const owed = () => {
      const { volume, sunDepth } = late.system!.report.pending
      return { volume, sunDepth }
    }
    // Both caches fill under a per-frame budget; 400 frames is many times it.
    const settle = (): void => {
      late.frame()
      for (let k = 0; k < 400 && (owed().volume || owed().sunDepth); k += 1)
        late.frame()
    }
    try {
      settle()
      expect(owed()).toEqual({ volume: false, sunDepth: false })
      await late.system!.warm()
      expect(owed()).toEqual({ volume: true, sunDepth: true })
      settle()
      expect(owed()).toEqual({ volume: false, sunDepth: false })
      await gpu.read(late.target)
    } finally {
      late.dispose()
    }
  }, 120_000)
})
