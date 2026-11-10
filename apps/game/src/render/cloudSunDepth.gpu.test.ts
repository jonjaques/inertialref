import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Node, StorageBufferAttribute, type Texture } from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  select,
  sin,
  storage,
  texture3D,
  uint,
  vec2,
  vec3,
} from 'three/tsl'
import {
  cloudExtents,
  levelFrames,
  reducePoint,
  shellBoundaries,
  shellHeights,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudBodyFrame,
  type CloudFrame,
  scenarioWeather,
} from './cloudFrame.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import {
  CloudSunGrid,
  SUN_DEPTH_FRAME_CAP,
  SUN_GRID_SIZE,
} from './cloudSunGrid.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_TEXELS,
  CloudVolume,
} from './cloudVolume.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun's optical depth through the grid, on the GPU (§3.12): on a
 * uniform slab it answers σ times the slant path; a scroll ends where a
 * rebuild does; a sun turned past 0.05° rebuilds it whole; and no frame
 * spends past the cap.
 */

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

/* ------------------------------------------------------------------------- */
/* A frame                                                                    */
/* ------------------------------------------------------------------------- */

const R = 6_371_000
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }
/** Meters: what a field fixed to the body repeats over on each axis. */
const FIELD_PERIOD = 9600

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / l, y: v.y / l, z: v.z / l }
}
const scale = (v: Vec3, s: number): Vec3 => ({
  x: v.x * s,
  y: v.y * s,
  z: v.z * s,
})
const add = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
})
const sub = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
})
const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z

const UP = unit({ x: 0.31, y: 0.89, z: 0.2 })
const HORIZON = levelFrames(scale(UP, R), R, [50], 256, null).frames[0]!

/** A sun at `elevation` degrees over the eye's horizon, toward its east turned `azimuth` degrees north. */
function sunAt(elevation: number, azimuth = 20): Vec3 {
  const e = (elevation * Math.PI) / 180
  const a = (azimuth * Math.PI) / 180
  const across = add(
    scale(HORIZON.east, Math.cos(a)),
    scale(HORIZON.north, Math.sin(a)),
  )
  return unit(add(scale(across, Math.cos(e)), scale(UP, Math.sin(e))))
}

function eyeAt(height: number, east = 0, north = 0): Vec3 {
  return add(
    add(scale(UP, R + height), scale(HORIZON.east, east)),
    scale(HORIZON.north, north),
  )
}

function slabScenario(
  base: number,
  top: number,
  sigma: number,
): WeatherScenario {
  return {
    id: 'overcast',
    layers: [
      {
        genus: 'stratus',
        base,
        top,
        coverage: 1,
        sigma,
        cellMeters: 3000,
        erosion: 0,
        radius: 8,
      },
    ],
    wind: { east: 0, north: 0 },
    pattern: 'uniform',
    patternScale: 0,
    patternPeriod: 0,
  }
}

/**
 * A scenario's key as a frame carries it. One a scenario object, since the
 * scenarios here are built by hand and share an id: every bake starts over
 * on a new key, as it does on a new weather.
 */
const WEATHER_KEYS = new WeakMap<WeatherScenario, string>()
function weatherKeyOf(scenario: WeatherScenario): string {
  let key = WEATHER_KEYS.get(scenario)
  if (key === undefined) {
    key = `${scenario.id} ${WEATHER_KEY_COUNT.next}`
    WEATHER_KEY_COUNT.next += 1
    WEATHER_KEYS.set(scenario, key)
  }
  return key
}
const WEATHER_KEY_COUNT = { next: 0 }

