import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ComputeNode,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  StorageBufferAttribute,
  type Texture,
  type WebGPURenderer,
} from 'three/webgpu'
import {
  bool,
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  ivec2,
  max,
  min,
  normalize,
  oneMinus,
  select,
  sqrt,
  storage,
  texture,
  textureLoad,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { sunThroughAt } from './air.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { cloudRay } from './cloudGeometry.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  type CloudAirFn,
  cloudMarch,
  type CloudMarchDeps,
  marchFar,
} from './cloudMarch.ts'
import {
  CLOUD_STAND_INS,
  type CloudFarFn,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudSample,
  cloudStandInTexture,
  type CloudSunDepthNodes,
  type CloudSunFn,
  slabMedium,
} from './cloudNodes.ts'
import {
  CLOUD_TRACE_PHASES,
  CloudTrace,
  type CloudTraceDeps,
} from './cloudTrace.ts'
import { type CloudUniforms, createCloudUniforms } from './cloudUniforms.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'

/*
 * The trace on the GPU (§9): its kernels against the stand-ins, the march
 * against analytic slabs to float32's bound, and the kernels' outputs — the
 * immediate regime's addressing, the knots, the sweep's constant work —
 * through the half-float textures the history and `cloudFront` read.
 *
 * A march held to 10⁻⁴ is read out of a float32 buffer by a probe kernel the
 * test builds around `cloudMarch`; the trace's own outputs are RGBA16F, whose
 * step of 2⁻¹¹ relative is the floor on anything asserted through them.
 */

let gpu: GpuSession
let renderer: WebGPURenderer

beforeAll(async () => {
  gpu = await openGpu(8, 8)
  renderer = gpu.renderer
})

afterAll(() => {
  gpu.dispose()
})

/** Earth's: the curvature the crossings carry is the real one. */
const R = 6_371_000
const ISOTROPIC = 1 / (4 * Math.PI)
/** The march's own light per unit of opacity under a white sun: first order at 1/(4π), and the placeholder sky's ½·Ψ with Ψ = 1. */
const LIGHT_PER_OPACITY = 1.5 * ISOTROPIC
/** float32 carried through a march of a few hundred steps and its exponentials. */
const MARCH = 1e-4
/** RGBA16F's step, relative: the floor on anything read out of the trace's textures. */
const HALF = 2 ** -10

type Vec3 = readonly [number, number, number]

/* ------------------------------------------------------------------------- */
/* The body, its layers and its rays                                          */
/* ------------------------------------------------------------------------- */

interface Layers {
  /** The eye over the datum, meters. */
  readonly eye: number
  /** Up to three [base, top] pairs, meters. */
  readonly layers: readonly (readonly [number, number])[]
}

/**
 * The served body's uniforms as `cloudUniforms.write` would leave them: the
 * eye on +Y over a body of Earth's radius, the sun overhead, and the layers'
 * boundaries with the eye's height over each formed in float64. An absent
 * layer sits at the union's top with no thickness, as `writeLayers` lays it.
 */
function placeBody(uniforms: CloudUniforms, { eye, layers }: Layers): void {
  const body = uniforms.served
  const top = Math.max(...layers.map(([, t]) => t))
  const flat = [0, 1, 2].flatMap((k) => layers[k] ?? [top, top])
  body.datumRadius.value = R
  body.eye.value = eye
  body.eyeTerm.value = eye * (2 * R + eye)
  body.eyeOver.value.set(...(flat.slice(0, 4).map((b) => eye - b) as Quad))
  body.eyeOverHigh.value.set(eye - flat[4]!, eye - flat[5]!)
  body.boundaries.value.set(...(flat.slice(0, 4) as Quad))
  body.boundariesHigh.value.set(flat[4]!, flat[5]!)
  body.up.value.set(0, 1, 0)
  body.sun.value.set(0, 1, 0)
  body.sunUp.value = 1
  body.compression.value = 1
  body.cleared.value = 0
  uniforms.layers.radius.value.set(10, 10, 10)
  const trace = uniforms.trace
  trace.farDistance.value = 1e9
  trace.maxSteps.value = 1024
  trace.frame.value = 0
}
type Quad = [number, number, number, number]

/** A slab's path length along a ray of up-cosine μ from the eye, float64: the sphere crossings' difference. */
function chord(eye: number, mu: number, base: number, top: number): number {
  const re = R + eye
  const crossing = (h: number): number => {
    const b = re * mu
    const c = (eye - h) * (2 * R + eye + h)
    const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(b * b - c))
    return Math.max(q, c / q)
  }
  return crossing(top) - Math.max(crossing(base), 0)
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v)
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** A ray with up-cosine μ, leaning toward +X. */
const leaning = (mu: number): Vec3 => [Math.sqrt(1 - mu * mu), mu, 0]

/* ------------------------------------------------------------------------- */
/* Stand-ins                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * A sun as `cloudSunFn` binds one: the medium read where the taps would read
 * it, the sun depth's texture and the air's beam, with the taps adding
 * nothing, so the cloud a sample sees toward the sun is `cloud` and the
 * beam is the air's table — white on the stand-in tables.
 */
function testSun(
  field: CloudMediumFn,
  depth: CloudSunDepthNodes,
  cloud: Node<'float'> = float(1),
): CloudSunFn {
  return (sample, _medium, body) => {
    const taps = field(sample, body).sigma.mul(0)
    const airHeight = float(R).mul(body.air.top.sub(1).max(1e-6))
    return {
      cloud: exp(depth.opticalDepth(sample.offset).negate())
        .mul(cloud)
        .add(taps),
      air: sunThroughAt(
        body.air,
        sample.altitude.div(airHeight),
        sample.sunMu,
        body.cleared,
        { level: true },
      ),
    }
  }
}

interface Media {
  readonly medium: CloudMediumFn
  readonly deps: CloudTraceDeps
}

/**
 * The trace's deps over the stand-ins, every candidate's: the field and the
 * volume carrying `medium`, both sun depths, both far fields, the stand-in
 * phase, and the depth copy `depth` stands in for.
 */
function standIns(
  uniforms: CloudUniforms,
  medium: CloudMediumFn,
  depth: () => Texture,
  options: { readonly phase?: CloudPhaseNodes } = {},
): Media {
  const field = CLOUD_STAND_INS.field(medium)
  const volume = CLOUD_STAND_INS.volume(medium)
  return {
    medium: field,
    deps: {
      uniforms,
      media: {
        field,
        volume: volume.medium,
        bound: volume.bound,
        brickExit: volume.brickExit,
        sweep: field,
      },
      sun: {
        cascades: testSun(field, CLOUD_STAND_INS.sunDepth('cascades')),
        grid: testSun(field, CLOUD_STAND_INS.sunDepth('grid')),
      },
      phase: options.phase ?? CLOUD_STAND_INS.phase(),
      far: { atlas: CLOUD_STAND_INS.far(), spheres: CLOUD_STAND_INS.far() },
      depth,
    },
  }
}

