import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Node,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn,
  If,
  instanceIndex,
  storage,
  texture3D,
  textureLoad,
  uint,
  vec4,
} from 'three/tsl'
import {
  baseNoise,
  baseNoiseWide,
  curlNoise,
  detailNoise,
} from '@inertialref/rendering'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget } from './cloudNodes.ts'
import type { CloudFrame } from './cloudFrame.ts'
import {
  CLOUD_BASE_CELLS,
  CLOUD_BASE_TEXELS,
  CLOUD_CURL_TEXELS,
  CLOUD_DETAIL_TEXELS,
  CloudNoise,
} from './cloudNoise.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The noise bake against `weatherNoise.ts` (§3.8): every texel the GPU wrote
 * is the CPU function at that texel's center, to 8-bit storage's step. A
 * texel is read back with `textureLoad`, so nothing filters it, and a read
 * through the field's own nodes then shows the texture wrapping at its
 * period with no seam.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let noise: CloudNoise

/**
 * An 8-bit texel's step, plus float32's distance from the float64
 * reference: a few parts in 10⁷ of a value in [0, 1], bounded at 10⁻⁵.
 */
const BYTE_BOUND = 1 / 255 + 1e-5
const TEXELS = 1000

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  noise = new CloudNoise()
  await noise.warm(renderer)
})

afterAll(() => {
  noise.dispose()
  gpu.dispose()
})

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

