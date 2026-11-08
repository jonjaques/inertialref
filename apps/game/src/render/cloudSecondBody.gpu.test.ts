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
import { FAR_HEIGHT, FAR_WIDTH } from './cloudFarAtlas.ts'
import type { CloudLevers } from './cloudLevers.ts'
import {
  type CloudRig,
  cloudRig,
  LOOKING_UP,
  RIG_EARTH_RADIUS,
  RIG_FOV,
  RIG_TWIN,
} from './cloudSystemRig.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * Two clouded bodies through the whole system: the second body's far
 * field, baked from the analytic medium because it has no weather cube,
 * and the composite's thin second-body path, which draws it behind the
 * served body's cloud. The modules' own tests cover each with stand-ins;
 * this is the chain they meet in.
 *
 * Earth is served, the eye 100 m up in fog (0–150 m) looking straight up;
 * the twin, Earth's own record under another address, stands overhead
 * 20,000 km away, its disk 18.6° in radius. The sun is 30° under the eye's
 * horizon, so the served fog holds no direct light, and lights the twin's
 * face toward the eye at a phase of 60°: whatever the twin's disk gains, the
 * twin's cloud drew.
 */

const WIDTH = 64
const HEIGHT = 48
const TWIN_DISTANCE = 20_000_000
const TIMESTAMPS = await adapterOffers('timestamp-query')
/** The twin's disk, radians from the image's middle: its angular radius. */
const DISK = Math.asin(RIG_EARTH_RADIUS / TWIN_DISTANCE)
const FAR_SPAN = 258
/** RGBA8. */
const ATLAS_TEXEL_BYTES = 4

let gpu: GpuSession
let rig: CloudRig

beforeAll(async () => {
  gpu = await openGpu(WIDTH, HEIGHT)
  rig = cloudRig(gpu, WIDTH, HEIGHT, {
    looking: LOOKING_UP,
    air: true,
    sun: { x: 0.3, y: -0.5, z: 0.8 },
    twin: { distance: TWIN_DISTANCE, toward: { x: 0, y: 1, z: 0 } },
    levers: { scenario: 'fog' },
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

/** Texels of a texture by `textureLoad`: RGBA, in order. */
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

/** The frame's mean luminance inside the twin's disk and well outside it. */
async function disk(): Promise<{ inside: number; outside: number }> {
  const image = await gpu.read(rig.target)
  const halfTan = Math.tan(((RIG_FOV / 2) * Math.PI) / 180)
  let inside = 0
  let insideCount = 0
  let outside = 0
  let outsideCount = 0
  for (let y = 0; y < HEIGHT; y += 1)
    for (let x = 0; x < WIDTH; x += 1) {
      const sx = ((2 * (x + 0.5)) / WIDTH - 1) * halfTan * (WIDTH / HEIGHT)
      const sy = (1 - (2 * (y + 0.5)) / HEIGHT) * halfTan
      const angle = Math.atan(Math.hypot(sx, sy))
      const [r, g, b] = image.at(x, y)
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
      // A margin either side of the limb, where a pixel's footprint straddles it.
      if (angle < 0.8 * DISK) {
        inside += luminance
        insideCount += 1
      } else if (angle > 1.2 * DISK) {
        outside += luminance
        outsideCount += 1
      }
    }
  return { inside: inside / insideCount, outside: outside / outsideCount }
}

describe('a second clouded body', () => {
  it('is served as the second, and its atlas bakes cover from the analytic medium past every face’s middle', async () => {
    set({ placement: 'split', second: null })
    frames(60)
    const report = rig.system!.report
    expect(report.served).toBe('g:milky-way/s:SOL/b:2')
    expect(report.second).toBe(RIG_TWIN)
    expect(report.pending.far).toBe(false)
    expect(report.bytes.farSecond).toBe(
      FAR_WIDTH * FAR_HEIGHT * ATLAS_TEXEL_BYTES,
    )
    // Fog covers the whole body: every face's middle holds cloud.
    const atlas = rig
      .system!.resources.find((held) => held.name === 'farSecond')!
      .textures()[0]!
    const centers = Array.from({ length: 6 }, (_, face): [number, number] => [
      face * FAR_SPAN + 129,
      129,
    ])
    for (const [fraction] of await texels(atlas, centers))
      expect(fraction).toBeGreaterThan(0.5)
  }, 60_000)

  it('draws its cloud over its disk by the thin form, through the served cloud, and nothing past it', async () => {
    set({ placement: 'split', second: 'g:milky-way/s:SOL/b:nowhere' })
    frames(60)
    expect(rig.system!.report.second).toBeNull()
    const without = await disk()
    set({ second: null })
    frames(60)
    expect(rig.system!.report.second).toBe(RIG_TWIN)
    const twin = await disk()
    // The sun is under the eye's horizon: the disk gains only the light the
    // twin's lit cloud sends through the served fog.
    expect(twin.inside).toBeGreaterThan(without.inside * 1.5)
    expect(twin.inside - without.inside).toBeGreaterThan(
      20 * Math.abs(twin.outside - without.outside),
    )
  }, 60_000)

  it.skipIf(!TIMESTAMPS)(
    'bakes a block of its atlas a frame, as `cloud far second`',
    async () => {
      set({ placement: 'split', second: null })
      frames(10)
      const stop = installPassTimeline(gpu.renderer as WebGPURenderer)
      try {
        const timeline = passTimelineOf(gpu.renderer as WebGPURenderer)!
        const read = await timeline.measure(() => rig.frame(), 4)
        expect(read.dropped).toBe(0)
        const second = read.passes.find(
          (pass) => pass.label === 'cloud far second',
        )
        expect(second?.count).toBe(1)
      } finally {
        stop()
      }
    },
    60_000,
  )
})