function frameAt(
  eye: Vec3,
  sun: Vec3,
  scenario: WeatherScenario,
  levers: CloudLevers,
  previous: CloudFrame | null,
  jump = false,
): CloudFrame {
  const shells = shellHeights(eye, R, shellBoundaries(scenario))
  const served: CloudBodyFrame = {
    address: 'test',
    datumRadius: R,
    compression: 1,
    toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
    eye,
    sun,
    shells,
    scattering: null,
    limb: 0,
    limbFalloff: 0,
    dayColor: { r: 1, g: 1, b: 1 },
    noiseOrigin: reducePoint(eye, FIELD_PERIOD),
    detailOrigin: ZERO,
    drift: ZERO,
    wind: ZERO,
    clipmap: levelFrames(
      eye,
      R,
      CLOUD_CLIPMAP_TEXELS,
      CLOUD_CLIPMAP_SIZE,
      previous?.served.clipmap.frames ?? null,
    ),
    volume: levelFrames(
      eye,
      R,
      CLOUD_VOLUME_TEXELS,
      CLOUD_VOLUME_SIZE,
      previous?.served.volume.frames ?? null,
    ),
    ...scenarioWeather(
      scenario,
      { noise: reducePoint(eye, FIELD_PERIOD), detail: ZERO },
      0,
    ),
    weatherKey: weatherKeyOf(scenario),
  }
  const camera = {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
    halfTan: Math.tan(Math.PI / 6),
    aspect: 1,
    pixelAngle: 0.004,
  }
  const extent = { width: 64, height: 64 }
  return {
    levers,
    scenario,
    served,
    second: null,
    time: 0,
    frameSeconds: 0,
    period: [0, 0],
    camera,
    previousCamera: null,
    translation: ZERO,
    enhanced: false,
    regime: 'converging',
    reset: 'none',
    jump,
    frameIndex: previous === null ? 0 : previous.frameIndex + 1,
    extents: cloudExtents(extent, extent),
  }
}

const NO_NOISE: CloudNoiseNodes = {
  base: () => float(0),
  detail: () => float(0),
}

const BUDGET: CloudBudget = {
  slices: 8,
  tiles: 1,
  jump: false,
  sunSlices: SUN_GRID_SIZE[2],
}

interface Rig {
  readonly uniforms: CloudUniforms
  readonly depth: CloudSunGrid & CloudSunDepthNodes
  readonly volume: CloudVolume
  frame: CloudFrame | null
  step(eye: Vec3, sun: Vec3, jump?: boolean): CloudFrame
  settle(eye: Vec3, sun: Vec3): number
}

/**
 * The grid over `medium`, summing through a volume that caches it — or,
 * `volume: false`, through a volume never drawn, which is the field itself
 * everywhere.
 */
function rig(
  medium: CloudMediumFn,
  scenario: WeatherScenario,
  options: { readonly volume?: boolean } = {},
): Rig {
  const cached = options.volume ?? true
  const uniforms = createCloudUniforms()
  const volume = new CloudVolume({ uniforms, bake: medium, detail: NO_NOISE })
  const depth = new CloudSunGrid(uniforms, volume)
  const levers = { ...DEFAULT_CLOUD_LEVERS, on: true }
  const state: Rig = {
    uniforms,
    depth,
    volume,
    frame: null,
    step(eye, sun, jump = false) {
      const frame = frameAt(eye, sun, scenario, levers, state.frame, jump)
      uniforms.write(frame)
      if (cached) volume.render(gpu.renderer, frame, BUDGET)
      depth.render(gpu.renderer, frame, BUDGET)
      state.frame = frame
      return frame
    },
    settle(eye, sun) {
      let frames = 0
      do {
        state.step(eye, sun)
        frames += 1
      } while ((depth.pending || (cached && volume.pending)) && frames < 64)
      return frames
    },
  }
  return state
}

function dispose(test: Rig): void {
  test.depth.dispose()
  test.volume.dispose()
}

