import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Node,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  storage,
  textureLoad,
  int,
  uint,
  vec4,
} from 'three/tsl'
import { rootSeed } from '@inertialref/procedural'
import {
  type BodyWeather,
  bodyWeather,
  CUBE_FACES,
  cloudExtents,
  directionOf,
  horizonBasis,
  type LevelFrame,
  type LevelUpdate,
  levelFrames,
  levelStatistics,
  planeOf,
  readLevelStatistics,
  regimeWeather,
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
  CLIPMAP_GAIN_SPAN,
  CloudClipmap,
  clipmapTexel,
} from './cloudClipmap.ts'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudFrame,
  weatherClimate,
  weatherLevels,
} from './cloudFrame.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  analyticMapNodes,
  CLOUD_CUBE_COLUMNS,
  CLOUD_CUBE_GUTTER,
  CLOUD_CUBE_TILE,
  CloudMaps,
} from './cloudMaps.ts'
import type { CloudBudget, CloudSample } from './cloudNodes.ts'
import { CloudNoise } from './cloudNoise.ts'
import { createCloudProfile, profileOf } from './cloudProfile.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'

/** A uniform bundle with the profile its field builds beside it. */
function fieldUniforms(): CloudUniforms {
  const uniforms = createCloudUniforms()
  createCloudProfile({ uniforms })
  return uniforms
}
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The clipmap (§3.9, phase 1 design §4.3, §4.7): a strip update after a
 * move is a full rebuild, texel for texel; every layer is the cube
 * resampled at its texels' directions, its cloud level's cover and
 * convective share; a lookup is the float64 projection of the sample, formed
 * eye-relatively, to float32's limit; a column reads the finest level
 * holding the sample and, in that level's outer fifth, the next one too; a
 * frame bakes what the schedule says it does; and a level is fresh only
 * from faces of the field's present generation.
 *
 * A 200 km body under bands of cirrus-over-cumulus: a band is 10 km, 16 of
 * the cube's 613 m texels, so the cover varies across every level, and the
 * displacement's waves are 20 km and up, so it varies across every level
 * too: a texel drawn in the wrong place or read at the wrong one cannot
 * hide.
 */

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice

const SMALL = 2e5
const EARTH = 6_371_000
const TIME = 7.3e9
const SIZE = CLOUD_CLIPMAP_SIZE
const SPAN = CLOUD_CUBE_TILE + 2 * CLOUD_CUBE_GUTTER
/**
 * Two 8-bit steps: the clipmap stores the cube's bilinear read, itself
 * stored at 8 bits, and the GPU's filter weights are fixed-point.
 */
const RESAMPLED = 2 / 255
/** Layers: six clipmap levels of three cloud levels, level k's cloud level j at 3k + j. */
const LAYERS = 18

let noise: CloudNoise

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
const EARTH_RECORD = SOL.get('g:milky-way/s:SOL/b:2')!
const SERVED_EARTH: Body = {
  ...EARTH_RECORD,
  appearance: { ...EARTH_RECORD.appearance, clouds: null },
}
/** The same world at 200 km. */
const SMALL_WORLD: Body = { ...SERVED_EARTH, radius: SMALL }

const bands = (body: Body): BodyWeather =>
  regimeWeather(body, 'cirrus-over-cumulus')

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
const SUN: Vec3 = { x: 0, y: 1, z: 0 }

const added = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})

/** A frame with every field the bundle writes, its clipmap given, copied into `uniforms`: the weather's own levels and climate. */
function frameAt(
  uniforms: CloudUniforms,
  weather: BodyWeather,
  key: string,
  radius: number,
  eye: Vec3,
  clipmap: LevelUpdate,
  jump = false,
  time = TIME,
): CloudFrame {
  const drawn = { weather, regime: null } as const
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
      sun: SUN,
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
      clipmap,
      volume: { frames: [], dirty: [], rebuilt: [] },
      weatherKey: key,
      levels,
      climate: weatherClimate(drawn, time, SUN),
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
    jump,
    frameIndex: 0,
    extents: cloudExtents({ width: 64, height: 64 }, { width: 64, height: 64 }),
  } satisfies CloudFrame
  uniforms.write(frame)
  // The levels' profile and statistics, as `CloudMaps.write` writes them.
  profileOf(uniforms)?.write(frame)
  return frame
}

