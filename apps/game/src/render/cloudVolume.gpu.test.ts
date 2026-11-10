import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Node, StorageBufferAttribute, type Texture } from 'three/webgpu'
import {
  abs,
  cos,
  dot,
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  length,
  Loop,
  max,
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
  directionOf,
  type LevelFrame,
  levelFrames,
  shellBoundaries,
  reducePoint,
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
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import { SUN_GRID_SIZE } from './cloudSunGrid.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_SLICES,
  CLOUD_VOLUME_TEXELS,
  CloudVolume,
} from './cloudVolume.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The local volume on the GPU (§3.11): it bakes the field it is handed at
 * its texels' centers, its guard slices stop each level's filter, its
 * schedule bakes what goes missing first, and a window that scrolls ends
 * where a fresh one starts. The field here is analytic, built from the sample alone.
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
/** One layer over the volume's whole union: 32 slices of 50 m. */
const BASE = 1000
const TOP = 2600
const SIGMA = 0.05
const SCENARIO: WeatherScenario = {
  id: 'fair-cumulus',
  layers: [
    {
      genus: 'cumulus',
      base: BASE,
      top: TOP,
      coverage: 1,
      sigma: SIGMA,
      cellMeters: 1200,
      // No erosion: the bake and the read are the field's, nothing added.
      erosion: 0,
      radius: 8,
    },
  ],
  wind: { east: 0, north: 0 },
  pattern: 'uniform',
  patternScale: 0,
  patternPeriod: 0,
}
const SLICE = (TOP - BASE) / CLOUD_VOLUME_SLICES
const STACK = CLOUD_VOLUME_SLICES + 2
const LEVERS = { ...DEFAULT_CLOUD_LEVERS, on: true }
const BUDGET: CloudBudget = {
  slices: 8,
  tiles: 1,
  jump: false,
  sunSlices: SUN_GRID_SIZE[2],
}
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

/** A direction off every axis, so no face, anchor or basis is a special case. */
const UP = unit({ x: 0.31, y: 0.89, z: 0.2 })
const SUN = unit({ x: 0.5, y: 0.8, z: -0.3 })