/** An R16F distance texture, km, filtered as the depth copy is. */
function depthTexture(
  width: number,
  height: number,
  km: (x: number, y: number) => number,
): DataTexture {
  const data = new Uint16Array(width * height)
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1)
      data[y * width + x] = DataUtils.toHalfFloat(km(x, y))
  const map = new DataTexture(data, width, height, RedFormat, HalfFloatType)
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
}

/** The depth copy's clamp: sky. */
const SKY_KM = 60_000

/* ------------------------------------------------------------------------- */
/* Readbacks                                                                  */
/* ------------------------------------------------------------------------- */

/** The WGSL three builds for a kernel. */
function wgslOf(kernel: ComputeNode): string {
  const nodes = (
    renderer as unknown as {
      _nodes: { getForCompute(node: ComputeNode): { computeShader: string } }
    }
  )._nodes
  return nodes.getForCompute(kernel).computeShader
}

/** Every texel of a texture, RGBA, row 0 first, read by a kernel so nothing filters or flips it. */
async function texels(
  map: Texture,
  width: number,
  height: number,
): Promise<(x: number, y: number) => [number, number, number, number]> {
  const count = width * height
  const out = new StorageBufferAttribute(new Float32Array(count * 4), 1)
  const into = storage(out, 'float', count * 4)
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(uint(count)), () => {
      const at = ivec2(
        uvec2(instanceIndex.mod(uint(width)), instanceIndex.div(uint(width))),
      )
      const texel = textureLoad(map, at)
      const to = instanceIndex.mul(uint(4))
      into.element(to).assign(texel.x)
      into.element(to.add(uint(1))).assign(texel.y)
      into.element(to.add(uint(2))).assign(texel.z)
      into.element(to.add(uint(3))).assign(texel.w)
    })
  })().compute(count)
  await gpu.compute(kernel)
  const values = new Float32Array(await gpu.readBuffer(out))
  kernel.dispose()
  return (x, y) => {
    const at = (y * width + x) * 4
    return [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!]
  }
}

/* ------------------------------------------------------------------------- */
/* Frames                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * What the trace reads of a frame — its levers, its extents and its index —
 * and nothing else. The uniforms are set by the test, as `cloudUniforms.write`
 * would set them from a whole frame.
 */
function frameOf(
  trace: { readonly width: number; readonly height: number },
  levers: Partial<CloudLevers> = {},
  frameIndex = 0,
): CloudFrame {
  const render = { width: 4 * trace.width, height: 4 * trace.height }
  return {
    levers: { ...DEFAULT_CLOUD_LEVERS, on: true, ...levers },
    extents: {
      render,
      css: render,
      trace,
      history: { width: 2 * trace.width, height: 2 * trace.height },
    },
    frameIndex,
    regime: 'converging',
  } as unknown as CloudFrame
}

const BUDGET = { slices: 0, tiles: 0, jump: false, sunTexelSteps: 0 }

/** A camera looking up the local vertical with `spread` of half-tangent each way. */
function lookUp(uniforms: CloudUniforms, spread: number): void {
  const camera = uniforms.camera
  camera.forward.value.set(0, 1, 0)
  camera.right.value.set(1, 0, 0)
  camera.up.value.set(0, 0, -1)
  camera.plane.value.set(spread, spread)
  camera.pixelAngle.value = 1e-3
}

/** The trace's extents in its uniforms, for a trace of `width` × `height`. */
function sizeTrace(
  uniforms: CloudUniforms,
  width: number,
  height: number,
): void {
  const trace = uniforms.trace
  trace.size.value.set(width, height)
  trace.history.value.set(2 * width, 2 * height)
  trace.render.value.set(4 * width, 4 * height)
}

/* ------------------------------------------------------------------------- */
/* The kernels                                                                */
/* ------------------------------------------------------------------------- */

/** Sampled and storage textures a WGSL program declares. */
function bindings(wgsl: string): { sampled: number; storage: number } {
  const declared = [...wgsl.matchAll(/var\s+\w+\s*:\s*(texture_\w+)/g)].map(
    (match) => match[1]!,
  )
  const storage = declared.filter((kind) => kind.startsWith('texture_storage'))
  return { sampled: declared.length - storage.length, storage: storage.length }
}

describe('the kernels', () => {
  it('all nine compile against the stand-ins, and bind within the stage’s limits', async () => {
    const uniforms = createCloudUniforms()
    const sky = depthTexture(4, 4, () => SKY_KM)
    const { deps } = standIns(uniforms, slabMedium([]), () => sky)
    const trace = new CloudTrace(deps)
    const kernels = trace.kernels()
    // Eight (cache, sun depth, far) triples, the sweep's, and the counters' clear.
    expect(kernels).toHaveLength(10)
    const from = gpu.reported().length
    const before = gpu.computePipelinesBuilt()
    await trace.warm(renderer)
    expect(gpu.computePipelinesBuilt() - before).toBe(10)
    expect(
      gpu
        .reported()
        .slice(from)
        .filter((entry) => entry.type === 'error'),
    ).toEqual([])
    const counted = kernels.map((kernel) => ({
      name: kernel.name,
      ...bindings(wgslOf(kernel)),
    }))
    // WebGPU's default device: 16 sampled and 4 storage textures a stage.
    for (const { sampled, storage } of counted) {
      expect(sampled).toBeLessThanOrEqual(16)
      expect(storage).toBeLessThanOrEqual(4)
    }
    const traces = counted.slice(0, 9)
    // The design's census (§3.7): the field's 7, one sun depth, the air's 2,
    // the phase, one far field and the depth copy; the volume's 2 beside
    // them; the sweep's field and depth alone. A floor as well as a ceiling:
    // the counts are a regex over three's WGSL, and a spelling that stopped
    // matching would pass the ceiling at zero.
    expect(traces.map(({ sampled }) => sampled)).toEqual([
      13, 13, 13, 13, 15, 15, 15, 15, 8,
    ])
    expect(traces.map(({ storage }) => storage)).toEqual(Array(9).fill(4))
    expect(new Set(counted.map(({ name }) => name))).toEqual(
      new Set(['cloud trace', 'cloud stats']),
    )
    trace.dispose()
    sky.dispose()
  }, 120_000)
})

