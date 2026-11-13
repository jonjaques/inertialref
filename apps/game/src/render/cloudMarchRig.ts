import {
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  type Node,
  RedFormat,
  StorageBufferAttribute,
  type Texture,
} from 'three/webgpu'
import {
  bool,
  exp,
  float,
  Fn,
  If,
  instanceIndex,
  ivec2,
  normalize,
  storage,
  textureLoad,
  uint,
  uniform,
  uvec2,
  vec2,
  vec3,
} from 'three/tsl'
import { sunThroughAt } from './air.ts'
import type { CloudFrame } from './cloudFrame.ts'
import { cloudRay } from './cloudGeometry.ts'
import { createCloudJitter } from './cloudJitter.ts'
import { type CloudLevers, DEFAULT_CLOUD_LEVERS } from './cloudLevers.ts'
import {
  type CloudAirFn,
  cloudMarch,
  type CloudMarchDeps,
  type CloudMarchOptions,
  marchFar,
} from './cloudMarch.ts'
import {
  CLOUD_STAND_INS,
  type CloudFarFn,
  type CloudMediumFn,
  type CloudPhaseNodes,
  type CloudSunDepthNodes,
  type CloudSunFn,
} from './cloudNodes.ts'
import { createCloudSky } from './cloudSky.ts'
import { createCloudSource } from './cloudSource.ts'
import type { CloudUniforms } from './cloudUniforms.ts'
import type { GpuSession } from './gpuHarness.ts'

/*
 * The march's GPU tests' rig: a body laid out by hand, as
 * `cloudUniforms.write` would lay it out from a frame, and a probe kernel
 * that runs `cloudMarch` one ray an invocation and writes its result in
 * float32. The trace's own outputs are RGBA16F, whose step of 2⁻¹¹ relative
 * is the floor on anything asserted through them; a march held to 10⁻⁴ is
 * read here.
 */

/** Earth's: the curvature the crossings carry is the real one. */
export const MARCH_RIG_RADIUS = 6_371_000
/** The depth copy's clamp: sky. */
export const SKY_KM = 60_000

export type Triple = readonly [number, number, number]
type Quad = [number, number, number, number]

export interface MarchLayers {
  /** The eye over the datum, meters. */
  readonly eye: number
  /** Up to three [base, top] pairs, meters. */
  readonly layers: readonly (readonly [number, number])[]
  /** Every level's noise cell, meters: a kilometer when absent, a cumulus's. */
  readonly cell?: number
}

/**
 * The served body's uniforms as `cloudUniforms.write` would leave them: the
 * eye on +Y over a body of Earth's radius, the sun overhead, and the layers'
 * boundaries with the eye's height over each formed in float64. An absent
 * layer sits at the union's top with no thickness, as `writeLayers` lays it.
 */
export function placeBody(
  uniforms: CloudUniforms,
  { eye, layers, cell = 1000 }: MarchLayers,
): void {
  const R = MARCH_RIG_RADIUS
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
  body.layers.radius.value.set(10, 10, 10)
  body.layers.cell.value.set(cell, cell, cell)
  // The levels' own heights, which the sun's taps end at.
  body.layers.base.value.set(flat[0]!, flat[2]!, flat[4]!)
  body.layers.top.value.set(flat[1]!, flat[3]!, flat[5]!)
  const trace = uniforms.trace
  trace.farDistance.value = 1e9
  trace.maxSteps.value = 1024
  trace.frame.value = 0
}

/** The sun at cosine `mu` over the eye's horizon, toward +X. */
export function placeSun(uniforms: CloudUniforms, mu: number): void {
  const body = uniforms.served
  body.sun.value.set(Math.sqrt(1 - mu * mu), mu, 0)
  body.sunUp.value = mu
}

/** A slab's path length along a ray of up-cosine μ from the eye, float64: the sphere crossings' difference. */
export function chord(
  eye: number,
  mu: number,
  base: number,
  top: number,
): number {
  const re = MARCH_RIG_RADIUS + eye
  const crossing = (h: number): number => {
    const b = re * mu
    const c = (eye - h) * (2 * MARCH_RIG_RADIUS + eye + h)
    const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(b * b - c))
    return Math.max(q, c / q)
  }
  return crossing(top) - Math.max(crossing(base), 0)
}

export const unit = (v: Triple): Triple => {
  const length = Math.hypot(...v)
  return [v[0] / length, v[1] / length, v[2] / length]
}

/** A ray with up-cosine μ, leaning toward +X. */
export const leaning = (mu: number): Triple => [Math.sqrt(1 - mu * mu), mu, 0]

export const relative = (value: number, reference: number): number =>
  Math.abs(value - reference) / Math.max(Math.abs(reference), 1e-30)

/**
 * A sun as `cloudSunFn` binds one: the medium read where the taps would read
 * it, the sun depth's texture and the air's beam, with the taps adding
 * nothing, so the cloud a sample sees toward the sun is `cloud` and the
 * beam is the air's table — white on the stand-in tables.
 */
