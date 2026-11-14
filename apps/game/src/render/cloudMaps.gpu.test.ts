import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Node,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import { Fn, If, instanceIndex, storage, textureLoad, uint } from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  type BodyWeather,
  bodyWeather,
  CUBE_FACES,
  type CubeFace,
  cubeDirection,
  cubeTexelCoordinate,
  levelFrames,
  periodIndex,
  regimeWeather,
  type ScenarioId,
  scenarioCoverage,
  shellHeights,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import {
  type Body,
  formatAddress,
  galaxySeedOf,
  generateSystem,
  MILKY_WAY,
  resolveSystem,
  SOL_ONLY_CATALOG,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudClimateFrame,
  type CloudFrame,
  weatherClimate,
  weatherLevels,
} from './cloudFrame.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  CLOUD_CUBE_COLUMNS,
  CLOUD_CUBE_GUTTER,
  CLOUD_CUBE_HEIGHT,
  CLOUD_CUBE_TILE,
  CLOUD_CUBE_WIDTH,
  CloudMaps,
  cubeTexelMeters,
} from './cloudMaps.ts'
import type { CloudBudget } from './cloudNodes.ts'
import { CloudNoise } from './cloudNoise.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The weather cube against `BodyClimate.sample` (phase 1 design §4.3): every
 * atlas texel, the gutters included, is the climate at that texel's
 * direction under the frame's sun at the frame's instant, to 8-bit
 * storage's step, for the zonal law and for each kind of regime pattern; one
 * MRT quad writes a face tile's two textures; a face is fresh by generation
 * and redrawn at the pace its field moves.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice
let noise: CloudNoise

/**
 * An 8-bit texel's step, plus float32 against float64 in the direction's
 * atan and the zonal law's exponentials: measured worst 2.0 × 10⁻³ against
 * 3.9 × 10⁻³ for the step (this Mac mini, Apple M6).
 */
const BYTE_BOUND = 1 / 255 + 1e-5
const SPAN = CLOUD_CUBE_TILE + 2 * CLOUD_CUBE_GUTTER
const TIME = 7.3e9
const EYE_HEIGHT = 1500

const ROOT = rootSeed('inertialref')
const SOL: ReadonlyMap<string, Body> = (() => {
  const stub = resolveSystem(
    galaxySeedOf(ROOT, MILKY_WAY),
    SOL_ONLY_CATALOG,
    systemId('SOL'),
  )!
  const system = generateSystem(ROOT, MILKY_WAY, stub)
  return new Map(
    [...walkBodies(system)].map((body) => [formatAddress(body.address), body]),
  )
})()
const EARTH = SOL.get('g:milky-way/s:SOL/b:2')!
/** Earth less its authored deck: a wet world with its own zonal climate. */
const SERVED_EARTH: Body = {
  ...EARTH,
  appearance: { ...EARTH.appearance, clouds: null },
}

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
  device = (renderer.backend as unknown as { device: GPUDevice }).device
  noise = new CloudNoise()
  await noise.warm(renderer)
})

afterAll(() => {
  noise.dispose()
  gpu.dispose()
})

const budget: CloudBudget = {
  slices: 0,
  tiles: 0,
  jump: false,
  sunSlices: 0,
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}
const scaled = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
})

const UP = unit({ x: 0.3, y: 0.9, z: -0.31 })
/** A sun 23° over the equator's plane, so the zonal law's season is not an equinox's. */
const SUN = unit({ x: 0.9, y: 0.42, z: 0.1 })

interface FrameOptions {
  readonly weather: BodyWeather
  readonly key: string
  readonly time?: number
  readonly sun?: Vec3
  readonly jump?: boolean
  /** Replaces the weather's own climate: a pattern no weather draws, held to its CPU function. */
  readonly climate?: CloudClimateFrame
}

