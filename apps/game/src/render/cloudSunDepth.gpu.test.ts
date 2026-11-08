import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DataUtils,
  type Node,
  StorageBufferAttribute,
  type Texture,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  ivec3,
  select,
  sin,
  storage,
  texture3D,
  textureLoad,
  uint,
  vec3,
} from 'three/tsl'
import {
  cloudExtents,
  levelFrames,
  reducePoint,
  shellBoundaries,
  shellHeights,
  sunCascades,
  type SunCascade,
  type WeatherScenario,
} from '@inertialref/rendering'
import type { Vec3 } from '@inertialref/spatial'
import {
  CLOUD_CLIPMAP_SIZE,
  CLOUD_CLIPMAP_TEXELS,
  type CloudBodyFrame,
  type CloudFrame,
} from './cloudFrame.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import type {
  CloudBudget,
  CloudMediumFn,
  CloudSunDepthNodes,
} from './cloudNodes.ts'
import type { CloudNoiseNodes } from './cloudNoise.ts'
import {
  CloudSunCascades,
  SUN_CASCADE_EXTENTS,
  SUN_CASCADE_SIZE,
  SUN_CASCADE_STEPS,
  SUN_DEPTH_FRAME_CAP,
} from './cloudSunCascades.ts'
import { CloudSunGrid, SUN_GRID_SIZE } from './cloudSunGrid.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import {
  CLOUD_VOLUME_SIZE,
  CLOUD_VOLUME_TEXELS,
  CloudVolume,
} from './cloudVolume.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The sun's optical depth, both candidates, on the GPU (§3.12): on a
 * uniform slab each answers σ times the slant path; the cascades' Beer form
 * is zero before the front and the whole column past the back; a low sun
 * through a deep union keeps its front depth to centimeters with the pair of
 * half floats, where one half float would not; a scroll ends where a
 * rebuild does; a turned sun rebuilds one cascade a frame; and no frame
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
    cascades: sunCascades(
      eye,
      sun,
      shells,
      SUN_CASCADE_EXTENTS,
      SUN_CASCADE_SIZE,
      previous?.served.cascades.cascades ?? null,
      jump,
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
  baseWide: () => vec3(0).xyzz,
  detail: () => float(0),
  curl: () => vec3(0).xy,
}

const BUDGET: CloudBudget = {
  slices: 8,
  tiles: 1,
  jump: false,
  sunTexelSteps: SUN_DEPTH_FRAME_CAP,
}

type Kind = 'cascades' | 'grid'

interface Rig {
  readonly uniforms: CloudUniforms
  readonly depth: (CloudSunCascades | CloudSunGrid) & CloudSunDepthNodes
  readonly volume: CloudVolume
  frame: CloudFrame | null
  step(eye: Vec3, sun: Vec3, jump?: boolean): CloudFrame
  settle(eye: Vec3, sun: Vec3): number
}

/**
 * The candidate over `medium`, the grid summing through a volume that
 * caches it — or, `volume: false`, through a volume never drawn, which is
 * the field itself everywhere.
 */
function rig(
  kind: Kind,
  medium: CloudMediumFn,
  scenario: WeatherScenario,
  options: { readonly volume?: boolean } = {},
): Rig {
  const cached = options.volume ?? true
  const uniforms = createCloudUniforms()
  const volume = new CloudVolume({ uniforms, bake: medium, detail: NO_NOISE })
  const depth =
    kind === 'cascades'
      ? new CloudSunCascades(uniforms, medium)
      : new CloudSunGrid(uniforms, volume)
  const levers = {
    ...DEFAULT_CLOUD_LEVERS,
    on: true,
    sunDepth: kind,
    cache: 'field' as const,
  }
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
      } while (
        (depth.pending || (kind === 'grid' && cached && volume.pending)) &&
        frames < 64
      )
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
    write(0, test.depth.opticalDepth(vec3(read(0), read(1), read(2))))
  })
}