describe('the march’s reads', () => {
  /** The fragment program of a quad whose color is a march through `medium`. */
  async function fragmentOf(medium: CloudMediumFn): Promise<string> {
    const uniforms = createCloudUniforms()
    const field = CLOUD_STAND_INS.field(medium)
    const deps: CloudMarchDeps = {
      uniforms,
      media: {
        field,
        volume: null,
        bound: null,
        brickExit: null,
        sweep: field,
      },
      phase: CLOUD_STAND_INS.phase(),
      medium: field,
      sun: testSun(field, CLOUD_STAND_INS.sunDepth('cascades')),
    }
    const material = new MeshBasicNodeMaterial()
    material.colorNode = Fn(() => {
      const ray = cloudRay(vec3(0, 1, 0), uniforms.served, float(1e9))
      const result = cloudMarch(ray, float(0.5), bool(true), deps, null)
      return vec4(result.light, result.transmittance)
    })()
    const mesh = new Mesh(new PlaneGeometry(2, 2), material)
    const scene = new Scene()
    scene.add(mesh)
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
    camera.position.z = 0.5
    camera.updateMatrixWorld()
    const { fragmentShader } = await gpu.shader(mesh, camera, scene)
    material.dispose()
    mesh.geometry.dispose()
    return fragmentShader
  }

  it('names the level of every texture it reads, in a fragment as in compute, where a plain read would not', async () => {
    /*
     * A compute stage has no derivatives, so three names level 0 there by
     * itself; a fragment's read is `textureSample` unless the code names one,
     * and inside a loop that breaks it is undefined, with three's uniformity
     * check off. The march, its sun, its phase and its air name theirs, so
     * the march compiles alike wherever it runs.
     */
    const slab = slabMedium([{ base: 1000, top: 1600, sigma: 0.002 }])
    const named = await fragmentOf(slab)
    expect(named).toMatch(/\btextureSampleLevel\(/)
    expect(named).not.toMatch(/\btextureSample\(/)
    // The control: one plain read in the medium, which is what the
    // assertion above would catch.
    const map = texture(cloudStandInTexture('2d', 'rgba8'))
    const plain: CloudMediumFn = (sample, body) => {
      const medium = slab(sample, body)
      return {
        ...medium,
        sigma: medium.sigma.add(map.sample(vec2(0.5)).x.mul(0)),
      }
    }
    expect(await fragmentOf(plain)).toMatch(/\btextureSample\(/)
  })
})

/* ------------------------------------------------------------------------- */
/* The march against analytic slabs                                          */
/* ------------------------------------------------------------------------- */

interface Probed {
  readonly light: Vec3
  readonly transmittance: number
  readonly air: Vec3
  readonly reproject: number
  readonly end: number
  readonly front: number
  readonly deviation: number
  readonly stopped: number
  readonly steps: number
  readonly exhausted: number
  readonly start: number
}
const PROBED = 15

interface ProbeRay {
  readonly direction: Vec3
  readonly jitter?: number
  /** True meters: where the scene stops the ray. */
  readonly stop?: number
}

interface ProbeOptions {
  readonly sky?: boolean
  readonly sun?: (field: CloudMediumFn) => CloudSunFn
  readonly air?: CloudAirFn
  readonly phase?: CloudPhaseNodes
  /** A far march past the handover, composed as the trace composes it. */
  readonly far?: CloudFarFn
  /** March the medium as the volume, skipping where `bound` is zero to `exit`. */
  readonly skip?: {
    readonly bound: (s: CloudSample) => Node<'float'>
    readonly exit: (s: CloudSample) => Node<'float'>
  }
}

/**
 * `cloudMarch` one ray an invocation, its result written in float32: the
 * march itself, without the half floats the trace's textures store it in.
 * The rays are clipped to the shell union as the trace clips them.
 */
function probe(
  uniforms: CloudUniforms,
  medium: CloudMediumFn,
  options: ProbeOptions = {},
): (rays: readonly ProbeRay[]) => Promise<Probed[]> {
  const capacity = 64
  const input = new StorageBufferAttribute(new Float32Array(capacity * 5), 1)
  const output = new StorageBufferAttribute(
    new Float32Array(capacity * PROBED),
    1,
  )
  const from = storage(input, 'float', capacity * 5)
  const into = storage(output, 'float', capacity * PROBED)
  const count = uniform(0, 'uint')
  const field = CLOUD_STAND_INS.field(medium)
  const sun =
    options.sun ?? ((f) => testSun(f, CLOUD_STAND_INS.sunDepth('grid')))
  const { skip } = options
  const deps: CloudMarchDeps = {
    uniforms,
    media: {
      field,
      volume: skip === undefined ? null : field,
      bound: skip === undefined ? null : (s) => skip.bound(s),
      brickExit: skip === undefined ? null : (s) => skip.exit(s),
      sweep: field,
    },
    phase: options.phase ?? CLOUD_STAND_INS.phase(),
    medium: field,
    sun: sun(field),
    ...(options.air === undefined ? {} : { air: options.air }),
  }
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(count), () => {
      const read = (k: number) => from.element(instanceIndex.mul(5).add(k))
      const direction = normalize(vec3(read(0), read(1), read(2)))
      const stop = read(4)
      const ray = cloudRay(direction, uniforms.served, stop)
      const start = ray.hit.select(ray.start, stop)
      const end = ray.hit.select(ray.end, stop)
      const clipped = { ...ray, start, end }
      const sky = bool(options.sky ?? true)
      const fine = cloudMarch(clipped, read(3), sky, deps, null)
      const { far } = options
      const result =
        far === undefined
          ? fine
          : marchFar(
              fine,
              clipped,
              (at) => far(clipped, at, uniforms.served, sky),
              null,
            )
      const values = [
        ...[result.light.x, result.light.y, result.light.z],
        result.transmittance,
        ...[result.air.x, result.air.y, result.air.z],
        result.reproject,
        result.end,
        result.front,
        result.deviation,
        result.stopped,
        result.steps,
        result.exhausted,
        start,
      ]
      values.forEach((value, k) => {
        into.element(instanceIndex.mul(PROBED).add(k)).assign(value)
      })
    })
  })().compute(capacity)
  return async (rays) => {
    const values = input.array as Float32Array
    rays.forEach((ray, i) => {
      values.set(
        [...unit(ray.direction), ray.jitter ?? 0, ray.stop ?? 1e9],
        i * 5,
      )
    })
    input.needsUpdate = true
    count.value = rays.length
    await gpu.compute(kernel)
    const out = new Float32Array(await gpu.readBuffer(output))
    return rays.map((_, i) => {
      const v = [...out.subarray(i * PROBED, (i + 1) * PROBED)]
      return {
        light: [v[0]!, v[1]!, v[2]!],
        transmittance: v[3]!,
        air: [v[4]!, v[5]!, v[6]!],
        reproject: v[7]!,
        end: v[8]!,
        front: v[9]!,
        deviation: v[10]!,
        stopped: v[11]!,
        steps: v[12]!,
        exhausted: v[13]!,
        start: v[14]!,
      }
    })
  }
}