/** A frame with every field the bundle writes, written into `uniforms`: the weather's own levels and climate. */
function frameOf(uniforms: CloudUniforms, options: FrameOptions): CloudFrame {
  const time = options.time ?? TIME
  const sun = options.sun ?? SUN
  const radius = SERVED_EARTH.radius
  const eye = scaled(UP, radius + EYE_HEIGHT)
  const drawn = { weather: options.weather, regime: null } as const
  const levels = weatherLevels(drawn, time, eye)
  const frame = {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true },
    scenario: WEATHER_SCENARIOS['fair-cumulus'],
    served: {
      address: 'test',
      datumRadius: radius,
      compression: 1,
      toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
      eye,
      sun,
      shells: shellHeights(
        eye,
        radius,
        levels.flatMap((level) => [level.base, level.top]),
      ),
      scattering: null,
      limb: 0,
      limbFalloff: 1,
      dayColor: { r: 1, g: 1, b: 1 },
      noiseOrigin: { x: 0, y: 0, z: 0 },
      detailOrigin: { x: 0, y: 0, z: 0 },
      drift: { x: 0, y: 0, z: 0 },
      wind: { x: 0, y: 0, z: 0 },
      clipmap: levelFrames(
        eye,
        radius,
        CLOUD_CLIPMAP_TEXELS,
        CLOUD_CLIPMAP_SIZE,
        null,
      ),
      volume: { frames: [], dirty: [], rebuilt: [] },
      weatherKey: options.key,
      levels,
      climate: options.climate ?? weatherClimate(drawn, time, sun),
    },
    second: null,
    time,
    frameSeconds: 0,
    period: [0, 0],
    camera: {
      right: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      forward: { x: 0, y: 0, z: -1 },
      halfTan: 0.5,
      aspect: 1,
      pixelAngle: 0.002,
    },
    previousCamera: null,
    translation: { x: 0, y: 0, z: 0 },
    enhanced: false,
    regime: 'converging',
    reset: 'none',
    jump: options.jump ?? false,
    frameIndex: 0,
    extents: cubeExtentsFor(),
  } satisfies CloudFrame
  uniforms.write(frame)
  return frame
}

