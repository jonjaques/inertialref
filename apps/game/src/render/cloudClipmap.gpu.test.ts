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
  uint,
  vec4,
} from 'three/tsl'
import {
  CUBE_FACES,
  cloudExtents,
  directionOf,
  horizonBasis,
  type LevelFrame,
  type LevelUpdate,
  levelFrames,
  periodIndex,
  planeOf,
  reducePoint,
  shellBoundaries,
  shellHeights,
  WEATHER_SCENARIOS,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import { CloudClipmap, clipmapTexel } from './cloudClipmap.ts'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudFrame,
  cloudNoisePeriods,
} from './cloudFrame.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  CLOUD_CUBE_COLUMNS,
  CLOUD_CUBE_GUTTER,
  CLOUD_CUBE_TILE,
  CloudMaps,
  writeScenarioPattern,
} from './cloudMaps.ts'
import type { CloudBudget, CloudSample } from './cloudNodes.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The clipmap (§3.9): a strip update after a move is a full rebuild, texel
 * for texel; every level is the cube resampled at its texels' directions; a
 * lookup is the float64 projection of the sample, formed eye-relatively, to
 * float32's limit; the coverage reads the finest level holding the sample
 * and, in that level's outer fifth, the next one too; and a frame bakes what
 * §4.4's schedule says it does.
 *
 * A 200 km body: its blob cells are 4.9 km, eight of the cube's 613 m
 * texels, so the field varies across every level and a texel drawn in the
 * wrong place or read at the wrong one cannot hide.
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

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}
const scaled = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
})
const added = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})

