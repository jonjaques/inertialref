import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Node,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import { Fn, If, instanceIndex, storage, textureLoad, uint } from 'three/tsl'
import {
  CUBE_FACES,
  type CubeFace,
  cubeDirection,
  cubeTexelCoordinate,
  periodIndex,
  scenarioCoverage,
  WEATHER_SCENARIOS,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import type { CloudFrame } from './cloudFrame.ts'
import {
  CLOUD_CUBE_COLUMNS,
  CLOUD_CUBE_GUTTER,
  CLOUD_CUBE_TILE,
  CloudMaps,
  scenarioChannels,
} from './cloudMaps.ts'
import type { CloudBudget } from './cloudNodes.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The weather cube against `scenarioCoverage` (§3.9): every atlas texel, the
 * gutters included, is the placeholder's coverage at that texel's direction
 * to 8-bit storage's step, so a read near an edge never mixes two faces; one
 * MRT quad writes a face tile's four textures; and the bake builds no
 * pipeline past its warm-up.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice

/** An 8-bit texel's step, plus float32 against float64 in the direction's atan: under 10⁻⁵. */
const BYTE_BOUND = 1 / 255 + 1e-5
const SPAN = CLOUD_CUBE_TILE + 2 * CLOUD_CUBE_GUTTER
/** An instant whose pattern period is not the first: the blobs' hash sees a nonzero period. */
const TIME = 7.3e9

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  device = (renderer.backend as unknown as { device: GPUDevice }).device
})

afterAll(() => {
  gpu.dispose()
})

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

const budget: CloudBudget = {
  slices: 0,
  tiles: 0,
  jump: false,
  sunTexelSteps: 0,
}

/**
 * What the maps read of a frame, and what the uniform bundle carries for
 * them: the layers' coverage and the pattern period, as `write` copies them.
 */
function frameFor(
  uniforms: CloudUniforms,
  scenario: WeatherScenario,
  eye: Vec3,
  jump = false,
): CloudFrame {
  const at = (k: number) => scenario.layers[k]?.coverage ?? 0
  uniforms.layers.coverage.value.set(at(0), at(1), at(2))
  const period = periodIndex(TIME, scenario.patternPeriod)
  uniforms.period.value.set(period[0], period[1])
  return {
    scenario,
    period,
    jump,
    served: { eye },
  } as unknown as CloudFrame
}