function cubeExtentsFor(): CloudFrame['extents'] {
  const extent = { width: 64, height: 64 }
  return { render: extent, css: extent, trace: extent, history: extent }
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

/** Every atlas texel of every face tile, gutters included: its coordinate and its direction, float64. */
function everyTexel(): {
  readonly at: (readonly [number, number])[]
  readonly directions: Vec3[]
} {
  const at: (readonly [number, number])[] = []
  const directions: Vec3[] = []
  for (const face of [0, 1, 2, 3, 4, 5] as CubeFace[]) {
    const x0 = (face % CLOUD_CUBE_COLUMNS) * SPAN
    const y0 = Math.floor(face / CLOUD_CUBE_COLUMNS) * SPAN
    for (let j = 0; j < SPAN; j += 1)
      for (let i = 0; i < SPAN; i += 1) {
        at.push([x0 + i, y0 + j])
        directions.push(
          cubeDirection(
            face,
            cubeTexelCoordinate(CLOUD_CUBE_TILE, CLOUD_CUBE_GUTTER, i),
            cubeTexelCoordinate(CLOUD_CUBE_TILE, CLOUD_CUBE_GUTTER, j),
          ),
        )
      }
  }
  return { at, directions }
}

function bakeAll(maps: CloudMaps, frame: CloudFrame): boolean[] {
  const pending: boolean[] = []
  for (let k = 0; k < 6; k += 1) {
    maps.render(renderer, frame, budget)
    pending.push(maps.pending)
  }
  return pending
}

/** The worst difference of the two textures from a CPU climate at every texel, and the texels where the reference was strictly between its ends. */
async function heldToClimate(
  maps: CloudMaps,
  expected: (direction: Vec3) => {
    readonly cover: readonly number[]
    readonly kind: readonly number[]
  },
): Promise<{ readonly worst: number; readonly between: number }> {
  const { at, directions } = everyTexel()
  const [cover, kind] = maps.textures()
  const covers = await loadTexels(cover!, at)
  const kinds = await loadTexels(kind!, at)
  let worst = 0
  let between = 0
  directions.forEach((direction, n) => {
    const want = expected(direction)
    for (let c = 0; c < 4; c += 1) {
      worst = Math.max(
        worst,
        Math.abs(covers[n * 4 + c]! - want.cover[c]!),
        Math.abs(kinds[n * 4 + c]! - want.kind[c]!),
      )
    }
    if (want.cover[0]! > 0.02 && want.cover[0]! < 0.98) between += 1
  })
  return { worst, between }
}

/* ------------------------------------------------------------------------- */

describe('the cube is BodyClimate.sample at every texel’s direction', () => {
  const sampleOf =
    (weather: BodyWeather, sun: Vec3, time: number) => (direction: Vec3) => {
      const s = weather.climate.sample(direction, sun, time)
      return {
        cover: [...s.cover, s.ice],
        kind: [...s.convective, s.deep],
      }
    }

  it('under the zonal law: its latitudes, its season and its synoptic field turning with the low level', async () => {
    const weather = bodyWeather(SERVED_EARTH)!
    expect(weather.climate.kind).toBe('zonal')
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    await maps.warm(renderer)
    const pipelines = gpu.pipelinesBuilt()
    const pending = bakeAll(
      maps,
      frameOf(uniforms, { weather, key: 'climate' }),
    )
    expect(gpu.pipelinesBuilt()).toBe(pipelines)
    expect(pending).toEqual([true, true, true, true, true, false])
    const { worst, between } = await heldToClimate(
      maps,
      sampleOf(weather, SUN, TIME),
    )
    expect(between).toBeGreaterThan(100_000)
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
    maps.dispose()
  }, 120_000)

  it.each([
    'broken-horizon',
    'cirrus-over-cumulus',
    'two-decks',
    'fair-cumulus',
    'dusk-altocumulus',
  ] as ScenarioId[])(
    '%s: a regime’s pattern, terminator included',
    async (id) => {
      const weather = regimeWeather(SERVED_EARTH, id)
      const uniforms = createCloudUniforms()
      const maps = new CloudMaps(uniforms, noise.nodes)
      bakeAll(maps, frameOf(uniforms, { weather, key: id }))
      const { worst } = await heldToClimate(maps, sampleOf(weather, SUN, TIME))
      expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
      maps.dispose()
    },
    60_000,
  )

  it('the terminator’s dusk edge: every texel inside the edge held to the CPU’s smoothstep', async () => {
    // A code review of the first pull request found the dusk edge's WGSL
    // held to nothing. Here the texels whose local sun stands inside the
    // edge, where the cover is strictly between the layer's and none, are
    // counted, so a terminator that ported as a step fails as well as one
    // that ported the wrong way round.
    const scenario = WEATHER_SCENARIOS['dusk-altocumulus']
    const weather = regimeWeather(SERVED_EARTH, 'dusk-altocumulus')
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: scenario.id }))
    const { at, directions } = everyTexel()
    const covers = await loadTexels(maps.textures()[0]!, at)
    let inside = 0
    let worst = 0
    directions.forEach((direction, n) => {
      const want = scenarioCoverage(scenario, 0, direction, TIME, SUN)
      if (want > 0.01 && want < 0.69) {
        inside += 1
        worst = Math.max(worst, Math.abs(covers[n * 4]! - want))
      }
    })
    expect(inside).toBeGreaterThan(500)
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
    maps.dispose()
  }, 60_000)

  it('a pattern of blobs, which no weather draws, still ports `scenarioCoverage` cell for cell', async () => {
    // Blobs are drawn as a uniform cover by every regime that names them
    // (`regimeWeather`); the pattern stays in the climate's uniforms, so the
    // WGSL that hashes a cell is held here with the raw pattern written in.
    const scenario = WEATHER_SCENARIOS.anvil
    const weather = regimeWeather(SERVED_EARTH, 'anvil')
    const uniforms = createCloudUniforms()
    const drawn = { weather, regime: null } as const
    const climate = weatherClimate(drawn, TIME, SUN)
    const raw: CloudClimateFrame = {
      ...climate,
      pattern: 'blobs',
      patternScale: scenario.patternScale,
      patternCells: 32,
      period: periodIndex(TIME, scenario.patternPeriod),
    }
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: 'anvil', climate: raw }))
    const { at, directions } = everyTexel()
    const covers = await loadTexels(maps.textures()[0]!, at)
    let worst = 0
    let clouded = 0
    directions.forEach((direction, n) => {
      const want = scenarioCoverage(scenario, 0, direction, TIME, SUN)
      if (want > 0.5) clouded += 1
      worst = Math.max(worst, Math.abs(covers[n * 4]! - want))
    })
    expect(clouded).toBeGreaterThan(10_000)
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
    maps.dispose()
  }, 60_000)
})