const relative = (value: number, reference: number): number =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), 1e-30)

/** The light a ray gathers under a white sun for an opacity `1 − T`, every band. */
function expectLight(probed: Probed, opacity: number): void {
  for (const band of probed.light)
    expect(relative(band, LIGHT_PER_OPACITY * opacity)).toBeLessThanOrEqual(
      MARCH,
    )
}

const SLAB = { base: 1000, top: 1600 } as const
/** A layer the media leave empty, under the slab: the span starts at its base. */
const EMPTY_BELOW = [100, 200] as const

describe('the march through one slab', () => {
  it('passes e^−σL and gathers its integral at every slant and jitter: c = 1 is Beer’s law', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const sigma = 0.002
    const march = probe(uniforms, slabMedium([{ ...SLAB, sigma }]))
    const cosines = [1, 0.9, 0.7, 0.5, 0.3]
    const jitters = [0, 0.37, 0.91]
    const rays = cosines.flatMap((mu) =>
      jitters.map((jitter) => ({ direction: leaning(mu), jitter })),
    )
    const probed = await march(rays)
    probed.forEach((result, i) => {
      const mu = cosines[Math.floor(i / jitters.length)]!
      const expected = Math.exp(-sigma * chord(0, mu, SLAB.base, SLAB.top))
      expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
        MARCH,
      )
      expectLight(result, 1 - expected)
      expect(result.exhausted).toBe(0)
    })
  })

  it('keeps T and the light as the steps that cut the layer change', async () => {
    /*
     * The jitter moves every step boundary, the budget changes nothing a ray
     * that finishes needs, and a slab 8 km farther is met by steps the
     * approach has grown to about 140 m where the near one's are about 60:
     * eighteen ways of cutting one 600 m column, each ending on the layer's
     * own crossings.
     */
    const sigma = 0.002
    const expected = Math.exp(-sigma * 600)
    for (const base of [1000, 9000]) {
      const uniforms = createCloudUniforms()
      placeBody(uniforms, { eye: 0, layers: [[base, base + 600]] })
      const slab = slabMedium([{ base, top: base + 600, sigma }])
      const march = probe(uniforms, slab)
      const results: Probed[] = []
      for (const maxSteps of [200, 400, 1024]) {
        uniforms.trace.maxSteps.value = maxSteps
        const rays = [0, 0.5, 0.99].map((jitter) => ({
          direction: [0, 1, 0] as Vec3,
          jitter,
        }))
        results.push(...(await march(rays)))
      }
      for (const result of results) {
        expect(relative(result.transmittance, expected)).toBeLessThanOrEqual(
          MARCH,
        )
        expectLight(result, 1 - expected)
      }
      /*
       * The cuts did move, or the test would pass whatever the step integral
       * did: the half-opacity front is interpolated inside the step that
       * crosses it, so it lands differently on each jitter's cut, within the
       * interpolation's own error, σΔ²/8 (5 m at 140 m), of ln 2/σ past the
       * base.
       */
      const fronts = new Set(results.map((result) => result.front))
      expect(fronts.size).toBeGreaterThanOrEqual(3)
      for (const front of fronts)
        expect(Math.abs(front - (base + Math.LN2 / sigma))).toBeLessThan(10)
    }
  })

  it('stops under 1% transmittance, with the light it gathered on the way', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[1000, 3000]] })
    const march = probe(
      uniforms,
      slabMedium([{ base: 1000, top: 3000, sigma: 0.1 }]),
    )
    const [result] = await march([{ direction: [0, 1, 0] }])
    // A step holds an optical depth of 0.675 at most here, the in-cloud
    // floor of 6.75 m at 1 km, so the march stops within a step of 1%.
    expect(result!.transmittance).toBeLessThan(0.01)
    expect(result!.transmittance).toBeGreaterThan(0.01 * Math.exp(-0.7))
    expect(result!.stopped).toBeLessThan(1100)
    // Through 2 km at that floor a march without the exit takes about three
    // hundred steps.
    expect(result!.steps).toBeLessThan(60)
    expectLight(result!, 1 - result!.transmittance)
  })
})

describe('the segment rule (maximum-random overlap, §5.7)', () => {
  it('passes half of a half-clear layer at τ 20, where mixing every step does not', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const halfClear = { ...SLAB, sigma: 20 / 600, fraction: 0.5 }
    const march = probe(uniforms, slabMedium([halfClear]))
    const rays = [1, 0.8].map((mu) => ({ direction: leaning(mu) }))
    for (const result of await march(rays)) {
      expect(relative(result.transmittance, 0.5)).toBeLessThanOrEqual(MARCH)
      // (b): between the cloudy share's e^−τ and 1.
      expect(result.transmittance).toBeGreaterThanOrEqual(Math.exp(-20))
      expectLight(result, 0.5 * (1 - Math.exp(-20)))
    }
    // The variant: a column a millimeter wide closes the segment at every
    // step of a slant ray, so every step mixes the fraction of its own, and
    // the layer's clear half is counted once a step.
    const column = probe(uniforms, slabMedium([{ ...halfClear, column: 1e-3 }]))
    const [mixed] = await column([{ direction: leaning(0.8) }])
    expect(mixed!.transmittance).toBeLessThan(0.05)
  })

  it('multiplies two segments of one column, each mixed once', async () => {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [
        [1000, 1400],
        [2500, 3000],
      ],
    })
    const lower = { base: 1000, top: 1400, sigma: 1.5 / 400, fraction: 0.6 }
    const upper = { base: 2500, top: 3000, sigma: 0.8 / 500, fraction: 0.3 }
    const march = probe(uniforms, slabMedium([lower, upper]))
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.25 }])
    const first = 0.4 + 0.6 * Math.exp(-1.5)
    const second = 0.7 + 0.3 * Math.exp(-0.8)
    expect(relative(result!.transmittance, first * second)).toBeLessThanOrEqual(
      MARCH,
    )
    expectLight(
      result!,
      0.6 * (1 - Math.exp(-1.5)) + first * 0.3 * (1 - Math.exp(-0.8)),
    )
  })
})