/** Every texel of a cascade layer, RGBA, row-major. */
async function layer(map: Texture, c: number): Promise<Float32Array> {
  const count = SUN_CASCADE_SIZE * SUN_CASCADE_SIZE
  const output = new StorageBufferAttribute(new Float32Array(count * 4), 1)
  const into = storage(output, 'float', count * 4)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const x = int(instanceIndex.mod(uint(SUN_CASCADE_SIZE)))
      const y = int(instanceIndex.div(uint(SUN_CASCADE_SIZE)))
      const texel = textureLoad(map, ivec2(x, y)).depth(int(c))
      const to = instanceIndex.mul(4)
      into.element(to).assign(texel.x)
      into.element(to.add(1)).assign(texel.y)
      into.element(to.add(2)).assign(texel.z)
      into.element(to.add(3)).assign(texel.w)
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(output))
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

  for (const kind of ['cascades', 'grid'] as const)
    for (const elevation of [37.5, 60]) {
      it(`gives σ times the slant path, within 2%, through the ${kind} at a ${elevation}° sun`, async () => {
        const test = rig(kind, slab(BASE, TOP, SIGMA), scenario)
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
    }

  it('reads zero before the front and the whole column past the back, through the cascades', async () => {
    const test = rig('cascades', slab(BASE, TOP, SIGMA), scenario)
    const eye = eyeAt(EYE)
    const sun = sunAt(37.5)
    test.settle(eye, sun)
    const next = draws(33)
    const above: Vec3[] = []
    const under: Vec3[] = []
    for (let k = 0; k < 256; k += 1) {
      const east = (next() - 0.5) * 6000
      const north = (next() - 0.5) * 6000
      const direction = unit(
        add(
          add(scale(UP, R), scale(HORIZON.east, east)),
          scale(HORIZON.north, north),
        ),
      )
      above.push(sub(scale(direction, R + TOP + 200 + 2000 * next()), eye))
      under.push(sub(scale(direction, R + 100 + 800 * next()), eye))
    }
    const before = await depths(test, above)
    for (const tau of before) expect(tau).toBe(0)
    const past = await depths(test, under)
    under.forEach((offset, k) => {
      const whole = slabDepth(eye, offset, sun, BASE, TOP, SIGMA)
      expect(Math.abs(past[k]! / whole - 1)).toBeLessThan(0.02)
    })
    dispose(test)
  })
})

/* ------------------------------------------------------------------------- */
/* A low sun through a deep union                                            */
/* ------------------------------------------------------------------------- */