describe('the gutters', () => {
  it('a read either side of each of the twelve edges agrees: no face reads its neighbor’s texels', async () => {
    // The zonal law is smooth across every edge, so the two sides differ
    // only by the 8-bit step and the field's own slope over the two-ε gap.
    const weather = bodyWeather(SERVED_EARTH)!
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: 'climate' }))
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
        for (let s = -0.9; s <= 0.9; s += 0.1)
          for (const sign of [1, -1])
            sides.push(
              unit({
                x: n1.x + n2.x + s * t.x + sign * epsilon * (n1.x - n2.x),
                y: n1.y + n2.y + s * t.y + sign * epsilon * (n1.y - n2.y),
                z: n1.z + n2.z + s * t.z + sign * epsilon * (n1.z - n2.z),
              }),
            )
      }),
    )
    expect(pairs).toHaveLength(12)
    const read = await readAt(sides, (d) => maps.nodes.cover(d))
    let worst = 0
    for (let n = 0; n < sides.length; n += 2)
      for (let c = 0; c < 3; c += 1)
        worst = Math.max(
          worst,
          Math.abs(read[n * 4 + c]! - read[(n + 1) * 4 + c]!),
        )
    expect(worst).toBeLessThanOrEqual(2 / 255)
    maps.dispose()
  }, 60_000)
})

describe('the bake', () => {
  it('one MRT quad writes a face tile’s two textures, each one level, their declared bytes the GPU’s', async () => {
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    expect(maps.bytes).toBe(0)
    expect(maps.textures()).toEqual([])
    await maps.warm(renderer)
    expect(maps.bytes).toBe(8)
    const weather = bodyWeather(SERVED_EARTH)!
    const passes = passesDuring(() => {
      maps.render(
        renderer,
        frameOf(uniforms, { weather, key: 'climate' }),
        budget,
      )
    })
    expect(passes).toBe(1)
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }
    let bytes = 0
    expect(maps.textures()).toHaveLength(2)
    for (const held of maps.textures()) {
      const gpuTexture = backend.get(held).texture!
      expect(gpuTexture.mipLevelCount).toBe(1)
      expect(gpuTexture.format).toBe('rgba8unorm')
      bytes += gpuTexture.width * gpuTexture.height * 4
    }
    expect(maps.bytes).toBe(bytes)
    // 12.68 MB, against phase 0's four targets' 25.36 MB.
    expect(maps.bytes).toBe(CLOUD_CUBE_WIDTH * CLOUD_CUBE_HEIGHT * 8)
    maps.dispose()
    expect(maps.bytes).toBe(0)
  })
})

