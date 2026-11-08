import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DataTexture,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  StorageBufferAttribute,
  type Texture,
  UnsignedByteType,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  max,
  normalize,
  screenUV,
  select,
  storage,
  textureLoad,
  uint,
  vec3,
  vec4,
} from 'three/tsl'
import {
  altitudeAlong,
  cubeDirection,
  cubeTexelCoordinate,
  type CubeFace,
  shellCrossings,
  unionSpan,
  type ShellHeights,
  WEATHER_SCENARIOS,
} from '@inertialref/rendering'
import { type CloudFarField, createFarField } from './cloudFar.ts'
import {
  type AirMediumFn,
  CloudFarAtlas,
  FAR_BLOCK,
  FAR_CYCLE,
  FAR_HEIGHT,
  FAR_MARGIN,
  FAR_WIDTH,
  farBlock,
} from './cloudFarAtlas.ts'
import { CloudFarSpheres } from './cloudFarSpheres.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { cloudRay } from './cloudGeometry.ts'
import { type CloudFarKind, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  type CloudBudget,
  type CloudMediumFn,
  CLOUD_STAND_INS,
  CLOUD_VACUUM,
  type CloudSlab,
  slabMedium,
} from './cloudNodes.ts'
import {
  type CloudBodyUniforms,
  type CloudUniforms,
  createCloudUniforms,
} from './cloudUniforms.ts'
import { adapterOffers, type GpuSession, openGpu } from './gpuHarness.ts'
import { installPassTimeline, passTimelineOf } from './passTimeline.ts'

/*
 * The far field on the GPU, both candidates, against analytic media bound
 * through the stand-ins (§3.5): a slab's transmittance, light and depth
 * moments against the fine march's limit computed here in float64, the
 * atlas's bake against the same statistics computed on the CPU, the bake's
 * cadence and allocation, and the blocked air's beam by class (§9).
 *
 * The media are the contracts' slabs, so a column is the same everywhere and
 * what a candidate's representation loses is only what its march loses. The
 * atlas stores in-cloud τ as an 8-bit log code and base and top as 8-bit
 * fractions of the layer's range, so its slabs sit on code values: a slab
 * from 1,000 m to 2,500 m is codes 51 and 204 exactly, and τ = 513^(m/255) − 1
 * is code m. The spheres store half floats, which every slab here is within
 * 2.5 × 10⁻⁴ of.
 */

const TIMESTAMPS = await adapterOffers('timestamp-query')

let gpu: GpuSession
let renderer: WebGPURenderer
let device: GPUDevice

beforeAll(async () => {
  gpu = await openGpu()
  renderer = gpu.renderer
  device = (renderer.backend as unknown as { device: GPUDevice }).device
})

afterAll(() => {
  gpu.dispose()
})

/** Earth's datum radius, true meters. */
const EARTH = 6_371_000
/** One slab layer, 1,000 m to 2,500 m: base and top on the atlas's codes 51 and 204. */
const LAYER = { base: 1000, top: 2500 } as const
/** A layer above it, the same thickness, for the sun's path through the layers above. */
const HIGH_LAYER = { base: 4000, top: 5500 } as const
/** The atlas's in-cloud τ at log code m, exactly. */
const tauAtCode = (code: number): number => 513 ** (code / 255) - 1
/** The stand-in phase: isotropic, normalized. */
const ISOTROPIC = 1 / (4 * Math.PI)

const BUDGET: CloudBudget = {
  slices: 8,
  tiles: 1,
  jump: false,
  sunTexelSteps: 0,
}

/**
 * Run `work` inside a validation scope of the test's own and fail on any
 * error either channel carried: the far field's `render` draws outside the
 * harness's verbs, which check their own.
 */
async function checked<T>(work: () => T | Promise<T>): Promise<T> {
  const from = gpu.reported().length
  device.pushErrorScope('validation')
  let result: T
  try {
    result = await work()
  } finally {
    const scoped = await device.popErrorScope()
    if (scoped !== null)
      throw new Error(`the device reported: ${scoped.message}`)
  }
  await device.queue.onSubmittedWorkDone()
  for (let turn = 0; turn < 3; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
  expect(
    gpu
      .reported()
      .slice(from)
      .filter((entry) => entry.type === 'error'),
  ).toEqual([])
  return result
}

/* ------------------------------------------------------------------------- */
/* The body and its frame                                                     */
/* ------------------------------------------------------------------------- */

interface Vec {
  readonly x: number
  readonly y: number
  readonly z: number
}

const unit = (v: Vec): Vec => {
  const n = Math.hypot(v.x, v.y, v.z)
  return { x: v.x / n, y: v.y / n, z: v.z / n }
}
const dot3 = (a: Vec, b: Vec): number => a.x * b.x + a.y * b.y + a.z * b.z

/** The eye straight over the body's +Y, its local vertical. */
const UP: Vec = { x: 0, y: 1, z: 0 }

interface Placement {
  /** The eye over the datum, meters. */
  readonly eye: number
  /** Body-fixed, toward the sun. */
  readonly sun: Vec
  /** [base, top] a layer, at most three; absent layers sit at the highest top. */
  readonly layers: readonly (readonly [number, number])[]
  readonly radius?: number
  /** `clearedFromOrbit`'s value. */
  readonly cleared?: number
}

/** The six boundaries `ShellHeights` lays out: each layer's base and top, absent ones at the highest top. */
function boundariesOf(layers: Placement['layers']): number[] {
  const flat = layers.flatMap(([base, top]) => [base, top])
  const ceiling = Math.max(...flat)
  while (flat.length < 6) flat.push(ceiling)
  return flat
}

/** The float64 heights the uniforms carry, as `cloudFrame` forms them. */
function shellsOf(place: Placement): ShellHeights {
  const boundaries = boundariesOf(place.layers)
  return {
    datumRadius: place.radius ?? EARTH,
    eye: place.eye,
    boundaries,
    eyeOver: boundaries.map((b) => place.eye - b),
  }
}

/** Write a body's uniforms as `CloudUniforms.write` would for this eye, and the layers' with them. */
function placeBody(
  uniforms: CloudUniforms,
  body: CloudBodyUniforms,
  place: Placement,
): void {
  const shells = shellsOf(place)
  const [b0, t0, b1, t1, b2, t2] = shells.boundaries as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const [o0, o1, o2, o3, o4, o5] = shells.eyeOver as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const radius = shells.datumRadius
  body.datumRadius.value = radius
  body.eye.value = place.eye
  body.eyeOver.value.set(o0, o1, o2, o3)
  body.eyeOverHigh.value.set(o4, o5)
  body.boundaries.value.set(b0, t0, b1, t1)
  body.boundariesHigh.value.set(b2, t2)
  body.eyeTerm.value = place.eye * (2 * radius + place.eye)
  body.up.value.set(UP.x, UP.y, UP.z)
  const sun = unit(place.sun)
  body.sun.value.set(sun.x, sun.y, sun.z)
  body.sunUp.value = dot3(UP, sun)
  body.cleared.value = place.cleared ?? 0
  body.active.value = 1
  uniforms.layers.base.value.set(b0, b1, b2)
  uniforms.layers.top.value.set(t0, t1, t2)
  uniforms.layers.radius.value.set(10, 10, 10)
}

/** A frame as the far field reads one: its levers, its scenario, its bodies, its jump. */
function frameFor(
  kind: CloudFarKind,
  options: { readonly jump?: boolean; readonly second?: boolean } = {},
): CloudFrame {
  return {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true, far: kind },
    scenario: WEATHER_SCENARIOS.overcast,
    served: { address: 'served' },
    second: options.second === true ? { address: 'second' } : null,
    jump: options.jump ?? false,
  } as unknown as CloudFrame
}

