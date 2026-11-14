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
  cloudFieldAt,
  directionOf,
  fieldClock,
  regimeWeather,
  type ScenarioId,
  type LevelFrame,
  levelFrames,
  levelProfile,
  shellBoundaries,
  reducePoint,
  shellHeights,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import { createInlineWorker, WorkerPool } from '@inertialref/workers'
import { createGameTaskRegistry } from '../workers/registry.ts'
import { type CloudField, createCloudField } from './cloudField.ts'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudBodyFrame,
  type CloudFrame,
  cloudFrame,
  scenarioWeather,
} from './cloudFrame.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type { CloudBudget, CloudMediumFn, CloudSample } from './cloudNodes.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_HELD,
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_SLICES,
  CLOUD_VOLUME_TEXELS,
  CloudVolume,
  VOLUME_SIGMA_SPAN,
} from './cloudVolume.ts'
import {
  LOOKING_UP,
  RIG_EARTH,
  rigFrameInputs,
  type RigStance,
} from './cloudSystemRig.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The local volume on the GPU (§2.5, §4.7): it holds two levels and no
 * bound, bakes the field it is handed at its texels' centers, stops each level's
 * filter with guard slices, comes back under the cap after the field
 * changes, redraws at the pace its field moves, waits for the maps it is
 * baked from, and a window that scrolls ends where a fresh one starts. The
 * field here is analytic, built from the sample alone.
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
/** Slices a frame: the `sunSlices` lever's default. */
const CAP = 8
/** The levels the volume holds. */
const LEVELS = CLOUD_VOLUME_HELD.length
const BUDGET: CloudBudget = {
  slices: CAP,
  tiles: 1,
  jump: false,
  sunSlices: CAP,
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
    /** Build the caches' frames from none, as `cloudFrame` does when the field changes, the frame count carried. */
    readonly cut?: boolean
    readonly scenario?: WeatherScenario
    /** The field's step of time this frame, seconds, and the wind it moves by, m/s. */
    readonly seconds?: number
    readonly wind?: number
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
    wind: scale(unit({ x: 1, y: 0, z: 0 }), options.wind ?? 0),
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
    frameSeconds: options.seconds ?? 0,
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

interface Rig {
  readonly uniforms: CloudUniforms
  readonly volume: CloudVolume
  frame: CloudFrame | null
  /** Render a frame at `eye`; returns it. */
  step(
    eye: Vec3,
    options?: {
      readonly jump?: boolean
      readonly cut?: boolean
      readonly seconds?: number
      readonly wind?: number
    },
  ): CloudFrame
  /** Render at `eye` until nothing is pending; returns the frames it took. */
  settle(eye: Vec3): number
}

function rig(
  medium: CloudMediumFn,
  sources?: readonly { readonly pending: boolean }[],
): Rig {
  const uniforms = createCloudUniforms()
  const volume = new CloudVolume({
    uniforms,
    bake: medium,
    ...(sources === undefined ? {} : { sources }),
  })
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
/**
 * The volume's texels against `cloudFieldAt`, in the level's reference σ′:
 * twice what this Mac mini's M6 reads, as the field's own port is bounded.
 */
const MEDIAN = 0.0105
const P99 = 0.0175
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

  it('holds the field’s extinction times its share at every level’s texel centers, within two steps of its sixteen bits', async () => {
    const test = rig(medium)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const frame = test.frame!
    const [map] = test.volume.textures()
    const span =
      test.uniforms.served.layers.sigmaScale.value * VOLUME_SIGMA_SPAN
    const next = draws(5)
    const at: [number, number, number][] = []
    const expected: number[] = []
    for (let n = 0; n < 600; n += 1) {
      const L = n % LEVELS
      const level = frame.served.volume.frames[CLOUD_VOLUME_HELD[L]!]!
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
      expected.push(sigmaOf(o, height) * fractionOf(o))
    }
    const read = await texels(map!, at)
    let worst = 0
    read.forEach(([high, low], n) => {
      // The high byte whole and the low one beside it, as the read decodes them.
      const held = ((high! * 256 + low!) * 255 * span) / 65535
      worst = Math.max(worst, Math.abs(held - expected[n]!))
    })
    // One step is the target's rounding of the low byte; the second is the
    // field's own float32, a 100 m offset under a planet's radius.
    expect(worst).toBeLessThanOrEqual((2 * span) / 65535)
    test.volume.dispose()
  })

  it('repeats each level’s edge slices in its guards, so its filter never reaches the next level', async () => {
    const test = rig(medium)
    test.settle(eyeAt(EYE_HEIGHT))
    const [map] = test.volume.textures()
    const next = draws(6)
    const at: [number, number, number][] = []
    for (let n = 0; n < 60; n += 1) {
      const L = n % LEVELS
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
  const total = (counts: readonly number[]): number =>
    counts.reduce((a, b) => a + b, 0)

  it('comes back at the cap, the finest level first, and a field that stands still is not baked again', () => {
    const test = rig(field)
    const eye = eyeAt(EYE_HEIGHT)
    const drawn: number[][] = []
    do {
      test.step(eye)
      drawn.push([...test.volume.drawn])
      expect(total(test.volume.drawn)).toBeLessThanOrEqual(CAP)
    } while (test.volume.pending)
    // 68 slices at 8 a frame: the 200 m level's 34, then the 800 m level's.
    // No level is baked at once.
    expect(drawn).toEqual([
      [8, 0],
      [8, 0],
      [8, 0],
      [8, 0],
      [2, 6],
      [0, 8],
      [0, 8],
      [0, 8],
      [0, 4],
    ])
    // The grid may bake from the frame after the one that made it whole.
    expect(test.volume.trusted).toBe(false)
    test.step(eye)
    expect(test.volume.trusted).toBe(true)
    expect(test.volume.drawn).toEqual([0, 0])
    // A jump: nothing held, and the cap again, never a level at once.
    const before = test.volume.generation
    test.step(eye, { jump: true })
    expect(test.volume.generation).toBe(before + 1)
    expect(test.volume.trusted).toBe(false)
    expect(test.volume.drawn).toEqual([CAP, 0])
    test.volume.dispose()
  })

  it('comes back at the cap when its frames are built from none, where every level’s epoch stands at the 0 it had', () => {
    const test = rig(field)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const before = test.frame!.served.volume.frames
    const cut = test.step(eye, { cut: true })
    // No anchor has moved, so the frames are the settled ones, epoch and
    // all, and the levels' `rebuilt` is the only word of it.
    expect(cut.served.volume.frames).toEqual(before)
    expect(cut.served.volume.rebuilt).toEqual([true, true, true])
    expect(test.volume.drawn).toEqual([CAP, 0])
    expect(test.volume.pending).toBe(true)
    test.volume.dispose()
  })

  it('redraws at the pace its field moves: a tenth of a 200 m texel at 25 m/s is 48 frames a level', () => {
    const test = rig(field)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const drawn = [0, 0]
    for (let n = 0; n < 96; n += 1) {
      test.step(eye, { seconds: 1 / 60, wind: 25 })
      test.volume.drawn.forEach((count, L) => (drawn[L]! += count))
      expect(total(test.volume.drawn)).toBeLessThanOrEqual(5)
      expect(test.volume.pending).toBe(false)
    }
    // 1.6 s: the 200 m level twice over, the 800 m level half.
    drawn.forEach((count, L) => {
      const asked = (2 * STACK) / 4 ** L
      expect(count).toBeGreaterThanOrEqual(asked - 1)
      expect(count).toBeLessThanOrEqual(asked)
    })
    test.volume.dispose()
  })

  it('bakes nothing while the maps it reads owe work, and comes back when they do not', () => {
    const maps = { pending: true }
    const test = rig(field, [maps])
    const eye = eyeAt(EYE_HEIGHT)
    for (let n = 0; n < 6; n += 1) {
      test.step(eye)
      expect(test.volume.drawn).toEqual([0, 0])
      expect(test.volume.pending).toBe(true)
      expect(test.volume.trusted).toBe(false)
    }
    maps.pending = false
    test.step(eye)
    expect(test.volume.drawn).toEqual([CAP, 0])
    test.volume.dispose()
  })

  it('bakes nothing from orbit and owes nothing, and the medium there is the field', async () => {
    const test = rig(field)
    const eye = eyeAt(400_000)
    test.step(eye)
    test.step(eye)
    expect(test.volume.drawn).toEqual([0, 0])
    expect(test.volume.pending).toBe(false)
    expect(test.volume.trusted).toBe(false)
    // A sample in the union below: no level is trusted, so the field answers.
    const level = test.frame!.served.volume.frames[1]!
    const below = latticeOffset(
      level,
      eye,
      level.eye[0] / level.texelMeters,
      level.eye[1] / level.texelMeters,
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
    expect(test.volume.drawn).toEqual([0, 0])
    expect(test.volume.pending).toBe(false)
    test.volume.dispose()
  })

  it('holds two levels in one texture of one mip and no bound beside it, declares the bytes the device holds, and builds no pipeline after its warm-up', async () => {
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
    // 256² × 68 of RG8: two levels, each with two guards.
    expect(test.volume.bytes).toBe(8_912_896)
    const backend = gpu.renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    const textures = test.volume.textures()
    expect(textures).toHaveLength(1)
    const held = backend.get(textures[0]!).texture
    expect(held.mipLevelCount).toBe(1)
    expect(held.format).toBe('rg8unorm')
    expect([held.width, held.height, held.depthOrArrayLayers]).toEqual([
      CLOUD_VOLUME_SIZE,
      CLOUD_VOLUME_SIZE,
      LEVELS * STACK,
    ])
    expect(held.width * held.height * held.depthOrArrayLayers * 2).toBe(
      test.volume.bytes,
    )
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
    const rows = CLOUD_VOLUME_SIZE * LEVELS * STACK
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
    // 450 m east: the 200 m level's window moves by two or three texels,
    // the 800 m level's by none or one, every anchor held.
    const before = eyeAt(EYE_HEIGHT)
    const after = eyeAt(EYE_HEIGHT, 450)
    const scrolled = rig(field)
    scrolled.settle(before)
    const origin = scrolled.frame!.served.volume.frames[1]!.origin
    scrolled.step(after)
    expect(scrolled.frame!.served.volume.frames[1]!.origin).not.toEqual(origin)
    // The slices at the window it has left, at the cap, and still trusted.
    expect(scrolled.volume.drawn).toEqual([CAP, 0])
    expect(scrolled.volume.trusted).toBe(true)
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
    // an offset two eyes 450 m apart round differently in float32: a value
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

/* ------------------------------------------------------------------------- */
/* The real field                                                             */
/* ------------------------------------------------------------------------- */

/** The system's own field, driven by frames built as the sensor builds them, over the rig's Earth. */
function realField(regime: ScenarioId): {
  readonly field: CloudField
  frame(): CloudFrame
  /** Frames until the volume is whole and owes nothing, or `most`. */
  settle(most: number): number
  dispose(): void
} {
  const field = createCloudField()
  const levers = { ...DEFAULT_CLOUD_LEVERS, on: true, weather: regime }
  const stance: RigStance = {
    eye: 2,
    looking: LOOKING_UP,
    air: true,
    sun: { x: 0, y: Math.sin(0.65), z: -Math.cos(0.65) },
  }
  const css = { width: 256, height: 144 }
  let previous: CloudFrame | null = null
  const frame = (): CloudFrame => {
    const next = cloudFrame(rigFrameInputs(stance, levers, css), previous)
    if (next === null) throw new Error('no frame: nothing served')
    previous = next
    field.write(next)
    field.render(gpu.renderer, next, {
      slices: levers.sunSlices,
      tiles: 1,
      jump: next.jump,
      sunSlices: levers.sunSlices,
    })
    return next
  }
  return {
    field,
    frame,
    settle(most) {
      for (let n = 1; n <= most; n += 1) {
        frame()
        if (field.volume.trusted && !field.volume.pending) return n
      }
      return most
    },
    dispose: () => field.dispose(),
  }
}

describe('the volume against the CPU field', () => {
  /*
   * Each level's texels against `cloudFieldAt` at their centers, read as the
   * bake reads the field: at the level's texel, the dither at one. In the
   * level's reference σ′, as the field's own port is held
   * (`cloudDensity.gpu.test.ts`), whose errors these carry: the clipmap's
   * bytes of cover and gain, half floats in the profile, float32 against
   * float64. The texel's own sixteen bits add 1/2,048 of the reference.
   */
  it.each([
    // Cumulus cells of 1,200 m: every level's texel is under a cell.
    ['fair-cumulus', ['resolved', 'resolved']],
    // Stratus cells of 3,000 m.
    ['overcast', ['resolved', 'resolved']],
    // Fog's cells are 500 m: the 800 m level is past a cell.
    ['fog', ['resolved', 'statistics']],
  ] as const)(
    '%s: every level holds the field at its texel, on the side of the switch its texel stands',
    async (regime, sides) => {
      const real = realField(regime)
      await Promise.all(real.field.bakes.map((bake) => bake.warm(gpu.renderer)))
      expect(real.settle(400)).toBeLessThan(400)
      const frame = real.frame()
      const { served } = frame
      const body = rigFrameInputs(
        { eye: 2, looking: LOOKING_UP },
        DEFAULT_CLOUD_LEVERS,
        { width: 8, height: 8 },
      ).record(RIG_EARTH)!
      const weather = regimeWeather(body, regime)
      const clock = fieldClock(weather, frame.time)
      const { boundaries } = served.shells
      const base = boundaries[0]!
      const top = boundaries[boundaries.length - 1]!
      const span =
        real.field.uniforms.served.layers.sigmaScale.value * VOLUME_SIGMA_SPAN
      const [map] = real.field.volume.textures()
      const next = draws(41)
      const at: [number, number, number][] = []
      const points: { level: number; position: Vec3 }[] = []
      for (let n = 0; n < 6000; n += 1) {
        const L = n % LEVELS
        const level = served.volume.frames[CLOUD_VOLUME_HELD[L]!]!
        const x = Math.floor(next() * CLOUD_VOLUME_SIZE)
        const y = Math.floor(next() * CLOUD_VOLUME_SIZE)
        const k = 1 + Math.floor(next() * CLOUD_VOLUME_SLICES)
        const mod = (v: number) =>
          ((v % CLOUD_VOLUME_SIZE) + CLOUD_VOLUME_SIZE) % CLOUD_VOLUME_SIZE
        const i = level.origin[0] + mod(x - level.origin[0])
        const j = level.origin[1] + mod(y - level.origin[1])
        const height = base + ((k - 0.5) * (top - base)) / CLOUD_VOLUME_SLICES
        const direction = directionOf(
          level,
          [(i + 0.5) * level.texelMeters, (j + 0.5) * level.texelMeters],
          served.datumRadius,
        )
        at.push([x, y, L * STACK + k])
        points.push({
          level: L,
          position: scale(direction, served.datumRadius + height),
        })
      }
      const read = await texels(map!, at)
      const errors: number[][] = Array.from({ length: LEVELS }, () => [])
      const clouded = Array.from({ length: LEVELS }, () => 0)
      const fractions: number[][] = Array.from({ length: LEVELS }, () => [])
      points.forEach(({ level, position }, n) => {
        const texel = CLOUD_VOLUME_TEXELS[CLOUD_VOLUME_HELD[level]!]
        const want = cloudFieldAt(
          weather,
          clock,
          served.sun,
          position,
          texel,
          1,
        )
        if (want.level < 0) return
        const [high, low] = read[n]!
        const held = ((high! * 256 + low!) * 255 * span) / 65535
        const expected = want.fraction * want.sigma
        if (expected > 0) {
          clouded[level]! += 1
          fractions[level]!.push(want.fraction)
        }
        if (held > 0 || expected > 0)
          errors[level]!.push(
            Math.abs(held - expected) /
              levelProfile(weather.levels[want.level]!).scaled,
          )
      })
      const quantile = (values: number[], q: number): number =>
        [...values].sort((a, b) => a - b)[
          Math.min(values.length - 1, Math.floor(q * values.length))
        ] ?? 0
      console.info(
        `${regime}: ` +
          errors
            .map(
              (level, L) =>
                `${CLOUD_VOLUME_TEXELS[CLOUD_VOLUME_HELD[L]!]} m ${sides[L]}: ${clouded[L]} in cloud, median ${quantile(level, 0.5).toExponential(2)}, p99 ${quantile(level, 0.99).toExponential(2)}, worst ${Math.max(0, ...level).toExponential(2)}`,
            )
            .join('; '),
      )
      errors.forEach((level, L) => {
        expect(clouded[L], `${regime}, level ${L}`).toBeGreaterThan(40)
        expect(quantile(level, 0.5), `${regime}, level ${L}`).toBeLessThan(
          MEDIAN,
        )
        expect(quantile(level, 0.99), `${regime}, level ${L}`).toBeLessThan(P99)
        // The side of the switch: the resolved field is all cloud or none
        // at a point, and a level's statistics are a share of its columns.
        const whole = fractions[L]!.every((f) => f === 1)
        expect(whole, `${regime}, level ${L}`).toBe(sides[L] === 'resolved')
      })
      real.dispose()
    },
    120_000,
  )
})

describe('a table that lands late', () => {
  it('bakes nothing while the body’s tables are owed, starts over when they land, and the sun’s depth is whole within the schedule’s bound after', async () => {
    const real = realField('stratocumulus')
    const { field } = real
    await Promise.all(field.bakes.map((bake) => bake.warm(gpu.renderer)))
    // A pool that holds every answer until it is told to give them.
    const pool = new WorkerPool({
      factory: () => createInlineWorker(createGameTaskRegistry()),
      size: 1,
    })
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    field.profile.pool = {
      submit: (task: never, input: never) => ({
        result: gate.then(() => pool.submit(task, input).result),
      }),
    } as unknown as WorkerPool
    const weight = (): number => field.uniforms.trace.sunWeight.value
    const baked = (): number =>
      field.volume.drawn.reduce((a, b) => a + b, 0) + field.grid.drawn
    for (let n = 0; n < 40; n += 1) {
      real.frame()
      expect(baked()).toBe(0)
      expect(weight()).toBe(0)
    }
    expect(field.profile.ready[0].value).toBe(0)
    expect(field.volume.pending).toBe(true)
    expect(field.volume.trusted).toBe(false)
    const generation = field.volume.generation
    // The tables land: the pool answers between frames.
    release()
    let landed = 0
    while (field.profile.ready[0].value === 0 && landed < 2000) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      real.frame()
      landed += 1
    }
    expect(field.profile.ready[0].value).toBe(1)
    // A field event of the volume's own, which the grid reads as one.
    expect(field.volume.generation).toBeGreaterThan(generation)
    // The cube's six faces and the clipmap again, 68 slices of the volume
    // and 32 of the grid at eight a frame, and sixteen frames of weight:
    // inside the rubric's 48.
    let frames = 0
    while (weight() < 1 && frames < 200) {
      real.frame()
      expect(field.volume.drawn.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        DEFAULT_CLOUD_LEVERS.sunSlices,
      )
      expect(field.grid.drawn).toBeLessThanOrEqual(
        DEFAULT_CLOUD_LEVERS.sunSlices,
      )
      frames += 1
    }
    console.info(
      `a late table: ${landed} frames to land, then ${frames} frames to the grid at full weight`,
    )
    expect(frames).toBeLessThanOrEqual(48)
    expect(field.volume.trusted).toBe(true)
    // And it holds cloud: the texels were baked with the table's gain in.
    const [map] = field.volume.textures()
    const at: [number, number, number][] = []
    const next = draws(9)
    for (let n = 0; n < 2000; n += 1)
      at.push([
        Math.floor(next() * CLOUD_VOLUME_SIZE),
        Math.floor(next() * CLOUD_VOLUME_SIZE),
        1 + Math.floor(next() * CLOUD_VOLUME_SLICES),
      ])
    const read = await texels(map!, at)
    expect(
      read.filter(([high, low]) => high! + low! > 0).length,
    ).toBeGreaterThan(100)
    pool.terminate()
    real.dispose()
  }, 180_000)
})