describe('the march’s edge cases', () => {
  const finite = (result: Probed): boolean =>
    [
      ...result.light,
      result.transmittance,
      ...result.air,
      result.reproject,
      result.end,
      result.front,
      result.deviation,
      result.stopped,
    ].every(Number.isFinite)

  it('writes finite outputs where no cloud is lit', async () => {
    /*
     * No first-order light anywhere: the mean radius is 0/0, and must not
     * reach the phase table. The stand-in phase never reads its radius, so
     * this one does, as a table's coordinate would: a NaN radius is a NaN
     * phase, whose product with no light is NaN, not 0.
     */
    const reading: CloudPhaseNodes = {
      droplets: (_nu, radius) => vec3(radius.mul(0).add(ISOTROPIC)),
    }
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const unlit = probe(uniforms, slabMedium([{ ...SLAB, sigma: 0.002 }]), {
      sun: (field) =>
        testSun(field, CLOUD_STAND_INS.sunDepth('grid'), float(0)),
      phase: reading,
    })
    const [shaded] = await unlit([{ direction: [0, 1, 0] }])
    expect(finite(shaded!)).toBe(true)
    // The sky's placeholder light still reaches it; the sun's does not.
    const sky = 0.5 * ISOTROPIC * (1 - shaded!.transmittance)
    for (const band of shaded!.light)
      expect(relative(band, sky)).toBeLessThanOrEqual(MARCH)
  })

  it('writes finite outputs on a level ray from an eye on a boundary', async () => {
    // The base's crossings for an eye on it, looking exactly level, are
    // (0, 0), never 0/0.
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: SLAB.base, layers: [[SLAB.base, SLAB.top]] })
    const along = probe(uniforms, slabMedium([{ ...SLAB, sigma: 0.002 }]))
    const [level] = await along([{ direction: [1, 0, 0] }])
    expect(finite(level!)).toBe(true)
    expect(level!.start).toBe(0)
    expect(level!.transmittance).toBeLessThan(1)
  })
})

describe('past the fine march', () => {
  const sigma = 0.002
  /**
   * What a far field holding the slab exactly would hand back for a ray up
   * the vertical from the datum, where t is the height: the slab past
   * `from`, its light relative to there, and the opacity-weighted mean and
   * spread of its depth.
   */
  const slabFar: CloudFarFn = (ray, from) => {
    const enter = max(from, float(SLAB.base))
    const depth = max(ray.end.sub(enter), 0)
    const through = exp(depth.mul(-sigma))
    const opacity = max(oneMinus(through), 1e-30)
    const mean = float(1 / sigma).sub(depth.mul(through).div(opacity))
    const square = float(2 / sigma ** 2)
      .sub(
        through.mul(
          depth
            .mul(depth)
            .add(depth.mul(2 / sigma))
            .add(2 / sigma ** 2),
        ),
      )
      .div(opacity)
    return {
      light: vec3(oneMinus(through).mul(LIGHT_PER_OPACITY)),
      air: vec3(0),
      airLight: vec3(0),
      transmittance: through,
      depthMean: enter.add(mean),
      depthDeviation: sqrt(max(square.sub(mean.mul(mean)), 0)),
    }
  }
  /** The same moments over the whole slab, float64. */
  const thickness = SLAB.top - SLAB.base
  const through = Math.exp(-sigma * thickness)
  const wholeMean =
    SLAB.base + 1 / sigma - (thickness * through) / (1 - through)
  const wholeSquare =
    (2 / sigma ** 2 -
      through * (thickness ** 2 + (2 * thickness) / sigma + 2 / sigma ** 2)) /
    (1 - through)
  const wholeDeviation = Math.sqrt(wholeSquare - (wholeMean - SLAB.base) ** 2)

  async function handed(
    configure: (uniforms: CloudUniforms) => void,
    layers: Layers['layers'] = [[SLAB.base, SLAB.top]],
  ) {
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers })
    configure(uniforms)
    const slab = slabMedium([{ ...SLAB, sigma }])
    const march = probe(uniforms, slab, { far: slabFar })
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.3 }])
    return result!
  }

  it('hands the rest of the span to the far march at the footprint’s distance, and merges what each saw', async () => {
    const result = await handed((uniforms) => {
      uniforms.trace.farDistance.value = 1300
    })
    expect(result.stopped).toBe(1300)
    expect(result.exhausted).toBe(0)
    expect(relative(result.transmittance, through)).toBeLessThanOrEqual(MARCH)
    expectLight(result, 1 - through)
    // The fine half's moments come from each step's midpoint, which sits
    // σΔ²/12 (under a meter) off the opacity-weighted centroid of its step.
    expect(Math.abs(result.reproject - wholeMean)).toBeLessThan(2)
    expect(Math.abs(result.deviation - wholeDeviation)).toBeLessThan(2)
  })

  it('hands it over where the step budget runs out, and counts the ray', async () => {
    // An empty layer under the slab starts the span at 100 m, so eight
    // steps run out short of the slab and the far march holds all of it.
    const result = await handed(
      (uniforms) => {
        uniforms.trace.maxSteps.value = 8
      },
      [EMPTY_BELOW, [SLAB.base, SLAB.top]],
    )
    expect(result.exhausted).toBe(1)
    expect(result.stopped).toBeLessThan(SLAB.base)
    expect(relative(result.transmittance, through)).toBeLessThanOrEqual(MARCH)
    expectLight(result, 1 - through)
    expect(Math.abs(result.reproject - wholeMean)).toBeLessThan(1e-2)
  })

  it('takes out of B the far air the slab it crossed hides, which the far march cannot see', async () => {
    /*
     * A clear far field holding air light alone, behind the slab, in an air
     * that carries no light of its own: all of B is then the far air the
     * slab hides, T_a·(T − 1)·L_far. The far march's own blocked air is
     * taken from where it starts, against its own cloud, and holds none of
     * it; summed alone, a nearly opaque near cloud lets the whole far air
     * through.
     */
    const airLight = [0.3, 0.2, 0.1] as const
    const clear: CloudFarFn = (_ray, from) => ({
      light: vec3(0),
      air: vec3(0),
      airLight: vec3(...airLight),
      transmittance: float(1),
      depthMean: from,
      depthDeviation: float(0),
    })
    const dark: CloudAirFn = () => ({
      extinction: vec3(0),
      single: vec3(0),
      multiple: vec3(0),
    })
    const uniforms = createCloudUniforms()
    // A layer the medium leaves empty carries the span past the handover.
    placeBody(uniforms, {
      eye: 0,
      layers: [
        [SLAB.base, SLAB.top],
        [3000, 4000],
      ],
    })
    uniforms.trace.farDistance.value = 2000
    const slab = slabMedium([{ ...SLAB, sigma }])
    const march = probe(uniforms, slab, { far: clear, air: dark })
    const [result] = await march([{ direction: [0, 1, 0], jitter: 0.3 }])
    expect(result!.stopped).toBe(2000)
    expect(relative(result!.transmittance, through)).toBeLessThanOrEqual(MARCH)
    result!.air.forEach((band, c) => {
      expect(relative(band, (through - 1) * airLight[c]!)).toBeLessThanOrEqual(
        MARCH,
      )
    })
  })

  it('skips an empty brick of the volume to its exit, and loses no cloud', async () => {
    // Bricks 250 m long and empty below 800 m, each ending where the empty
    // region does, as a brick's far face does.
    const skip = {
      bound: (s: CloudSample) =>
        select(s.altitude.greaterThanEqual(800), float(1), float(0)),
      exit: (s: CloudSample) => min(s.distance.add(250), 800),
    }
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [EMPTY_BELOW, [SLAB.base, SLAB.top]],
    })
    const slab = slabMedium([{ ...SLAB, sigma }])
    // At two jitters: the first step after the last brick takes it again.
    const skipping = await probe(uniforms, slab, { skip })(
      [0, 0.6].map((jitter) => ({ direction: [0, 1, 0] as Vec3, jitter })),
    )
    const [walked] = await probe(uniforms, slab)([{ direction: [0, 1, 0] }])
    for (const skipped of skipping) {
      expect(relative(skipped.transmittance, through)).toBeLessThanOrEqual(
        MARCH,
      )
      expectLight(skipped, 1 - through)
      // Three bricks cover the 700 m the schedule's growing steps take about
      // fourteen to cross.
      expect(skipped.steps).toBeLessThan(walked!.steps - 5)
    }
  })
})