export function testSun(
  field: CloudMediumFn,
  depth: CloudSunDepthNodes,
  cloud: Node<'float'> = float(1),
): CloudSunFn {
  return (sample, _medium, body) => {
    const taps = field(sample, body).sigma.mul(0)
    const airHeight = float(MARCH_RIG_RADIUS).mul(body.air.top.sub(1).max(1e-6))
    const through = exp(depth.depths(sample.offset).toSun.negate())
      .mul(cloud)
      .add(taps)
    return {
      cloud: through,
      depth: vec2(0),
      octave: () => through,
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

/**
 * What a march's deps hold beyond its medium, its sun and its phase: no sky
 * and no source, which the march reads nowhere, and the trace's own jitter
 * over the test's uniforms, so a kernel here draws the rays the system's
 * draws.
 */
export const marchLight = (uniforms: CloudUniforms) => ({
  sky: createCloudSky(),
  source: createCloudSource(),
  jitter: createCloudJitter({ uniforms }),
})

/** An R16F distance texture, km, filtered as the depth copy is. */
export function depthTexture(
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

/** Every texel of a texture, RGBA, row 0 first, read by a kernel so nothing filters or flips it. */
export async function readTexels(
  gpu: GpuSession,
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
  out.dispose()
  return (x, y) => {
    const at = (y * width + x) * 4
    return [values[at]!, values[at + 1]!, values[at + 2]!, values[at + 3]!]
  }
}

/**
 * What the trace reads of a frame — its levers, its extents and its index —
 * and nothing else. The uniforms are set by the test, as `cloudUniforms.write`
 * would set them from a whole frame.
 */
export function traceFrame(
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

export const NO_BUDGET = { slices: 0, tiles: 0, jump: false, sunSlices: 0 }

/** A camera looking up the local vertical with `spread` of half-tangent each way. */
export function lookUp(uniforms: CloudUniforms, spread: number): void {
  const camera = uniforms.camera
  camera.forward.value.set(0, 1, 0)
  camera.right.value.set(1, 0, 0)
  camera.up.value.set(0, 0, -1)
  camera.plane.value.set(spread, spread)
  camera.pixelAngle.value = 1e-3
}

/** The trace's extents in its uniforms, for a trace of `width` × `height`. */
export function sizeTrace(
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
/* The probe                                                                  */
/* ------------------------------------------------------------------------- */

export interface Probed {
  readonly light: Triple
  readonly transmittance: number
  readonly air: Triple
  readonly reproject: number
  readonly end: number
  readonly front: number
  readonly deviation: number
  readonly stopped: number
  readonly steps: number
  readonly exhausted: number
  readonly start: number
  readonly range: number
}
const PROBED = 16
const RAY = 6

export interface ProbeRay {
  readonly direction: Triple
  readonly jitter?: number
  /** True meters: where the scene stops the ray. */
  readonly stop?: number
  /** ξ: where in the handover's band the ray stops. */
  readonly handover?: number
}

export interface ProbeOptions {
  readonly sky?: boolean
  readonly sun?: (field: CloudMediumFn) => CloudSunFn
  readonly air?: CloudAirFn
  readonly phase?: CloudPhaseNodes
  /** A far march past the handover, composed as the trace composes it. */
  readonly far?: CloudFarFn
  /** The march's own options, less the handover's ξ, which is a ray's. */
  readonly march?: Omit<CloudMarchOptions, 'handover'>
}

/**
 * `cloudMarch` one ray an invocation, its result written in float32: the
 * march itself, without the half floats the trace's textures store it in.
 * The rays are clipped to the shell union as the trace clips them.
 */
export function marchProbe(
  gpu: GpuSession,
  uniforms: CloudUniforms,
  medium: CloudMediumFn,
  options: ProbeOptions = {},
): (rays: readonly ProbeRay[]) => Promise<Probed[]> {
  const capacity = 64
  const input = new StorageBufferAttribute(new Float32Array(capacity * RAY), 1)
  const output = new StorageBufferAttribute(
    new Float32Array(capacity * PROBED),
    1,
  )
  const from = storage(input, 'float', capacity * RAY)
  const into = storage(output, 'float', capacity * PROBED)
  const count = uniform(0, 'uint')
  const field = CLOUD_STAND_INS.field(medium)
  const sun = options.sun ?? ((f) => testSun(f, CLOUD_STAND_INS.sunDepth()))
  const deps: CloudMarchDeps = {
    uniforms,
    phase: options.phase ?? CLOUD_STAND_INS.phase(),
    medium: field,
    sun: sun(field),
    ...marchLight(uniforms),
    ...(options.air === undefined ? {} : { air: options.air }),
  }
  const kernel = Fn(() => {
    If(instanceIndex.lessThan(count), () => {
      const read = (k: number) => from.element(instanceIndex.mul(RAY).add(k))
      const direction = normalize(vec3(read(0), read(1), read(2)))
      const stop = read(4)
      const ray = cloudRay(direction, uniforms.served, stop)
      const start = ray.hit.select(ray.start, stop)
      const end = ray.hit.select(ray.end, stop)
      const clipped = { ...ray, start, end }
      const sky = bool(options.sky ?? true)
      const fine = cloudMarch(clipped, read(3), sky, deps, null, {
        ...options.march,
        handover: read(5),
      })
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
        result.range,
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
        [
          ...unit(ray.direction),
          ray.jitter ?? 0,
          ray.stop ?? 1e9,
          ray.handover ?? 0,
        ],
        i * RAY,
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
        range: v[15]!,
      }
    })
  }
}