/* ------------------------------------------------------------------------- */
/* Building, baking and marching a far field                                  */
/* ------------------------------------------------------------------------- */

interface Built {
  readonly field: CloudFarField
  readonly uniforms: CloudUniforms
  readonly body: CloudBodyUniforms
}

function build(
  kind: CloudFarKind,
  medium: CloudMediumFn,
  place: Placement,
  options: { readonly air?: AirMediumFn; readonly second?: boolean } = {},
): Built {
  const uniforms = createCloudUniforms()
  const side = options.second === true ? 'second' : 'served'
  const body = uniforms[side]
  placeBody(uniforms, body, place)
  const deps = {
    uniforms,
    field: CLOUD_STAND_INS.field(medium),
    phase: CLOUD_STAND_INS.phase(),
    body: side,
  } as const
  const field =
    options.air === undefined
      ? createFarField(kind, deps)
      : kind === 'atlas'
        ? new CloudFarAtlas(deps, { air: options.air })
        : new CloudFarSpheres(deps, { air: options.air })
  return { field, uniforms, body }
}

/** Every block once, after the warm-up. */
async function bake(built: Built, second = false): Promise<void> {
  const kind = built.field instanceof CloudFarAtlas ? 'atlas' : 'spheres'
  await checked(() => built.field.warm(renderer))
  await checked(() => {
    for (let k = 0; k < FAR_CYCLE; k += 1)
      built.field.render(renderer, frameFor(kind, { second }), BUDGET)
  })
}

interface Probe {
  /** Body-fixed, unit. */
  readonly direction: Vec
  /** Where the far march starts; the span's own start when it is earlier. */
  readonly from?: number
  readonly sky?: boolean
}

interface Marched {
  readonly light: readonly [number, number, number]
  readonly air: readonly [number, number, number]
  readonly transmittance: number
  readonly mean: number
  readonly deviation: number
  /** The span the kernel's ray had, and where the march began. */
  readonly start: number
  readonly end: number
  readonly from: number
}

const PROBE_IN = 5
const PROBE_OUT = 12

/** The far march for each probe, in one kernel: `cloudRay` gives the span, the far field marches it. */
async function march(
  built: Built,
  probes: readonly Probe[],
): Promise<Marched[]> {
  const count = probes.length
  const inputs = new Float32Array(count * PROBE_IN)
  probes.forEach((probe, k) => {
    const d = unit(probe.direction)
    inputs.set(
      [d.x, d.y, d.z, probe.from ?? -1, probe.sky === true ? 1 : 0],
      k * PROBE_IN,
    )
  })
  const input = new StorageBufferAttribute(inputs, 1)
  const output = new StorageBufferAttribute(
    new Float32Array(count * PROBE_OUT),
    1,
  )
  const from = storage(input, 'float', inputs.length)
  const into = storage(output, 'float', count * PROBE_OUT)
  const { body, field } = built
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const at = instanceIndex.mul(PROBE_IN)
      const read = (k: number): Node<'float'> => from.element(at.add(k))
      const direction = vec3(read(0), read(1), read(2))
      const ray = cloudRay(direction, body, float(1e9))
      const start = max(ray.start, read(3)).toVar()
      const result = field.far(ray, start, body, read(4).greaterThan(0.5))
      const to = instanceIndex.mul(PROBE_OUT)
      const values = [
        result.light.x,
        result.light.y,
        result.light.z,
        result.air.x,
        result.air.y,
        result.air.z,
        result.transmittance,
        result.depthMean,
        result.depthDeviation,
        ray.start,
        ray.end,
        start,
      ]
      values.forEach((value, k) => {
        into.element(to.add(k)).assign(value)
      })
    })
  })().compute(count)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(output))
  return probes.map((_, k) => {
    const v = values.subarray(k * PROBE_OUT, (k + 1) * PROBE_OUT)
    return {
      light: [v[0]!, v[1]!, v[2]!],
      air: [v[3]!, v[4]!, v[5]!],
      transmittance: v[6]!,
      mean: v[7]!,
      deviation: v[8]!,
      start: v[9]!,
      end: v[10]!,
      from: v[11]!,
    }
  })
}