const levels = (
  eye: Vec3,
  radius: number,
  previous: readonly LevelFrame[] | null,
): LevelUpdate => levelFrames(eye, radius, CLOUD_CLIPMAP_TEXELS, SIZE, previous)

/** The same frames, every level marked for a whole rebuild: what a fresh clipmap at this frame draws. */
const rebuiltAt = (update: LevelUpdate): LevelUpdate => ({
  frames: update.frames,
  dirty: update.frames.map(() => [{ x: 0, y: 0, width: SIZE, height: SIZE }]),
  rebuilt: update.frames.map(() => true),
})
const stillAt = (update: LevelUpdate): LevelUpdate => ({
  frames: update.frames,
  dirty: update.frames.map(() => []),
  rebuilt: update.frames.map(() => false),
})

/** Texels at integer coordinates, `textureLoad`ed by one thread each: RGBA a texel. */
async function loadTexels(
  map: Texture,
  kind: '2d' | '2d-array',
  at: readonly (readonly [number, number, number?])[],
): Promise<Float32Array> {
  const count = at.length
  const input = new StorageBufferAttribute(
    new Int32Array(at.flatMap(([x, y, z = 0]) => [x, y, z, 0])),
    4,
  )
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 4)
  const coordinates = storage(input, 'ivec4', count)
  const into = storage(output, 'vec4', count)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const c = coordinates.element(instanceIndex)
      into
        .element(instanceIndex)
        .assign(
          kind === '2d-array'
            ? textureLoad(map, c.xy).depth(c.z)
            : textureLoad(map, c.xy),
        )
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** Every texel of every layer of a clipmap's two textures. */
async function everyTexel(clipmap: CloudClipmap): Promise<Float32Array[]> {
  const at: [number, number, number][] = []
  for (let k = 0; k < LAYERS; k += 1)
    for (let y = 0; y < SIZE; y += 1)
      for (let x = 0; x < SIZE; x += 1) at.push([x, y, k])
  const out: Float32Array[] = []
  for (const map of clipmap.textures())
    out.push(await loadTexels(map, '2d-array', at))
  return out
}

/** A sample at an eye-relative offset, with nothing else the clipmap reads. */
const sampleAt = (offset: Node<'vec3'>): CloudSample => ({
  offset,
  distance: float(0),
  altitude: float(0),
  sunMu: float(1),
  footprint: float(1),
})