describe('the air in front of a cloud', () => {
  it('dims the cloud’s light by the air between t₀ and it', async () => {
    /*
     * An air that only extinguishes, at a rate that passes half the light
     * over the 900 m from the span's start, at an empty layer's base, to a
     * slab 100 m thick: the slab is lit through between e^−0.077 of a half
     * (its far side) and a half (its near side) of the air, whatever the
     * coarse schedule did inside it. The air before t₀ is the composite's.
     */
    const extinction = (Math.LN2 * R) / 900
    const air: CloudAirFn = () => ({
      extinction: vec3(extinction),
      single: vec3(0),
      multiple: vec3(0),
    })
    const thin = { base: 1000, top: 1100, sigma: 0.004 }
    const uniforms = createCloudUniforms()
    placeBody(uniforms, {
      eye: 0,
      layers: [EMPTY_BELOW, [thin.base, thin.top]],
    })
    const march = probe(uniforms, slabMedium([thin]), { air })
    const [result] = await march([{ direction: [0, 1, 0] }])
    const cloud = Math.exp(-0.4)
    expect(relative(result!.transmittance, cloud)).toBeLessThanOrEqual(MARCH)
    const dimmed = result!.light[1] / (LIGHT_PER_OPACITY * (1 - cloud))
    expect(dimmed).toBeLessThanOrEqual(0.5 * (1 + MARCH))
    expect(dimmed).toBeGreaterThanOrEqual(0.5 * Math.exp(-Math.LN2 / 9))
  })
})

describe('the blocked air', () => {
  it('takes the sky’s beam on a sky texel and the cleared beam on a surface texel under Enhanced', async () => {
    /*
     * An air lit by exactly the beam it is handed, so B is that beam times
     * one factor the class does not move: the cloud in front of the air and
     * the air's own throughput. A transmittance table constant over its
     * texels makes the slant its own overhead, so the cleared beam is the
     * table mixed halfway to white (`clearedBeam` at cleared·ORBIT_AIRLIGHT).
     */
    const table = [0.5, 0.25, 0.125] as const
    const cleared = table.map((c) => c + (1 - c) * 0.5)
    const texelValues = Array.from({ length: 16 }, (_, k) =>
      DataUtils.toHalfFloat(k % 4 === 3 ? 1 : table[k % 4]!),
    )
    const transmittance = new DataTexture(
      new Uint16Array(texelValues),
      2,
      2,
      RGBAFormat,
      HalfFloatType,
    )
    transmittance.magFilter = LinearFilter
    transmittance.minFilter = LinearFilter
    transmittance.needsUpdate = true
    const air: CloudAirFn = (_air, _height, _muSun, _phases, sunT) => ({
      extinction: vec3(20),
      single: sunT.mul(5),
      multiple: vec3(0),
    })
    const blocked = async (sky: boolean): Promise<Vec3> => {
      const uniforms = createCloudUniforms()
      placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
      uniforms.served.air.transmittance.value = transmittance
      uniforms.served.cleared.value = 1
      const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
      const march = probe(uniforms, slab, { sky, air })
      const [result] = await march([{ direction: [0, 1, 0] }])
      return result!.air
    }
    const sky = await blocked(true)
    const surface = await blocked(false)
    sky.forEach((band, k) => {
      expect(band).toBeLessThan(0)
      const ratio = surface[k]! / band
      expect(relative(ratio, cleared[k]! / table[k]!)).toBeLessThanOrEqual(
        MARCH,
      )
    })
    transmittance.dispose()
  })
})

describe('the texel’s class', () => {
  it('is the composite’s own test at any compression: a ridge 3 km out is surface, the clamp is sky', async () => {
    /*
     * An air lit by exactly the beam it is handed makes B one factor times
     * that beam, so a texel's band ratios name its class whatever the
     * quadrature did: the table's 0.5 and 0.25 on a sky texel, the cleared
     * beam's 0.833 and 0.75 on a surface one. Compression 0.25 tells the
     * class's units from their reciprocal: as R·c/1000 a ridge 0.75 render
     * km out lies 1,194 sea-level units deep, past the air's wall at 0.0157,
     * and reads as sky.
     */
    const compression = 0.25
    const table = [0.5, 0.25, 0.125] as const
    const cleared = table.map((c) => c + (1 - c) * 0.5)
    const transmittance = new DataTexture(
      new Uint16Array(
        Array.from({ length: 16 }, (_, k) =>
          DataUtils.toHalfFloat(k % 4 === 3 ? 1 : table[k % 4]!),
        ),
      ),
      2,
      2,
      RGBAFormat,
      HalfFloatType,
    )
    transmittance.magFilter = LinearFilter
    transmittance.minFilter = LinearFilter
    transmittance.needsUpdate = true
    const air: CloudAirFn = (_air, _height, _muSun, _phases, sunT) => ({
      extinction: vec3(20),
      single: sunT.mul(5000),
      multiple: vec3(0),
    })
    const uniforms = createCloudUniforms()
    placeBody(uniforms, { eye: 0, layers: [[SLAB.base, SLAB.top]] })
    const body = uniforms.served
    body.compression.value = compression
    body.cleared.value = 1
    body.air.top.value = 1 + 100_000 / R
    body.air.transmittance.value = transmittance
    lookUp(uniforms, 1e-3)
    sizeTrace(uniforms, 2, 1)
    // The left texel's history pixels read the ridge, the right one's the clamp.
    const depth = depthTexture(8, 4, (x) => (x < 4 ? 3 * compression : SKY_KM))
    const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
    const { deps } = standIns(uniforms, slab, () => depth)
    const trace = new CloudTrace({ ...deps, air })
    await trace.warm(renderer)
    trace.render(renderer, frameOf({ width: 2, height: 1 }), BUDGET)
    const aux = await texels(trace.outputs.aux, 4, 1)
    const shape = (b: readonly number[]) => [b[1]! / b[0]!, b[2]! / b[0]!]
    const [surface, sky] = [aux(0, 0), aux(2, 0)]
    expect(surface[0]).toBeLessThan(0)
    expect(sky[0]).toBeLessThan(0)
    // Two half floats a ratio, each to its step.
    const close = (got: number[], want: number[]) =>
      got.forEach((value, k) =>
        expect(relative(value, want[k]!)).toBeLessThanOrEqual(4 * HALF),
      )
    close(shape(surface), shape(cleared))
    close(shape(sky), shape(table))
    trace.dispose()
    depth.dispose()
    transmittance.dispose()
  })
})

