import fc from 'fast-check'
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
  directionOf,
  genusProfileMean,
  type LevelFrame,
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
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import { sunPastTaps, sunStatistics } from './cloudMix.ts'
import {
  type CloudBudget,
  type CloudMediumFn,
  type CloudSample,
  slabMedium,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import {
  CloudSunGrid,
  type CloudSunSource,
  SUN_GRID_FADE,
  SUN_GRID_REACH,
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
 * The sun's depth through the grid, on the GPU (§5.5, §4.7): on a uniform
 * slab it answers σ times the slant path, from a sun over the horizon and
 * from one under it; it gives the ray's whole depth beside the depth to the
 * sun; it comes back under the cap after the field changes, with its weight
 * at zero until it is whole; its weight ends in a ramp from the eye; and
 * the layers' statistics agree with it where they can and stand in for it
 * where it holds nothing.
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
/** Slices a frame: the `sunSlices` lever's default, for the volume and for the grid. */
const CAP = 8
const RAMP = DEFAULT_CLOUD_LEVERS.sunRamp
const [, , SLICES] = SUN_GRID_SIZE
/** A level of the volume with its guards, and the levels it holds. */
const STACK = 34
const LEVELS = 3

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

type Slab = readonly [base: number, top: number, sigma: number]

/** Stratus layers of full cover, each reference extinction twice its slab's, so the volume's encoding has room. */
function slabScenario(...slabs: readonly Slab[]): WeatherScenario {
  return {
    id: 'overcast',
    layers: slabs.map(([base, top, sigma]) => ({
      genus: 'stratus' as const,
      base,
      top,
      coverage: 1,
      sigma: 2 * sigma,
      cellMeters: 3000,
      erosion: 0,
      radius: 8,
    })),
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

interface Moment {
  readonly jump?: boolean
  /** The field's step of time this frame, seconds, and the wind it moves by, m/s. */
  readonly seconds?: number
  readonly wind?: number
}

function frameAt(
  eye: Vec3,
  sun: Vec3,
  scenario: WeatherScenario,
  levers: CloudLevers,
  previous: CloudFrame | null,
  moment: Moment = {},
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
    wind: scale(HORIZON.east, moment.wind ?? 0),
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
    frameSeconds: moment.seconds ?? 0,
    period: [0, 0],
    camera,
    previousCamera: null,
    translation: ZERO,
    enhanced: false,
    regime: 'converging',
    reset: 'none',
    jump: moment.jump ?? false,
    frameIndex: previous === null ? 0 : previous.frameIndex + 1,
    extents: cloudExtents(extent, extent),
  }
}

const NO_NOISE: CloudNoiseNodes = {
  base: () => float(0),
  detail: () => float(0),
}

const BUDGET: CloudBudget = {
  slices: CAP,
  tiles: 1,
  jump: false,
  sunSlices: CAP,
}

interface Rig {
  readonly uniforms: CloudUniforms
  readonly depth: CloudSunGrid
  readonly volume: CloudVolume
  frame: CloudFrame | null
  step(eye: Vec3, sun: Vec3, moment?: Moment): CloudFrame
  /** Frames until neither cache owes anything: a rebuild, and the weight's rise. */
  settle(eye: Vec3, sun: Vec3): number
  /** The grid's weight as the trace reads it. */
  readonly weight: number
  /** The grid's level of the volume, as the last frame laid it out. */
  readonly level: LevelFrame
}

/**
 * The grid over `medium`, summing through a volume that caches it; or,
 * `volume: false`, through a volume never drawn, which is the field itself
 * everywhere and is called whole.
 */
function rig(
  medium: CloudMediumFn,
  scenario: WeatherScenario,
  options: { readonly volume?: boolean } = {},
): Rig {
  const cached = options.volume ?? true
  const uniforms = createCloudUniforms()
  const volume = new CloudVolume({ uniforms, bake: medium, detail: NO_NOISE })
  const field: CloudSunSource = {
    medium: volume.medium,
    trusted: true,
    generation: 0,
  }
  const depth = new CloudSunGrid(uniforms, cached ? volume : field)
  const levers = { ...DEFAULT_CLOUD_LEVERS, on: true }
  const state: Rig = {
    uniforms,
    depth,
    volume,
    frame: null,
    step(eye, sun, moment = {}) {
      const frame = frameAt(eye, sun, scenario, levers, state.frame, moment)
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
      } while ((depth.pending || (cached && volume.pending)) && frames < 200)
      return frames
    },
    get weight() {
      return uniforms.trace.sunWeight.value
    },
    get level() {
      return state.frame!.served.volume.frames[1]!
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
  return slabMedium([{ base, top, sigma }])
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

interface Depths {
  readonly toSun: number
  readonly whole: number
  readonly weight: number
  readonly behind: number
}

/** What the grid answers at each offset. */
async function depths(test: Rig, offsets: readonly Vec3[]): Promise<Depths[]> {
  const inputs = new Float32Array(offsets.flatMap((o) => [o.x, o.y, o.z]))
  const out = await run(offsets.length, inputs, 3, 4, (read, write) => {
    const got = test.depth.depths(vec3(read(0), read(1), read(2)))
    write(0, got.toSun)
    write(1, got.whole)
    write(2, got.weight)
    write(3, got.behind)
  })
  return offsets.map((_, k) => ({
    toSun: out[4 * k]!,
    whole: out[4 * k + 1]!,
    weight: out[4 * k + 2]!,
    behind: out[4 * k + 3]!,
  }))
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

/** The roots of |P + sŝ|² = r²: where a ray from P along ŝ crosses the sphere, or null where it does not. */
function crossings(
  point: Vec3,
  toward: Vec3,
  radius: number,
): readonly [near: number, far: number] | null {
  const b = dot3(point, toward)
  const d = b * b - (dot3(point, point) - radius * radius)
  if (d < 0) return null
  return [-b - Math.sqrt(d), -b + Math.sqrt(d)]
}

/** The far root: where a ray from inside the sphere leaves it. */
const leaves = (point: Vec3, toward: Vec3, radius: number): number =>
  crossings(point, toward, radius)?.[1] ?? 0

/** The optical depth from an eye-relative point to a sun over its horizon through a uniform slab, float64. */
function slabDepth(
  eye: Vec3,
  offset: Vec3,
  sun: Vec3,
  [base, top, sigma]: Slab,
): number {
  const point = add(eye, offset)
  const height = Math.hypot(point.x, point.y, point.z) - R
  const toTop = leaves(point, sun, R + top)
  if (height >= top) return 0
  if (height >= base) return sigma * toTop
  return sigma * (toTop - leaves(point, sun, R + base))
}

/**
 * The same through a slab whose base the ray dips under: σ times the path
 * to that exit, and times the chord from where the ray comes back up
 * through the base to where it leaves through the top.
 */
function dippingDepth(
  eye: Vec3,
  offset: Vec3,
  sun: Vec3,
  [base, top, sigma]: Slab,
): { readonly depth: number; readonly dips: boolean } {
  const point = add(eye, offset)
  const end = leaves(point, sun, R + top)
  const under = crossings(point, sun, R + base)
  if (under === null || dot3(point, sun) >= 0)
    return { depth: sigma * end, dips: false }
  return {
    depth: sigma * (Math.max(under[0], 0) + (end - under[1])),
    dips: true,
  }
}

/** An eye-relative point on the sphere `height` over the datum, at plane offsets from the eye along the grid's own axes. */
function along(
  test: Rig,
  eye: Vec3,
  height: number,
  east: number,
  north = 0,
): Vec3 {
  const { level } = test
  const direction = directionOf(
    level,
    [level.eye[0] + east, level.eye[1] + north],
    R,
  )
  return sub(scale(direction, R + height), eye)
}

/* ------------------------------------------------------------------------- */
/* A uniform slab                                                             */
/* ------------------------------------------------------------------------- */

describe('a uniform slab', () => {
  const SLAB: Slab = [1000, 2000, 0.01]
  const [BASE, TOP, SIGMA] = SLAB
  const scenario = slabScenario(SLAB)
  const EYE = 300

  /** Points within a few kilometers of the eye, at heights from under the slab to its top. */
  function points(count: number, below: boolean, slab = SLAB): Vec3[] {
    const next = draws(below ? 31 : 32)
    const eye = eyeAt(EYE)
    return Array.from({ length: count }, () => {
      const height = below
        ? 400 + next() * 550
        : slab[0] + 30 + next() * (slab[1] - slab[0] - 60)
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

  for (const elevation of [60, 37.5, 5])
    it(`gives σ times the slant path, within 2%, at a ${elevation}° sun`, async () => {
      const test = rig(slab(BASE, TOP, SIGMA), scenario)
      const eye = eyeAt(EYE)
      const sun = sunAt(elevation)
      test.settle(eye, sun)
      expect(test.weight).toBe(1)
      for (const below of [false, true]) {
        const offsets = points(512, below)
        const read = await depths(test, offsets)
        offsets.forEach((offset, k) => {
          const expected = slabDepth(eye, offset, sun, SLAB)
          expect(Math.abs(read[k]!.toSun / expected - 1)).toBeLessThan(0.02)
          expect(read[k]!.weight).toBe(1)
        })
        // The plane-parallel form the design states, under the slab: the
        // sphere bends it by under a percent this close to the eye, where
        // the sun is high.
        if (below && elevation > 30) {
          const mu = Math.sin((elevation * Math.PI) / 180)
          const flat = (SIGMA * (TOP - BASE)) / mu
          expect(Math.abs(read[0]!.toSun / flat - 1)).toBeLessThan(0.02)
        }
      }
      dispose(test)
    })

  it('gives the ray’s whole depth beside the depth to the sun, from the cell where the ray meets the base', async () => {
    const test = rig(slab(BASE, TOP, SIGMA), scenario)
    const eye = eyeAt(EYE)
    const sun = sunAt(37.5)
    test.settle(eye, sun)
    const inside = points(256, false)
    const read = await depths(test, inside)
    inside.forEach((offset, k) => {
      const point = add(eye, offset)
      // Back along the sun to the base, then the slab's whole chord from there.
      const back = crossings(point, scale(sun, -1), R + BASE)![0]
      const foot = sub(point, scale(sun, back))
      const expected = SIGMA * leaves(foot, sun, R + TOP)
      expect(Math.abs(read[k]!.whole / expected - 1)).toBeLessThan(0.02)
      expect(read[k]!.whole).toBeGreaterThanOrEqual(read[k]!.toSun)
      expect(read[k]!.behind).toBe(1)
    })
    // Under the slab nothing lies behind a point: the whole is the depth to the sun.
    const under = points(64, true)
    for (const got of await depths(test, under))
      expect(got.whole).toBeCloseTo(got.toSun, 5)
    dispose(test)
  })

  describe('under a sun 1.5° below the horizon', () => {
    // A deck high enough that a ray dipping 2.2 km under it clears the
    // ground, and thin enough that its 30 km chord at the re-entry is a
    // depth of 12: the crossing is a transmittance, and past e⁻⁴⁶ the bake
    // holds it there.
    const DECK: Slab = [4000, 4800, 0.0004]
    const dusk = slabScenario(DECK)
    const SUN = sunAt(-1.5)
    const eye = eyeAt(EYE)

    it('sums to the base the ray leaves through, and adds the deck’s chord where it comes back up, within 2%', async () => {
      const test = rig(slab(...DECK), dusk)
      expect(test.depth.toFirstExit).toBe(true)
      test.settle(eye, SUN)
      const offsets = points(512, false, DECK)
      const read = await depths(test, offsets)
      offsets.forEach((offset, k) => {
        const expected = dippingDepth(eye, offset, SUN, DECK)
        expect(expected.dips).toBe(true)
        expect(Math.abs(read[k]!.toSun / expected.depth - 1)).toBeLessThan(0.02)
      })
      dispose(test)
    })

    it('is what the 32 steps to the far crossing of the top do not hold: three of them fall in the deck', async () => {
      const test = rig(slab(...DECK), dusk)
      test.depth.toFirstExit = false
      test.settle(eye, SUN)
      const offsets = points(512, false, DECK)
      const read = await depths(test, offsets)
      const miss = offsets
        .map((offset, k) =>
          Math.abs(
            read[k]!.toSun / dippingDepth(eye, offset, SUN, DECK).depth - 1,
          ),
        )
        .sort((a, b) => a - b)
      // The median point is off by more than a tenth, where the first exit holds 2% at every one.
      expect(miss[miss.length >> 1]).toBeGreaterThan(0.1)
      dispose(test)
    })
  })
})

/* ------------------------------------------------------------------------- */
/* The rebuild, the pace and the wake                                         */
/* ------------------------------------------------------------------------- */

describe('a grid that comes back', () => {
  const SLAB: Slab = [1000, 2600, 0.015]
  const scenario = slabScenario(SLAB)
  const EYE = 500
  const SUN = sunAt(37.5)
  const eye = eyeAt(EYE)
  const total = (counts: readonly number[]): number =>
    counts.reduce((a, b) => a + b, 0)

  it('bakes the volume, then the grid, then raises its weight, and no frame bakes more than the cap of either', () => {
    const test = rig(slab(...SLAB), scenario)
    const volume: number[] = []
    const grid: number[] = []
    const weight: number[] = []
    const source = Math.ceil((LEVELS * STACK) / CAP)
    const frames = source + SLICES / CAP + RAMP
    for (let n = 0; n < frames; n += 1) {
      test.step(eye, SUN)
      volume.push(total(test.volume.drawn))
      grid.push(test.depth.drawn)
      weight.push(test.weight)
    }
    // 102 slices of the volume at 8 a frame: twelve frames of 8 and one of 6.
    expect(volume.slice(0, source)).toEqual([
      ...new Array<number>(12).fill(8),
      6,
    ])
    expect(total(volume.slice(source))).toBe(0)
    // Nothing of the grid until the volume is whole, then its 32 at the cap.
    expect(grid.slice(0, source)).toEqual(new Array(source).fill(0))
    expect(grid.slice(source, source + 4)).toEqual([8, 8, 8, 8])
    expect(total(grid.slice(source + 4))).toBe(0)
    // Zero until every slice holds the field, then a sixteenth a frame.
    expect(weight.slice(0, source + 4)).toEqual(new Array(source + 4).fill(0))
    weight
      .slice(source + 4)
      .forEach((w, k) => expect(w).toBeCloseTo((k + 1) / RAMP, 12))
    expect(weight[frames - 1]).toBe(1)
    expect(test.depth.pending).toBe(false)
    // A field that stands still under a sun that stands still is not baked again.
    test.step(eye, SUN)
    expect(total(test.volume.drawn) + test.depth.drawn).toBe(0)
    // A jump of the field's time: the weight is zero at once, and the same again.
    test.step(eye, SUN, { jump: true })
    expect(test.weight).toBe(0)
    expect(total(test.volume.drawn)).toBe(CAP)
    expect(test.depth.drawn).toBe(0)
    expect(test.settle(eye, SUN)).toBe(frames - 1)
    expect(test.weight).toBe(1)
    dispose(test)
  })

  it('reads as nothing held while it comes back: no depth and no weight at any point', async () => {
    const test = rig(slab(...SLAB), scenario)
    for (let n = 0; n < 15; n += 1) test.step(eye, SUN)
    // Two frames into the grid's own bake: sixteen slices hold the field.
    expect(test.depth.pending).toBe(true)
    const point = along(test, eye, 1800, 500)
    const [got] = await depths(test, [point])
    expect(got).toEqual({ toSun: 0, whole: 0, weight: 0, behind: 0 })
    dispose(test)
  })

  it('takes a turning sun as motion: through 0.05° and past it no frame is a rebuild, and the weight stands', () => {
    const test = rig(slab(...SLAB), scenario)
    test.settle(eye, SUN)
    // 0.02° of azimuth a frame, 0.016° of arc at this elevation: a whole
    // grid every 0.25°, two slices a frame.
    const counts: number[] = []
    for (let k = 1; k <= 20; k += 1) {
      test.step(eye, sunAt(37.5, 20 + 0.02 * k))
      counts.push(test.depth.drawn)
      expect(test.weight).toBe(1)
    }
    expect(Math.max(...counts)).toBeLessThanOrEqual(3)
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2)
    // A step of 0.1° in one frame asks for ten slices: the cap, and the rest next frame.
    test.step(eye, sunAt(37.5, 20.4 + 0.126))
    expect(test.depth.drawn).toBe(CAP)
    expect(test.weight).toBe(1)
    test.step(eye, sunAt(37.5, 20.4 + 0.126))
    expect(test.depth.drawn).toBeGreaterThanOrEqual(4)
    expect(test.depth.drawn).toBeLessThanOrEqual(5)
    test.step(eye, sunAt(37.5, 20.4 + 0.126))
    expect(test.depth.drawn).toBeLessThanOrEqual(1)
    dispose(test)
  })

  it('redraws at the pace its field moves: a cell’s tenth at 25 m/s is 96 frames a grid', () => {
    const test = rig(slab(...SLAB), scenario)
    test.settle(eye, SUN)
    let grid = 0
    const volume = [0, 0, 0]
    for (let n = 0; n < 96; n += 1) {
      test.step(eye, SUN, { seconds: 1 / 60, wind: 25 })
      grid += test.depth.drawn
      test.volume.drawn.forEach((count, L) => (volume[L]! += count))
      expect(test.depth.drawn).toBeLessThanOrEqual(1)
    }
    // 1.6 s: the grid's 400 m cells once; the volume's 50 m level eight
    // times, its 200 m level twice, its 800 m level half.
    expect(grid).toBeGreaterThanOrEqual(SLICES - 1)
    expect(grid).toBeLessThanOrEqual(SLICES)
    volume.forEach((count, L) => {
      const asked = (8 * STACK) / 4 ** L
      expect(count).toBeGreaterThanOrEqual(asked - 1)
      expect(count).toBeLessThanOrEqual(asked)
    })
    dispose(test)
  })

  it('idles from orbit at no weight, and wakes by the eye’s height: half its weight half way through the fade', () => {
    const test = rig(slab(...SLAB), scenario)
    const top = SLAB[1]
    test.step(eyeAt(400_000), SUN)
    test.step(eyeAt(400_000), SUN)
    expect(test.depth.drawn).toBe(0)
    expect(test.depth.pending).toBe(false)
    expect(test.weight).toBe(0)
    // 51.2 km over the top is the wake; a quarter of that lower is all of it.
    const fade = (over: number): number => {
      test.settle(eyeAt(top + over), SUN)
      return test.weight
    }
    expect(fade(51_300)).toBe(0)
    expect(fade(44_800)).toBeCloseTo(0.5, 6)
    expect(fade(38_400)).toBeCloseTo(1, 6)
    // A hover in the fade holds one weight: it is the camera's, not a frame's.
    const held = fade(47_000)
    test.step(eyeAt(top + 47_000), SUN)
    expect(test.weight).toBe(held)
    dispose(test)
  })
})

/* ------------------------------------------------------------------------- */
/* The reach's ramp, and the statistics past it                               */
/* ------------------------------------------------------------------------- */

describe('the grid’s edge', () => {
  // A thin layer under a thin layer: the lower one's sun is the upper one's shadow.
  const LOW: Slab = [1000, 1500, 0.001]
  const HIGH: Slab = [3000, 3600, 0.0015]
  const scenario = slabScenario(LOW, HIGH)
  const medium = slabMedium([
    { base: LOW[0], top: LOW[1], sigma: LOW[2] },
    { base: HIGH[0], top: HIGH[1], sigma: HIGH[2] },
  ])
  const EYE = 300
  const SUN = sunAt(37.5)
  const HEIGHT = 1250
  /** Meters out from the eye along the grid's east: 400 m apart, from 18 km to 28 km. */
  const LINE = Array.from({ length: 26 }, (_, k) => 18_000 + 400 * k)
  const ramp = (out: number): number =>
    Math.min(1, Math.max(0, (SUN_GRID_REACH - out) / SUN_GRID_FADE))

  /** The mixed transmittance, the grid's depth and weight, and the statistics, at each offset. */
  async function line(
    test: Rig,
    offsets: readonly Vec3[],
  ): Promise<{ mixed: number; toSun: number; weight: number; stat: number }[]> {
    const body = test.uniforms.served
    const inputs = new Float32Array(offsets.flatMap((o) => [o.x, o.y, o.z]))
    const out = await run(offsets.length, inputs, 3, 4, (read, write) => {
      const offset = vec3(read(0), read(1), read(2))
      const sample: CloudSample = {
        offset,
        distance: float(0),
        altitude: altitudeAt(body, offset),
        sunMu: sunMuAt(body, offset),
        footprint: float(0),
      }
      const here = medium(sample, body)
      const stat = sunStatistics({
        layers: body.layers,
        level: here.layer,
        cover: vec3(1, 1, 0),
        convective: vec3(0),
        depth: here.depth,
        sunMu: sample.sunMu,
        taps: float(0),
      })
      const got = test.depth.depths(offset)
      write(0, sunPastTaps(got, stat))
      write(1, got.toSun)
      write(2, got.weight)
      write(3, stat)
    })
    return offsets.map((_, k) => ({
      mixed: out[4 * k]!,
      toSun: out[4 * k + 1]!,
      weight: out[4 * k + 2]!,
      stat: out[4 * k + 3]!,
    }))
  }

  /** The statistics' own law in float64: the sample's column over the sun's cosine, and one crossing of the level above at its mean depth. */
  function statistics(eye: Vec3, offset: Vec3): number {
    const point = add(eye, offset)
    const radius = Math.hypot(point.x, point.y, point.z)
    const mu = dot3(point, SUN) / radius
    const own = (LOW[2] * (LOW[1] - (radius - R))) / mu
    const above =
      (2 * HIGH[2] * (HIGH[1] - HIGH[0]) * genusProfileMean('stratus')) / mu
    return Math.exp(-own) * Math.exp(-above)
  }

  it('ends in a ramp from the eye: one to 20.8 km, zero from 24 km, and the sun the weight’s mix of the grid’s and the statistics’ within 0.01', async () => {
    const test = rig(medium, scenario)
    const eye = eyeAt(EYE)
    test.settle(eye, SUN)
    const offsets = LINE.map((out) => along(test, eye, HEIGHT, out))
    const read = await line(test, offsets)
    read.forEach((got, k) => {
      const out = LINE[k]!
      const w = ramp(out)
      // The weight is the eye's distance along the grid's axis and nothing else.
      expect(got.weight).toBeCloseTo(w, 3)
      const stat = statistics(eye, offsets[k]!)
      expect(Math.abs(got.stat - stat)).toBeLessThan(2e-3)
      const mix = w * Math.exp(-got.toSun) + (1 - w) * stat
      expect(Math.abs(got.mixed - mix)).toBeLessThan(0.01)
      if (w === 0) expect(got.toSun).toBe(0)
    })
    // The grid and the statistics disagree here, the slab's depth against the
    // regime's mean, and across the ramp no two neighbors are further apart
    // than an eighth of that: 400 m of a 3.2 km ramp.
    const inside = read[0]!
    const apart = Math.abs(Math.exp(-inside.toSun) - inside.stat)
    expect(apart).toBeGreaterThan(0.03)
    for (let k = 1; k < read.length; k += 1)
      expect(Math.abs(read[k]!.mixed - read[k - 1]!.mixed)).toBeLessThanOrEqual(
        apart / 8 + 2e-3,
      )
    // At full weight the grid's own value: the two slabs' slant paths. Not
    // to the 2% of a slab that is the whole union: the volume holds the
    // field at its slices' centers, 81 m apart here, and each of the three
    // slab edges inside the union is worth up to half a slice of path.
    const first = add(eye, offsets[0]!)
    const exact =
      LOW[2] * leaves(first, SUN, R + LOW[1]) +
      HIGH[2] *
        (leaves(first, SUN, R + HIGH[1]) - leaves(first, SUN, R + HIGH[0]))
    expect(Math.abs(inside.toSun / exact - 1)).toBeLessThan(0.15)
    dispose(test)
  })

  it('does not step when the window snaps: the weight at a point is the same on both sides of a cell', async () => {
    const test = rig(medium, scenario)
    const before = eyeAt(EYE)
    test.settle(before, SUN)
    const cell = test.level.origin
    const here = LINE.map((out) => along(test, before, HEIGHT, out))
    const was = await line(test, here)
    // Two cells east: the window's corner moves with the eye, and only six
    // slices hold the new window after this frame.
    const after = eyeAt(EYE, 800)
    test.step(after, SUN)
    expect(test.depth.pending).toBe(true)
    expect(test.level.origin).not.toEqual(cell)
    const there = LINE.map((out) => along(test, after, HEIGHT, out))
    const now = await line(test, there)
    now.forEach((got, k) => {
      expect(got.weight).toBeCloseTo(was[k]!.weight, 3)
      expect(got.weight).toBeCloseTo(ramp(LINE[k]!), 3)
    })
    dispose(test)
  })
})

describe('the layers’ statistics', () => {
  it('equal the grid’s depth on a uniform layer, within 2%', async () => {
    const SLAB: Slab = [1000, 2000, 0.002]
    const medium = slab(...SLAB)
    const test = rig(medium, slabScenario(SLAB))
    const eye = eyeAt(300)
    const sun = sunAt(37.5)
    test.settle(eye, sun)
    const next = draws(77)
    const offsets = Array.from({ length: 256 }, () =>
      along(
        test,
        eye,
        SLAB[0] + 30 + next() * (SLAB[1] - SLAB[0] - 60),
        (next() - 0.5) * 16_000,
        (next() - 0.5) * 16_000,
      ),
    )
    const body = test.uniforms.served
    const inputs = new Float32Array(offsets.flatMap((o) => [o.x, o.y, o.z]))
    const out = await run(offsets.length, inputs, 3, 2, (read, write) => {
      const offset = vec3(read(0), read(1), read(2))
      const sample: CloudSample = {
        offset,
        distance: float(0),
        altitude: altitudeAt(body, offset),
        sunMu: sunMuAt(body, offset),
        footprint: float(0),
      }
      const here = medium(sample, body)
      write(
        0,
        sunStatistics({
          layers: body.layers,
          level: here.layer,
          cover: vec3(1, 0, 0),
          convective: vec3(0),
          depth: here.depth,
          sunMu: sample.sunMu,
          taps: float(0),
        }),
      )
      write(1, test.depth.depths(offset).toSun)
    })
    offsets.forEach((_, k) => {
      const stat = -Math.log(out[2 * k]!)
      expect(Math.abs(stat / out[2 * k + 1]! - 1)).toBeLessThan(0.02)
    })
    dispose(test)
  })

  it('are the law: the sample’s column on the sun’s side less the taps, and one crossing of each level beyond it', async () => {
    const LOW: Slab = [1000, 1500, 0.01]
    const MID: Slab = [3000, 3600, 0.004]
    const HIGH: Slab = [8000, 9000, 0.0005]
    const scenario = slabScenario(LOW, MID, HIGH)
    const uniforms = createCloudUniforms()
    uniforms.write(
      frameAt(eyeAt(300), sunAt(37.5), scenario, DEFAULT_CLOUD_LEVERS, null),
    )
    const mean = [LOW, MID, HIGH].map(
      ([base, top, sigma]) =>
        2 * sigma * (top - base) * genusProfileMean('stratus'),
    )
    const cases = fc.sample(
      fc.record({
        level: fc.integer({ min: -1, max: 2 }),
        cover: fc.tuple(
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          fc.double({ min: 0, max: 1, noNaN: true }),
        ),
        whole: fc.double({ min: 0, max: 12, noNaN: true }),
        share: fc.double({ min: 0, max: 1, noNaN: true }),
        sunMu: fc.double({ min: -1, max: 1, noNaN: true }),
        taps: fc.double({ min: 0, max: 3, noNaN: true }),
      }),
      { numRuns: 512, seed: 5 },
    )
    const inputs = new Float32Array(
      cases.flatMap((one) => [
        one.level,
        ...one.cover,
        one.whole * one.share,
        one.whole,
        one.sunMu,
        one.taps,
      ]),
    )
    const out = await run(cases.length, inputs, 8, 1, (read, write) => {
      write(
        0,
        sunStatistics({
          layers: uniforms.served.layers,
          level: int(read(0)),
          cover: vec3(read(1), read(2), read(3)),
          convective: vec3(0.3),
          depth: vec2(read(4), read(5)),
          sunMu: read(6),
          taps: read(7),
        }),
      )
    })
    cases.forEach((one, k) => {
      const above = Math.fround(one.sunMu) >= 0
      const mu = Math.max(Math.abs(one.sunMu), 0.05)
      const pass = (cover: number, depth: number): number =>
        1 - cover + cover * Math.exp(-depth)
      let expected = 1
      if (one.level >= 0) {
        const up = one.whole * one.share
        const column = above ? up : one.whole - up
        expected = pass(
          one.cover[one.level]!,
          Math.max(column / mu - one.taps, 0),
        )
        for (let j = 0; j < 3; j += 1)
          if (above ? j > one.level : j < one.level)
            expected *= pass(one.cover[j]!, mean[j]! / mu)
      }
      expect(Math.abs(out[k]! - expected)).toBeLessThan(2e-5)
    })
    uniforms.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* Scrolling, and the cap                                                     */
/* ------------------------------------------------------------------------- */

describe('a grid that moves', () => {
  const BASE = 1000
  const TOP = 2600
  const SIGMA = 0.03
  const scenario = slabScenario([BASE, TOP, SIGMA])
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
    // whatever their volumes' bakes have reached.
    const test = rig(field, scenario, { volume: false })
    test.settle(eyeAt(EYE), SUN)
    const origin = test.level.origin
    // Two cells east, on the level's held anchor.
    const moved = eyeAt(EYE, 800)
    test.step(moved, SUN)
    expect(test.frame!.served.volume.rebuilt[1]).toBe(false)
    expect(test.depth.pending).toBe(true)
    // Six slices a frame at the new window, and the weight stands.
    expect(test.depth.drawn).toBe(6)
    expect(test.weight).toBe(1)
    const held = test.frame!
    test.settle(moved, SUN)
    const fresh = rig(field, scenario, { volume: false })
    fresh.frame = held
    fresh.settle(moved, SUN)
    expect(test.level.origin).not.toEqual(origin)
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

  it('bakes no frame past the cap: a first frame, a jump, a turning sun, a flight', () => {
    const test = rig(field, scenario)
    let east = 0
    let whole = 0
    for (let k = 0; k < 120; k += 1) {
      east += 128
      const azimuth = 20 + (k % 10 === 0 ? 0.2 * k : 0)
      test.step(eyeAt(EYE, east), sunAt(37.5, azimuth), { jump: k === 60 })
      expect(test.depth.drawn).toBeLessThanOrEqual(CAP)
      expect(test.volume.drawn.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
        CAP,
      )
      if (test.weight === 1) whole += 1
    }
    // It was whole before the jump and came back after it.
    expect(whole).toBeGreaterThan(40)
    expect(test.weight).toBe(1)
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
    const test = rig(slab(1000, 2000, 0.01), slabScenario([1000, 2000, 0.01]))
    expect(test.depth.bytes).toBe(0)
    await test.depth.warm(gpu.renderer)
    await test.volume.warm(gpu.renderer)
    const render = gpu.pipelinesBuilt()
    const compute = gpu.computePipelinesBuilt()
    test.settle(eyeAt(300), sunAt(37.5))
    // Under the horizon too: the first exit is a branch of the one program.
    test.settle(eyeAt(300), sunAt(-1.5))
    expect(gpu.pipelinesBuilt()).toBe(render)
    expect(gpu.computePipelinesBuilt()).toBe(compute)
    expect(test.depth.bytes).toBe(bytes)
    const textures = test.depth.textures()
    expect(textures).toHaveLength(1)
    const held = backend.get(textures[0]!).texture
    expect(held.mipLevelCount).toBe(1)
    expect(held.width * held.height * held.depthOrArrayLayers * 2).toBe(bytes)
    dispose(test)
    expect(test.depth.bytes).toBe(0)
  })
})