/** `read` at each offset, one thread each. */
async function readAt(
  offsets: readonly Vec3[],
  read: (offset: Node<'vec3'>) => Node<'vec4'>,
): Promise<Float32Array> {
  const count = offsets.length
  const input = new StorageBufferAttribute(
    new Float32Array(offsets.flatMap(({ x, y, z }) => [x, y, z, 0])),
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

/** Render passes begun while `work` runs. */
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

/** The cube atlas's continuous texel coordinates of a direction, float64: `cubeAtlasUv` × the atlas's size. */
function atlasCoordinates(d: Vec3): readonly [number, number] {
  const ax = Math.abs(d.x)
  const ay = Math.abs(d.y)
  const az = Math.abs(d.z)
  const face =
    ax >= ay && ax >= az
      ? d.x >= 0
        ? 0
        : 1
      : ay >= az
        ? d.y >= 0
          ? 2
          : 3
        : d.z >= 0
          ? 4
          : 5
  const { normal, a, b } = CUBE_FACES[face]!
  const dot = (v: Vec3) => d.x * v.x + d.y * v.y + d.z * v.z
  const depth = dot(normal)
  const wa = Math.atan(dot(a) / depth) / (Math.PI / 4)
  const wb = Math.atan(dot(b) / depth) / (Math.PI / 4)
  return [
    (face % CLOUD_CUBE_COLUMNS) * SPAN +
      CLOUD_CUBE_GUTTER +
      ((wa + 1) / 2) * CLOUD_CUBE_TILE,
    Math.floor(face / CLOUD_CUBE_COLUMNS) * SPAN +
      CLOUD_CUBE_GUTTER +
      ((wb + 1) / 2) * CLOUD_CUBE_TILE,
  ]
}

/** The four texels a bilinear read at continuous coordinates takes, and their weights. */
function bilinear(
  x: number,
  y: number,
): { readonly at: [number, number][]; readonly weights: number[] } {
  const i = Math.floor(x - 0.5)
  const j = Math.floor(y - 0.5)
  const fx = x - 0.5 - i
  const fy = y - 0.5 - j
  return {
    at: [
      [i, j],
      [i + 1, j],
      [i, j + 1],
      [i + 1, j + 1],
    ],
    weights: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy],
  }
}

const wrapped = (i: number): number => ((i % SIZE) + SIZE) % SIZE

/** A cube baked for `weather` on a body of `radius`, and a clipmap baked from it at `eye`, every level whole. */
async function bakedPair(
  weather: BodyWeather,
  key: string,
  radius: number,
  eye: Vec3,
): Promise<{
  readonly uniforms: CloudUniforms
  readonly maps: CloudMaps
  readonly clipmap: CloudClipmap
  readonly update: LevelUpdate
}> {
  const uniforms = fieldUniforms()
  const maps = new CloudMaps(uniforms, noise.nodes)
  const clipmap = new CloudClipmap(uniforms, maps.nodes, profileOf(uniforms)!)
  await maps.warm(renderer)
  await clipmap.warm(renderer)
  const first = levels(eye, radius, null)
  const at = (u: LevelUpdate) => frameAt(uniforms, weather, key, radius, eye, u)
  for (let k = 0; k < 6; k += 1)
    maps.render(renderer, at(stillAt(first)), budget)
  clipmap.render(renderer, at(first), budget)
  for (let k = 0; k < 3; k += 1)
    clipmap.render(renderer, at(stillAt(first)), budget)
  expect(clipmap.pending).toBe(false)
  return { uniforms, maps, clipmap, update: first }
}

const EYE_DIRECTION = unit({ x: 0.3, y: 0.9, z: -0.31 })

describe('the toroidal window', () => {
  it('a strip update after a move equals a full rebuild, texel for texel, in every layer', async () => {
    const weather = bands(SMALL_WORLD)
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { uniforms, maps, clipmap, update } = await bakedPair(
      weather,
      'cirrus-over-cumulus',
      SMALL,
      eye,
    )
    const at = (u: LevelUpdate, where: Vec3) =>
      frameAt(uniforms, weather, 'cirrus-over-cumulus', SMALL, where, u)
    const { east, north } = horizonBasis(eye)
    const moved = added(eye, added(scaled(east, 3100), scaled(north, -1730)))
    const after = levels(moved, SMALL, update.frames)
    expect(after.rebuilt).toEqual([false, false, false, false, false, false])
    // Level 0 moves twelve texels east and seven south, level 3 one and none.
    expect(after.dirty[0]!.length).toBeGreaterThan(0)
    const passes = passesDuring(() =>
      clipmap.render(renderer, at(after, moved), budget),
    )
    const strips = after.dirty.reduce((sum, rects) => sum + rects.length, 0)
    // The strips, a pass for each of a level's three layers; the cube has
    // not moved, so no refresh.
    expect(passes).toBe(3 * strips)
    const scrolled = await everyTexel(clipmap)

    const fresh = new CloudClipmap(uniforms, maps.nodes, profileOf(uniforms)!)
    fresh.render(renderer, at(rebuiltAt(after), moved), budget)
    for (let k = 0; k < 3; k += 1)
      fresh.render(renderer, at(stillAt(after), moved), budget)
    expect(fresh.pending).toBe(false)
    const rebuilt = await everyTexel(fresh)
    // Every texel is a function of its lattice coordinate alone, to the bit.
    let differing = 0
    scrolled.forEach((map, t) => {
      for (let n = 0; n < map.length; n += 1)
        if (map[n] !== rebuilt[t]![n]) differing += 1
    })
    expect(differing).toBe(0)
    // And the field is not constant there: a misplaced strip would show.
    const [held] = scrolled
    let low = 1
    let high = 0
    for (let n = 0; n < SIZE * SIZE; n += 1) {
      low = Math.min(low, held![n * 4]!)
      high = Math.max(high, held![n * 4]!)
    }
    expect(high - low).toBeGreaterThan(0.3)
    clipmap.dispose()
    fresh.dispose()
    maps.dispose()
  })
})

describe('the layers are the cube resampled, and the displacement', () => {
  it('a layer texel holds the cube’s bilinear read at its center’s direction, for its cloud level', async () => {
    const weather = bands(SMALL_WORLD)
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { maps, clipmap, update } = await bakedPair(
      weather,
      'cirrus-over-cumulus',
      SMALL,
      eye,
    )
    const next = draws(11)
    const probes = Array.from({ length: 600 }, () => {
      const k = Math.floor(next() * 6)
      const j = Math.floor(next() * 3)
      const frame = update.frames[k]!
      const i = frame.origin[0] + Math.floor(next() * SIZE)
      const jj = frame.origin[1] + Math.floor(next() * SIZE)
      const direction = directionOf(
        frame,
        [(i + 0.5) * frame.texelMeters, (jj + 0.5) * frame.texelMeters],
        SMALL,
      )
      return { k, j, i, jj, ...bilinear(...atlasCoordinates(direction)) }
    })
    const [coverMap, kindMap] = maps.textures()
    const loads = probes.flatMap((p) => p.at)
    const cover = await loadTexels(coverMap!, '2d', loads)
    const kind = await loadTexels(kindMap!, '2d', loads)
    const layers = probes.map(
      (p) => [wrapped(p.i), wrapped(p.jj), 3 * p.k + p.j] as const,
    )
    const [texel] = clipmap.textures()
    const held = await loadTexels(texel!, '2d-array', layers)
    let worst = 0
    let varied = 0
    probes.forEach((probe, n) => {
      let wantCover = 0
      let wantShare = 0
      probe.weights.forEach((w, q) => {
        wantCover += w * cover[(n * 4 + q) * 4 + probe.j]!
        wantShare += w * kind[(n * 4 + q) * 4 + probe.j]!
      })
      if (wantCover > 0.05 && wantCover < 0.95) varied += 1
      worst = Math.max(
        worst,
        Math.abs(held[n * 4]! - wantCover),
        Math.abs(held[n * 4 + 1]! - wantShare),
      )
    })
    expect(worst).toBeLessThanOrEqual(RESAMPLED)
    expect(varied).toBeGreaterThan(50)
    clipmap.dispose()
    maps.dispose()
  })

  it('a layer texel carries its level’s gain at its own cover and share, in sixteen bits', async () => {
    // Earth's climate, whose low level blends two genera and whose gain runs
    // past what a byte holds.
    const weather = bodyWeather(SERVED_EARTH)!
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const { clipmap, update, maps } = await bakedPair(
      weather,
      'climate',
      EARTH,
      eye,
    )
    const next = draws(17)
    const probes = Array.from({ length: 600 }, () => {
      const k = Math.floor(next() * 6)
      const j = Math.floor(next() * 3)
      const frame = update.frames[k]!
      return [
        wrapped(frame.origin[0] + Math.floor(next() * SIZE)),
        wrapped(frame.origin[1] + Math.floor(next() * SIZE)),
        3 * k + j,
      ] as const
    })
    const held = await loadTexels(clipmap.textures()[0]!, '2d-array', probes)
    let worst = 0
    let largest = 0
    let relative = 0
    probes.forEach(([, , layer], n) => {
      const stats = levelStatistics(weather.levels[layer % 3]!)
      const cover = held[n * 4]!
      const share = held[n * 4 + 1]!
      const gainAt = (c: number, v: number) =>
        readLevelStatistics(stats, c, v).gain
      const want = gainAt(cover, share)
      // The bake read the gain at the cover and share before their bytes,
      // which this reads back: allowed is what one byte of either moves the
      // gain by, where it is steep, and half a percent beside it.
      const byte = 1 / 255
      const reach = Math.max(
        ...[
          [byte, 0],
          [-byte, 0],
          [0, byte],
          [0, -byte],
        ].map(([dc, dv]) => Math.abs(gainAt(cover + dc!, share + dv!) - want)),
      )
      const read =
        ((held[n * 4 + 2]! * 255 * 256 + held[n * 4 + 3]! * 255) / 65535) *
        CLIPMAP_GAIN_SPAN
      largest = Math.max(largest, want)
      relative = Math.max(relative, Math.abs(read - want) / want)
      worst = Math.max(worst, Math.abs(read - want) / (reach + 0.005 * want))
    })
    console.info(
      `clipmap gain: largest ${largest.toFixed(3)}, ${relative.toExponential(2)} relative at worst, ${worst.toFixed(3)} of one byte's reach and half a percent`,
    )
    expect(largest).toBeGreaterThan(1.2)
    expect(worst).toBeLessThanOrEqual(1)
    clipmap.dispose()
    maps.dispose()
  })
})

describe('a lookup', () => {
  it('is the float64 projection of the sample, formed eye-relatively, at 100 km', async () => {
    // Earth, where an absolute float32 direction would carry 0.4 m. The
    // limit is float32's: a plane coordinate 100 km out carries 2.2 cm at
    // worst over twelve seeds (cloudGeometry.gpu.test.ts), so 3 cm.
    const uniforms = fieldUniforms()
    const weather = regimeWeather(SERVED_EARTH, 'two-decks')
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const update = levels(eye, EARTH, null)
    frameAt(uniforms, weather, 'two-decks', EARTH, eye, update)
    const next = draws(5)
    const offsets: Vec3[] = []
    for (let n = 0; n < 512; n += 1) {
      const { east, north, up } = horizonBasis(eye)
      const angle = next() * 2 * Math.PI
      const reach = 100_000 * Math.sqrt(next())
      offsets.push(
        added(
          added(
            scaled(east, reach * Math.cos(angle)),
            scaled(north, reach * Math.sin(angle)),
          ),
          scaled(up, (next() - 0.5) * 20_000),
        ),
      )
    }
    for (const k of [0, 2, 5]) {
      const level = uniforms.served.clipmap[k]!
      const read = await readAt(offsets, (offset) =>
        vec4(clipmapTexel(level, offset, uniforms.served), 0, 0),
      )
      const frame = update.frames[k]!
      let worst = 0
      offsets.forEach((offset, n) => {
        const [u, v] = planeOf(frame, unit(added(eye, offset)), EARTH)
        worst = Math.max(
          worst,
          Math.abs(read[n * 4]! * frame.texelMeters - u),
          Math.abs(read[n * 4 + 1]! * frame.texelMeters - v),
        )
      })
      expect(worst, `level ${k}`).toBeLessThanOrEqual(0.03)
    }
  })

  it('a column is the finest holding level’s bilinear read of its cloud level’s layer, there and in its fade band', async () => {
    const weather = bands(SMALL_WORLD)
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { uniforms, maps, clipmap, update } = await bakedPair(
      weather,
      'cirrus-over-cumulus',
      SMALL,
      eye,
    )
    const { east, north } = horizonBasis(eye)
    const next = draws(23)
    const offsets: Vec3[] = []
    for (let n = 0; n < 400; n += 1) {
      const angle = next() * 2 * Math.PI
      // Out to 600 km: levels 0 to 5 and the fade bands between.
      const reach = 6e5 * next() ** 2
      offsets.push(
        added(
          scaled(east, reach * Math.cos(angle)),
          scaled(north, reach * Math.sin(angle)),
        ),
      )
    }
    const CLOUD = 1
    const read = await readAt(offsets, (offset) => {
      const column = clipmap.nodes.column(
        sampleAt(offset),
        uniforms.served,
        int(CLOUD),
      )
      return vec4(
        column.cover,
        column.convective,
        0,
        clipmap.nodes.columnMeters(sampleAt(offset), uniforms.served),
      )
    })
    // The CPU's choice of level, and the texels its reads take.
    const plan = offsets.map((offset) => {
      const direction = unit(added(eye, offset))
      const at = update.frames.map((frame) => {
        const [u, v] = planeOf(frame, direction, SMALL)
        const x = u / frame.texelMeters
        const y = v / frame.texelMeters
        const reach = Math.max(
          Math.abs(x - frame.origin[0] - SIZE / 2),
          Math.abs(y - frame.origin[1] - SIZE / 2),
        )
        return { x, y, reach }
      })
      const k = at.findIndex((a) => a.reach < SIZE / 2 - 1)
      return { k, at }
    })
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)))
      return t * t * (3 - 2 * t)
    }
    const loads: (readonly [number, number, number])[] = []
    for (const { k, at } of plan)
      for (const level of [k, Math.min(k + 1, 5)]) {
        const { at: texels } = bilinear(at[level]!.x, at[level]!.y)
        for (const [i, j] of texels)
          loads.push([wrapped(i), wrapped(j), 3 * level + CLOUD])
      }
    const texels = await loadTexels(clipmap.textures()[0]!, '2d-array', loads)
    let worstCover = 0
    let banded = 0
    plan.forEach(({ k, at }, n) => {
      expect(k, `offset ${n}`).toBeGreaterThanOrEqual(0)
      const value = (slot: number, level: number, c: number) => {
        const { weights } = bilinear(at[level]!.x, at[level]!.y)
        let sum = 0
        weights.forEach((w, q) => {
          sum += w * texels[(n * 8 + slot * 4 + q) * 4 + c]!
        })
        return sum
      }
      const fade = smooth(0.8 * (SIZE / 2), SIZE / 2 - 1, at[k]!.reach)
      if (fade > 0.05 && fade < 0.95) banded += 1
      const blended = (c: number) =>
        k === 5
          ? (1 - fade) * value(0, 5, c)
          : (1 - fade) * value(0, k, c) + fade * value(1, k + 1, c)
      worstCover = Math.max(
        worstCover,
        Math.abs(read[n * 4]! - blended(0)),
        Math.abs(read[n * 4 + 1]! - blended(1)),
      )
      expect(read[n * 4 + 3]).toBe(update.frames[k]!.texelMeters)
    })
    expect(worstCover).toBeLessThanOrEqual(RESAMPLED)
    expect(banded).toBeGreaterThan(10)
    clipmap.dispose()
    maps.dispose()
  })

  it('the fade band reads two levels: a level baked from another field than the next blends the two', async () => {
    // From the climate itself, so a change of weather lands in the levels a
    // frame rebuilds: one frame after overcast's cover of 1 gives way to
    // two-decks' 0.6, levels 0–2 hold 0.6 and 3–5 still 1.
    const uniforms = fieldUniforms()
    const clipmap = new CloudClipmap(
      uniforms,
      analyticMapNodes(uniforms.served, noise.nodes),
      profileOf(uniforms)!,
    )
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const update = levels(eye, EARTH, null)
    const overcast = regimeWeather(SERVED_EARTH, 'overcast')
    const decks = regimeWeather(SERVED_EARTH, 'two-decks')
    clipmap.render(
      renderer,
      frameAt(uniforms, overcast, 'overcast', EARTH, eye, update),
      budget,
    )
    for (let k = 0; k < 3; k += 1)
      clipmap.render(
        renderer,
        frameAt(uniforms, overcast, 'overcast', EARTH, eye, stillAt(update)),
        budget,
      )
    clipmap.render(
      renderer,
      frameAt(uniforms, decks, 'two-decks', EARTH, eye, stillAt(update)),
      budget,
    )
    expect(clipmap.pending).toBe(true)
    const frame = update.frames[2]!
    const { east } = horizonBasis(eye)
    // Along east from the eye, through level 2's inner window, its fade band
    // and out past it: 128 texels of 1 km is the window's edge.
    const reaches = [40e3, 100e3, 108e3, 115e3, 122e3, 126e3]
    const offsets = reaches.map((m) => scaled(east, m))
    const read = await readAt(offsets, (offset) => {
      const sample = sampleAt(offset)
      return vec4(
        clipmap.nodes.column(sample, uniforms.served, int(0)).cover,
        clipmap.nodes.columnMeters(sample, uniforms.served),
        0,
        0,
      )
    })
    const fades = offsets.map((offset) => {
      const [u, v] = planeOf(frame, unit(added(eye, offset)), EARTH)
      const reach = Math.max(
        Math.abs(u / frame.texelMeters - frame.origin[0] - SIZE / 2),
        Math.abs(v / frame.texelMeters - frame.origin[1] - SIZE / 2),
      )
      const t = Math.min(1, Math.max(0, (reach - 102.4) / (127 - 102.4)))
      return t * t * (3 - 2 * t)
    })
    const decksCover = 0.6
    offsets.forEach((_, n) => {
      const [cover, meters] = [0, 1].map((c) => read[n * 4 + c]!)
      if (n === 0) {
        // Inside level 1's window: level 1 alone.
        expect(meters).toBe(500)
        expect(Math.abs(cover! - decksCover)).toBeLessThan(1e-3)
        return
      }
      expect(meters).toBe(1000)
      const expected = decksCover + (1 - decksCover) * fades[n]!
      expect(Math.abs(cover! - expected), `${reaches[n]} m`).toBeLessThan(2e-3)
    })
    expect(fades[3]! > 0.2 && fades[3]! < 0.8).toBe(true)
    clipmap.dispose()
  })
})

