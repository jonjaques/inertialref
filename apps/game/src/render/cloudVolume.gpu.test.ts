import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type Node,
  StorageBufferAttribute,
  type Texture,
  Vector3,
} from 'three/webgpu'
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
  sqrt,
  storage,
  texture3D,
  uint,
  uniform,
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
  sunCascades,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudBodyFrame,
  type CloudFrame,
} from './cloudFrame.ts'
import { altitudeAt, sunMuAt } from './cloudGeometry.ts'
import { DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudRay,
  CloudSample,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import {
  SUN_CASCADE_EXTENTS,
  SUN_CASCADE_SIZE,
  SUN_DEPTH_FRAME_CAP,
} from './cloudSunCascades.ts'
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
 * its texels' centers, its guard slices stop each level's filter, its bound
 * covers every trilinear read in a brick, a skip lands past the brick's
 * face and never past cloud, and a window that scrolls ends where a fresh
 * one starts. The field here is analytic, built from the sample alone.
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
const LEVERS = { ...DEFAULT_CLOUD_LEVERS, on: true, cache: 'volume' as const }
const BUDGET: CloudBudget = {
  slices: 8,
  tiles: 1,
  jump: false,
  sunTexelSteps: SUN_DEPTH_FRAME_CAP,
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
 * A frame as `cloudFrame` builds it for the served body, from WP1's own
 * level frames and cascades, carried from `previous`: what `uniforms.write`
 * and the resources read.
 */
function frameAt(
  eye: Vec3,
  previous: CloudFrame | null,
  options: {
    readonly jump?: boolean
    readonly scenario?: WeatherScenario
  } = {},
): CloudFrame {
  const scenario = options.scenario ?? SCENARIO
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
      previous?.served.clipmap.frames ?? null,
    ),
    volume: levelFrames(
      eye,
      R,
      CLOUD_VOLUME_TEXELS,
      CLOUD_VOLUME_SIZE,
      previous?.served.volume.frames ?? null,
    ),
    cascades: sunCascades(
      eye,
      SUN,
      shells,
      SUN_CASCADE_EXTENTS,
      SUN_CASCADE_SIZE,
      previous?.served.cascades.cascades ?? null,
      options.jump ?? false,
    ),
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
  baseWide: () => vec3(0).xyzz,
  detail: () => float(0),
  curl: () => vec3(0).xy,
}

interface Rig {
  readonly uniforms: CloudUniforms
  readonly volume: CloudVolume
  frame: CloudFrame | null
  /** Render a frame at `eye`; returns it. */
  step(eye: Vec3, options?: { readonly jump?: boolean }): CloudFrame
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

/** TSL's `Loop` over three ranges, which `@types/three` declares up to two of. */
const loopOver3 = Loop as unknown as (
  i: number,
  j: number,
  k: number,
  body: (inputs: {
    readonly i: Node<'int'>
    readonly j: Node<'int'>
    readonly k: Node<'int'>
  }) => void,
) => void

/** A lattice texel's storage column, floored mod the window. */
const wrap = (x: Node<'float'>): Node<'float'> =>
  x.sub(x.div(CLOUD_VOLUME_SIZE).floor().mul(CLOUD_VOLUME_SIZE))

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
/* The bound and the skip                                                     */
/* ------------------------------------------------------------------------- */

describe('the bound', () => {
  const east = levelFrames(scale(UP, R + EYE_HEIGHT), R, [50], 256, null)
    .frames[0]!.east
  const north = levelFrames(scale(UP, R + EYE_HEIGHT), R, [50], 256, null)
    .frames[0]!.north
  const E = vec3(east.x, east.y, east.z)
  const N = vec3(north.x, north.y, north.z)
  // Patches a few hundred meters across with clear air between: most bricks
  // at level 0 hold cloud or none, and many have an edge.
  const patchy = analytic((o) =>
    select(
      sin(dot(o, E).div(170))
        .mul(cos(dot(o, N).div(230)))
        .greaterThan(0.5),
      float(SIGMA),
      float(0),
    ),
  )

  it('is at least every trilinear read inside its brick, at every level', async () => {
    const test = rig(patchy)
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const frame = test.frame!
    const next = draws(7)
    const count = 8192
    const inputs = new Float32Array(count * 3)
    for (let n = 0; n < count; n += 1) {
      const L = n % 3
      const level = frame.served.volume.frames[L]!
      // Inside the trusted window, two texels in, anywhere in the union.
      const i = level.origin[0] + 2 + next() * (CLOUD_VOLUME_SIZE - 4)
      const j = level.origin[1] + 2 + next() * (CLOUD_VOLUME_SIZE - 4)
      const height = BASE + next() * (TOP - BASE)
      const o = latticeOffset(level, eye, i, j, height)
      inputs.set([o.x, o.y, o.z], n * 3)
    }
    const out = await run(count, inputs, 3, 2, (read, write) => {
      const sample = sampleAt(test.uniforms, vec3(read(0), read(1), read(2)))
      const medium = test.volume.medium(sample, test.uniforms.served)
      write(0, test.volume.bound(sample, test.uniforms.served))
      write(1, sqrt(medium.sigma.div(SIGMA)))
    })
    let empty = 0
    let cloudy = 0
    for (let n = 0; n < count; n += 1) {
      const bound = out[n * 2]!
      const read = out[n * 2 + 1]!
      expect(read).toBeLessThanOrEqual(bound + 1e-6)
      if (bound === 0) empty += 1
      if (read > 0) cloudy += 1
    }
    // The bound is a bound, not a constant: some bricks are empty, some not.
    expect(empty).toBeGreaterThan(count / 20)
    expect(cloudy).toBeGreaterThan(count / 20)
    test.volume.dispose()
  })

  /*
   * One cloudy texel at a brick's corner, and 1,000 rays from the eye aimed
   * through its filter's reach where it lies in the neighboring bricks, each
   * marched as the trace marches: a step whose bound is zero jumps to the
   * brick's exit, any other steps a meter and reads. Every ray sees the
   * cloud. With the bound taken over the brick alone, undilated, some do
   * not: they cross a neighbor whose own texels are clear while its reads
   * near the shared corner blend the cloudy one.
   */
  async function seen(dilated: boolean): Promise<number> {
    const eye = eyeAt(EYE_HEIGHT)
    const level = levelFrames(eye, R, CLOUD_VOLUME_TEXELS, 256, null).frames[0]!
    // A brick's far corner texel, 1.4 km east and 0.9 km north of the eye.
    const brick = [
      Math.floor((level.eye[0] + 1400) / 200),
      Math.floor((level.eye[1] + 900) / 200),
    ]
    const i = brick[0]! * 4 + 3
    const j = brick[1]! * 4 + 3
    const slice = 4 * 3 + 3
    const height = BASE + (slice + 0.5) * SLICE
    const center = latticeOffset(level, eye, i + 0.5, j + 0.5, height)
    const target = uniform(new Vector3(center.x, center.y, center.z))
    const corner = analytic((o) =>
      select(length(o.sub(target)).lessThan(10), float(SIGMA), float(0)),
    )
    const test = rig(corner)
    test.settle(eye)
    const body = test.uniforms.served
    const map = test.volume.textures()[0]!
    const raw = texture3D(map)
    const next = draws(8)
    const count = 1000
    const inputs = new Float32Array(count * 3)
    for (let n = 0; n < count; n += 1) {
      // Within 0.8 of a texel of the cloudy one's center on every axis, so
      // its weight in a read there is at least 0.2³, and past its brick's
      // face on at least one: in a neighbor.
      let d: number[]
      do d = [0, 0, 0].map(() => 1.6 * next() - 0.8)
      while (Math.max(...d) < 0.55)
      const p = latticeOffset(
        level,
        eye,
        i + 0.5 + d[0]!,
        j + 0.5 + d[1]!,
        height + d[2]! * SLICE,
      )
      inputs.set([p.x, p.y, p.z], n * 3)
    }
    const out = await run(count, inputs, 3, 1, (read, write) => {
      const aim = vec3(read(0), read(1), read(2))
      const reach = length(aim)
      const direction = aim.div(reach)
      const ray: CloudRay = {
        direction,
        mu: dot(direction, body.up),
        nu: dot(direction, body.sun),
        start: reach.sub(400),
        end: reach.add(400),
      }
      const t = ray.start.toVar()
      const hit = float(0).toVar()
      Loop(4000, () => {
        If(t.greaterThan(ray.end).or(hit.greaterThan(0)), () => {
          // Break by running out the range.
          t.assign(ray.end.add(1))
        }).Else(() => {
          const sample = sampleAt(test.uniforms, direction.mul(t))
          const own = dilated
            ? test.volume.bound(sample, body)
            : undilated(raw, sample, test)
          If(own.equal(0), () => {
            t.assign(test.volume.brickExit(sample, ray, body))
          }).Else(() => {
            If(test.volume.medium(sample, body).sigma.greaterThan(0), () => {
              hit.assign(1)
            })
            t.addAssign(1)
          })
        })
      })
      write(0, hit)
    })
    test.volume.dispose()
    return out.reduce((sum, hit) => sum + hit, 0)
  }

  /** The largest R over the sample's level-0 brick alone, read in the test: the bound without its border. */
  function undilated(
    raw: ReturnType<typeof texture3D>,
    sample: CloudSample,
    test: Rig,
  ): Node<'float'> {
    const level = test.uniforms.served.volume[0]!
    const oA = dot(sample.offset, level.anchor)
    const eA = level.along.x
    const scaleOf = test.uniforms.served.datumRadius.div(eA.add(oA))
    const u = level.eye.x.add(
      dot(sample.offset, level.east)
        .sub(level.along.y.mul(oA).div(eA))
        .mul(scaleOf),
    )
    const v = level.eye.y.add(
      dot(sample.offset, level.north)
        .sub(level.along.z.mul(oA).div(eA))
        .mul(scaleOf),
    )
    const bx = u.div(level.texel).div(4).floor()
    const by = v.div(level.texel).div(4).floor()
    const bz = sample.altitude.sub(BASE).div(SLICE).div(4).floor()
    const largest = float(0).toVar()
    // One loop of three ranges: nested `Loop`s each name their index `i`.
    loopOver3(4, 4, 4, ({ i: dz, j: dy, k: dx }) => {
      const x = wrap(bx.mul(4).add(float(dx)))
      const y = wrap(by.mul(4).add(float(dy)))
      const z = bz.mul(4).add(float(dz)).add(1)
      largest.assign(max(largest, raw.load(ivec3(int(x), int(y), int(z))).x))
    })
    return largest
  }

  it('lets no ray skip one cloudy texel at a brick’s corner, through 1,000 directions', async () => {
    expect(await seen(true)).toBe(1000)
  })

  it('where a bound over the brick alone lets some through', async () => {
    expect(await seen(false)).toBeLessThan(1000)
  })
})

/** What float32 moves a brick exit by along the rays here: twice the 5.3 cm measured. */
const EXIT_SLACK = 0.1

describe('the brick exit', () => {
  /*
   * From the eye along random rays, at samples in level 0's window, the
   * exit less its half meter against the float64 distance at which the ray
   * leaves the sample's brick: on the face, to float32's centimeter at a few
   * kilometers and the curvature the rates take as straight, under 3 mm
   * over a 200 m brick.
   */
  it('lands on the brick’s far face, within half a meter past it', async () => {
    const test = rig(analytic(() => float(0)))
    const eye = eyeAt(EYE_HEIGHT)
    test.settle(eye)
    const level = test.frame!.served.volume.frames[0]!
    const body = test.uniforms.served
    const next = draws(9)
    const count = 2048
    const cases: { d: Vec3; t: number }[] = []
    for (let n = 0; n < count; n += 1) {
      const p = latticeOffset(
        level,
        eye,
        level.eye[0] / 50 + (next() - 0.5) * 200,
        level.eye[1] / 50 + (next() - 0.5) * 200,
        BASE + 50 + next() * (TOP - BASE - 100),
      )
      const t = Math.hypot(p.x, p.y, p.z)
      // The ray from the eye through the point: the points spread over
      // level 0's window and the union, so faces of all three axes are met.
      const d = { x: p.x / t, y: p.y / t, z: p.z / t }
      cases.push({ d, t })
    }
    const inputs = new Float32Array(
      cases.flatMap(({ d, t }) => [d.x, d.y, d.z, t]),
    )
    const out = await run(count, inputs, 4, 1, (read, write) => {
      const direction = vec3(read(0), read(1), read(2))
      const t = read(3)
      const ray: CloudRay = {
        direction,
        mu: dot(direction, body.up),
        nu: dot(direction, body.sun),
        start: float(0),
        end: float(1e9),
      }
      write(
        0,
        test.volume.brickExit(
          sampleAt(test.uniforms, direction.mul(t)),
          ray,
          body,
        ),
      )
    })
    // The brick of a point, by level 0's lattice: (u, v) in 4-texel bricks, h in 4-slice ones.
    const brickOf = (p: Vec3): [number, number, number] => {
      const position = add(eye, p)
      const depth = dot3(position, level.anchor)
      const u = (R * dot3(position, level.east)) / depth
      const v = (R * dot3(position, level.north)) / depth
      const h = Math.hypot(position.x, position.y, position.z) - R
      return [
        Math.floor(u / 200),
        Math.floor(v / 200),
        Math.floor((h - BASE) / SLICE / 4),
      ]
    }
    let nearest = Infinity
    let farthest = -Infinity
    cases.forEach(({ d, t }, n) => {
      const from = brickOf(scale(d, t))
      const same = (s: number) => {
        const at = brickOf(scale(d, s))
        return at[0] === from[0] && at[1] === from[1] && at[2] === from[2]
      }
      // March out of the brick, then bisect onto the face.
      let low = t
      let high = t + 1
      while (same(high)) {
        low = high
        high += 1
      }
      for (let k = 0; k < 60; k += 1) {
        const mid = (low + high) / 2
        if (same(mid)) low = mid
        else high = mid
      }
      const past = out[n]! - high
      nearest = Math.min(nearest, past)
      farthest = Math.max(farthest, past)
    })
    // Past the face, so the next sample is the next brick's, and half a
    // meter past it to float32's millimeters in the plane coordinate over
    // the rate of an axis the ray runs nearly along: 5.3 cm, measured.
    expect(nearest).toBeGreaterThan(0.5 - EXIT_SLACK)
    expect(farthest).toBeLessThanOrEqual(0.5 + EXIT_SLACK)
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
      2,
      (read, write) => {
        const sample = sampleAt(test.uniforms, vec3(read(0), read(1), read(2)))
        write(0, test.volume.medium(sample, test.uniforms.served).sigma)
        write(1, test.volume.bound(sample, test.uniforms.served))
      },
    )
    expect(out[0]).toBeCloseTo(SIGMA / 2, 7)
    expect(out[1]).toBe(1)
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

  it('holds one level of each texture, declares their bytes, and builds no pipeline after its warm-up', async () => {
    const test = rig(field)
    expect(test.volume.bytes).toBe(0)
    await test.volume.warm(gpu.renderer)
    const render = gpu.pipelinesBuilt()
    const compute = gpu.computePipelinesBuilt()
    test.settle(eyeAt(EYE_HEIGHT))
    // The slices and the bound drawn at their real size on pipelines the
    // 1 × 1 targets warmed: a pipeline is the format's, not the size's.
    expect(gpu.pipelinesBuilt()).toBe(render)
    expect(gpu.computePipelinesBuilt()).toBe(compute)
    expect(test.volume.bytes).toBe(
      CLOUD_VOLUME_SIZE * CLOUD_VOLUME_SIZE * 3 * STACK * 2 + 64 * 64 * 24 * 4,
    )
    const backend = gpu.renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    const textures = test.volume.textures()
    expect(textures).toHaveLength(2)
    for (const map of textures)
      expect(backend.get(map).texture.mipLevelCount).toBe(1)
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