/** Texels at integer coordinates, `textureLoad`ed by one thread each: RGBA a texel. */
async function loadTexels(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<Float32Array> {
  const count = at.length
  const input = new StorageBufferAttribute(
    new Int32Array(at.flatMap(([x, y]) => [x, y, 0, 0])),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
  const coordinates = storage(input, 'ivec4', count)
  const into = storage(output, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      into
        .element(instanceIndex)
        .assign(textureLoad(map, coordinates.element(instanceIndex).xy))
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** `read` at each direction, one thread each. */
async function readAt(
  directions: readonly Vec3[],
  read: (direction: Node<'vec3'>) => Node<'vec4'>,
): Promise<Float32Array> {
  const count = directions.length
  const input = new StorageBufferAttribute(
    new Float32Array(directions.flatMap(({ x, y, z }) => [x, y, z, 0])),
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

/** Render passes begun while `work` runs, on every encoder the device makes. */
function passesDuring(work: () => void): number {
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
    work()
  } finally {
    device.createCommandEncoder = create
  }
  return passes
}

/** A face tile's texel, its atlas coordinate and its direction, float64. */
function atlasTexel(
  face: CubeFace,
  i: number,
  j: number,
): { readonly at: readonly [number, number]; readonly direction: Vec3 } {
  const x = (face % CLOUD_CUBE_COLUMNS) * SPAN + i
  const y = Math.floor(face / CLOUD_CUBE_COLUMNS) * SPAN + j
  const direction = cubeDirection(
    face,
    cubeTexelCoordinate(CLOUD_CUBE_TILE, CLOUD_CUBE_GUTTER, i),
    cubeTexelCoordinate(CLOUD_CUBE_TILE, CLOUD_CUBE_GUTTER, j),
  )
  return { at: [x, y], direction }
}

const EYE: Vec3 = { x: 0.3, y: 0.9, z: -0.31 }

/** Bake every face, a frame a face, and report what was pending along the way. */
function bakeAll(
  maps: CloudMaps,
  uniforms: CloudUniforms,
  scenario: WeatherScenario,
): boolean[] {
  const pending: boolean[] = []
  for (let k = 0; k < 6; k += 1) {
    maps.render(renderer, frameFor(uniforms, scenario, EYE), budget)
    pending.push(maps.pending)
  }
  return pending
}

describe('the cube is the placeholder’s coverage at every texel’s direction', () => {
  it.each([
    'fair-cumulus',
    'anvil',
    'cirrus-over-cumulus',
    'two-decks',
  ] as const)(
    '%s: every channel of every face, gutters included',
    async (id) => {
      const scenario = WEATHER_SCENARIOS[id]
      const uniforms = createCloudUniforms()
      const maps = new CloudMaps(uniforms)
      await maps.warm(renderer)
      const pipelines = gpu.pipelinesBuilt()
      const pending = bakeAll(maps, uniforms, scenario)
      // Warmed at 1 × 1: the full-size draws build nothing.
      expect(gpu.pipelinesBuilt()).toBe(pipelines)
      expect(pending).toEqual([true, true, true, true, true, false])

      const next = draws(id.length * 977)
      const texels = Array.from({ length: 1000 }, () =>
        atlasTexel(
          Math.floor(next() * 6) as CubeFace,
          Math.floor(next() * SPAN),
          Math.floor(next() * SPAN),
        ),
      )
      // Every gutter corner, where three faces' directions meet.
      for (const face of [0, 1, 2, 3, 4, 5] as const)
        for (const [i, j] of [
          [0, 0],
          [SPAN - 1, 0],
          [0, SPAN - 1],
          [SPAN - 1, SPAN - 1],
        ] as const)
          texels.push(atlasTexel(face, i, j))
      const at = texels.map((texel) => texel.at)
      const maps0 = await loadTexels(maps.textures()[0]!, at)
      const channels = scenarioChannels(scenario)
      let worst = 0
      texels.forEach(({ direction }, n) => {
        for (let k = 0; k < 3; k += 1) {
          const expected = scenarioCoverage(scenario, k, direction, TIME)
          worst = Math.max(worst, Math.abs(maps0[n * 4 + k]! - expected))
        }
        worst = Math.max(worst, Math.abs(maps0[n * 4 + 3]! - channels.ice))
      })
      expect(worst).toBeLessThanOrEqual(BYTE_BOUND)

      const expected = [
        [...channels.logDepth, 0],
        [...channels.convective, 0],
        [...channels.wind, 0, 0],
      ]
      for (const k of [1, 2, 3] as const) {
        const read = await loadTexels(maps.textures()[k]!, at.slice(0, 64))
        for (let n = 0; n < 64; n += 1)
          for (let c = 0; c < 4; c += 1)
            expect(
              Math.abs(read[n * 4 + c]! - expected[k - 1]![c]!),
            ).toBeLessThanOrEqual(BYTE_BOUND)
      }
      maps.dispose()
    },
  )
})

describe('the gutters', () => {
  it('a read either side of each of the twelve edges agrees: no face reads its neighbor’s texels', async () => {
    // Bands are smooth across every edge, so the two sides differ only by
    // the 8-bit step and the field's own slope over the two-ε gap: at most
    // 31 a radian for a 0.05 rad band at coverage ½.
    const scenario = WEATHER_SCENARIOS['cirrus-over-cumulus']
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms)
    bakeAll(maps, uniforms, scenario)
    const epsilon = 1e-5
    const sides: Vec3[] = []
    const pairs: [number, number][] = []
    CUBE_FACES.forEach((one, f) =>
      CUBE_FACES.forEach((two, g) => {
        if (g <= f) return
        const n1 = one.normal
        const n2 = two.normal
        if (n1.x * n2.x + n1.y * n2.y + n1.z * n2.z !== 0) return
        pairs.push([f, g])
        const t = {
          x: n1.y * n2.z - n1.z * n2.y,
          y: n1.z * n2.x - n1.x * n2.z,
          z: n1.x * n2.y - n1.y * n2.x,
        }
        for (let s = -0.9; s <= 0.9; s += 0.1) {
          for (const sign of [1, -1]) {
            const d = {
              x: n1.x + n2.x + s * t.x + sign * epsilon * (n1.x - n2.x),
              y: n1.y + n2.y + s * t.y + sign * epsilon * (n1.y - n2.y),
              z: n1.z + n2.z + s * t.z + sign * epsilon * (n1.z - n2.z),
            }
            const length = Math.hypot(d.x, d.y, d.z)
            sides.push({ x: d.x / length, y: d.y / length, z: d.z / length })
          }
        }
      }),
    )
    expect(pairs).toHaveLength(12)
    const read = await readAt(sides, (direction) =>
      maps.nodes.synoptic(direction),
    )
    let worst = 0
    for (let n = 0; n < sides.length; n += 2)
      for (let k = 0; k < 2; k += 1)
        worst = Math.max(
          worst,
          Math.abs(read[n * 4 + k]! - read[n * 4 + 4 + k]!),
        )
    expect(worst).toBeLessThanOrEqual(2 / 255 + 31 * 2 * epsilon)
    maps.dispose()
  })
})

describe('the bake', () => {
  it('one MRT quad a frame writes a face tile’s four textures, and nothing outside the tile', async () => {
    const scenario = WEATHER_SCENARIOS['two-decks']
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms)
    await maps.warm(renderer)
    const passes = passesDuring(() =>
      maps.render(renderer, frameFor(uniforms, scenario, EYE), budget),
    )
    expect(passes).toBe(1)
    // The eye's face first: (0.3, 0.9, −0.31) is +Y's, tile 2 at column 2.
    const inside = atlasTexel(2, 200, 300)
    const outside = atlasTexel(0, 200, 300)
    const textures = maps.textures()
    const expected = [
      [0.6, 0.6, 0, 0],
      [...scenarioChannels(scenario).logDepth, 0],
      [...scenarioChannels(scenario).convective, 0],
      [...scenarioChannels(scenario).wind, 0, 0],
    ]
    for (let k = 0; k < 4; k += 1) {
      const read = await loadTexels(textures[k]!, [inside.at, outside.at])
      for (let c = 0; c < 4; c += 1) {
        expect(Math.abs(read[c]! - expected[k]![c]!)).toBeLessThanOrEqual(
          BYTE_BOUND,
        )
        // A tile no quad has drawn keeps WebGPU's zero.
        expect(read[4 + c]).toBe(0)
      }
    }
    maps.dispose()
  })

  it('a jump or a new pattern stales every face, baked nearest the eye first', async () => {
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms)
    bakeAll(maps, uniforms, WEATHER_SCENARIOS['two-decks'])
    expect(maps.pending).toBe(false)
    // The steady cycle owes nothing.
    maps.render(
      renderer,
      frameFor(uniforms, WEATHER_SCENARIOS['two-decks'], EYE),
      budget,
    )
    expect(maps.pending).toBe(false)

    const overcast = WEATHER_SCENARIOS.overcast
    maps.render(renderer, frameFor(uniforms, overcast, EYE), budget)
    expect(maps.pending).toBe(true)
    const eyeFace = atlasTexel(2, 257, 257)
    const opposite = atlasTexel(3, 257, 257)
    const read = await loadTexels(maps.textures()[0]!, [
      eyeFace.at,
      opposite.at,
    ])
    expect(read[0]).toBeCloseTo(1, 5)
    expect(Math.abs(read[4]! - 0.6)).toBeLessThanOrEqual(BYTE_BOUND)
    const pending: boolean[] = []
    for (let k = 0; k < 5; k += 1) {
      maps.render(renderer, frameFor(uniforms, overcast, EYE, k === 2), budget)
      pending.push(maps.pending)
    }
    // A jump on the third frame stales all six again.
    expect(pending).toEqual([true, true, true, true, true])
    for (let k = 0; k < 5; k += 1)
      maps.render(renderer, frameFor(uniforms, overcast, EYE), budget)
    expect(maps.pending).toBe(false)
    const after = await loadTexels(maps.textures()[0]!, [opposite.at])
    expect(after[0]).toBeCloseTo(1, 5)
    maps.dispose()
  })

  it('holds one level a texture, its declared bytes its own, and nothing before it warms', async () => {
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms)
    expect(maps.bytes).toBe(0)
    expect(maps.textures()).toEqual([])
    await maps.warm(renderer)
    expect(maps.bytes).toBe(16)
    maps.render(
      renderer,
      frameFor(uniforms, WEATHER_SCENARIOS.fog, EYE),
      budget,
    )
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }
    let bytes = 0
    for (const held of maps.textures()) {
      const gpuTexture = backend.get(held).texture!
      expect(gpuTexture.mipLevelCount).toBe(1)
      expect(gpuTexture.format).toBe('rgba8unorm')
      bytes += gpuTexture.width * gpuTexture.height * 4
    }
    expect(maps.bytes).toBe(bytes)
    // 25.36 MB, §3.19's figure.
    expect(maps.bytes).toBe(1542 * 1028 * 16)
    maps.dispose()
    expect(maps.bytes).toBe(0)
  })
})