describe('the schedule', () => {
  it('a first frame rebuilds levels 0–2, then one more a frame; a still frame over a moving source refreshes an eighth; a cut three', async () => {
    const uniforms = fieldUniforms()
    const clipmap = new CloudClipmap(
      uniforms,
      analyticMapNodes(uniforms.served, noise.nodes),
      profileOf(uniforms)!,
    )
    const weather = regimeWeather(SERVED_EARTH, 'two-decks')
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const update = levels(eye, EARTH, null)
    await clipmap.warm(renderer)
    const pipelines = gpu.pipelinesBuilt()
    const counts: number[] = []
    const pending: boolean[] = []
    const step = (u: LevelUpdate, jump = false) => {
      counts.push(
        passesDuring(() =>
          clipmap.render(
            renderer,
            frameAt(uniforms, weather, 'two-decks', EARTH, eye, u, jump),
            budget,
          ),
        ),
      )
      pending.push(clipmap.pending)
    }
    step(update)
    for (let k = 0; k < 4; k += 1) step(stillAt(update))
    // A pass a layer: three a level.
    expect(counts).toEqual([9, 3, 3, 3, 3])
    expect(pending).toEqual([true, true, true, false, false])
    // Warmed at 1 × 1 × 18: the full-size draws build nothing.
    expect(gpu.pipelinesBuilt()).toBe(pipelines)

    counts.length = 0
    pending.length = 0
    for (let k = 0; k < 6; k += 1) step(rebuiltAt(update))
    // A cut every frame: 0, 1 and the coarse level stale longest.
    expect(counts).toEqual([9, 9, 9, 9, 9, 9])
    counts.length = 0
    step(stillAt(update), true)
    expect(counts).toEqual([9])
    for (let k = 0; k < 3; k += 1) step(stillAt(update))
    expect(pending.at(-1)).toBe(false)
    clipmap.dispose()
  })

  it('holds one level a texture, its declared bytes its own, and nothing before it warms', async () => {
    const uniforms = fieldUniforms()
    const clipmap = new CloudClipmap(
      uniforms,
      analyticMapNodes(uniforms.served, noise.nodes),
      profileOf(uniforms)!,
    )
    expect(clipmap.bytes).toBe(0)
    expect(clipmap.textures()).toEqual([])
    expect(clipmap.pending).toBe(false)
    await clipmap.warm(renderer)
    expect(clipmap.bytes).toBe(LAYERS * 4)
    const weather = regimeWeather(SERVED_EARTH, 'fog')
    const eye = scaled(EYE_DIRECTION, EARTH + 100)
    clipmap.render(
      renderer,
      frameAt(uniforms, weather, 'fog', EARTH, eye, levels(eye, EARTH, null)),
      budget,
    )
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }
    const texelBytes: Record<string, number> = { rgba8unorm: 4 }
    let bytes = 0
    const formats: string[] = []
    for (const held of clipmap.textures()) {
      const gpuTexture = backend.get(held).texture!
      expect(gpuTexture.mipLevelCount).toBe(1)
      formats.push(gpuTexture.format)
      bytes +=
        gpuTexture.width *
        gpuTexture.height *
        gpuTexture.depthOrArrayLayers *
        texelBytes[gpuTexture.format]!
    }
    expect(formats).toEqual(['rgba8unorm'])
    expect(clipmap.bytes).toBe(bytes)
    // 4.72 MB, against phase 0's four RGBA8 targets' 6.29 MB and the
    // design's two, 3.15 MB: the gain rides in the column.
    expect(clipmap.bytes).toBe(256 * 256 * LAYERS * 4)
    clipmap.dispose()
    expect(clipmap.bytes).toBe(0)
  })
})

