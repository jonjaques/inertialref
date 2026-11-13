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
import {
  type CloudLevers,
  cloudLeversHash,
  DEFAULT_CLOUD_LEVERS,
} from './cloudLevers.ts'
import type { CloudResource } from './cloudNodes.ts'
import { CLOUD_SUN_GRID_LABEL, SUN_GRID_SIZE } from './cloudSunGrid.ts'
import type { CloudTrace } from './cloudTrace.ts'
import { type CloudRig, cloudRig } from './cloudSystemRig.ts'
import {
  CLOUD_VOLUME_HELD,
  CLOUD_VOLUME_LABEL,
  CLOUD_VOLUME_SLICES,
} from './cloudVolume.ts'
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
    levers: { weather: 'overcast' },
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
    // Under the rig's held clock nothing a steady frame draws has moved, so
    // the volume and the sun grid bake no slice (cloudSunSchedule.ts), and
    // the cube and the clipmap, which bake at the pace their field moves, a
    // face or an eighth of a level every few seconds at 1×, draw nothing
    // either (phase 1 design §4.7).
    expect(steady).toEqual([
      ['scene over clouds', 1],
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

  /** One frame's cloud passes by label, each its count. */
  async function passesOfOne(): Promise<ReadonlyMap<string, number>> {
    const stop = installPassTimeline(gpu.renderer as WebGPURenderer)
    try {
      const timeline = passTimelineOf(gpu.renderer as WebGPURenderer)!
      const read = await timeline.measure(() => rig.frame(), 1)
      expect(read.dropped).toBe(0)
      return new Map(read.passes.map((pass) => [pass.label, pass.count]))
    } finally {
      stop()
    }
  }

  /** `total` in pieces of `cap`, the last the remainder: a cap a frame. */
  const pieces = (total: number, cap: number): number[] =>
    Array.from({ length: Math.ceil(total / cap) }, (_, k) =>
      Math.min(cap, total - k * cap),
    )

  it('rebuilds after a field event by slices: the volume at the cap a frame, then the grid from the frame after, then nothing', async () => {
    set({ force: 'none' })
    frames(50)
    // Another weather is another field: every slice of both caches starts
    // over. The counts are cloudSunSchedule.test.ts's: two levels of 34
    // slices (the stack and a slice each side), the grid's 32, 8 a frame.
    const cap = DEFAULT_CLOUD_LEVERS.sunSlices
    const stack = CLOUD_VOLUME_SLICES + 2
    const volume: number[] = []
    const grid: number[] = []
    set({ weather: 'stratocumulus' })
    try {
      for (let n = 0; n < 60; n += 1) {
        const passes = await passesOfOne()
        volume.push(passes.get(CLOUD_VOLUME_LABEL) ?? 0)
        grid.push(passes.get(CLOUD_SUN_GRID_LABEL) ?? 0)
      }
    } finally {
      set({ weather: 'overcast' })
      frames(60)
    }
    // Frames the maps owe work bake nothing; the rebuild starts after them.
    expect(volume.filter((n) => n > 0)).toEqual(
      pieces(CLOUD_VOLUME_HELD.length * stack, cap),
    )
    expect(grid.filter((n) => n > 0)).toEqual(pieces(SUN_GRID_SIZE[2], cap))
    const lastVolume = volume.findLastIndex((n) => n > 0)
    const firstGrid = grid.findIndex((n) => n > 0)
    expect(firstGrid).toBe(lastVolume + 1)
    // Whole again, under a held clock: no slice of either.
    const lastGrid = grid.findLastIndex((n) => n > 0)
    expect(volume.slice(lastGrid + 1).every((n) => n === 0)).toBe(true)
    expect(grid.slice(lastGrid + 1).every((n) => n === 0)).toBe(true)
  }, 120_000)
})