/** A frame with every field the bundle writes, its clipmap given, copied into `uniforms`. */
function frameAt(
  uniforms: CloudUniforms,
  scenario: WeatherScenario,
  radius: number,
  eye: Vec3,
  clipmap: LevelUpdate,
  jump = false,
): CloudFrame {
  const periods = cloudNoisePeriods(scenario)
  const { east, north } = horizonBasis(eye)
  const frame = {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true, scenario: scenario.id },
    scenario,
    served: {
      address: 'test',
      datumRadius: radius,
      compression: 1,
      toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
      eye,
      sun: { x: 0, y: 1, z: 0 },
      shells: shellHeights(eye, radius, shellBoundaries(scenario)),
      scattering: null,
      limb: 0,
      limbFalloff: 1,
      dayColor: { r: 1, g: 1, b: 1 },
      noiseOrigin: reducePoint(eye, periods.base),
      detailOrigin: reducePoint(eye, periods.detail),
      drift: { x: 0, y: 0, z: 0 },
      wind: added(
        scaled(east, scenario.wind.east),
        scaled(north, scenario.wind.north),
      ),
      clipmap,
      volume: { frames: [], dirty: [], rebuilt: [] },
      cascades: { cascades: [], dirty: [], stale: [] },
    },
    second: null,
    time: TIME,
    frameSeconds: 0,
    period: periodIndex(TIME, scenario.patternPeriod),
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

/** Every texel of every level of a clipmap's four textures. */
async function everyTexel(clipmap: CloudClipmap): Promise<Float32Array[]> {
  const at: [number, number, number][] = []
  for (let k = 0; k < 6; k += 1)
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

/** A cube baked for `scenario` on a body of `radius`, and a clipmap baked from it at `eye`, every level whole. */
async function bakedPair(
  scenario: WeatherScenario,
  radius: number,
  eye: Vec3,
): Promise<{
  readonly uniforms: CloudUniforms
  readonly maps: CloudMaps
  readonly clipmap: CloudClipmap
  readonly update: LevelUpdate
}> {
  const uniforms = createCloudUniforms()
  const maps = new CloudMaps(uniforms)
  const clipmap = new CloudClipmap(uniforms, maps.nodes)
  await maps.warm(renderer)
  await clipmap.warm(renderer)
  const first = levels(eye, radius, null)
  frameAt(uniforms, scenario, radius, eye, first)
  for (let k = 0; k < 6; k += 1)
    maps.render(
      renderer,
      frameAt(uniforms, scenario, radius, eye, stillAt(first)),
      budget,
    )
  clipmap.render(
    renderer,
    frameAt(uniforms, scenario, radius, eye, first),
    budget,
  )
  for (let k = 0; k < 3; k += 1)
    clipmap.render(
      renderer,
      frameAt(uniforms, scenario, radius, eye, stillAt(first)),
      budget,
    )
  expect(clipmap.pending).toBe(false)
  return { uniforms, maps, clipmap, update: first }
}

const EYE_DIRECTION = unit({ x: 0.3, y: 0.9, z: -0.31 })

describe('the toroidal window', () => {
  it('a strip update after a move equals a full rebuild, texel for texel', async () => {
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { uniforms, maps, clipmap, update } = await bakedPair(
      scenario,
      SMALL,
      eye,
    )
    const { east, north } = horizonBasis(eye)
    const moved = added(eye, added(scaled(east, 3100), scaled(north, -1730)))
    const after = levels(moved, SMALL, update.frames)
    expect(after.rebuilt).toEqual([false, false, false, false, false, false])
    // Level 0 moves twelve texels east and seven south, level 3 one and none.
    expect(after.dirty[0]!.length).toBeGreaterThan(0)
    const passes = passesDuring(() =>
      clipmap.render(
        renderer,
        frameAt(uniforms, scenario, SMALL, moved, after),
        budget,
      ),
    )
    const strips = after.dirty.reduce((sum, rects) => sum + rects.length, 0)
    // The strips and one time-refresh slice.
    expect(passes).toBe(strips + 1)
    const scrolled = await everyTexel(clipmap)

    const fresh = new CloudClipmap(uniforms, maps.nodes)
    fresh.render(
      renderer,
      frameAt(uniforms, scenario, SMALL, moved, rebuiltAt(after)),
      budget,
    )
    for (let k = 0; k < 3; k += 1)
      fresh.render(
        renderer,
        frameAt(uniforms, scenario, SMALL, moved, stillAt(after)),
        budget,
      )
    expect(fresh.pending).toBe(false)
    const rebuilt = await everyTexel(fresh)
    let differing = 0
    scrolled.forEach((map, t) => {
      for (let n = 0; n < map.length; n += 1)
        if (map[n] !== rebuilt[t]![n]) differing += 1
    })
    expect(differing).toBe(0)
    // And the field is not constant there: a misplaced strip would show.
    const cover = scrolled[0]!
    let low = 1
    let high = 0
    for (let n = 0; n < SIZE * SIZE; n += 1) {
      low = Math.min(low, cover[n * 4]!)
      high = Math.max(high, cover[n * 4]!)
    }
    expect(high - low).toBeGreaterThan(0.5)
    clipmap.dispose()
    fresh.dispose()
    maps.dispose()
  })
})

describe('the levels are the cube, resampled', () => {
  it('a level texel holds the cube’s bilinear read at its center’s direction', async () => {
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { maps, clipmap, update } = await bakedPair(scenario, SMALL, eye)
    const next = draws(11)
    const probes = Array.from({ length: 600 }, () => {
      const k = Math.floor(next() * 6)
      const frame = update.frames[k]!
      const i = frame.origin[0] + Math.floor(next() * SIZE)
      const j = frame.origin[1] + Math.floor(next() * SIZE)
      const direction = directionOf(
        frame,
        [(i + 0.5) * frame.texelMeters, (j + 0.5) * frame.texelMeters],
        SMALL,
      )
      return { k, i, j, ...bilinear(...atlasCoordinates(direction)) }
    })
    const cube = await loadTexels(
      maps.textures()[0]!,
      '2d',
      probes.flatMap((p) => p.at),
    )
    const level = await loadTexels(
      clipmap.textures()[0]!,
      '2d-array',
      probes.map((p) => [wrapped(p.i), wrapped(p.j), p.k] as const),
    )
    let worst = 0
    probes.forEach((probe, n) => {
      for (let c = 0; c < 3; c += 1) {
        let expected = 0
        probe.weights.forEach((w, q) => {
          expected += w * cube[(n * 4 + q) * 4 + c]!
        })
        worst = Math.max(worst, Math.abs(level[n * 4 + c]! - expected))
      }
    })
    expect(worst).toBeLessThanOrEqual(RESAMPLED)
    clipmap.dispose()
    maps.dispose()
  })
})

describe('a lookup', () => {
  it('is the float64 projection of the sample, formed eye-relatively, at 100 km', async () => {
    // Earth, where an absolute float32 direction would carry 0.4 m. The
    // limit is float32's: a plane coordinate 100 km out carries 2.2 cm at
    // worst over twelve seeds (cloudGeometry.gpu.test.ts), so 3 cm.
    const uniforms = createCloudUniforms()
    const scenario = WEATHER_SCENARIOS['two-decks']
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const update = levels(eye, EARTH, null)
    frameAt(uniforms, scenario, EARTH, eye, update)
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

  it('the coverage is the finest holding level’s bilinear read, there and in its fade band', async () => {
    const scenario = WEATHER_SCENARIOS['fair-cumulus']
    const eye = scaled(EYE_DIRECTION, SMALL + 2000)
    const { uniforms, maps, clipmap, update } = await bakedPair(
      scenario,
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
    const read = await readAt(offsets, (offset) =>
      vec4(
        clipmap.nodes.coverage(sampleAt(offset), uniforms.served),
        clipmap.nodes.columnMeters(sampleAt(offset), uniforms.served),
      ),
    )
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
        for (const [i, j] of texels) loads.push([wrapped(i), wrapped(j), level])
      }
    const texels = await loadTexels(clipmap.textures()[0]!, '2d-array', loads)
    let worst = 0
    let banded = 0
    plan.forEach(({ k, at }, n) => {
      expect(k, `offset ${n}`).toBeGreaterThanOrEqual(0)
      const value = (slot: number, level: number) => {
        const { weights } = bilinear(at[level]!.x, at[level]!.y)
        let sum = 0
        weights.forEach((w, q) => {
          sum += w * texels[(n * 8 + slot * 4 + q) * 4]!
        })
        return sum
      }
      const fade = smooth(0.8 * (SIZE / 2), SIZE / 2 - 1, at[k]!.reach)
      if (fade > 0.05 && fade < 0.95) banded += 1
      const expected =
        k === 5
          ? (1 - fade) * value(0, 5)
          : (1 - fade) * value(0, k) + fade * value(1, k + 1)
      worst = Math.max(worst, Math.abs(read[n * 4]! - expected))
      expect(read[n * 4 + 3]).toBe(update.frames[k]!.texelMeters)
    })
    expect(worst).toBeLessThanOrEqual(RESAMPLED)
    expect(banded).toBeGreaterThan(10)
    clipmap.dispose()
    maps.dispose()
  })

  it('the fade band reads two levels: a level baked from another field than the next blends the two', async () => {
    // From the placeholder's function itself, so a scenario change lands in
    // the levels a frame rebuilds: one frame after overcast's cover of 1
    // gives way to two-decks' 0.6, levels 0–2 hold 0.6 and 3–5 still 1.
    const uniforms = createCloudUniforms()
    const clipmap = new CloudClipmap(uniforms)
    const eye = scaled(EYE_DIRECTION, EARTH + 1500)
    const update = levels(eye, EARTH, null)
    const overcast = WEATHER_SCENARIOS.overcast
    const decks = WEATHER_SCENARIOS['two-decks']
    writeScenarioPattern(uniforms, overcast)
    clipmap.render(
      renderer,
      frameAt(uniforms, overcast, EARTH, eye, update),
      budget,
    )
    for (let k = 0; k < 3; k += 1)
      clipmap.render(
        renderer,
        frameAt(uniforms, overcast, EARTH, eye, stillAt(update)),
        budget,
      )
    writeScenarioPattern(uniforms, decks)
    clipmap.render(
      renderer,
      frameAt(uniforms, decks, EARTH, eye, stillAt(update)),
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
        clipmap.nodes.coverage(sample, uniforms.served).x,
        clipmap.nodes.level(sample, uniforms.served, 2).x,
        clipmap.nodes.level(sample, uniforms.served, 3).x,
        clipmap.nodes.columnMeters(sample, uniforms.served),
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
    const decksCover = Math.round(0.6 * 255) / 255
    offsets.forEach((_, n) => {
      const [cover, here, there, meters] = [0, 1, 2, 3].map(
        (c) => read[n * 4 + c]!,
      )
      expect(Math.abs(here! - decksCover)).toBeLessThan(1e-6)
      expect(there).toBe(1)
      if (n === 0) {
        // Inside level 1's window: level 1 alone.
        expect(meters).toBe(500)
        expect(Math.abs(cover! - decksCover)).toBeLessThan(1e-6)
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
  it('a first frame rebuilds levels 0–2, then one more a frame; a still frame refreshes an eighth; a cut three', async () => {
    const uniforms = createCloudUniforms()
    const clipmap = new CloudClipmap(uniforms)
    const scenario = WEATHER_SCENARIOS['two-decks']
    writeScenarioPattern(uniforms, scenario)
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
            frameAt(uniforms, scenario, EARTH, eye, u, jump),
            budget,
          ),
        ),
      )
      pending.push(clipmap.pending)
    }
    step(update)
    for (let k = 0; k < 4; k += 1) step(stillAt(update))
    expect(counts).toEqual([3, 1, 1, 1, 1])
    expect(pending).toEqual([true, true, true, false, false])
    // Warmed at 1 × 1 × 6: the full-size draws build nothing.
    expect(gpu.pipelinesBuilt()).toBe(pipelines)

    counts.length = 0
    pending.length = 0
    for (let k = 0; k < 6; k += 1) step(rebuiltAt(update))
    // A cut every frame: 0, 1 and the coarse level stale longest.
    expect(counts).toEqual([3, 3, 3, 3, 3, 3])
    counts.length = 0
    step(stillAt(update), true)
    expect(counts).toEqual([3])
    for (let k = 0; k < 3; k += 1) step(stillAt(update))
    expect(pending.at(-1)).toBe(false)
    clipmap.dispose()
  })

  it('holds one level a texture, its declared bytes its own, and nothing before it warms', async () => {
    const uniforms = createCloudUniforms()
    const clipmap = new CloudClipmap(uniforms)
    expect(clipmap.bytes).toBe(0)
    expect(clipmap.textures()).toEqual([])
    expect(clipmap.pending).toBe(false)
    await clipmap.warm(renderer)
    expect(clipmap.bytes).toBe(6 * 16)
    const scenario = WEATHER_SCENARIOS.fog
    writeScenarioPattern(uniforms, scenario)
    const eye = scaled(EYE_DIRECTION, EARTH + 100)
    clipmap.render(
      renderer,
      frameAt(uniforms, scenario, EARTH, eye, levels(eye, EARTH, null)),
      budget,
    )
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture?: GPUTexture }
    }
    let bytes = 0
    for (const held of clipmap.textures()) {
      const gpuTexture = backend.get(held).texture!
      expect(gpuTexture.mipLevelCount).toBe(1)
      expect(gpuTexture.format).toBe('rgba8unorm')
      bytes +=
        gpuTexture.width * gpuTexture.height * gpuTexture.depthOrArrayLayers * 4
    }
    expect(clipmap.bytes).toBe(bytes)
    // 6.29 MB, §3.19's figure.
    expect(clipmap.bytes).toBe(256 * 256 * 6 * 16)
    clipmap.dispose()
    expect(clipmap.bytes).toBe(0)
  })
})