describe('freshness by generation, and the pace', () => {
  it('after a change of weather, with the cube baked a face a frame, no level reports fresh while it holds the old cover, and a texel read after the settle holds the new', async () => {
    // 16 km from a cube corner, so even level 0 reads three faces, which
    // the cube bakes over three frames: levels 0 and 1, rebuilt the frame
    // of the change from the first face alone, hold the old weather over
    // the other two until those are baked.
    const eye = scaled(unit({ x: 1, y: 1.003, z: 0.997 }), EARTH + 1500)
    const overcast = regimeWeather(SERVED_EARTH, 'overcast')
    const decks = regimeWeather(SERVED_EARTH, 'two-decks')
    const { uniforms, maps, clipmap, update } = await bakedPair(
      overcast,
      'overcast',
      EARTH,
      eye,
    )
    const [texel] = clipmap.textures()
    // Every level's texels on a 9 × 9 grid over its window: the eye's own
    // face, and on the coarse levels its neighbors.
    const grid = Array.from({ length: 9 }, (_, n) => 2 + n * 31)
    const probes = update.frames.flatMap((frame, k) =>
      grid.flatMap((i) =>
        grid.map(
          (j) =>
            [
              wrapped(frame.origin[0] + i),
              wrapped(frame.origin[1] + j),
              3 * k,
            ] as const,
        ),
      ),
    )
    const held = async () => {
      const read = await loadTexels(texel!, '2d-array', probes)
      return probes.map((_, n) => read[n * 4]!)
    }
    const at = () =>
      frameAt(uniforms, decks, 'two-decks', EARTH, eye, stillAt(update))
    const frames: { pending: boolean; old: boolean }[] = []
    for (let k = 0; k < 12; k += 1) {
      const frame = at()
      maps.render(renderer, frame, budget)
      clipmap.render(renderer, frame, budget)
      const covers = await held()
      frames.push({
        pending: clipmap.pending,
        old: covers.some((cover) => Math.abs(cover - 1) < 1e-3),
      })
    }
    // Fresh never while any level holds overcast's cover.
    for (const frame of frames) if (frame.old) expect(frame.pending).toBe(true)
    const whole = frames.findIndex((frame) => !frame.pending)
    expect(whole).toBeGreaterThan(0)
    expect(whole).toBeLessThan(12)
    expect(frames[whole]!.old).toBe(false)
    expect((await held()).every((cover) => Math.abs(cover - 0.6) < 1e-3)).toBe(
      true,
    )
    clipmap.dispose()
    maps.dispose()
  })

  it('bakes nothing while no face it reads is redrawn, then an eighth a frame', async () => {
    // Earth's zonal climate: its cube is due 78 s after a bake, a face a
    // frame, and each level then refreshes an eighth a frame from it.
    const weather = bodyWeather(SERVED_EARTH)!
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const { uniforms, maps, clipmap, update } = await bakedPair(
      weather,
      'climate',
      EARTH,
      eye,
    )
    const at = (seconds: number) => {
      const frame = frameAt(
        uniforms,
        weather,
        'climate',
        EARTH,
        eye,
        stillAt(update),
        false,
        TIME + seconds,
      )
      maps.render(renderer, frame, budget)
      return passesDuring(() => clipmap.render(renderer, frame, budget))
    }
    const steady = Array.from({ length: 60 }, (_, k) => at((k + 1) / 60))
    expect(steady.every((passes) => passes === 0)).toBe(true)
    // At 80 s the cube redraws its faces, one a frame, and the levels that
    // read them follow, an eighth of one a frame, three layers each.
    const late = Array.from({ length: 12 }, (_, k) => at(80 + k / 60))
    expect(late.every((passes) => passes === 0 || passes === 3)).toBe(true)
    expect(late.filter((passes) => passes === 3).length).toBeGreaterThan(8)
    expect(clipmap.pending).toBe(false)
    clipmap.dispose()
    maps.dispose()
  })
})