describe('a low sun through the anvil’s union', () => {
  /*
   * The anvil's 1–15 km union under a 5° sun, cloud from 9 to 12 km at
   * the anvil's σ. The cascades' near planes then stand 284, 600 and
   * 1,391 km from the eye, and their fronts lie 94–243, 228–953 and
   * 515–1,921 km deep: where one half float steps by 62.5 m to half a
   * kilometer. The stored pair is held to the shader's own march replayed
   * in float64 — the same crossings, the same 48 steps, the same first
   * cloudy step — in optical depth at the largest σ.
   *
   * What the pair stores is to centimeters; what the shader computes is to
   * float32's crossings, formed from a near plane that far out. §5.2's
   * quadratic carries terms of 10¹² m² there, and its root's error is
   * ulp(c)/2√D plus the linear term's: decimeters on most columns and a
   * meter on the outer cascade's worst, measured, 0.116 of an optical
   * depth. So the design's bound of 0.05 is held where float32 resolves a
   * column's crossings to a quarter meter, which is storage's question, and
   * the end-to-end error everywhere is held to the crossings' own limit.
   */
  const BASE = 1000
  const TOP = 15_000
  const SIGMA_MAX = 0.093
  const scenario = slabScenario(BASE, TOP, SIGMA_MAX)
  const CLOUD = [9000, 12_000] as const
  const EYE = 500
  /** Meters: a column whose crossings float32 resolves this well tests storage alone. */
  const RESOLVED = 0.25
  /** Optical depth: the crossings' float32 limit at the outer cascade, 0.116 measured. */
  const CROSSING_LIMIT = 0.15

  /** The ray's two crossings of a sphere of `radius`, from `point` along `direction`, or null. */
  function crossings(
    point: Vec3,
    direction: Vec3,
    radius: number,
  ): readonly [number, number] | null {
    const b = dot3(point, direction)
    const c = dot3(point, point) - radius * radius
    const d = b * b - c
    if (d < 0) return null
    const root = Math.sqrt(d)
    return [-b - root, -b + root]
  }

  /**
   * One texel's column as the bake marches it, float64: its front depth in
   * km, and how far float32 may move its crossings, in meters — the
   * quadratic's terms each rounded once, through the root's sensitivity to
   * c and to b. Null where the column is clear, or a midpoint sits within a
   * meter of the cloud's edge, which float32 may decide either way.
   */
  function column(
    cascade: SunCascade,
    eye: Vec3,
    x: number,
    y: number,
  ): { readonly front: number; readonly error: number } | null {
    const size = SUN_CASCADE_SIZE
    const half = size / 2
    const mod = (v: number) => ((v % size) + size) % size
    const texel = cascade.texelMeters
    const across = (mod(x - mod(cascade.origin[0])) + 0.5 - half) * texel
    const upward = (mod(y - mod(cascade.origin[1])) + 0.5 - half) * texel
    const cx = (cascade.origin[0] + half) * texel - dot3(eye, cascade.right)
    const cy = (cascade.origin[1] + half) * texel - dot3(eye, cascade.up)
    const center = add(scale(cascade.right, cx), scale(cascade.up, cy))
    const near = cascade.plane! - dot3(eye, cascade.toward)
    const origin = add(
      add(add(center, scale(cascade.right, across)), scale(cascade.up, upward)),
      scale(cascade.toward, near),
    )
    const start = add(eye, origin)
    const down = scale(cascade.toward, -1)
    const crossingError = (boundary: number): number => {
      const re = R + EYE
      const linear = re * dot3(UP, down)
      const b = linear + dot3(origin, down)
      const c0 = (EYE - boundary) * (2 * R + EYE + boundary)
      const lift = 2 * re * dot3(UP, origin)
      const squared = dot3(origin, origin)
      const d = b * b - (c0 + lift + squared)
      if (!(d > 0)) return 0
      const root = Math.sqrt(d)
      const dc = (Math.abs(c0) + Math.abs(lift) + squared + b * b) * 2 ** -24
      const db = (Math.abs(linear) + Math.abs(dot3(origin, down))) * 2 ** -24
      return dc / (2 * root) + db * (1 + Math.abs(b) / root)
    }
    const top = crossings(start, down, R + TOP)
    if (top === null) return null
    const base = crossings(start, down, R + BASE)
    const ground = crossings(start, down, R)
    const s0 = Math.max(top[0], 0)
    let s1 = base !== null && base[0] > s0 ? base[0] : top[1]
    if (ground !== null && ground[0] > s0) s1 = Math.min(s1, ground[0])
    if (!(s1 > s0)) return null
    const step = (s1 - s0) / SUN_CASCADE_STEPS
    for (let i = 0; i < SUN_CASCADE_STEPS; i += 1) {
      const s = s0 + (i + 0.5) * step
      const p = add(start, scale(down, s))
      const h = Math.hypot(p.x, p.y, p.z) - R
      if (Math.abs(h - CLOUD[0]) < 1 || Math.abs(h - CLOUD[1]) < 1) return null
      if (h >= CLOUD[0] && h < CLOUD[1])
        return {
          front: (s - step / 2) / 1000,
          error: Math.max(
            crossingError(TOP),
            crossingError(BASE),
            crossingError(0),
          ),
        }
    }
    return null
  }

  it('keeps the front depth to 0.05 of an optical depth at σ_max with the pair, where one half float does not', async () => {
    const test = rig('cascades', slab(CLOUD[0], CLOUD[1], SIGMA_MAX), scenario)
    const eye = eyeAt(EYE)
    const sun = sunAt(5)
    test.settle(eye, sun)
    const cascades = test.frame!.served.cascades.cascades
    const map = test.depth.textures()[0]!
    let pair = 0
    let single = 0
    let everywhere = 0
    let resolved = 0
    for (let c = 0; c < cascades.length; c += 1) {
      const texels = await layer(map, c)
      const next = draws(40 + c)
      for (let n = 0; n < 2000; n += 1) {
        const x = Math.floor(next() * SUN_CASCADE_SIZE)
        const y = Math.floor(next() * SUN_CASCADE_SIZE)
        const expected = column(cascades[c]!, eye, x, y)
        if (expected === null) continue
        const at = (y * SUN_CASCADE_SIZE + x) * 4
        const stored = texels[at]! + texels[at + 3]!
        const error = Math.abs(stored - expected.front) * SIGMA_MAX * 1000
        everywhere = Math.max(everywhere, error)
        if (expected.error >= RESOLVED) continue
        const half = DataUtils.fromHalfFloat(
          DataUtils.toHalfFloat(expected.front),
        )
        pair = Math.max(pair, error)
        single = Math.max(
          single,
          Math.abs(half - expected.front) * SIGMA_MAX * 1000,
        )
        resolved += 1
      }
    }
    expect(resolved).toBeGreaterThan(1000)
    expect(pair).toBeLessThanOrEqual(0.05)
    expect(single).toBeGreaterThan(0.05)
    expect(everywhere).toBeLessThanOrEqual(CROSSING_LIMIT)
    dispose(test)
  })
})
/* ------------------------------------------------------------------------- */
/* Scrolling, turning, and the cap                                           */
/* ------------------------------------------------------------------------- */