/* ------------------------------------------------------------------------- */
/* The trace's kernels and outputs                                            */
/* ------------------------------------------------------------------------- */

interface Rig {
  readonly uniforms: CloudUniforms
  readonly trace: CloudTrace
  readonly depth: DataTexture
  dispose(): void
}

/** A trace over `medium` at `width` × `height`, warmed, its uniforms the test's. */
async function rig(
  medium: CloudMediumFn,
  width: number,
  height: number,
  place: Layers,
  options: {
    readonly km?: (x: number, y: number) => number
    readonly phase?: CloudPhaseNodes
    readonly spread?: number
  } = {},
): Promise<Rig> {
  const uniforms = createCloudUniforms()
  placeBody(uniforms, place)
  lookUp(uniforms, options.spread ?? 1)
  sizeTrace(uniforms, width, height)
  const depth = depthTexture(
    4 * width,
    4 * height,
    options.km ?? (() => SKY_KM),
  )
  const phase = options.phase === undefined ? {} : { phase: options.phase }
  const { deps } = standIns(uniforms, medium, () => depth, phase)
  const trace = new CloudTrace(deps)
  await trace.warm(renderer)
  return {
    uniforms,
    trace,
    depth,
    dispose() {
      trace.dispose()
      depth.dispose()
    },
  }
}

/** The light, aux and knot textures, read back whole at `extent`. */
async function outputsOf(trace: CloudTrace, width: number, height: number) {
  const { light, aux, knotDepth, knotLight } = trace.outputs
  return {
    light: await texels(light, width, height),
    aux: await texels(aux, 2 * width, height),
    knotDepth: await texels(knotDepth, 2 * width, height),
    knotLight: await texels(knotLight, 2 * width, 2 * height),
  }
}

/** Waits out the counters' readback, which lands a few frames late. */
async function stepsOf(trace: CloudTrace): Promise<CloudTrace['steps']> {
  for (let turn = 0; turn < 200 && trace.steps === null; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  return trace.steps
}

describe('the outputs', () => {
  it('follow the frame’s extent, one level each, holding the 72 bytes a texel they declare', async () => {
    const traced = await rig(slabMedium([]), 4, 4, {
      eye: 1000,
      layers: [[100, 5000]],
    })
    const { trace, uniforms } = traced
    const backend = renderer.backend as unknown as {
      get(texture: object): { texture: GPUTexture }
    }
    for (const [width, height] of [
      [4, 4],
      [6, 2],
    ] as const) {
      sizeTrace(uniforms, width, height)
      trace.render(renderer, frameOf({ width, height }), BUDGET)
      // A resize disposes the four and three makes them again at the next
      // binding: the kernels write the new ones, not what was destroyed.
      const { light } = await outputsOf(trace, width, height)
      for (let k = 0; k < width * height; k += 1)
        expect(light(k % width, Math.floor(k / width))).toEqual([0, 0, 0, 1])
      const held = trace.textures().map((map) => {
        const gpuTexture = backend.get(map).texture
        return [gpuTexture.width, gpuTexture.height, gpuTexture.mipLevelCount]
      })
      expect(held).toEqual([
        [width, height, 1],
        [2 * width, height, 1],
        [2 * width, height, 1],
        [2 * width, 2 * height, 1],
      ])
      // RGBA16F: eight bytes a texel of each.
      const bytes = held.reduce((sum, [w, h]) => sum + w! * h! * 8, 0)
      expect(trace.bytes).toBe(bytes)
      expect(trace.bytes).toBe(width * height * 72)
    }
    traced.dispose()
    expect(trace.bytes).toBe(0)
    expect(trace.textures()).toEqual([])
  })
})

describe('the immediate regime', () => {
  it('traces every history pixel exactly once over its four dispatches, and stores nothing outside the extent', async () => {
    /*
     * The depth copy names each history pixel by its distance: the 2 × 2
     * render pixels under history pixel n hold 2 + n/64 km, exact in a half
     * float, and a ray that meets no cloud ends there, so each texel's d_end
     * says which history pixel it traced. The textures are a column wider
     * than the extent the kernels are told, and that column stays as WebGPU
     * made it.
     */
    const width = 4
    const height = 3
    const named = (x: number, y: number): number =>
      2 + (Math.floor(y / 2) * 2 * width + Math.floor(x / 2)) / 64
    const traced = await rig(
      slabMedium([]),
      width,
      height,
      { eye: 1000, layers: [[100, 5000]] },
      { km: named },
    )
    const frame = frameOf({ width: width + 1, height })
    const seen = new Map<number, number>()
    for (const [k, [px, py]] of CLOUD_TRACE_PHASES.entries()) {
      traced.trace.dispatchPhase(renderer, frame, k)
      const { light, aux, knotDepth, knotLight } = await outputsOf(
        traced.trace,
        width + 1,
        height,
      )
      for (let j = 0; j < height; j += 1) {
        for (let i = 0; i < width; i += 1) {
          const n = Math.round((aux(2 * i + 1, j)[0] - 2) * 64)
          expect([n % (2 * width), Math.floor(n / (2 * width))]).toEqual([
            2 * i + px,
            2 * j + py,
          ])
          seen.set(n, (seen.get(n) ?? 0) + 1)
          expect(light(i, j)).toEqual([0, 0, 0, 1])
        }
        const untouched = [0, 0, 0, 0]
        expect(light(width, j)).toEqual(untouched)
        for (const x of [2 * width, 2 * width + 1]) {
          expect(aux(x, j)).toEqual(untouched)
          expect(knotDepth(x, j)).toEqual(untouched)
          expect(knotLight(x, 2 * j)).toEqual(untouched)
          expect(knotLight(x, 2 * j + 1)).toEqual(untouched)
        }
      }
    }
    expect(seen.size).toBe(4 * width * height)
    expect([...seen.values()].every((times) => times === 1)).toBe(true)
    traced.dispose()
  })
})

describe('the knots', () => {
  const lower = { base: 1000, top: 1400, sigma: 1.2 / 400 }
  const upper = { base: 2500, top: 3000, sigma: 1 / 500 }
  const place: Layers = {
    eye: 0,
    layers: [
      [lower.base, lower.top],
      [upper.base, upper.top],
    ],
  }

  it('sit at two slabs’ entries and exits, with the transmittance and light at each exit', async () => {
    // Rays within a thousandth of the zenith: chords within 10⁻⁶ of the
    // slabs' thicknesses, under a half float's step.
    const traced = await rig(slabMedium([lower, upper]), 2, 2, place, {
      spread: 1e-3,
    })
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const { aux, knotDepth, knotLight } = await outputsOf(traced.trace, 2, 2)
    const first = Math.exp(-1.2)
    const both = Math.exp(-2.2)
    const expected = [
      [LIGHT_PER_OPACITY * (1 - first), first],
      [LIGHT_PER_OPACITY * (1 - both), both],
      [0, 1],
      [0, 1],
    ] as const
    const near = (value: number, reference: number): void => {
      expect(Math.abs(value - reference)).toBeLessThanOrEqual(
        HALF * Math.max(Math.abs(reference), 1e-2),
      )
    }
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 2; i += 1) {
        expect(aux(2 * i + 1, j)[3]).toBe(2)
        knotDepth(2 * i, j).forEach((km, k) => {
          near(km, [1, 1.4, 2.5, 3][k]!)
        })
        expect(knotDepth(2 * i + 1, j)).toEqual([
          SKY_KM,
          SKY_KM,
          SKY_KM,
          SKY_KM,
        ])
        expected.forEach(([band, transmittance], k) => {
          const [r, g, b, t] = knotLight(2 * i + (k & 1), 2 * j + (k >> 1))
          for (const value of [r, g, b]) near(value, band)
          near(t, transmittance)
        })
      }
    traced.dispose()
  })

  it('are written through finiteOr, where the light beside them is not', async () => {
    // A phase poisoned at run time: a NaN constant would be folded, or
    // refused, by the compiler.
    const poison = uniform(Number.NaN)
    const traced = await rig(slabMedium([lower, upper]), 2, 2, place, {
      spread: 1e-3,
      phase: CLOUD_STAND_INS.phase(poison),
    })
    traced.trace.render(renderer, frameOf({ width: 2, height: 2 }), BUDGET)
    const { light, knotLight } = await outputsOf(traced.trace, 2, 2)
    // The injection reaches the light, which the history guards…
    expect(light(0, 0).slice(0, 3).every(Number.isNaN)).toBe(true)
    // …and never the knots, which nothing guards after them.
    for (let y = 0; y < 4; y += 1)
      for (let x = 0; x < 4; x += 1)
        expect(knotLight(x, y)).toEqual([0, 0, 0, 1])
    traced.dispose()
  })
})