describe('freshness by generation, and the pace', () => {
  it('a jump starts a generation: every face is stale until it is baked in it, nearest the eye first', async () => {
    const weather = bodyWeather(SERVED_EARTH)!
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: 'climate' }))
    const first = maps.generation
    const faces = [0, 1, 2, 3, 4, 5] as CubeFace[]
    expect(faces.map((f) => maps.faceGeneration(f))).toEqual(
      faces.map(() => first),
    )
    const later = TIME + 3 * 3600
    maps.render(
      renderer,
      frameOf(uniforms, { weather, key: 'climate', time: later, jump: true }),
      budget,
    )
    expect(maps.generation).toBe(first + 1)
    // The eye's own face is baked in the jump's frame, and only it.
    const fresh = faces.filter((f) => maps.faceGeneration(f) === first + 1)
    const { x, y, z } = UP
    const own = [x >= 0 ? 0 : 1, y >= 0 ? 2 : 3, z >= 0 ? 4 : 5][
      [Math.abs(x), Math.abs(y), Math.abs(z)].indexOf(
        Math.max(Math.abs(x), Math.abs(y), Math.abs(z)),
      )
    ]
    expect(fresh).toEqual([own])
    expect(maps.pending).toBe(true)
    for (let k = 0; k < 5; k += 1)
      maps.render(
        renderer,
        frameOf(uniforms, { weather, key: 'climate', time: later }),
        budget,
      )
    expect(maps.pending).toBe(false)
    expect(faces.every((f) => maps.faceGeneration(f) === first + 1)).toBe(true)
    // What it holds is the new instant's climate.
    const { worst } = await heldToClimate(maps, (direction) => {
      const s = weather.climate.sample(direction, SUN, later)
      return { cover: [...s.cover, s.ice], kind: [...s.convective, s.deep] }
    })
    expect(worst).toBeLessThanOrEqual(BYTE_BOUND)
    maps.dispose()
  }, 60_000)

  it('reaches all six faces through a scrub, which jumps every frame', () => {
    const weather = bodyWeather(SERVED_EARTH)!
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: 'climate' }))
    const baked = new Set<number>()
    for (let k = 0; k < 6; k += 1) {
      const before = [0, 1, 2, 3, 4, 5].map((f) =>
        maps.faceVersion(f as CubeFace),
      )
      maps.render(
        renderer,
        frameOf(uniforms, {
          weather,
          key: 'climate',
          time: TIME + 600 * (k + 1),
          jump: true,
        }),
        budget,
      )
      before.forEach((version, f) => {
        if (maps.faceVersion(f as CubeFace) > version) baked.add(f)
      })
    }
    expect([...baked].sort()).toEqual([0, 1, 2, 3, 4, 5])
    maps.dispose()
  })

  it('bakes nothing while its field moves under a tenth of a texel, then a face a frame, never more', () => {
    // Earth's zonal climate: the high level turns at 25 m/s at the equator,
    // and a face's texel is 19.6 km, so a face is due 78 s after its bake.
    const weather = bodyWeather(SERVED_EARTH)!
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    bakeAll(maps, frameOf(uniforms, { weather, key: 'climate' }))
    const due =
      cubeTexelMeters(SERVED_EARTH.radius) /
      10 /
      Math.max(...weather.turn.map((rate) => rate * SERVED_EARTH.radius))
    expect(due).toBeGreaterThan(70)
    expect(due).toBeLessThan(90)
    const at = (seconds: number) =>
      passesDuring(() =>
        maps.render(
          renderer,
          frameOf(uniforms, { weather, key: 'climate', time: TIME + seconds }),
          budget,
        ),
      )
    const steady = Array.from({ length: 60 }, (_, k) => at((k + 1) / 60))
    expect(steady.every((passes) => passes === 0)).toBe(true)
    // Past the pace every face is due, and they go one a frame.
    const late = Array.from({ length: 8 }, (_, k) => at(due + 1 + k / 60))
    expect(late).toEqual([1, 1, 1, 1, 1, 1, 0, 0])
    // Under a warp of 1,000×, 16.7 s of field a frame: a face every frame.
    const warped = Array.from({ length: 12 }, (_, k) =>
      at(2 * due + (k + 1) * 16.7),
    )
    expect(warped.every((passes) => passes === 1)).toBe(true)
    maps.dispose()
  })

  it('a terminator moves its faces with the sun, at the sun’s pace and not the wind’s', () => {
    // dusk-altocumulus turns at 8 m/s, which alone is due after 245 s; the
    // sun's sweep over a tenth of a texel is 1960 m of Earth's surface.
    const weather = regimeWeather(SERVED_EARTH, 'dusk-altocumulus')
    const uniforms = createCloudUniforms()
    const maps = new CloudMaps(uniforms, noise.nodes)
    const key = 'dusk-altocumulus'
    bakeAll(maps, frameOf(uniforms, { weather, key }))
    const turned = (angle: number): Vec3 => ({
      x: Math.cos(angle) * SUN.x + Math.sin(angle) * SUN.z,
      y: SUN.y,
      z: -Math.sin(angle) * SUN.x + Math.cos(angle) * SUN.z,
    })
    const tenth =
      cubeTexelMeters(SERVED_EARTH.radius) / 10 / SERVED_EARTH.radius
    const at = (angle: number) =>
      passesDuring(() =>
        maps.render(
          renderer,
          frameOf(uniforms, {
            weather,
            key,
            time: TIME + 1,
            sun: turned(angle),
          }),
          budget,
        ),
      )
    expect(at(0.5 * tenth)).toBe(0)
    expect(at(1.5 * tenth)).toBe(1)
    maps.dispose()
  })
})