/** Texels of an atlas, read back by a kernel: `textureLoad`, so nothing filters them. */
async function texels(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<number[][]> {
  const out = new StorageBufferAttribute(new Float32Array(at.length * 4), 1)
  const into = storage(out, 'float', at.length * 4)
  const kernel = Fn(() => {
    at.forEach(([x, y], k) => {
      const read = textureLoad(map, ivec2(x, y))
      If(instanceIndex.equal(uint(0)), () => {
        into.element(k * 4).assign(read.x)
        into.element(k * 4 + 1).assign(read.y)
        into.element(k * 4 + 2).assign(read.z)
        into.element(k * 4 + 3).assign(read.w)
      })
    })
  })().compute(1)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  return at.map((_, k) => [...values.subarray(k * 4, k * 4 + 4)])
}

/** Many texels of an atlas, one invocation each: four floats a texel, in order. */
async function texelsAt(
  map: Texture,
  at: readonly (readonly [number, number])[],
): Promise<Float32Array> {
  const count = at.length
  const coordinates = new StorageBufferAttribute(
    new Uint32Array(at.flatMap(([x, y]) => [x, y])),
    1,
  )
  const out = new StorageBufferAttribute(new Float32Array(count * 4), 1)
  const from = storage(coordinates, 'uint', count * 2)
  const into = storage(out, 'float', count * 4)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const x = int(from.element(instanceIndex.mul(2)))
      const y = int(from.element(instanceIndex.mul(2).add(1)))
      const read = textureLoad(map, ivec2(x, y))
      const to = instanceIndex.mul(4)
      into.element(to).assign(read.x)
      into.element(to.add(1)).assign(read.y)
      into.element(to.add(2)).assign(read.z)
      into.element(to.add(3)).assign(read.w)
    })
  })().compute(count)
  await gpu.compute(kernel)
  return new Float32Array(await gpu.readBuffer(out))
}

/** The texture a far field bakes into. */
const textureOf = (field: CloudFarField): Texture => field.textures()[0]!

/* ------------------------------------------------------------------------- */
/* The program                                                                */
/* ------------------------------------------------------------------------- */

const KINDS = ['atlas', 'spheres'] as const

/** One slab, filling `LAYER`. */
const slab = (sigma: number, extra: Partial<CloudSlab> = {}): CloudMediumFn =>
  slabMedium([{ base: LAYER.base, top: LAYER.top, sigma, ...extra }])