describe('the kernels’ choice', () => {
  it('marches one medium alike in every (cache, sun depth, far) triple', async () => {
    const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
    const traced = await rig(slab, 4, 4, {
      eye: 0,
      layers: [[SLAB.base, SLAB.top]],
    })
    const outputs: number[][] = []
    for (const cache of ['field', 'volume'] as const)
      for (const sunDepth of ['cascades', 'grid'] as const)
        for (const far of ['atlas', 'spheres'] as const) {
          const frame = frameOf(
            { width: 4, height: 4 },
            { cache, sunDepth, far },
          )
          traced.trace.render(renderer, frame, BUDGET)
          const { light, aux } = await outputsOf(traced.trace, 4, 4)
          outputs.push([...light(1, 2), ...aux(3, 2), ...aux(4, 1)])
        }
    // A slab the stand-ins add nothing to: the same numbers from each.
    expect(outputs[0]![3]).toBeLessThan(1)
    for (const output of outputs) expect(output).toEqual(outputs[0])
    traced.dispose()
  })

  it('draws one frame index alike every time, and moves the samples with the index', async () => {
    // Frames 5 and 9 share an interleave phase, so only the jitter differs.
    const slab = slabMedium([{ ...SLAB, sigma: 0.002 }])
    const traced = await rig(slab, 4, 4, {
      eye: 0,
      layers: [[SLAB.base, SLAB.top]],
    })
    const at = async (index: number): Promise<number[]> => {
      traced.uniforms.trace.frame.value = index
      const frame = frameOf({ width: 4, height: 4 }, {}, index)
      traced.trace.render(renderer, frame, BUDGET)
      const { light } = await outputsOf(traced.trace, 4, 4)
      return Array.from({ length: 16 }, (_, k) => light(k % 4, k >> 2)[3])
    }
    const once = await at(5)
    expect(await at(5)).toEqual(once)
    expect(await at(9)).not.toEqual(once)
    traced.dispose()
  })
})

describe('the step counters', () => {
  it('count exactly fixedSteps steps a ray under the sweep kernel', async () => {
    // Standing in an overcast deck, as the sweep does (§8.4).
    const deck = slabMedium([{ base: 100, top: 1100, sigma: 0.03 }])
    const traced = await rig(deck, 4, 4, { eye: 2, layers: [[100, 1100]] })
    traced.uniforms.trace.fixedSteps.value = 32
    const sweep = { fixedSteps: 32, sweepReads: 1, stats: true } as const
    traced.trace.render(
      renderer,
      frameOf({ width: 4, height: 4 }, sweep),
      BUDGET,
    )
    expect(await stepsOf(traced.trace)).toEqual({
      mean: 32,
      max: 32,
      exhausted: 0,
    })
    // The control: the fine march's count follows each ray, and a budget of
    // four steps runs out on every one of them before the deck's top.
    const off = frameOf({ width: 4, height: 4 }, { stats: false })
    traced.trace.render(renderer, off, BUDGET)
    expect(traced.trace.steps).toBeNull()
    traced.uniforms.trace.maxSteps.value = 4
    const fine = frameOf({ width: 4, height: 4 }, { stats: true })
    traced.trace.render(renderer, fine, BUDGET)
    expect(await stepsOf(traced.trace)).toEqual({
      mean: 4,
      max: 4,
      exhausted: 16,
    })
    traced.dispose()
  })
})