/** A uniform slab between two heights over the datum. */
function slab(base: number, top: number, sigma: number): CloudMediumFn {
  return (sample) => {
    const inside = sample.altitude
      .greaterThanEqual(base)
      .and(sample.altitude.lessThan(top))
    return {
      sigma: select(inside, float(sigma), float(0)),
      fraction: select(inside, float(1), float(0)),
      layer: select(inside, int(0), int(-1)),
      column: float(1e9),
      radius: float(8),
      depth: vec2(0),
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Kernels                                                                    */
/* ------------------------------------------------------------------------- */

type Read = (k: number) => Node<'float'>
type Write = (k: number, value: Node<'float'>) => void

async function run(
  count: number,
  inputs: Float32Array,
  stride: number,
  outputs: number,
  body: (read: Read, write: Write) => void,
): Promise<Float32Array> {
  const input = new StorageBufferAttribute(inputs, 1)
  const output = new StorageBufferAttribute(
    new Float32Array(count * outputs),
    1,
  )
  const from = storage(input, 'float', inputs.length)
  const into = storage(output, 'float', count * outputs)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const at = instanceIndex.mul(stride)
      const to = instanceIndex.mul(outputs)
      body(
        (k) => from.element(at.add(k)),
        (k, value) => {
          into.element(to.add(k)).assign(value)
        },
      )
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

/** The optical depth each offset reads. */
async function depths(
  test: Rig,
  offsets: readonly Vec3[],
): Promise<Float32Array> {
  const inputs = new Float32Array(offsets.flatMap((o) => [o.x, o.y, o.z]))
  return run(offsets.length, inputs, 3, 1, (read, write) => {
    write(0, test.depth.depths(vec3(read(0), read(1), read(2))).toSun)
  })
}

/** Every cell of the grid, slice by slice. */
async function cells(map: Texture): Promise<Float32Array> {
  const [width, height, depth] = SUN_GRID_SIZE
  const count = width * height * depth
  const output = new StorageBufferAttribute(new Float32Array(count), 1)
  const into = storage(output, 'float', count)
  const read = texture3D(map)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const x = int(instanceIndex.mod(uint(width)))
      const y = int(instanceIndex.div(uint(width)).mod(uint(height)))
      const z = int(instanceIndex.div(uint(width * height)))
      into.element(instanceIndex).assign(read.load(ivec3(x, y, z)).x)
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
}

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

/** The far root of |P + sŝ|² = r²: where a ray from P along ŝ leaves the sphere. */
function leaves(point: Vec3, toward: Vec3, radius: number): number {
  const b = dot3(point, toward)
  const c = dot3(point, point) - radius * radius
  return -b + Math.sqrt(Math.max(b * b - c, 0))
}

/** The optical depth from an eye-relative point to the sun through a uniform slab, float64. */
function slabDepth(
  eye: Vec3,
  offset: Vec3,
  sun: Vec3,
  base: number,
  top: number,
  sigma: number,
): number {
  const point = add(eye, offset)
  const height = Math.hypot(point.x, point.y, point.z) - R
  const toTop = leaves(point, sun, R + top)
  if (height >= top) return 0
  if (height >= base) return sigma * toTop
  return sigma * (toTop - leaves(point, sun, R + base))
}

/* ------------------------------------------------------------------------- */
/* A uniform slab                                                             */
/* ------------------------------------------------------------------------- */

describe('a uniform slab', () => {
  const BASE = 1000
  const TOP = 2000
  const SIGMA = 0.01
  const scenario = slabScenario(BASE, TOP, 2 * SIGMA)
  const EYE = 300

  /** Points within a few kilometers of the eye, at heights from under the slab to its top. */
  function points(count: number, below: boolean): Vec3[] {
    const next = draws(below ? 31 : 32)
    const eye = eyeAt(EYE)
    return Array.from({ length: count }, () => {
      const height = below
        ? 400 + next() * 550
        : BASE + 30 + next() * (TOP - BASE - 60)
      const east = (next() - 0.5) * 8000
      const north = (next() - 0.5) * 8000
      const direction = unit(
        add(
          add(scale(UP, R), scale(HORIZON.east, east)),
          scale(HORIZON.north, north),
        ),
      )
      return sub(scale(direction, R + height), eye)
    })
  }

  for (const elevation of [37.5, 60])
    it(`gives σ times the slant path, within 2%, at a ${elevation}° sun`, async () => {
      const test = rig(slab(BASE, TOP, SIGMA), scenario)
      const eye = eyeAt(EYE)
      const sun = sunAt(elevation)
      test.settle(eye, sun)
      for (const below of [false, true]) {
        const offsets = points(512, below)
        const read = await depths(test, offsets)
        offsets.forEach((offset, k) => {
          const expected = slabDepth(eye, offset, sun, BASE, TOP, SIGMA)
          expect(Math.abs(read[k]! / expected - 1)).toBeLessThan(0.02)
        })
        // The plane-parallel form the design states, under the slab: the
        // sphere bends it by under a percent this close to the eye.
        if (below) {
          const mu = Math.sin((elevation * Math.PI) / 180)
          const flat = (SIGMA * (TOP - BASE)) / mu
          expect(Math.abs(read[0]! / flat - 1)).toBeLessThan(0.02)
        }
      }
      dispose(test)
    })
})

/* ------------------------------------------------------------------------- */
/* Scrolling, turning, and the cap                                           */
/* ------------------------------------------------------------------------- */

describe('a grid that moves', () => {
  const BASE = 1000
  const TOP = 2600
  const SIGMA = 0.03
  const scenario = slabScenario(BASE, TOP, SIGMA)
  const wave = (world: Node<'float'>, k: number): Node<'float'> =>
    sin(world.mul((2 * Math.PI * k) / FIELD_PERIOD))
  /** Cloud fixed to the body, periodic on each axis in the origin's period. */
  const field: CloudMediumFn = (sample, body) => {
    const world = body.noiseOrigin.add(sample.offset)
    const inside = sample.altitude
      .greaterThanEqual(BASE)
      .and(sample.altitude.lessThan(TOP))
    const sigma = float(SIGMA).mul(
      float(0.5).add(
        wave(world.x, 31)
          .add(wave(world.y, 29))
          .add(wave(world.z, 37))
          .mul(0.15),
      ),
    )
    return {
      sigma: select(inside, sigma, float(0)),
      fraction: select(inside, float(1), float(0)),
      layer: select(inside, int(0), int(-1)),
      column: float(1e9),
      radius: float(8),
      depth: vec2(0),
    }
  }
  const EYE = 500
  const SUN = sunAt(37.5)

  it('ends the grid’s scroll where a grid built at the new window begins', async () => {
    // Summed through the field itself, so the two grids read one medium
    // whatever their volumes' refresh has reached.
    const test = rig(field, scenario, { volume: false })
    test.settle(eyeAt(EYE), SUN)
    const origin = test.frame!.served.volume.frames[1]!.origin
    // Two cells east, on level 1's held anchor.
    const moved = eyeAt(EYE, 800)
    test.step(moved, SUN)
    expect(test.frame!.served.volume.rebuilt[1]).toBe(false)
    expect(test.depth.pending).toBe(true)
    const held = test.frame!
    test.settle(moved, SUN)
    const fresh = rig(field, scenario, { volume: false })
    fresh.frame = held
    fresh.settle(moved, SUN)
    expect(test.frame!.served.volume.frames[1]!.origin).not.toEqual(origin)
    const a = await cells(test.depth.textures()[0]!)
    const b = await cells(fresh.depth.textures()[0]!)
    let worst = 0
    for (let k = 0; k < a.length; k += 1)
      worst = Math.max(worst, Math.abs(a[k]! - b[k]!) / Math.max(b[k]!, 1e-2))
    // R16F's step, about two eyes 800 m apart rounding the same column.
    expect(worst).toBeLessThan(2 ** -9)
    dispose(test)
    dispose(fresh)
  })

  it('rebuilds whole when the sun turns past 0.05°, and not at 0.04°', () => {
    const test = rig(field, scenario)
    const eye = eyeAt(EYE)
    test.settle(eye, SUN)
    expect(test.depth.pending).toBe(false)
    test.step(eye, sunAt(37.5, 20.1))
    expect(test.depth.spent).toBe(SUN_DEPTH_FRAME_CAP)
    test.settle(eye, sunAt(37.5, 20.1))
    test.step(eye, sunAt(37.5, 20.14))
    expect(test.depth.spent).toBeLessThan(SUN_DEPTH_FRAME_CAP)
    dispose(test)
  })

  it('spends no frame past the cap: a cut, a jump, a turning sun, a flight', () => {
    const test = rig(field, scenario)
    const spent: number[] = []
    let east = 0
    for (let k = 0; k < 40; k += 1) {
      east += 128
      const azimuth = 20 + (k % 10 === 0 ? 0.2 * k : 0)
      test.step(eyeAt(EYE, east), sunAt(37.5, azimuth), k === 15)
      spent.push(test.depth.spent)
    }
    expect(Math.max(...spent)).toBeLessThanOrEqual(SUN_DEPTH_FRAME_CAP)
    // The first frame rebuilds whole, at the cap.
    expect(spent[0]).toBe(SUN_DEPTH_FRAME_CAP)
    dispose(test)
  })
})

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

describe('the grid as a resource', () => {
  it('holds one level of its texture, declares its bytes, builds no pipeline after its warm-up, and holds nothing once disposed', async () => {
    const backend = gpu.renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    const bytes = SUN_GRID_SIZE[0] * SUN_GRID_SIZE[1] * SUN_GRID_SIZE[2] * 2
    const test = rig(slab(1000, 2000, 0.01), slabScenario(1000, 2000, 0.02))
    expect(test.depth.bytes).toBe(0)
    await test.depth.warm(gpu.renderer)
    await test.volume.warm(gpu.renderer)
    const render = gpu.pipelinesBuilt()
    const compute = gpu.computePipelinesBuilt()
    test.settle(eyeAt(300), sunAt(37.5))
    expect(gpu.pipelinesBuilt()).toBe(render)
    expect(gpu.computePipelinesBuilt()).toBe(compute)
    expect(test.depth.bytes).toBe(bytes)
    const textures = test.depth.textures()
    expect(textures).toHaveLength(1)
    expect(backend.get(textures[0]!).texture.mipLevelCount).toBe(1)
    dispose(test)
    expect(test.depth.bytes).toBe(0)
  })
})