describe('what the resources hold', () => {
  const BYTES: Readonly<Record<string, number>> = {
    r8unorm: 1,
    rg8unorm: 2,
    rgba8unorm: 4,
    r16float: 2,
    rg16float: 4,
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

describe('what the device is asked for', () => {
  /*
   * The test above sums each resource's own list, so a texture left off a
   * list is a texture it cannot see, and it reads no buffer at all. This one
   * asks the device: every `createTexture` and `createBuffer` over a
   * chain's whole life, a chain built with the clouds against one built
   * without, the same frames drawn through both. What the clouds add is
   * the difference, and it is held to the declaration to the byte.
   *
   * On a device of its own, so the chain with the clouds is that device's
   * first: a second chain on one device shares the composite's warm-up
   * target and the air's shared stand-ins with the first, and adds 16
   * undeclared bytes where the first adds 1,640.
   */
  let session: GpuSession
  let bare: Awaited<ReturnType<typeof life>>
  let clouded: Awaited<ReturnType<typeof life>>

  beforeAll(async () => {
    session = await openGpu(WIDTH, HEIGHT)
    bare = await life(false)
    clouded = await life(true)
  }, 240_000)

  afterAll(() => {
    session?.dispose()
  })

  const TEXEL_BYTES: Readonly<Record<string, number>> = {
    r8unorm: 1,
    rg8unorm: 2,
    rgba8unorm: 4,
    r16float: 2,
    rg16float: 4,
    rgba16float: 8,
    r32float: 4,
    rgba32float: 16,
    depth32float: 4,
  }

  interface Asked {
    readonly made: object
    /** `label|width×height×depth format ×samples`: what tells one request from another. */
    readonly kind: string
    readonly bytes: number
    readonly usage: number
    live: boolean
  }

  /** Every texture and buffer the device is asked for while `work` runs, and whether each is still alive after it. */
  async function asked<T>(
    work: (seen: () => { textures: Asked[]; buffers: Asked[] }) => Promise<T>,
  ): Promise<T> {
    const device = (
      session.renderer.backend as unknown as { device: GPUDevice }
    ).device
    const textures: Asked[] = []
    const buffers: Asked[] = []
    const createTexture = device.createTexture.bind(device)
    const createBuffer = device.createBuffer.bind(device)
    const watch = <M extends { destroy(): void }>(
      list: Asked[],
      made: M,
      rest: Omit<Asked, 'made' | 'live'>,
    ): M => {
      const record: Asked = { made, live: true, ...rest }
      list.push(record)
      const destroy = made.destroy.bind(made)
      made.destroy = () => {
        record.live = false
        destroy()
      }
      return made
    }
    device.createTexture = (descriptor) => {
      const size = descriptor.size as
        | readonly number[]
        | { width: number; height?: number; depthOrArrayLayers?: number }
      const [width = 1, height = 1, depth = 1] = Array.isArray(size)
        ? (size as readonly number[])
        : [
            (size as { width: number }).width,
            (size as { height?: number }).height,
            (size as { depthOrArrayLayers?: number }).depthOrArrayLayers,
          ]
      const samples = descriptor.sampleCount ?? 1
      const texel = TEXEL_BYTES[descriptor.format]
      // A format the table does not know is counted as nothing and named,
      // so the comparison below fails on its kind rather than on a NaN.
      return watch(textures, createTexture(descriptor), {
        kind: `${descriptor.label ?? ''}|${width}×${height}×${depth} ${descriptor.format} ×${samples}${texel === undefined ? ' (unknown format)' : ''}`,
        bytes: width * height * depth * samples * (texel ?? 0),
        usage: descriptor.usage,
      })
    }
    device.createBuffer = (descriptor) =>
      watch(buffers, createBuffer(descriptor), {
        kind: descriptor.label ?? '',
        bytes: descriptor.size,
        usage: descriptor.usage,
      })
    try {
      return await work(() => ({ textures, buffers }))
    } finally {
      device.createTexture = createTexture
      device.createBuffer = createBuffer
    }
  }

  /** How many of each kind, so two chains' requests can be taken apart. */
  const tally = (rows: readonly Asked[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const row of rows)
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    return counts
  }

  /** A chain's life: built, warmed, drawn to a settled field, then every lever that allocates. */
  async function life(clouds: boolean) {
    return asked(async (seen) => {
      const chain = cloudRig(session, WIDTH, HEIGHT, {
        ceiling: CEILING,
        levers: { weather: 'overcast' },
        clouds,
      })
      try {
        await chain.sensor.warm()
        await chain.system?.warm()
        chain.levers = { ...chain.levers, on: true }
        for (let k = 0; k < 60; k += 1) chain.frame()
        await session.read(chain.target)
        if (chain.system !== null) {
          // The radiance meter's buffer, the step counters' and the
          // residual's are each made at first use.
          const capture = chain.system.captureRadiance()
          chain.frame()
          await capture
          chain.levers = { ...chain.levers, stats: true }
          for (let k = 0; k < 4; k += 1) chain.frame()
          chain.levers = { ...chain.levers, composite: 'residual' }
          for (let k = 0; k < 4; k += 1) chain.frame()
          await session.read(chain.target)
        }
        const report = chain.system?.report ?? null
        const held = new Set<object>()
        if (chain.system !== null) {
          const backend = session.renderer.backend as unknown as {
            get(texture: object): { texture?: GPUTexture }
          }
          const { resources, field } = chain.system
          for (const map of [
            ...resources.flatMap((resource) => resource.textures()),
            // The profile table is declared by its size, on no resource's list.
            field.profile.texture,
          ]) {
            const texture = backend.get(map).texture
            if (texture !== undefined) held.add(texture)
          }
        }
        const { textures, buffers } = seen()
        return {
          report,
          held,
          resources: chain.system?.resources.map((one) => one.name) ?? [],
          textures: textures.filter((row) => row.live),
          // A readback's staging buffer is mapped and freed; a buffer
          // still alive is one the chain keeps.
          buffers: buffers.filter((row) => row.live),
          extent: report?.extents.trace ?? [0, 0],
        }
      } finally {
        chain.dispose()
      }
    })
  }

  const STORAGE = 0x80
  const sum = (rows: readonly Asked[]): number =>
    rows.reduce((total, row) => total + row.bytes, 0)

  it('holds the declared bytes to the textures the clouds add to a chain, to the byte', () => {
    const declared = clouded.report!.bytes.total
    // Every texture a resource lists is one the device made, at the bytes
    // the device was asked for, multisampling and layers included.
    const listed = clouded.textures.filter((row) => clouded.held.has(row.made))
    expect(listed).toHaveLength(clouded.held.size)
    expect(sum(listed)).toBe(declared)

    // What is left is the sensor's own, which the bare chain made too, and
    // what the clouds add without declaring. Taken apart by kind.
    const sensor = tally(bare.textures)
    const unlisted = new Map<string, number>()
    for (const [kind, count] of tally(
      clouded.textures.filter((row) => !clouded.held.has(row.made)),
    )) {
      const extra = count - (sensor.get(kind) ?? 0)
      if (extra !== 0) unlisted.set(kind, extra)
    }
    for (const kind of sensor.keys())
      expect(tally(clouded.textures).has(kind), kind).toBe(true)
    /*
     * 1,640 bytes the clouds add and do not declare, each named: the 4 × 4
     * scene target the composite's warm-up draws into and keeps, with its
     * multisampled twins (1,616 B); the air's four 1 × 1 table stand-ins,
     * the shared pair and the second body's own (16 B); and one 1 × 1
     * half-float stand-in a meter reads the scene through (8 B). A texture
     * a resource leaves off its list is a new line here.
     */
    expect(Object.fromEntries(unlisted)).toEqual({
      'output|4×4×1 rgba16float ×1': 1,
      'output-msaa|4×4×1 rgba16float ×4': 1,
      'motion|4×4×1 rgba16float ×1': 1,
      'motion-msaa|4×4×1 rgba16float ×4': 1,
      'meterMask|4×4×1 r8unorm ×1': 1,
      'meterMask-msaa|4×4×1 r8unorm ×4': 1,
      '|4×4×1 depth32float ×4': 1,
      '|1×1×1 rgba8unorm ×1': 4,
      '|1×1×1 rgba16float ×1': 1,
    })
    expect(sum(clouded.textures) - sum(bare.textures) - declared).toBe(1640)
  })

  it('names the storage buffers the clouds keep, which the declaration leaves out', () => {
    const storage = (rows: readonly Asked[]): number[] =>
      rows
        .filter((row) => (row.usage & STORAGE) !== 0)
        .map((row) => row.bytes)
        .sort((a, b) => a - b)
    const kept = storage(clouded.buffers)
    for (const bytes of storage(bare.buffers)) {
      const at = kept.indexOf(bytes)
      expect(at, `the sensor's own ${bytes} B`).toBeGreaterThanOrEqual(0)
      kept.splice(at, 1)
    }
    const [width, height] = clouded.extent
    /*
     * The history's frame counter, the trace's twelve counters, the
     * residual meter's histograms, the radiance meter's two floats a
     * trace texel, which is 1.04 MB at 1080p's 480 × 270, and the trace's
     * longest ray a batch of 32, 16,384 of them for each of the immediate
     * regime's four dispatches. No buffer is in `bytes`:
     * the report declares textures.
     */
    expect(kept).toEqual([4, 48, 1036, width * height * 8, 262_144])
    expect(width * height * 8).toBe(1536)
    // Every key of the declaration is a resource's or the profile's.
    expect(Object.keys(clouded.report!.bytes).sort()).toEqual(
      ['profile', 'total', ...clouded.resources].sort(),
    )
  })
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

describe('the report’s levers', () => {
  it('carries the hash of the levers the frame drew with, which a steering lever does not move', () => {
    set({ force: 'none', stats: false, lightTaps: 4 })
    rig.frame()
    const steady = rig.system!.report
    expect(steady.leversHash).toBe(cloudLeversHash(rig.levers))
    expect(steady.leversHash).toMatch(/^[0-9a-f]{8}$/)
    expect(steady.levers).toMatchObject({ weather: 'overcast', lightTaps: 4 })
    // A forced row and its steady row are one picture's levers.
    set({ force: 'cut', stats: true })
    rig.frame()
    expect(rig.system!.report.leversHash).toBe(steady.leversHash)
    // A shipped lever is another set.
    set({ force: 'none', stats: false, lightTaps: 2 })
    rig.frame()
    expect(rig.system!.report.leversHash).not.toBe(steady.leversHash)
    set({ lightTaps: 4 })
  })
})

describe('the front handle', () => {
  it('holds this frame’s trace and the numbers beside it while the clouds draw, and no trace on a frame they do not', () => {
    const front = rig.system!.front
    const trace = resource<CloudTrace>('trace')
    set({ force: 'none' })
    frames(2)
    expect(front.textures()).toBe(trace.outputs)
    const [width, height] = rig.system!.report.extents.trace
    expect(front.screen.traceSize.value.toArray()).toEqual([width, height])
    const day = rig.system!.field.uniforms.served.dayColor.value
    expect(front.screen.dayColor.value.equals(day)).toBe(true)
    // Its own uniforms, copied into: a material that built over them keeps
    // reading this frame's numbers when the chain behind them is another.
    expect(front.screen.dayColor.value).not.toBe(day)
    set({ on: false })
    rig.frame()
    expect(front.textures()).toBeNull()
    set({ on: true })
    rig.frame()
    expect(front.textures()).toBe(trace.outputs)
  })
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
      levers: { weather: 'overcast', on: true },
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

describe('a frame whose cloud work throws', () => {
  /*
   * The composite reads the history under the frame's own camera, so a
   * trace that throws after converged frames leaves it holding their cloud,
   * and a composite left live draws that cloud on a frame that traced none.
   * The camera here holds still, so the stale cloud lands exactly where the
   * last good frame put it and the failed frame would read as a clouded one.
   */
  it('composites none of the history it abandoned, captures nothing, and draws cloud again from a reset', async () => {
    const trace = resource<CloudTrace>('trace')
    const history = resource<CloudHistory>('history')
    const sink = new RingBufferSink()
    const detach = logHub.addSink(sink)
    /** The largest difference in any channel of any texel, over the larger image's peak. */
    const apart = (
      a: Float32Array | Uint8Array,
      b: Float32Array | Uint8Array,
    ) => {
      let peak = 0
      let worst = 0
      for (let i = 0; i < a.length; i += 1) {
        peak = Math.max(peak, Math.abs(a[i]!), Math.abs(b[i]!))
        worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
      }
      return worst / peak
    }
    const image = async () => (await gpu.read(rig.target)).data.slice()
    const { render, dispatchPhase } = trace
    try {
      set({ on: false })
      rig.frame()
      const plain = await image()
      set({ on: true, force: 'none', composite: 'identity', lightTaps: 2 })
      frames(20)
      const clouded = await image()
      // The control: the deck over the image's top half is in the frame.
      expect(apart(clouded, plain)).toBeGreaterThan(0.05)

      const fail = (): never => {
        throw new Error('the trace failed')
      }
      trace.render = fail
      trace.dispatchPhase = fail
      const resets = history.report.resets
      const asked = rig.system!.captureRadiance()
      rig.frame()
      trace.render = render
      trace.dispatchPhase = dispatchPhase
      // The frame is the clouds-off frame: the composite drew nothing, and
      // nothing drawn over it is handed the trace it abandoned.
      expect(apart(await image(), plain)).toBeLessThan(1e-3)
      expect(rig.system!.front.textures()).toBeNull()
      await expect(asked).resolves.toBeNull()
      expect(
        sink
          .records()
          .filter((record) => record.scope === 'game.clouds')
          .map((record) => record.level),
      ).toEqual(['warn'])

      // The next frame keeps none of the history, and the cloud comes back.
      rig.frame()
      expect(history.report.resets).toBe(resets + 1)
      frames(20)
      expect(apart(await image(), plain)).toBeGreaterThan(0.05)
    } finally {
      trace.render = render
      trace.dispatchPhase = dispatchPhase
      detach()
    }
  }, 120_000)
})