describe('the far march in a fragment', () => {
  it.each(KINDS)(
    '%s compiles in control flow that differs per pixel, every read at level 0, its atlas its one binding',
    async (kind) => {
      const built = build(kind, slab(1e-3), {
        eye: 400_000,
        sun: UP,
        layers: [[LAYER.base, LAYER.top]],
      })
      const material = new MeshBasicNodeMaterial()
      material.colorNode = Fn(() => {
        // A direction and a class per pixel: the composite's case.
        const direction = normalize(
          vec3(screenUV.x.sub(0.5), float(-1), screenUV.y.sub(0.5)),
        )
        const ray = cloudRay(direction, built.body, float(1e9))
        const result = built.field.far(
          ray,
          ray.start,
          built.body,
          screenUV.x.greaterThan(0.5),
        )
        return vec4(
          result.light.add(result.air),
          result.transmittance.add(result.depthMean.mul(0)),
        )
      })()
      const mesh = new Mesh(new PlaneGeometry(2, 2), material)
      const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10)
      camera.position.z = 1
      camera.updateMatrixWorld()
      const scene = new Scene()
      scene.add(mesh)
      await gpu.compile(mesh, camera, scene)
      const { fragmentShader } = await gpu.shader(mesh, camera, scene)
      expect(fragmentShader).not.toMatch(/textureSample\(/)
      expect(fragmentShader).toMatch(/textureSampleLevel\(/)
      // The atlas, the air's two tables and the phase table: a far field binds
      // one texture of its own (§3.7).
      expect(fragmentShader.match(/:\s*texture_2d</g) ?? []).toHaveLength(4)
      built.field.dispose()
    },
  )
})

/* ------------------------------------------------------------------------- */
/* The fine march's limit, in float64                                         */
/* ------------------------------------------------------------------------- */

/** A body-fixed direction at cosine `mu` to the eye's vertical, turned `azimuth` from +X toward +Z. */
const toward = (mu: number, azimuth = 0): Vec => {
  const across = Math.sqrt(Math.max(1 - mu * mu, 0))
  return {
    x: across * Math.cos(azimuth),
    y: mu,
    z: across * Math.sin(azimuth),
  }
}

/** The span `cloudRay` gives a ray, float64: the union's, clipped to the datum. */
function spanOf(place: Placement, direction: Vec): readonly [number, number] {
  const span = unionSpan(shellsOf(place), dot3(UP, unit(direction)), 1e9)
  if (span === null) throw new Error('a probe that misses the union')
  return span
}

/** The pieces of [from, end] a ray spends inside the slab [base, top), float64. */
function slabPieces(
  place: Placement,
  direction: Vec,
  [base, top]: readonly [number, number],
  from: number,
): (readonly [number, number])[] {
  const radius = place.radius ?? EARTH
  const mu = dot3(UP, unit(direction))
  const [, end] = spanOf(place, direction)
  const upper = shellCrossings(radius, place.eye, place.eye - top, mu)
  if (upper === null) return []
  const lower = shellCrossings(radius, place.eye, place.eye - base, mu)
  const pieces: (readonly [number, number])[] =
    lower === null
      ? [upper]
      : [
          [upper[0], lower[0]],
          [lower[1], upper[1]],
        ]
  return pieces
    .map(([a, b]) => [Math.max(a, from), Math.min(b, end)] as const)
    .filter(([a, b]) => b > a)
}

const STEPS = 4000

/** Beer's law over the pieces, and the moments of the opacity −dT/dt over them, by quadrature. */
function slabTruth(
  pieces: readonly (readonly [number, number])[],
  sigma: number,
): { transmittance: number; mean: number; deviation: number; length: number } {
  let through = 1
  let weight = 0
  let first = 0
  let second = 0
  let length = 0
  for (const [a, b] of pieces) {
    const dt = (b - a) / STEPS
    length += b - a
    for (let i = 0; i < STEPS; i += 1) {
      const t = a + (i + 0.5) * dt
      const w = through * -Math.expm1(-sigma * dt)
      weight += w
      first += w * t
      second += w * t * t
      through *= Math.exp(-sigma * dt)
    }
  }
  const mean = first / weight
  return {
    transmittance: through,
    mean,
    deviation: Math.sqrt(Math.max(second / weight - mean * mean, 0)),
    length,
  }
}

/**
 * The slab's single scattering, phase not applied, beam white: the fine
 * march's limit, each point lit through the slab above it along the sun,
 * every distance from the stable crossings in float64.
 */
function slabLight(
  place: Placement,
  direction: Vec,
  layer: readonly [number, number],
  sigma: number,
  from: number,
): number {
  const radius = place.radius ?? EARTH
  const d = unit(direction)
  const sun = unit(place.sun)
  const mu = dot3(UP, d)
  const nu = dot3(d, sun)
  const sunUp = dot3(UP, sun)
  let through = 1
  let light = 0
  for (const [a, b] of slabPieces(place, direction, layer, from)) {
    const dt = (b - a) / STEPS
    for (let i = 0; i < STEPS; i += 1) {
      const t = a + (i + 0.5) * dt
      const height = altitudeAlong(radius, place.eye, mu, t)
      const r = radius + height
      const muSun = ((radius + place.eye) * sunUp + t * nu) / r
      const exit = shellCrossings(radius, height, height - layer[1], muSun)
      const toTop = exit === null ? 0 : exit[1]
      light += through * Math.exp(-sigma * toTop) * -Math.expm1(-sigma * dt)
      through *= Math.exp(-sigma * dt)
    }
  }
  return light
}

/* ------------------------------------------------------------------------- */
/* A uniform slab against the fine march                                      */
/* ------------------------------------------------------------------------- */

/**
 * A thick slab (τ 1.47 a column, the atlas's code 37; 1.5 for the spheres)
 * through steep rays from below, inside, above and orbit; a thin one along
 * grazing chords, which only the atlas follows. The thin one is τ 0.103, the
 * atlas's code 4 and the least past the bake's cloudy threshold: a column
 * under τ 0.1 is clear by the design's rule, and a thinner slab bakes to
 * nothing. The spheres take each crossing at the plane-parallel slant
 * through the sphere, which is the chord to second order in the curvature
 * (2 × 10⁻⁶ at μ = 0.2), and fail a grazing chord by construction: there is
 * no column mixing along it.
 */
const THICK = { atlas: tauAtCode(37), spheres: 1.5 } as const
const THIN = { atlas: tauAtCode(4), spheres: 0.103 } as const
const THICKNESS = LAYER.top - LAYER.base

const steep = (
  eye: number,
  mus: readonly number[],
): Placement & {
  readonly probes: readonly Vec[]
} => ({
  eye,
  sun: UP,
  layers: [[LAYER.base, LAYER.top]],
  probes: mus.flatMap((mu) => [toward(mu, 0.3), toward(mu, 2.1)]),
})

const STEEP = [
  steep(200, [1, 0.7, 0.4]),
  steep(1800, [1, 0.5, -0.5, -1]),
  steep(5000, [-1, -0.7, -0.4]),
  steep(400_000, [-1, -0.97]),
]

/**
 * Chords of 16 to 51 km through the thin slab, a quarter to two of its τ:
 * level and rising from 100 m under its top, rising through it from under it,
 * and dipping into it from over it, the perigee inside the slab (−0.01 dips
 * 18 m, −0.0105 dips 51 m), where the shell's one interval spans the perigee.
 */
const GRAZING = [
  steep(2400, [0, 0.002, 0.005]),
  steep(200, [0.02, 0.025]),
  steep(2800, [-0.01, -0.0105]),
]

/** T is held absolutely: an 8-bit code is the atlas's floor, and T spans [0, 1]. */
const TRANSMITTANCE_BOUND = 1e-3

describe('a uniform slab', () => {
  it.each(KINDS)(
    'marched by the %s has the fine march’s transmittance on every steep ray',
    async (kind) => {
      const sigma = THICK[kind] / THICKNESS
      for (const place of STEEP) {
        const built = build(kind, slab(sigma), place)
        await bake(built)
        const result = await march(
          built,
          place.probes.map((direction) => ({ direction })),
        )
        result.forEach((got, k) => {
          const direction = place.probes[k]!
          const [start, end] = spanOf(place, direction)
          expect(got.start).toBeCloseTo(start, -1)
          expect(got.end).toBeCloseTo(end, -1)
          const truth = slabTruth(
            slabPieces(place, direction, [LAYER.base, LAYER.top], start),
            sigma,
          )
          expect(
            Math.abs(got.transmittance - truth.transmittance),
            `${kind} from ${place.eye} m at μ ${direction.y}`,
          ).toBeLessThanOrEqual(TRANSMITTANCE_BOUND)
        })
        built.field.dispose()
      }
    },
  )

  it('marched by the atlas has the fine march’s transmittance along grazing chords, the column read a texel a step', async () => {
    const sigma = THIN.atlas / THICKNESS
    for (const place of GRAZING) {
      const built = build('atlas', slab(sigma), place)
      await bake(built)
      const result = await march(
        built,
        place.probes.map((direction) => ({ direction })),
      )
      result.forEach((got, k) => {
        const direction = place.probes[k]!
        const truth = slabTruth(
          slabPieces(place, direction, [LAYER.base, LAYER.top], got.from),
          sigma,
        )
        // Chords over ten times the slab's thickness, and far from opaque:
        // the shell they run in takes two to four texel-long steps.
        expect(truth.length).toBeGreaterThan(15_000)
        expect(truth.transmittance).toBeGreaterThan(0.01)
        expect(
          Math.abs(got.transmittance - truth.transmittance),
          `from ${place.eye} m at μ ${direction.y}`,
        ).toBeLessThanOrEqual(TRANSMITTANCE_BOUND)
      })
      built.field.dispose()
    }
  })

  /*
   * The far march lights a column from half its own depth toward the sun
   * (§5.13 step 5): its light is c·T_sun·P₁·(1 − e^(−τ_s)) a step, which over
   * one slab is (1 − T)·e^(−τ/2μ_s)·P₁ whatever the steps. That holds the step
   * integral, the half column, the beam and the phase, at any depth.
   */
  it.each(KINDS)(
    'marched by the %s has the design’s light model in a thick slab',
    async (kind) => {
      const tau = THICK[kind]
      const sigma = tau / THICKNESS
      for (const place of STEEP.filter((p) => p.eye !== 1800)) {
        const built = build(kind, slab(sigma), place)
        await bake(built)
        const result = await march(
          built,
          place.probes.map((direction) => ({ direction })),
        )
        result.forEach((got, k) => {
          const truth = slabTruth(
            slabPieces(
              place,
              place.probes[k]!,
              [LAYER.base, LAYER.top],
              got.from,
            ),
            sigma,
          )
          // The sun at the zenith: its cosine over any column of these rays is
          // within 1.2 × 10⁻⁴ of 1, which moves e^(−τ/2μ_s) by under 10⁻⁴.
          const model = (1 - truth.transmittance) * Math.exp(-tau / 2)
          expect(
            Math.abs(got.light[1] / ISOTROPIC / model - 1),
            `${kind} from ${place.eye} m at μ ${place.probes[k]!.y}`,
          ).toBeLessThanOrEqual(1e-3)
        })
        built.field.dispose()
      }
    },
  )

  /*
   * Against each point's own path to the sun, which is the fine march's
   * limit, the half column is right to second order in τ: measured against
   * this file's quadrature at τ 0.103, the thinnest slab the bake holds, it is
   * 1.1 × 10⁻³ off from below and 3.7 × 10⁻³ from above (μ −0.6 under a sun
   * at μ 0.6), where the lit top of the column is the half nearer the eye.
   * The bound is that measured limit, not the march's.
   */
  it.each(KINDS)(
    'marched by the %s has the fine march’s light in a thin slab, within the half column’s second order',
    async (kind) => {
      const sigma = THIN[kind] / THICKNESS
      const cases: { place: Placement; probes: Vec[] }[] = [
        {
          place: { eye: 200, sun: UP, layers: [[LAYER.base, LAYER.top]] },
          probes: [toward(1), toward(0.8, 1), toward(0.6, 2)],
        },
        {
          place: {
            eye: 200,
            sun: toward(0.866, 0.4),
            layers: [[LAYER.base, LAYER.top]],
          },
          probes: [toward(1), toward(0.8, 0.4), toward(0.6, 2.5)],
        },
        {
          place: {
            eye: 5000,
            sun: toward(0.6, 1.2),
            layers: [[LAYER.base, LAYER.top]],
          },
          probes: [toward(-1), toward(-0.7, 1.2), toward(-0.6, 4)],
        },
      ]
      for (const { place, probes } of cases) {
        const built = build(kind, slab(sigma), place)
        await bake(built)
        const result = await march(
          built,
          probes.map((direction) => ({ direction })),
        )
        result.forEach((got, k) => {
          const truth = slabLight(
            place,
            probes[k]!,
            [LAYER.base, LAYER.top],
            sigma,
            got.from,
          )
          const [r, g, b] = got.light
          expect(r).toBe(g)
          expect(b).toBe(g)
          // The half column's measured 3.7 × 10⁻³ is most of each bound. The
          // spheres cache their sun at a texel's center, up to 27 km from where
          // the ray crosses, which moves e^(−τ/2μ_s) by up to 5 × 10⁻⁴ under a
          // sun at μ 0.6.
          expect(
            Math.abs(g / ISOTROPIC / truth - 1),
            `${kind} from ${place.eye} m at μ ${probes[k]!.y}`,
          ).toBeLessThanOrEqual(kind === 'atlas' ? 4e-3 : 4.5e-3)
        })
        built.field.dispose()
      }
    },
  )

  /*
   * Each step carries the truncated exponential its cloud's opacity follows,
   * combined by the parallel-axis rule, so the moments of a uniform slab are
   * exact however the march divides it. The spheres center a crossing's run on
   * the mid-height sphere, which the true run sits κH²/(4μ³) from: 1.6 m at
   * μ = 0.3 against a 5 km run, under the bound.
   */
  it.each(KINDS)(
    'marched by the %s has the depth moments of one slab',
    async (kind) => {
      const places = kind === 'atlas' ? [...STEEP, ...GRAZING] : STEEP
      for (const place of places) {
        const sigma = (GRAZING.includes(place) ? THIN : THICK)[kind] / THICKNESS
        const built = build(kind, slab(sigma), place)
        await bake(built)
        const result = await march(
          built,
          place.probes.map((direction) => ({ direction })),
        )
        result.forEach((got, k) => {
          const truth = slabTruth(
            slabPieces(
              place,
              place.probes[k]!,
              [LAYER.base, LAYER.top],
              got.from,
            ),
            sigma,
          )
          const bound = 1e-3 * truth.length
          expect(
            Math.abs(got.mean - truth.mean),
            `${kind} mean from ${place.eye} m at μ ${place.probes[k]!.y}`,
          ).toBeLessThanOrEqual(bound)
          expect(
            Math.abs(got.deviation - truth.deviation),
            `${kind} deviation from ${place.eye} m at μ ${place.probes[k]!.y}`,
          ).toBeLessThanOrEqual(bound)
        })
        built.field.dispose()
      }
    },
  )

  it.each(KINDS)(
    'marched by the %s through a vacuum is clear, unlit, and its depth where it began',
    async (kind) => {
      const place = steep(5000, [-1, -0.5])
      const built = build(kind, CLOUD_VACUUM, place)
      await bake(built)
      const result = await march(
        built,
        place.probes.map((direction) => ({ direction })),
      )
      for (const got of result) {
        expect(got.transmittance).toBe(1)
        expect(got.light).toEqual([0, 0, 0])
        expect(got.air).toEqual([0, 0, 0])
        expect(got.mean).toBe(got.from)
        expect(got.deviation).toBe(0)
      }
      built.field.dispose()
    },
  )

  /*
   * The fine march may stop anywhere inside a layer, so the far march takes
   * only what is left of it: the atlas by clipping its shells to the span,
   * the spheres by clipping each crossing's run.
   */
  it.each(KINDS)(
    'marched by the %s from inside the slab takes only the rest of it',
    async (kind) => {
      const sigma = THICK[kind] / THICKNESS
      const place = steep(5000, [-1, -0.6])
      const built = build(kind, slab(sigma), place)
      await bake(built)
      const probes = place.probes.map((direction) => {
        const [start] = spanOf(place, direction)
        // A third of the way down through the slab.
        return { direction, from: start + THICKNESS / 3 / -direction.y }
      })
      const result = await march(built, probes)
      result.forEach((got, k) => {
        const truth = slabTruth(
          slabPieces(
            place,
            probes[k]!.direction,
            [LAYER.base, LAYER.top],
            got.from,
          ),
          sigma,
        )
        expect(
          Math.abs(got.transmittance - truth.transmittance),
        ).toBeLessThanOrEqual(TRANSMITTANCE_BOUND)
      })
      built.field.dispose()
    },
  )
})

/* ------------------------------------------------------------------------- */
/* The sun through the layers above                                           */
/* ------------------------------------------------------------------------- */

describe('a slab under a partly cloudy one', () => {
  /*
   * Three bakes: both slabs, the upper alone, the lower alone. The lower's
   * light under the upper is its light alone times the upper's column mixed
   * along the sun, (1 − c) + c·e^(−τ/μ_s) (§5.13 step 5), and the upper's light
   * reaches the eye through the lower: L_both = L_low·T_above + T_low·L_high.
   * The upper slab's share is 0.6, code 153 exactly.
   */
  const COVER = 0.6
  const twoLayers: Placement['layers'] = [
    [LAYER.base, LAYER.top],
    [HIGH_LAYER.base, HIGH_LAYER.top],
  ]
  const lowSigma = (kind: CloudFarKind): number => THIN[kind] / THICKNESS
  const highTau = (kind: CloudFarKind): number => THICK[kind]
  const media = (
    kind: CloudFarKind,
    low: boolean,
    high: boolean,
  ): CloudMediumFn =>
    slabMedium([
      { ...LAYER, sigma: low ? lowSigma(kind) : 0 },
      {
        ...HIGH_LAYER,
        sigma: high ? highTau(kind) / THICKNESS : 0,
        fraction: COVER,
      },
    ])

  it.each([
    ['atlas', UP],
    ['spheres', UP],
    ['atlas', toward(0.8, 0.7)],
  ] as const)(
    'the %s dims the lower slab by the upper one along a sun at %o',
    async (kind, sun) => {
      const place: Placement = { eye: 200, sun, layers: twoLayers }
      const probes = [{ direction: toward(1) }, { direction: toward(0.9, 2) }]
      const runs: Marched[][] = []
      for (const [low, high] of [
        [true, true],
        [false, true],
        [true, false],
      ] as const) {
        const built = build(kind, media(kind, low, high), place)
        await bake(built)
        runs.push(await march(built, probes))
        built.field.dispose()
      }
      const [both, upper, lower] = runs as [Marched[], Marched[], Marched[]]
      probes.forEach((probe, k) => {
        const muSun = dot3(UP, unit(sun))
        const expected = 1 - COVER + COVER * Math.exp(-highTau(kind) / muSun)
        const above =
          (both[k]!.light[1] - lower[k]!.transmittance * upper[k]!.light[1]) /
          lower[k]!.light[1]
        expect(
          Math.abs(above - expected),
          `${kind} at μ ${probe.direction.y}`,
        ).toBeLessThanOrEqual(1e-3)
        // Seen from below, the upper slab is one column too, mixed at its share.
        const mu = probe.direction.y
        const viewHigh = 1 - COVER + COVER * Math.exp(-highTau(kind) / mu)
        expect(
          Math.abs(both[k]!.transmittance - lower[k]!.transmittance * viewHigh),
        ).toBeLessThanOrEqual(TRANSMITTANCE_BOUND)
      })
    },
  )
})

/* ------------------------------------------------------------------------- */
/* The atlas's bake against its statistics                                    */
/* ------------------------------------------------------------------------- */

describe('the atlas’s bake', () => {
  /*
   * A medium with a horizontal edge and a vertical one, both from the sample
   * alone: cloud where the sun's cosine over the column passes 0.35, from
   * 1,300 m up to a top that rises with that cosine, at a share of 0.6 under
   * a cosine of 0.5 and 1 over it. The edge crosses face 0 and face 2 of
   * layer 0's row, so many texels hold some cloudy sub-columns and some
   * clear, and the shares mix. Texels any of whose 128 samples sits within
   * float32's reach of an edge are left out, and the rest must be a code
   * apart at most.
   */
  const SUN = unit({ x: 1, y: 0.3, z: 0.2 })
  const EDGE = 0.35
  const FULL = 0.5
  const SIGMA = 0.004
  const BASE = 1300
  const RISE = 4000
  const ceilingAt = (mu: number): number => BASE + RISE * (mu - EDGE)

  const structured: CloudMediumFn = (sample) => {
    const mu = sample.sunMu
    const h = sample.altitude
    const cloudy = mu
      .greaterThan(EDGE)
      .and(h.greaterThanEqual(BASE))
      .and(h.lessThan(float(BASE).add(mu.sub(EDGE).mul(RISE))))
    return {
      sigma: select(cloudy, float(SIGMA), float(0)),
      fraction: select(mu.greaterThan(FULL), float(1), float(0.6)),
      layer: select(cloudy, int(0), int(-1)),
      column: float(1e9),
      radius: float(10),
    }
  }

  /** The bake's statistics for one texel, float64, and whether every sample is clear of an edge. */
  function expected(face: CubeFace, i: number, j: number) {
    const slice = THICKNESS / 8
    const a0 = cubeTexelCoordinate(256, 1, i)
    const b0 = cubeTexelCoordinate(256, 1, j)
    let share = 0
    let sum = 0
    let low: number = LAYER.top
    let high: number = LAYER.base
    let safe = true
    for (let p = 0; p < 4; p += 1)
      for (let q = 0; q < 4; q += 1) {
        const d = cubeDirection(
          face,
          a0 + (p - 1.5) / 512,
          b0 + (q - 1.5) / 512,
        )
        const mu = dot3(d, SUN)
        if (Math.abs(mu - EDGE) < 1e-4 || Math.abs(mu - FULL) < 1e-4)
          safe = false
        let tau = 0
        let cover = 0
        let first = 8
        let last = -1
        for (let k = 0; k < 8; k += 1) {
          const h = LAYER.base + (k + 0.5) * slice
          if (Math.abs(h - ceilingAt(mu)) < 0.05) safe = false
          if (mu > EDGE && h >= BASE && h < ceilingAt(mu)) {
            tau += SIGMA * slice
            cover = Math.max(cover, mu > FULL ? 1 : 0.6)
            first = Math.min(first, k)
            last = Math.max(last, k)
          }
        }
        if (tau > 0.1) {
          share += cover
          sum += cover * tau
          low = Math.min(low, LAYER.base + first * slice)
          high = Math.max(high, LAYER.base + (last + 1) * slice)
        }
      }
    const cloudy = share > 0
    const floor = LAYER.base - FAR_MARGIN
    const range = THICKNESS + 2 * FAR_MARGIN
    const codes = [
      share / 16,
      Math.log2(1 + (cloudy ? sum / share : 0)) / Math.log2(513),
      ((cloudy ? low : LAYER.base) - floor) / range,
      ((cloudy ? high : LAYER.top) - floor) / range,
    ].map((v) => Math.round(v * 255))
    return { codes, fraction: share / 16, safe }
  }

  it('holds each texel’s fraction, in-cloud τ, base and top as the CPU integrates them', async () => {
    const built = build('atlas', structured, {
      eye: 2000,
      sun: SUN,
      layers: [[LAYER.base, LAYER.top]],
    })
    await bake(built)
    const at: [number, number][] = []
    const wanted: number[][] = []
    let partial = 0
    for (const face of [0, 2] as const)
      for (let j = 0; j < 258; j += 1)
        for (let i = 0; i < 258; i += 1) {
          const { codes, fraction, safe } = expected(face, i, j)
          if (!safe) continue
          at.push([258 * face + i, j])
          wanted.push(codes)
          if (fraction > 0 && fraction < 1) partial += 1
        }
    // Enough texels straddle the edge for the sub-columns to be what is tested.
    expect(partial).toBeGreaterThan(1000)
    expect(at.length).toBeGreaterThan(0.9 * 2 * 258 * 258)
    const read = await texelsAt(textureOf(built.field), at)
    let worst = 0
    wanted.forEach((codes, k) => {
      for (let c = 0; c < 4; c += 1)
        worst = Math.max(
          worst,
          Math.abs(Math.round(read[k * 4 + c]! * 255) - codes[c]!),
        )
    })
    expect(worst).toBeLessThanOrEqual(1)
    built.field.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* The blocked air's beam                                                     */
/* ------------------------------------------------------------------------- */

describe('the blocked air', () => {
  /*
   * An air whose single scattering is its beam and nothing else, through a
   * transmittance table that is one color everywhere, under Enhanced from
   * orbit (`cleared` 1). The slant is then the overhead column, so the
   * cleared beam is mix(table, 1, strength): a sky texel's B takes the table
   * as it is, a surface texel's the table cleared ORBIT_AIRLIGHT (½) of the
   * way, and the cloud's own light the table cleared whole, as the ground's
   * beam is. Each a different color, so a march that took any one beam for
   * another fails per channel.
   */
  const TABLE = [204, 128, 51] as const
  const table = (() => {
    const map = new DataTexture(
      new Uint8Array([...TABLE, 255]),
      1,
      1,
      RGBAFormat,
      UnsignedByteType,
    )
    map.magFilter = LinearFilter
    map.minFilter = LinearFilter
    map.needsUpdate = true
    return map
  })()
  const beam = TABLE.map((v) => v / 255)
  const surfaceBeam = beam.map((v) => v + (1 - v) * 0.5)
  const beamAir: AirMediumFn = (_air, _height, _muSun, _phases, sunT) => ({
    extinction: vec3(0),
    single: sunT,
    multiple: vec3(0),
  })

  it.each(KINDS)(
    'the %s blocks the sky’s beam on a sky texel and the cleared one on a surface texel',
    async (kind) => {
      const place: Placement = {
        eye: 5000,
        sun: UP,
        layers: [[LAYER.base, LAYER.top]],
        cleared: 1,
      }
      const built = build(kind, slab(THICK[kind] / THICKNESS), place, {
        air: beamAir,
      })
      built.body.air.transmittance.value = table
      await bake(built)
      const direction = toward(-0.8, 1)
      const [sky, surface] = await march(built, [
        { direction, sky: true },
        { direction, sky: false },
      ])
      // Air behind cloud the march crossed is hidden: B is negative.
      expect(sky!.air[1]).toBeLessThan(0)
      for (let c = 0; c < 3; c += 1) {
        const blocked = sky!.air[c]! / beam[c]!
        expect(
          Math.abs(surface!.air[c]! / surfaceBeam[c]! / blocked - 1),
        ).toBeLessThanOrEqual(1e-4)
        expect(
          Math.abs(blocked / (sky!.air[1]! / beam[1]!) - 1),
        ).toBeLessThanOrEqual(1e-4)
      }
      // The class decides B and nothing else.
      expect(surface!.light).toEqual(sky!.light)
      expect(surface!.transmittance).toBe(sky!.transmittance)

      // Its own light takes the beam cleared whole: white, against the table's
      // own color with nothing cleared.
      built.body.cleared.value = 0
      const [dim] = await march(built, [{ direction, sky: true }])
      for (let c = 0; c < 3; c += 1)
        expect(
          Math.abs(dim!.light[c]! / sky!.light[c]! / beam[c]! - 1),
        ).toBeLessThanOrEqual(1e-4)
      built.field.dispose()
    },
  )
})

/* ------------------------------------------------------------------------- */
/* The bake's cadence and what it holds                                       */
/* ------------------------------------------------------------------------- */

describe('the bake', () => {
  it('covers the atlas in 45 blocks of 192², the last of each row and column clipped', () => {
    const covered = new Uint8Array(FAR_WIDTH * FAR_HEIGHT)
    for (let k = 0; k < FAR_CYCLE; k += 1) {
      const block = farBlock(k)
      expect(block.width).toBeGreaterThan(0)
      expect(block.height).toBeGreaterThan(0)
      expect(block.width).toBeLessThanOrEqual(FAR_BLOCK)
      for (let y = block.y; y < block.y + block.height; y += 1)
        for (let x = block.x; x < block.x + block.width; x += 1)
          covered[y * FAR_WIDTH + x] = (covered[y * FAR_WIDTH + x] ?? 0) + 1
    }
    expect(FAR_CYCLE).toBe(45)
    expect([FAR_WIDTH, FAR_HEIGHT]).toEqual([1548, 774])
    expect(covered.every((n) => n === 1)).toBe(true)
  })

  it.each([
    ['atlas', 'farAtlas', 4],
    ['spheres', 'farSpheres', 8],
  ] as const)(
    '%s draws one block a frame as one pass, and is pending until the cycle is through',
    async (kind, name, texelBytes) => {
      const built = build(kind, slab(1e-3), {
        eye: 2000,
        sun: UP,
        layers: [[LAYER.base, LAYER.top]],
      })
      const { field } = built
      expect(field.name).toBe(name)
      expect([field.bytes, field.textures(), field.pending]).toEqual([
        0,
        [],
        false,
      ])
      await checked(() => field.warm(renderer))
      // A 1 × 1 target of the real format, which the warm-up compiled against.
      expect(field.bytes).toBe(texelBytes)
      let draws = 0
      const render = renderer.render.bind(renderer)
      renderer.render = (...args: Parameters<typeof renderer.render>) => {
        draws += 1
        return render(...args)
      }
      try {
        await checked(() => field.render(renderer, frameFor(kind), BUDGET))
        expect(draws).toBe(1)
      } finally {
        renderer.render = render
      }
      expect(field.bytes).toBe(FAR_WIDTH * FAR_HEIGHT * texelBytes)
      expect(field.pending).toBe(true)
      // Block 0 holds the bake; block 1 and the row of blocks under it do not
      // yet. An absent layer's texels hold its range's middle in base and top,
      // so every baked texel is nonzero somewhere.
      const baked = (texel: number[]): boolean => texel.some((v) => v !== 0)
      const [inside, right, below] = await texels(textureOf(field), [
        [FAR_BLOCK - 1, FAR_BLOCK - 1],
        [FAR_BLOCK, 0],
        [0, FAR_BLOCK],
      ])
      expect([baked(inside!), baked(right!), baked(below!)]).toEqual([
        true,
        false,
        false,
      ])
      await checked(() => {
        for (let k = 1; k < FAR_CYCLE - 1; k += 1)
          field.render(renderer, frameFor(kind), BUDGET)
      })
      expect(field.pending).toBe(true)
      await checked(() => field.render(renderer, frameFor(kind), BUDGET))
      expect(field.pending).toBe(false)
      const corners = await texels(textureOf(field), [
        [FAR_WIDTH - 1, FAR_HEIGHT - 1],
        [FAR_WIDTH - 1, 0],
        [0, FAR_HEIGHT - 1],
      ])
      expect(corners.every(baked)).toBe(true)
      // A jump starts the cycle over.
      await checked(() =>
        field.render(renderer, frameFor(kind, { jump: true }), BUDGET),
      )
      expect(field.pending).toBe(true)
      field.dispose()
      expect([field.bytes, field.textures(), field.pending]).toEqual([
        0,
        [],
        false,
      ])
    },
  )

  it('releases its atlas on a frame that selects the other candidate, and the second body’s when there is none', async () => {
    const place: Placement = {
      eye: 2000,
      sun: UP,
      layers: [[LAYER.base, LAYER.top]],
    }
    const atlas = build('atlas', slab(1e-3), place)
    await checked(() => atlas.field.warm(renderer))
    await checked(() => atlas.field.render(renderer, frameFor('atlas'), BUDGET))
    expect(atlas.field.bytes).toBe(FAR_WIDTH * FAR_HEIGHT * 4)
    await checked(() =>
      atlas.field.render(renderer, frameFor('spheres'), BUDGET),
    )
    expect([atlas.field.bytes, atlas.field.pending]).toEqual([4, false])
    expect(atlas.field.textures()).toHaveLength(1)
    // What `textures()` lists exists on the GPU, at the size declared.
    const gpuTexture = (
      renderer.backend as unknown as {
        get(texture: Texture): { texture?: GPUTexture }
      }
    ).get(textureOf(atlas.field)).texture
    expect([gpuTexture?.width, gpuTexture?.height]).toEqual([1, 1])
    atlas.field.dispose()

    const second = build('atlas', slab(1e-3), place, { second: true })
    expect(second.field.name).toBe('farSecond')
    await checked(() => second.field.warm(renderer))
    await checked(() =>
      second.field.render(
        renderer,
        frameFor('spheres', { second: true }),
        BUDGET,
      ),
    )
    expect(second.field.bytes).toBe(FAR_WIDTH * FAR_HEIGHT * 4)
    await checked(() =>
      second.field.render(renderer, frameFor('atlas'), BUDGET),
    )
    expect(second.field.bytes).toBe(4)
    second.field.dispose()
  })

  describe.skipIf(!TIMESTAMPS)('on the pass timeline', () => {
    it.each([
      ['atlas', false, 'cloud far atlas'],
      ['spheres', false, 'cloud far spheres'],
      ['atlas', true, 'cloud far second'],
    ] as const)(
      '%s (second body: %s) is one pass a frame, named %s',
      async (kind, second, label) => {
        const built = build(
          kind,
          slab(1e-3),
          { eye: 2000, sun: UP, layers: [[LAYER.base, LAYER.top]] },
          { second },
        )
        await checked(() => built.field.warm(renderer))
        const stop = installPassTimeline(renderer)
        try {
          const timeline = passTimelineOf(renderer)
          expect(timeline).not.toBeNull()
          const draw = () =>
            built.field.render(renderer, frameFor(kind, { second }), BUDGET)
          await checked(draw)
          const result = await timeline!.measure(draw, 4)
          expect(result.dropped).toBe(0)
          expect(result.passes.map((pass) => [pass.label, pass.count])).toEqual(
            [[label, 1]],
          )
        } finally {
          stop()
          built.field.dispose()
        }
      },
    )
  })
})