/** Texels at integer coordinates, `textureLoad`ed by one thread each: RGBA a texel. */
async function loadTexels(
  map: Texture,
  kind: '2d' | '3d',
  at: readonly (readonly [number, number, number])[],
): Promise<Float32Array> {
  const count = at.length
  const input = new StorageBufferAttribute(
    new Int32Array(at.flatMap(([x, y, z]) => [x, y, z, 0])),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
  const coordinates = storage(input, 'ivec4', count)
  const into = storage(output, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const c = coordinates.element(instanceIndex)
      const read =
        kind === '3d' ? texture3D(map).load(c.xyz) : textureLoad(map, c.xy)
      into.element(instanceIndex).assign(read)
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** Values of `read` at each point, one thread each. */
async function readNodes(
  points: readonly (readonly [number, number, number])[],
  read: (point: Node<'vec3'>) => Node<'vec4'>,
): Promise<Float32Array> {
  const count = points.length
  const input = new StorageBufferAttribute(
    new Float32Array(points.flatMap(([x, y, z]) => [x, y, z, 0])),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
  const from = storage(input, 'vec4', count)
  const into = storage(output, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      into.element(instanceIndex).assign(read(from.element(instanceIndex).xyz))
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

function randomTexels(
  size: number,
  depth: number,
  seed: number,
): [number, number, number][] {
  const next = draws(seed)
  const at: [number, number, number][] = []
  for (let k = 0; k < TEXELS; k += 1)
    at.push([
      Math.floor(next() * size),
      Math.floor(next() * size),
      Math.floor(next() * depth),
    ])
  // The corners, where a wrap or a flip would show first.
  at.push([0, 0, 0], [size - 1, size - 1, Math.max(0, depth - 1)])
  return at
}

const center = (i: number, perUnit: number): number => (i + 0.5) / perUnit
const BASE_PER_CELL = CLOUD_BASE_TEXELS / CLOUD_BASE_CELLS
const DETAIL_PER_CELL = CLOUD_DETAIL_TEXELS / 4

const texture = (name: string): Texture => {
  const found = noise.textures().find((t) => t.name === name)
  if (found === undefined) throw new Error(`no texture named ${name}`)
  return found
}

const budget: CloudBudget = {
  slices: 0,
  tiles: 0,
  jump: false,
  sunTexelSteps: 0,
}
const frameWith = (noiseFormat: 'r8' | 'rgba8'): CloudFrame =>
  ({ levers: { ...DEFAULT_CLOUD_LEVERS, noiseFormat } }) as CloudFrame

describe('the baked noise is weatherNoise at every texel center', () => {
  it('the base: R8, the Perlin–Worley shape', async () => {
    const at = randomTexels(CLOUD_BASE_TEXELS, CLOUD_BASE_TEXELS, 1)
    const read = await loadTexels(texture('cloud base noise'), '3d', at)
    let worst = 0
    at.forEach(([i, j, k], n) => {
      const expected = baseNoise({
        x: center(i, BASE_PER_CELL),
        y: center(j, BASE_PER_CELL),
        z: center(k, BASE_PER_CELL),
      })
      worst = Math.max(worst, Math.abs(read[n * 4]! - expected))
    })
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
  })

  it('the detail: R8 Worley, eight texels a cell', async () => {
    const at = randomTexels(CLOUD_DETAIL_TEXELS, CLOUD_DETAIL_TEXELS, 2)
    const read = await loadTexels(texture('cloud detail noise'), '3d', at)
    let worst = 0
    at.forEach(([i, j, k], n) => {
      const expected = detailNoise({
        x: center(i, DETAIL_PER_CELL),
        y: center(j, DETAIL_PER_CELL),
        z: center(k, DETAIL_PER_CELL),
      })
      worst = Math.max(worst, Math.abs(read[n * 4]! - expected))
    })
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
  })

  it('the curl: RG8, stored as ½ + ½·curl, the unit square across 128 texels', async () => {
    const at = randomTexels(CLOUD_CURL_TEXELS, 1, 3)
    const read = await loadTexels(texture('cloud curl'), '2d', at)
    let worst = 0
    at.forEach(([i, j], n) => {
      const [cx, cy] = curlNoise(
        center(i, CLOUD_CURL_TEXELS),
        center(j, CLOUD_CURL_TEXELS),
      )
      worst = Math.max(
        worst,
        Math.abs(read[n * 4]! - (0.5 + 0.5 * cx)),
        Math.abs(read[n * 4 + 1]! - (0.5 + 0.5 * cy)),
      )
    })
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
  })
})

describe('the field reads it through its nodes', () => {
  it('wrapping at the period: a read across the seam blends the last texel with the first', async () => {
    // Half a texel past the last texel's center on x, at texel centers on y
    // and z: the filter takes the last texel and the first equally, and both
    // are the CPU function's values a period apart.
    const y = center(37, BASE_PER_CELL)
    const z = center(90, BASE_PER_CELL)
    const seam = CLOUD_BASE_CELLS
    const points: [number, number, number][] = [
      [seam, y, z],
      [0, y, z],
      [seam * 3, y, z],
    ]
    const read = await readNodes(points, (p) => vec4(noise.nodes.base(p)))
    const last = baseNoise({ x: center(127, BASE_PER_CELL), y, z })
    const first = baseNoise({ x: center(0, BASE_PER_CELL), y, z })
    for (let n = 0; n < points.length; n += 1)
      expect(Math.abs(read[n * 4]! - (last + first) / 2)).toBeLessThanOrEqual(
        BYTE_BOUND,
      )

    // And along the slices, which wrap by the texture's own R axis.
    const x = center(5, BASE_PER_CELL)
    const slices = await readNodes(
      [
        [x, y, seam],
        [x, y, -seam],
      ],
      (p) => vec4(noise.nodes.base(p)),
    )
    const top = baseNoise({ x, y, z: center(127, BASE_PER_CELL) })
    const bottom = baseNoise({ x, y, z: center(0, BASE_PER_CELL) })
    for (let n = 0; n < 2; n += 1)
      expect(Math.abs(slices[n * 4]! - (top + bottom) / 2)).toBeLessThanOrEqual(
        BYTE_BOUND,
      )

    const detail = await readNodes(
      [[center(3, DETAIL_PER_CELL), center(20, DETAIL_PER_CELL), 4]],
      (p) => vec4(noise.nodes.detail(p)),
    )
    const near = detailNoise({
      x: center(3, DETAIL_PER_CELL),
      y: center(20, DETAIL_PER_CELL),
      z: center(31, DETAIL_PER_CELL),
    })
    const far = detailNoise({
      x: center(3, DETAIL_PER_CELL),
      y: center(20, DETAIL_PER_CELL),
      z: center(0, DETAIL_PER_CELL),
    })
    expect(Math.abs(detail[0]! - (near + far) / 2)).toBeLessThanOrEqual(
      BYTE_BOUND,
    )

    const curl = await readNodes([[1, center(64, 128), 0]], (p) =>
      vec4(noise.nodes.curl(p.xy), 0, 0),
    )
    const [ax] = curlNoise(center(127, 128), center(64, 128))
    const [bx] = curlNoise(center(0, 128), center(64, 128))
    // Decoded as 2v − 1, so two 8-bit steps.
    expect(Math.abs(curl[0]! - (ax + bx) / 2)).toBeLessThanOrEqual(
      2 * BYTE_BOUND,
    )
  })
})

describe('the sweep’s RGBA8 base', () => {
  it('waits for a frame that selects it, then bakes base and three octaves into the same binding', async () => {
    const at = randomTexels(CLOUD_BASE_TEXELS, CLOUD_BASE_TEXELS, 4)
    const points = at.map(
      ([i, j, k]) =>
        [
          center(i, BASE_PER_CELL),
          center(j, BASE_PER_CELL),
          center(k, BASE_PER_CELL),
        ] as const,
    )
    const narrow = await readNodes(points.slice(0, 8), (p) =>
      noise.nodes.baseWide(p),
    )
    // R8 has no other channels: WebGPU reads them as (r, 0, 0, 1).
    expect([narrow[1], narrow[2], narrow[3]]).toEqual([0, 0, 1])

    const pipelines = gpu.pipelinesBuilt()
    noise.setFormat('rgba8')
    expect(noise.pending).toBe(true)
    noise.render(renderer, frameWith('rgba8'), budget)
    expect(noise.pending).toBe(false)
    // Warmed against its 1 × 1 × 1 stand-in: the real bake builds nothing.
    expect(gpu.pipelinesBuilt()).toBe(pipelines)

    const wide = await loadTexels(texture('cloud base noise, sweep'), '3d', at)
    const through = await readNodes(points, (p) => noise.nodes.baseWide(p))
    let worst = 0
    let channel = 0
    points.forEach(([x, y, z], n) => {
      const expected = baseNoiseWide({ x, y, z })
      for (let c = 0; c < 4; c += 1) {
        worst = Math.max(worst, Math.abs(wide[n * 4 + c]! - expected[c]!))
        // The node reads the swapped texture at a texel center, so exactly it.
        channel = Math.max(
          channel,
          Math.abs(through[n * 4 + c]! - wide[n * 4 + c]!),
        )
      }
    })
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
    expect(channel).toBeLessThanOrEqual(1e-6)

    noise.render(renderer, frameWith('r8'), budget)
    const back = await readNodes(points.slice(0, 8), (p) =>
      noise.nodes.baseWide(p),
    )
    expect([back[1], back[2], back[3]]).toEqual([0, 0, 1])
  })
})

describe('what it holds', () => {
  it('one level a texture, and the bytes declared are the textures’', () => {
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }
    let bytes = 0
    for (const held of noise.textures()) {
      const gpuTexture = backend.get(held).texture
      expect(gpuTexture, held.name).toBeDefined()
      expect(gpuTexture!.mipLevelCount, held.name).toBe(1)
      const channels =
        gpuTexture!.format === 'r8unorm'
          ? 1
          : gpuTexture!.format === 'rg8unorm'
            ? 2
            : 4
      bytes +=
        gpuTexture!.width *
        gpuTexture!.height *
        gpuTexture!.depthOrArrayLayers *
        channels
    }
    expect(noise.bytes).toBe(bytes)
    // 2.10 MB of base, 8.39 MB of the sweep's, 32 KB each of detail and curl.
    expect(noise.bytes).toBe(128 ** 3 * 5 + 32 ** 3 + 128 ** 2 * 2)
  })

  it('a fresh noise holds nothing before it warms, and nothing once disposed', async () => {
    const fresh = new CloudNoise()
    expect(fresh.bytes).toBe(0)
    expect(fresh.textures()).toEqual([])
    expect(fresh.pending).toBe(false)
    await fresh.warm(renderer)
    // The sweep's stand-in is warmed at 1 × 1 × 1, and the rest are baked.
    expect(fresh.bytes).toBe(128 ** 3 + 4 + 32 ** 3 + 128 ** 2 * 2)
    fresh.dispose()
    expect(fresh.bytes).toBe(0)
    expect(fresh.textures()).toEqual([])
  })

  it('a noise disposed while it warms bakes nothing when the warm-up settles', async () => {
    // StrictMode builds, warms and disposes a system before it builds the
    // one it keeps: the first one's bake would draw 161 slices into targets
    // already disposed, which makes their textures again with nothing left
    // to dispose them.
    const device = (renderer.backend as unknown as { device: GPUDevice }).device
    const fresh = new CloudNoise()
    const warmed = fresh.warm(renderer)
    fresh.dispose()
    let passes = 0
    const create = device.createCommandEncoder.bind(device)
    device.createCommandEncoder = (descriptor) => {
      const encoder = create(descriptor)
      const begin = encoder.beginRenderPass.bind(encoder)
      encoder.beginRenderPass = (pass) => {
        passes += 1
        return begin(pass)
      }
      return encoder
    }
    try {
      await warmed
    } finally {
      device.createCommandEncoder = create
    }
    expect(passes).toBe(0)
  })
})