describe('a candidate that moves', () => {
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
    }
  }
  const EYE = 500
  const SUN = sunAt(37.5)

  it('ends a cascade’s scroll where its every texel redrawn there ends', async () => {
    const test = rig('cascades', field, scenario)
    test.settle(eyeAt(EYE), SUN)
    const before = test.frame!.served.cascades.cascades[0]!
    // Three inner texels east: the orientation and the near plane hold.
    const moved = eyeAt(EYE, 75)
    test.step(moved, SUN)
    const after = test.frame!.served.cascades.cascades[0]!
    expect(after.origin).not.toEqual(before.origin)
    expect(after.plane).toBe(before.plane)
    expect((test.depth as CloudSunCascades).rebuilt).toBe(null)
    const map = test.depth.textures()[0]!
    const scrolled = await layer(map, 0)
    // The refresh redraws every slice of every cascade, at this frame's window.
    for (let k = 0; k < 24; k += 1) test.step(moved, SUN)
    const redrawn = await layer(map, 0)
    let front = 0
    let rest = 0
    for (let at = 0; at < scrolled.length; at += 4) {
      front = Math.max(
        front,
        Math.abs(
          scrolled[at]! + scrolled[at + 3]! - redrawn[at]! - redrawn[at + 3]!,
        ),
      )
      for (const k of [1, 2])
        rest = Math.max(
          rest,
          Math.abs(scrolled[at + k]! - redrawn[at + k]!) /
            Math.max(Math.abs(redrawn[at + k]!), 1e-3),
        )
    }
    // A texel's column is the same column whichever eye drew it, to
    // float32's centimeters about two eyes 75 m apart (1.7 cm, measured);
    // its stored G and B can then round to neighboring half floats, at most
    // 2⁻¹⁰ apart (8.3 × 10⁻⁴, measured).
    expect(front).toBeLessThan(1e-3)
    expect(rest).toBeLessThan(1e-3)
    dispose(test)
  })

  it('ends the grid’s scroll where a grid built at the new window begins', async () => {
    // Summed through the field itself, so the two grids read one medium
    // whatever their volumes' refresh has reached.
    const test = rig('grid', field, scenario, { volume: false })
    test.settle(eyeAt(EYE), SUN)
    const origin = test.frame!.served.volume.frames[1]!.origin
    // Two cells east, on level 1's held anchor.
    const moved = eyeAt(EYE, 800)
    test.step(moved, SUN)
    expect(test.frame!.served.volume.rebuilt[1]).toBe(false)
    expect(test.depth.pending).toBe(true)
    const held = test.frame!
    test.settle(moved, SUN)
    const fresh = rig('grid', field, scenario, { volume: false })
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

  it('rebuilds one cascade a frame, inner first, when the sun turns past 0.05°', () => {
    const test = rig('cascades', field, scenario)
    const eye = eyeAt(EYE)
    test.settle(eye, SUN)
    expect(test.depth.pending).toBe(false)
    const turned = sunAt(37.5, 20.1)
    const order: (number | null)[] = []
    for (let k = 0; k < 4; k += 1) {
      test.step(eye, turned)
      order.push((test.depth as CloudSunCascades).rebuilt)
    }
    expect(order).toEqual([0, 1, 2, null])
    expect(test.depth.pending).toBe(false)
    // 0.04° moves nothing.
    test.step(eye, sunAt(37.5, 20.14))
    expect((test.depth as CloudSunCascades).rebuilt).toBe(null)
    dispose(test)
  })

  it('spends no frame past the cap: a cut, a jump, a turning sun, a flight', () => {
    for (const kind of ['cascades', 'grid'] as const) {
      const test = rig(kind, field, scenario)
      const spent: number[] = []
      const record = () => spent.push((test.depth as CloudSunCascades).spent)
      let east = 0
      for (let k = 0; k < 40; k += 1) {
        east += 128
        const azimuth = 20 + (k % 10 === 0 ? 0.2 * k : 0)
        test.step(eyeAt(EYE, east), sunAt(37.5, azimuth), k === 15)
        record()
      }
      expect(Math.max(...spent)).toBeLessThanOrEqual(SUN_DEPTH_FRAME_CAP)
      // The first frame rebuilds whole: a cascade, or the grid at the cap.
      expect(spent[0]).toBe(
        kind === 'cascades'
          ? SUN_CASCADE_SIZE ** 2 * SUN_CASCADE_STEPS
          : SUN_DEPTH_FRAME_CAP,
      )
      dispose(test)
    }
  })
})

/* ------------------------------------------------------------------------- */
/* The resource                                                               */
/* ------------------------------------------------------------------------- */

describe('the candidates as resources', () => {
  it('hold one level of their texture, declare its bytes, build no pipeline after their warm-ups, and hold nothing once disposed', async () => {
    const backend = gpu.renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    for (const [kind, bytes] of [
      ['cascades', SUN_CASCADE_SIZE ** 2 * 3 * 8],
      ['grid', SUN_GRID_SIZE[0] * SUN_GRID_SIZE[1] * SUN_GRID_SIZE[2] * 2],
    ] as const) {
      const test = rig(
        kind,
        slab(1000, 2000, 0.01),
        slabScenario(1000, 2000, 0.02),
      )
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
    }
  })
})