/** The eye at `height` over the datum along UP, moved `east` and `north` meters along its horizon. */
function eyeAt(height: number, east = 0, north = 0): Vec3 {
  const center = scale(UP, R + height)
  const frames = levelFrames(center, R, [50], 256, null).frames[0]!
  return add(add(center, scale(frames.east, east)), scale(frames.north, north))
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

/**
 * A frame as `cloudFrame` builds it for the served body, from the clipmap's
 * and the volume's own level frames, carried from `previous`: what `uniforms.write`
 * and the resources read.
 */
function frameAt(
  eye: Vec3,
  previous: CloudFrame | null,
  options: {
    readonly jump?: boolean
    /** Build the caches' frames from none, as `cloudFrame` does under a cut, the frame count carried. */
    readonly cut?: boolean
    readonly scenario?: WeatherScenario
  } = {},
): CloudFrame {
  const scenario = options.scenario ?? SCENARIO
  const caches = options.cut === true ? null : (previous?.served ?? null)
  const shells = shellHeights(eye, R, shellBoundaries(scenario))
  const served: CloudBodyFrame = {
    address: 'test',
    datumRadius: R,
    compression: 1,
    toBodyFixed: { x: 0, y: 0, z: 0, w: 1 },
    eye,
    sun: SUN,
    shells,
    scattering: null,
    limb: 0,
    limbFalloff: 0,
    dayColor: { r: 1, g: 1, b: 1 },
    // The eye reduced into the test fields' period, as the real field's
    // origin is reduced into the noise's: a field read at this plus the
    // offset holds still while the eye moves.
    noiseOrigin: reducePoint(eye, FIELD_PERIOD),
    detailOrigin: ZERO,
    drift: ZERO,
    wind: ZERO,
    clipmap: levelFrames(
      eye,
      R,
      CLOUD_CLIPMAP_TEXELS,
      CLOUD_CLIPMAP_SIZE,
      caches?.clipmap.frames ?? null,
    ),
    volume: levelFrames(
      eye,
      R,
      CLOUD_VOLUME_TEXELS,
      CLOUD_VOLUME_SIZE,
      caches?.volume.frames ?? null,
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
    levers: LEVERS,
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
    jump: options.jump ?? false,
    frameIndex: previous === null ? 0 : previous.frameIndex + 1,
    extents: cloudExtents(extent, extent),
  }
}

/** Noise nodes that read nothing: the scenario erodes nothing. */
const NO_NOISE: CloudNoiseNodes = {
  base: () => float(0),
  detail: () => float(0),
}

interface Rig {
  readonly uniforms: CloudUniforms
  readonly volume: CloudVolume
  frame: CloudFrame | null
  /** Render a frame at `eye`; returns it. */
  step(
    eye: Vec3,
    options?: { readonly jump?: boolean; readonly cut?: boolean },
  ): CloudFrame
  /** Render at `eye` until nothing is pending; returns the frames it took. */
  settle(eye: Vec3): number
}

function rig(medium: CloudMediumFn): Rig {
  const uniforms = createCloudUniforms()
  const volume = new CloudVolume({ uniforms, bake: medium, detail: NO_NOISE })
  const state: Rig = {
    uniforms,
    volume,
    frame: null,
    step(eye, options = {}) {
      const frame = frameAt(eye, state.frame, options)
      uniforms.write(frame)
      volume.render(gpu.renderer, frame, BUDGET)
      state.frame = frame
      return frame
    },
    settle(eye) {
      let frames = 0
      do {
        state.step(eye)
        frames += 1
      } while (volume.pending && frames < 64)
      return frames
    },
  }
  return state
}

/** A medium from a function of the sample's offset and height, inside the layer. */
function analytic(
  sigma: (offset: Node<'vec3'>, height: Node<'float'>) => Node<'float'>,
  fraction: (offset: Node<'vec3'>) => Node<'float'> = () => float(1),
): CloudMediumFn {
  return (sample) => {
    const inside = sample.altitude
      .greaterThanEqual(BASE)
      .and(sample.altitude.lessThan(TOP))
    return {
      sigma: select(inside, sigma(sample.offset, sample.altitude), float(0)),
      fraction: select(inside, fraction(sample.offset), float(0)),
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

/** Texels of a 3D texture by integer coordinate: textureLoad, nothing filtered. */
async function texels(
  map: Texture,
  at: readonly (readonly [number, number, number])[],
): Promise<number[][]> {
  const read = texture3D(map)
  const out = await run(
    at.length,
    new Float32Array(at.flat()),
    3,
    2,
    (r, w) => {
      const texel = read.load(ivec3(int(r(0)), int(r(1)), int(r(2))))
      w(0, texel.x)
      w(1, texel.y)
    },
  )
  return at.map((_, k) => [out[k * 2]!, out[k * 2 + 1]!])
}

/** A sample of the volume's medium at an eye-relative offset, as a march forms one. */
function sampleAt(
  uniforms: CloudUniforms,
  offset: Node<'vec3'>,
  footprint = 1e6,
): CloudSample {
  const body = uniforms.served
  return {
    offset,
    distance: length(offset),
    altitude: altitudeAt(body, offset),
    sunMu: sunMuAt(body, offset),
    // Coarser than every level: no erosion is added to the cached field.
    footprint: float(footprint),
  }
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

/** The eye-relative offset of a level's lattice point at a height, in float64. */
function latticeOffset(
  frame: LevelFrame,
  eye: Vec3,
  i: number,
  j: number,
  height: number,
): Vec3 {
  const direction = directionOf(
    frame,
    [i * frame.texelMeters, j * frame.texelMeters],
    R,
  )
  return sub(scale(direction, R + height), eye)
}

/** RG8's step: what a stored texel is held to. */
const BYTE = 1 / 255
const EYE_HEIGHT = 1500

/* ------------------------------------------------------------------------- */
/* The bake                                                                   */
/* ------------------------------------------------------------------------- */

describe('the bake', () => {
  // A field with structure across every level and up the slices, its
  // extinction and its fraction both varying.
  const east = levelFrames(scale(UP, R + EYE_HEIGHT), R, [50], 256, null)
    .frames[0]!.east
  const north = levelFrames(scale(UP, R + EYE_HEIGHT), R, [50], 256, null)
    .frames[0]!.north
  const E = vec3(east.x, east.y, east.z)
  const N = vec3(north.x, north.y, north.z)
  const sigmaOf = (o: Vec3, h: number): number =>
    SIGMA *
    (0.5 +
      0.25 * Math.sin(dot3(o, east) / 730) +
      0.2 * Math.cos(dot3(o, north) / 1170 + (h - BASE) / 400))
  const fractionOf = (o: Vec3): number =>
    0.55 + 0.4 * Math.sin(dot3(o, north) / 910)
  const medium = analytic(
    (o, h) =>
      float(SIGMA).mul(
        float(0.5)
          .add(sin(dot(o, E).div(730)).mul(0.25))
          .add(cos(dot(o, N).div(1170).add(h.sub(BASE).div(400))).mul(0.2)),
      ),
    (o) => float(0.55).add(sin(dot(o, N).div(910)).mul(0.4)),
  )

  it('holds the field at every level’s texel centers, within the √ encoding’s step', async () => {
    const test = rig(medium)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const frame = test.frame!
    const [map] = test.volume.textures()
    const next = draws(5)
    const at: [number, number, number][] = []
    const expected: [number, number][] = []
    for (let n = 0; n < 600; n += 1) {
      const L = n % 3
      const level = frame.served.volume.frames[L]!
      const x = Math.floor(next() * CLOUD_VOLUME_SIZE)
      const y = Math.floor(next() * CLOUD_VOLUME_SIZE)
      const k = 1 + Math.floor(next() * CLOUD_VOLUME_SLICES)
      const mod = (v: number) =>
        ((v % CLOUD_VOLUME_SIZE) + CLOUD_VOLUME_SIZE) % CLOUD_VOLUME_SIZE
      const i = level.origin[0] + mod(x - level.origin[0])
      const j = level.origin[1] + mod(y - level.origin[1])
      const height = BASE + (k - 0.5) * SLICE
      const o = latticeOffset(level, eye, i + 0.5, j + 0.5, height)
      at.push([x, y, L * STACK + k])
      expected.push([Math.sqrt(sigmaOf(o, height) / SIGMA), fractionOf(o)])
    }
    const read = await texels(map!, at)
    read.forEach(([r, g], n) => {
      expect(Math.abs(r! - expected[n]![0])).toBeLessThanOrEqual(BYTE)
      expect(Math.abs(g! - expected[n]![1])).toBeLessThanOrEqual(BYTE)
    })
    test.volume.dispose()
  })

  it('repeats each level’s edge slices in its guards, so its filter never reaches the next level', async () => {
    const test = rig(medium)
    test.settle(eyeAt(EYE_HEIGHT))
    const [map] = test.volume.textures()
    const next = draws(6)
    const at: [number, number, number][] = []
    for (let n = 0; n < 60; n += 1) {
      const L = n % 3
      const x = Math.floor(next() * CLOUD_VOLUME_SIZE)
      const y = Math.floor(next() * CLOUD_VOLUME_SIZE)
      at.push(
        [x, y, L * STACK],
        [x, y, L * STACK + 1],
        [x, y, L * STACK + STACK - 1],
        [x, y, L * STACK + STACK - 2],
      )
    }
    const read = await texels(map!, at)
    for (let n = 0; n < read.length; n += 2) {
      expect(read[n]).toEqual(read[n + 1])
    }
    // Not trivially: the bottom and top slices differ.
    expect(
      read.some((texel, n) => n % 4 === 0 && texel[0] !== read[n + 2]![0]),
    ).toBe(true)
    test.volume.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* The schedule                                                               */
/* ------------------------------------------------------------------------- */

describe('the schedule', () => {
  const field = analytic(() => float(SIGMA / 2))

  it('bakes level 0 whole the frame it goes missing, and levels 1 and 2 at the budget after', () => {
    const test = rig(field)
    const eye = eyeAt(EYE_HEIGHT)
    test.step(eye)
    expect(test.volume.drawn).toEqual([STACK, 0, 0])
    expect(test.volume.pending).toBe(true)
    let frames = 1
    while (test.volume.pending) {
      test.step(eye)
      expect(test.volume.drawn.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        8,
      )
      frames += 1
    }
    // 68 slices of levels 1 and 2 at 8 a frame.
    expect(frames).toBe(1 + Math.ceil((2 * STACK) / 8))
    // Then the refresh: the oldest eight a frame.
    test.step(eye)
    expect(test.volume.drawn.reduce((a, b) => a + b, 0)).toBe(8)
    // A jump: level 0 whole again.
    test.step(eye, { jump: true })
    expect(test.volume.drawn[0]).toBe(STACK)
    test.volume.dispose()
  })

  it('bakes level 0 whole on a cut, where every level’s epoch stands at the 0 it had', () => {
    const test = rig(field)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const before = test.frame!.served.volume.frames
    const cut = test.step(eye, { cut: true })
    // No anchor has moved, so the cut's frames are the settled ones, epoch
    // and all, and the levels' `rebuilt` is the only word of it.
    expect(cut.served.volume.frames).toEqual(before)
    expect(cut.served.volume.rebuilt).toEqual([true, true, true])
    expect(test.volume.drawn[0]).toBe(STACK)
    expect(test.volume.pending).toBe(true)
    test.volume.dispose()
  })

  it('bakes nothing from orbit and owes nothing, and the medium there is the field', async () => {
    const test = rig(field)
    const eye = eyeAt(400_000)
    test.step(eye)
    test.step(eye)
    expect(test.volume.drawn).toEqual([0, 0, 0])
    expect(test.volume.pending).toBe(false)
    // A sample in the union below: no level is trusted, so the field answers.
    const below = latticeOffset(
      test.frame!.served.volume.frames[0]!,
      eye,
      test.frame!.served.volume.frames[0]!.eye[0] / 50,
      test.frame!.served.volume.frames[0]!.eye[1] / 50,
      1800,
    )
    const out = await run(
      1,
      new Float32Array([below.x, below.y, below.z]),
      3,
      1,
      (read, write) => {
        const sample = sampleAt(test.uniforms, vec3(read(0), read(1), read(2)))
        write(0, test.volume.medium(sample, test.uniforms.served).sigma)
      },
    )
    expect(out[0]).toBeCloseTo(SIGMA / 2, 7)
    test.volume.dispose()
  })

  it('owes nothing from orbit after a climb, whatever its idle levels still hold', () => {
    // Filled near the deck, then carried to orbit and along it: the levels
    // are idle there with their slices at windows the eye has left, and no
    // frame will redraw them.
    const test = rig(field)
    test.settle(eyeAt(EYE_HEIGHT))
    expect(test.volume.pending).toBe(false)
    test.step(eyeAt(400_000))
    test.step(eyeAt(400_000, 5_000))
    expect(test.volume.drawn).toEqual([0, 0, 0])
    expect(test.volume.pending).toBe(false)
    test.volume.dispose()
  })

  it('holds one level of its texture, declares its bytes, and builds no pipeline after its warm-up', async () => {
    const test = rig(field)
    expect(test.volume.bytes).toBe(0)
    await test.volume.warm(gpu.renderer)
    const render = gpu.pipelinesBuilt()
    const compute = gpu.computePipelinesBuilt()
    test.settle(eyeAt(EYE_HEIGHT))
    // The slices drawn at their real size on the pipeline the 1 × 1 target
    // warmed: a pipeline is the format's, not the size's.
    expect(gpu.pipelinesBuilt()).toBe(render)
    expect(gpu.computePipelinesBuilt()).toBe(compute)
    expect(test.volume.bytes).toBe(
      CLOUD_VOLUME_SIZE * CLOUD_VOLUME_SIZE * 3 * STACK * 2,
    )
    const backend = gpu.renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    const textures = test.volume.textures()
    expect(textures).toHaveLength(1)
    expect(backend.get(textures[0]!).texture.mipLevelCount).toBe(1)
    test.volume.dispose()
    expect(test.volume.bytes).toBe(0)
  })
})

/* ------------------------------------------------------------------------- */
/* The scroll                                                                 */
/* ------------------------------------------------------------------------- */

describe('a window that scrolls', () => {
  // Fixed to the body, so the cloud holds still as the eye moves: periodic
  // on each axis in the period the origin is reduced into.
  const wave = (world: Node<'float'>, k: number): Node<'float'> =>
    sin(world.mul((2 * Math.PI * k) / FIELD_PERIOD))
  const field: CloudMediumFn = (sample, body) =>
    analytic((o, h) => {
      const world = body.noiseOrigin.add(o)
      return float(SIGMA).mul(
        float(0.5).add(
          wave(world.x, 31)
            .add(wave(world.y, 29))
            .add(wave(world.z, 37))
            .add(sin(h.div(170)))
            .mul(0.11),
        ),
      )
    })(sample, body)

  /** The largest difference between two volumes' texels, every texel compared on the GPU. */
  async function largestDifference(a: Texture, b: Texture): Promise<number> {
    const rows = CLOUD_VOLUME_SIZE * 3 * STACK
    const left = texture3D(a)
    const right = texture3D(b)
    const out = await run(rows, new Float32Array(1), 0, 1, (_, write) => {
      const y = int(instanceIndex.mod(uint(CLOUD_VOLUME_SIZE)))
      const z = int(instanceIndex.div(uint(CLOUD_VOLUME_SIZE)))
      const largest = float(0).toVar()
      Loop(CLOUD_VOLUME_SIZE, ({ i }) => {
        const at = ivec3(i, y, z)
        const d = left.load(at).sub(right.load(at))
        largest.assign(max(largest, max(abs(d.x), abs(d.y))))
      })
      write(0, largest)
    })
    return Math.max(...out)
  }

  it('ends, once every slice has been drawn at the new window, where a volume built there begins', async () => {
    // 130 m east: level 0's window moves by two or three texels, levels 1
    // and 2 by none or one, every anchor held.
    const before = eyeAt(EYE_HEIGHT)
    const after = eyeAt(EYE_HEIGHT, 130)
    const scrolled = rig(field)
    scrolled.settle(before)
    const origin = scrolled.frame!.served.volume.frames[0]!.origin
    scrolled.step(after)
    expect(scrolled.frame!.served.volume.frames[0]!.origin).not.toEqual(origin)
    expect(scrolled.frame!.served.volume.rebuilt).toEqual([false, false, false])
    expect(scrolled.volume.pending).toBe(true)
    const held = scrolled.frame!
    scrolled.settle(after)
    // Built from nothing at the new window, on the anchors the scroll held:
    // a fresh snap there may land in the next snap cell.
    const fresh = rig(field)
    fresh.frame = held
    fresh.settle(after)
    expect(fresh.frame!.served.volume.frames.map((f) => f.anchor)).toEqual(
      scrolled.frame!.served.volume.frames.map((f) => f.anchor),
    )
    // The same texels from the same field, but each read at an origin and
    // an offset two eyes 130 m apart round differently in float32: a value
    // on a rounding edge of RG8 lands a step apart.
    const steps =
      (await largestDifference(
        scrolled.volume.textures()[0]!,
        fresh.volume.textures()[0]!,
      )) / BYTE
    expect(Math.round(steps)).toBeLessThanOrEqual(1)
    scrolled.volume.dispose()
    fresh.volume.dispose()
  })
})
