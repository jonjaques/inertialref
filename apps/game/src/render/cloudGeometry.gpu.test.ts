import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  FloatType,
  Mesh,
  MeshBasicNodeMaterial,
  type Node,
  PerspectiveCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  StorageBufferAttribute,
} from 'three/webgpu'
import {
  float,
  Fn,
  If,
  instanceIndex,
  ivec2,
  storage,
  textureLoad,
  uint,
  uvec2,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { CUBE_FACES } from '@inertialref/rendering'
import {
  altitudeAlong,
  altitudeAt,
  cloudRay,
  cubeAtlasUv,
  levelOffset,
  levelPlane,
  screenTexel,
  shellCrossing,
  sunMuAt,
  traceScreen,
  viewDirection,
} from './cloudGeometry.ts'
import { traceJitter } from './cloudJitter.ts'
import { finiteOr, slabMedium } from './cloudNodes.ts'
import { type GpuSession, openGpu } from './gpuHarness.ts'
import {
  type CloudBodyUniforms,
  type CloudLevelUniforms,
  createCloudUniforms,
} from './cloudUniforms.ts'

/*
 * The geometry every cloud pass forms its rays and heights with, run on the
 * GPU and held to float64 computed here from the same float32 inputs the
 * kernel was given (§3.5b). Each sample carries its own body in a storage
 * buffer, so 4,096 rays over planets from 10⁵ to 10⁸ m are one dispatch.
 */

/** float32's unit roundoff: half an ulp, relative. */
const EPSILON = 2 ** -24
/**
 * float32's step at 10⁵ m, 7.8 mm: what a 100 km offset's components carry
 * into its dot products with a level's axes.
 */
const STEP_AT_100_KM = 2 ** -7
/**
 * A plane coordinate 100 km out, measured: 2.2 cm worst over twelve seeds of
 * 1,024 offsets, about three float32 steps at 10⁵ m through the dot product,
 * the scale and the eye's own coordinate. The design asked for 2 cm, which
 * half the seeds exceed; normalizing an absolute direction instead carries
 * 0.4 m on Earth.
 */
const PLANE_BOUND = 4 * STEP_AT_100_KM
/** The altitude bound where a layer's base and top are decided (§5.3). */
const LAYER_BAND = { low: -1000, high: 20_000, bound: 0.25 } as const

let gpu: GpuSession

beforeAll(async () => {
  gpu = await openGpu()
})

afterAll(() => {
  gpu.dispose()
})

const f32 = Math.fround

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

type Read = (k: number) => Node<'float'>
type Write = (k: number, value: Node<'float'>) => void

/**
 * One kernel over `count` samples: `inputs` holds `stride` floats a sample,
 * and each writes `outputs` floats. Returns what the kernel wrote.
 */
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

/** The fields of a body the geometry reads, from a sample's inputs. */
function bodyFrom(read: Read, at = 0): CloudBodyUniforms {
  return {
    datumRadius: read(at),
    eye: read(at + 1),
    eyeTerm: read(at + 2),
    up: vec3(read(at + 3), read(at + 4), read(at + 5)),
    sun: vec3(read(at + 6), read(at + 7), read(at + 8)),
    sunUp: read(at + 9),
    eyeOver: vec4(read(at + 10), read(at + 11), read(at + 12), read(at + 13)),
    eyeOverHigh: vec2(read(at + 14), read(at + 15)),
    boundaries: vec4(
      read(at + 16),
      read(at + 17),
      read(at + 18),
      read(at + 19),
    ),
    boundariesHigh: vec2(read(at + 20), read(at + 21)),
  } as unknown as CloudBodyUniforms
}
const BODY_FLOATS = 22

interface Body64 {
  readonly R: number
  readonly he: number
  readonly up: readonly [number, number, number]
  readonly sun: readonly [number, number, number]
  readonly boundaries: readonly number[]
}

/** The body as float32 inputs, and the float32 values the reference reads back. */
function packBody(target: Float32Array, at: number, body: Body64): void {
  const R = f32(body.R)
  const he = f32(body.he)
  target[at] = R
  target[at + 1] = he
  target[at + 2] = he * (2 * R + he)
  target.set(body.up, at + 3)
  target.set(body.sun, at + 6)
  target[at + 9] =
    body.up[0] * body.sun[0] +
    body.up[1] * body.sun[1] +
    body.up[2] * body.sun[2]
  body.boundaries.forEach((b, k) => {
    target[at + 10 + k] = he - b
    target[at + 16 + k] = b
  })
}

function unit(v: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...v)
  return [v[0] / length, v[1] / length, v[2] / length]
}

function randomUnit(next: () => number): [number, number, number] {
  const z = 2 * next() - 1
  const phi = 2 * Math.PI * next()
  const s = Math.sqrt(1 - z * z)
  return [s * Math.cos(phi), s * Math.sin(phi), z]
}

/** Any unit vector perpendicular to `n`. */
function perpendicular(
  n: readonly [number, number, number],
): [number, number, number] {
  const helper: [number, number, number] =
    Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
  return unit([
    n[1] * helper[2] - n[2] * helper[1],
    n[2] * helper[0] - n[0] * helper[2],
    n[0] * helper[1] - n[1] * helper[0],
  ])
}

const cross = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

const dot3 = (
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** The stable roots of t² + 2bt + c = 0 in float64, or null. */
function roots64(b: number, c: number): [number, number] | null {
  const d = b * b - c
  if (d < 0) return null
  const q = -(b + (b >= 0 ? 1 : -1) * Math.sqrt(d))
  const other = q !== 0 ? c / q : 0
  return [Math.min(q, other), Math.max(q, other)]
}

/** Exact height over the datum at distance t along a ray, float64. */
function height64(R: number, he: number, mu: number, t: number): number {
  const re = R + he
  const numerator = he * (2 * R + he) + 2 * re * mu * t + t * t
  return numerator / (Math.sqrt(R * R + numerator) + R)
}

function heightBound(h: number, R: number, t: number): number {
  return h >= LAYER_BAND.low && h <= LAYER_BAND.high
    ? LAYER_BAND.bound
    : 1e-6 * (R + Math.abs(t))
}

describe('shell crossings', () => {
  it('match the float64 roots at 4,096 rays, to float32 carried through the stable quadratic', async () => {
    const next = draws(1)
    const count = 4096
    const stride = 5
    const inputs = new Float32Array(count * stride)
    for (let i = 0; i < count; i += 1) {
      const R = f32(10 ** (5 + 3 * next()))
      const he = f32(-1e4 + 4.1e5 * next() ** 2)
      const hs = f32(2e4 * next())
      const mu = f32(next() < 0.05 ? 0 : 2 * next() - 1)
      inputs.set([R, he, f32(he - hs), hs, mu], i * stride)
    }
    const out = await run(count, inputs, stride, 3, (read, write) => {
      const body = {
        datumRadius: read(0),
        eye: read(1),
      } as unknown as CloudBodyUniforms
      const crossing = shellCrossing(body, read(4), read(2), read(3))
      write(0, crossing.near)
      write(1, crossing.far)
      write(2, crossing.hit.select(float(1), float(0)))
    })
    let compared = 0
    for (let i = 0; i < count; i += 1) {
      const [R, he, eyeOver, hs, mu] = inputs.subarray(
        i * stride,
      ) as unknown as number[]
      const b = (R! + he!) * mu!
      const c = eyeOver! * (2 * R! + he! + hs!)
      const d = b * b - c
      // The float32 rounding of D: b² and c each to a few ulps.
      const dError = EPSILON * (6 * b * b + 4 * Math.abs(c) + Math.abs(d))
      const near = out[i * 3]!
      const far = out[i * 3 + 1]!
      const hit = out[i * 3 + 2] === 1
      expect(Number.isFinite(near) && Number.isFinite(far)).toBe(true)
      const exact = roots64(b, c)
      if (Math.abs(d) <= dError) continue
      expect(hit, `ray ${i}`).toBe(exact !== null)
      if (exact === null) continue
      const sqrtError = Math.min(
        Math.sqrt(dError),
        dError / (2 * Math.sqrt(Math.abs(d))),
      )
      const q = Math.max(Math.abs(exact[0]), Math.abs(exact[1]))
      const qError = 4 * EPSILON * (Math.abs(b) + q) + sqrtError
      for (const [gpuRoot, root] of [
        [near, exact[0]],
        [far, exact[1]],
      ] as const) {
        const bound =
          2 *
          (Math.abs(root) === q
            ? qError
            : Math.abs(root) * (8 * EPSILON + qError / Math.max(q, 1e-30)))
        expect(Math.abs(gpuRoot - root), `ray ${i}`).toBeLessThanOrEqual(
          bound + 1e-30,
        )
      }
      compared += 1
    }
    expect(compared).toBeGreaterThan(count / 4)
  })

  it('give a level ray from an eye on a boundary (0, 0), and never 0/0', async () => {
    const inputs = new Float32Array([
      6_371_000, 1000, 0, 1000, 0, 3_980_000, 0, 0, 0, 0, 1e5, 2.4e3, 0, 2.4e3,
      0,
    ])
    const out = await run(3, inputs, 5, 3, (read, write) => {
      const body = {
        datumRadius: read(0),
        eye: read(1),
      } as unknown as CloudBodyUniforms
      const crossing = shellCrossing(body, read(4), read(2), read(3))
      write(0, crossing.near)
      write(1, crossing.far)
      write(2, crossing.hit.select(float(1), float(0)))
    })
    expect([...out]).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
  })

  it('span an eye on the union’s base with a level ray, finitely', async () => {
    const R = 6_371_000
    const he = 900
    const inputs = new Float32Array(BODY_FLOATS)
    packBody(inputs, 0, {
      R,
      he,
      up: [0, 1, 0],
      sun: unit([0.3, 0.8, 0.1]),
      boundaries: [900, 2200, 2200, 2200, 2200, 2200],
    })
    const out = await run(1, inputs, BODY_FLOATS, 3, (read, write) => {
      const ray = cloudRay(vec3(1, 0, 0), bodyFrom(read), float(1e7))
      write(0, ray.start)
      write(1, ray.end)
      write(2, ray.hit.select(float(1), float(0)))
    })
    expect(out[0]).toBe(0)
    // A level ray from the base rises through the layer: it leaves by the
    // top, √((R + 2200)² − (R + 900)²) ahead.
    const exit = Math.sqrt((R + 2200) ** 2 - (R + he) ** 2)
    expect(Math.abs(out[1]! - exit)).toBeLessThan(1)
    expect(out[2]).toBe(1)
  })
})

describe('altitude', () => {
  /** Rays over the whole domain, then Earth from 400 km into the layers, then the ground's horizon. */
  function rays(): Float32Array {
    const next = draws(2)
    const count = 4096
    const inputs = new Float32Array(count * 4)
    for (let i = 0; i < count; i += 1) {
      let R: number
      let he: number
      let mu: number
      let t: number
      if (i < 2048) {
        R = 10 ** (5 + 3 * next())
        he = -1e4 + 4.1e5 * next()
        mu = 2 * next() - 1
        t = 3e6 * next()
      } else if (i < 3072) {
        // Earth from 400 km, each ray stopped at a height in the band.
        R = 6_371_000
        he = 400_000
        const re = R + he
        const target = R - 1000 + 21_000 * next()
        const steepest = -Math.sqrt(1 - (target / re) ** 2)
        mu = -1 + (steepest + 1) * next()
        t =
          -re * mu - Math.sqrt(re * re * mu * mu - (re * re - target * target))
      } else {
        R = 3_980_000 + 2_391_000 * next()
        he = 3000 * next()
        mu = -0.1 + 0.4 * next()
        t = 3e5 * next()
      }
      inputs.set([R, he, mu, t], i * 4)
    }
    return inputs
  }

  it('along a ray, to 0.25 m in [−1, 20] km of the datum and 10⁻⁶·(R + t) elsewhere', async () => {
    const inputs = rays()
    const count = inputs.length / 4
    const out = await run(count, inputs, 4, 1, (read, write) => {
      const R = read(0)
      const he = read(1)
      const body = {
        datumRadius: R,
        eye: he,
        // The CPU forms this in float64; here it is the float32 of it, as
        // the uniform is.
        eyeTerm: he.mul(R.mul(2).add(he)),
      } as unknown as CloudBodyUniforms
      write(0, altitudeAlong(body, read(2), read(3)))
    })
    let worstBand = 0
    for (let i = 0; i < count; i += 1) {
      const [R, he, mu, t] = inputs.subarray(
        i * 4,
        i * 4 + 4,
      ) as unknown as number[]
      const h = height64(R!, he!, mu!, t!)
      const error = Math.abs(out[i]! - h)
      expect(error, `ray ${i}: h ${h}`).toBeLessThanOrEqual(
        heightBound(h, R!, t!),
      )
      if (h >= LAYER_BAND.low && h <= LAYER_BAND.high)
        worstBand = Math.max(worstBand, error)
    }
    expect(worstBand).toBeGreaterThan(0)
  })

  it('at a point, to the same bound, and the sun’s cosine there to 10⁻⁶', async () => {
    const source = rays()
    const count = source.length / 4
    const next = draws(3)
    const stride = BODY_FLOATS + 3
    const inputs = new Float32Array(count * stride)
    const offsets: [number, number, number][] = []
    // The float64 unit vectors the uniforms round from: a float32 `up` is
    // not unit length, and an eye put at r_e·up_f32 sits r_e²·2δ ≈ 5 × 10⁶ m²
    // off the sphere the uniforms describe, 0.4 m of height on Earth.
    const ups: [number, number, number][] = []
    const suns: [number, number, number][] = []
    for (let i = 0; i < count; i += 1) {
      const [R, he, mu, t] = source.subarray(
        i * 4,
        i * 4 + 4,
      ) as unknown as number[]
      const up = randomUnit(next)
      const sun = randomUnit(next)
      ups.push(up)
      suns.push(sun)
      const side = perpendicular(up)
      const s = Math.sqrt(Math.max(0, 1 - mu! * mu!))
      const o: [number, number, number] = [
        f32(t! * (mu! * up[0] + s * side[0])),
        f32(t! * (mu! * up[1] + s * side[1])),
        f32(t! * (mu! * up[2] + s * side[2])),
      ]
      offsets.push(o)
      packBody(inputs, i * stride, {
        R: R!,
        he: he!,
        up,
        sun,
        boundaries: [0, 0, 0, 0, 0, 0],
      })
      inputs.set(o, i * stride + BODY_FLOATS)
    }
    const out = await run(count, inputs, stride, 2, (read, write) => {
      const body = bodyFrom(read)
      const offset = vec3(
        read(BODY_FLOATS),
        read(BODY_FLOATS + 1),
        read(BODY_FLOATS + 2),
      )
      write(0, altitudeAt(body, offset))
      write(1, sunMuAt(body, offset))
    })
    for (let i = 0; i < count; i += 1) {
      const at = inputs.subarray(i * stride)
      const R = at[0]!
      const he = at[1]!
      const up = ups[i]!
      const sun = suns[i]!
      const o = offsets[i]!
      const re = R + he
      const point = [
        re * up[0] + o[0],
        re * up[1] + o[1],
        re * up[2] + o[2],
      ] as const
      const r = Math.hypot(...point)
      const h = r - R
      expect(
        Math.abs(out[i * 2]! - h),
        `point ${i}: h ${h}`,
      ).toBeLessThanOrEqual(heightBound(h, R, Math.hypot(...o)))
      if (h > -R / 2) {
        const cosine = dot3(point, sun) / r
        expect(Math.abs(out[i * 2 + 1]! - cosine), `point ${i}`).toBeLessThan(
          1e-6,
        )
      }
    }
  })
})

describe('a level frame', () => {
  const R = 6_371_000
  const next = draws(4)
  const anchor = randomUnit(next)
  const east = perpendicular(anchor)
  const north = cross(anchor, east)
  /** The eye 1,250 m up, a few kilometers from the anchor. */
  const toward = unit([
    anchor[0] + 4e-4 * east[0] - 7e-4 * north[0],
    anchor[1] + 4e-4 * east[1] - 7e-4 * north[1],
    anchor[2] + 4e-4 * east[2] - 7e-4 * north[2],
  ])
  const he = 1250
  const eye = toward.map((c) => c * (R + he)) as [number, number, number]
  const along = [dot3(eye, anchor), dot3(eye, east), dot3(eye, north)] as const
  const plane = [(R * along[1]) / along[0], (R * along[2]) / along[0]] as const
  const LEVEL_FLOATS = 14

  function packLevel(target: Float32Array, at: number): void {
    target.set(anchor, at)
    target.set(east, at + 3)
    target.set(north, at + 6)
    target.set(plane, at + 9)
    target.set(along, at + 11)
  }

  function levelFrom(read: Read, at: number): CloudLevelUniforms {
    return {
      anchor: vec3(read(at), read(at + 1), read(at + 2)),
      east: vec3(read(at + 3), read(at + 4), read(at + 5)),
      north: vec3(read(at + 6), read(at + 7), read(at + 8)),
      eye: vec2(read(at + 9), read(at + 10)),
      along: vec3(read(at + 11), read(at + 12), read(at + 13)),
    } as unknown as CloudLevelUniforms
  }

  /** u(P) = R(P·E)/(P·A), float64, of the point the eye plus `o` is. */
  function plane64(o: readonly [number, number, number]): [number, number] {
    const p = [eye[0] + o[0], eye[1] + o[1], eye[2] + o[2]] as const
    const a = dot3(p, anchor)
    return [(R * dot3(p, east)) / a, (R * dot3(p, north)) / a]
  }

  const bodyInputs = (target: Float32Array, at: number) =>
    packBody(target, at, {
      R,
      he,
      up: toward,
      sun: [0, 1, 0],
      boundaries: [0, 0, 0, 0, 0, 0],
    })

  it('places an offset 100 km out at its float64 plane coordinate to four float32 steps', async () => {
    const count = 1024
    const stride = BODY_FLOATS + LEVEL_FLOATS + 3
    const inputs = new Float32Array(count * stride)
    const offsets: [number, number, number][] = []
    for (let i = 0; i < count; i += 1) {
      const heading = 2 * Math.PI * next()
      const tilt = -0.02 + 0.06 * next()
      const distance = i < count / 2 ? 100_000 : 100_000 * next()
      const d = unit([
        Math.cos(heading) * east[0] +
          Math.sin(heading) * north[0] +
          tilt * toward[0],
        Math.cos(heading) * east[1] +
          Math.sin(heading) * north[1] +
          tilt * toward[1],
        Math.cos(heading) * east[2] +
          Math.sin(heading) * north[2] +
          tilt * toward[2],
      ])
      const o = d.map((c) => f32(c * distance)) as [number, number, number]
      offsets.push(o)
      bodyInputs(inputs, i * stride)
      packLevel(inputs, i * stride + BODY_FLOATS)
      inputs.set(o, i * stride + BODY_FLOATS + LEVEL_FLOATS)
    }
    const out = await run(count, inputs, stride, 2, (read, write) => {
      const at = BODY_FLOATS + LEVEL_FLOATS
      const uv = levelPlane(
        levelFrom(read, BODY_FLOATS),
        vec3(read(at), read(at + 1), read(at + 2)),
        bodyFrom(read),
      )
      write(0, uv.x)
      write(1, uv.y)
    })
    let worst = 0
    offsets.forEach((o, i) => {
      const [u, v] = plane64(o)
      worst = Math.max(
        worst,
        Math.abs(out[i * 2]! - u),
        Math.abs(out[i * 2 + 1]! - v),
      )
    })
    expect(worst).toBeLessThanOrEqual(PLANE_BOUND)
  })

  it('inverts the plane coordinate at a height, eye-relatively', async () => {
    const count = 1024
    const stride = BODY_FLOATS + LEVEL_FLOATS + 3
    const inputs = new Float32Array(count * stride)
    const targets: [number, number, number][] = []
    for (let i = 0; i < count; i += 1) {
      const u = plane[0] + (2 * next() - 1) * 100_000
      const v = plane[1] + (2 * next() - 1) * 100_000
      const h = 15_000 * next()
      targets.push([u, v, h])
      bodyInputs(inputs, i * stride)
      packLevel(inputs, i * stride + BODY_FLOATS)
      inputs.set([u, v, h], i * stride + BODY_FLOATS + LEVEL_FLOATS)
    }
    const out = await run(count, inputs, stride, 6, (read, write) => {
      const at = BODY_FLOATS + LEVEL_FLOATS
      const body = bodyFrom(read)
      const level = levelFrom(read, BODY_FLOATS)
      const o = levelOffset(
        level,
        vec2(read(at), read(at + 1)),
        read(at + 2),
        body,
      )
      const back = levelPlane(level, o, body)
      write(0, o.x)
      write(1, o.y)
      write(2, o.z)
      write(3, back.x)
      write(4, back.y)
      write(5, altitudeAt(body, o))
    })
    let worstOffset = 0
    let worstPlane = 0
    let worstHeight = 0
    targets.forEach(([u0, v0, h0], i) => {
      const u = f32(u0)
      const v = f32(v0)
      const h = f32(h0)
      const rho = Math.sqrt(R * R + u * u + v * v)
      const s = (R + h) / rho
      const exact = [0, 1, 2].map(
        (k) => s * (R * anchor[k]! + u * east[k]! + v * north[k]!) - eye[k]!,
      )
      const gpu3 = [out[i * 6]!, out[i * 6 + 1]!, out[i * 6 + 2]!]
      worstOffset = Math.max(
        worstOffset,
        Math.hypot(
          gpu3[0]! - exact[0]!,
          gpu3[1]! - exact[1]!,
          gpu3[2]! - exact[2]!,
        ),
      )
      worstPlane = Math.max(
        worstPlane,
        Math.abs(out[i * 6 + 3]! - u),
        Math.abs(out[i * 6 + 4]! - v),
      )
      worstHeight = Math.max(worstHeight, Math.abs(out[i * 6 + 5]! - h))
    })
    // Measured over twelve seeds: the offset 2.3 cm, the round trip four
    // float32 steps at 10⁵ m, the height 1.1 cm.
    expect(worstOffset).toBeLessThanOrEqual(4 * STEP_AT_100_KM)
    expect(worstPlane).toBeLessThanOrEqual(6 * STEP_AT_100_KM)
    expect(worstHeight).toBeLessThanOrEqual(LAYER_BAND.bound)
  })
})

describe('the image', () => {
  it('puts traceScreen’s row 0 at the top of what three draws, and screenTexel inverts it', async () => {
    const width = 16
    const height = 10
    const target = new RenderTarget(width, height, {
      // float32, so the harness reads it back as it draws.
      type: FloatType,
      depthBuffer: false,
    })
    // A plane over the upper half of the view and nothing under it.
    const camera = new PerspectiveCamera(60, width / height, 0.1, 10)
    camera.updateMatrixWorld()
    const material = new MeshBasicNodeMaterial()
    material.colorNode = vec4(1, 1, 1, 1)
    const upper = new Mesh(new PlaneGeometry(100, 50), material)
    upper.position.set(0, 25, -5)
    const scene = new Scene()
    scene.add(upper)
    scene.updateMatrixWorld(true)
    await gpu.draw(scene, camera, { into: target })

    const uniforms = createCloudUniforms().camera
    uniforms.plane.value.set(
      Math.tan(Math.PI / 6) * (width / height),
      Math.tan(Math.PI / 6),
    )
    const extent = vec2(width, height)
    const count = width * height
    const out = await run(count, new Float32Array(1), 0, 4, (_read, write) => {
      const pixel = uvec2(
        instanceIndex.mod(uint(width)),
        instanceIndex.div(uint(width)),
      )
      const screen = traceScreen(pixel, vec2(0), extent)
      const texel = screenTexel(screen, extent)
      write(0, float(texel.x))
      write(1, float(texel.y))
      write(2, textureLoad(target.texture, ivec2(texel)).r)
      write(3, viewDirection(uniforms, screen).y)
    })
    for (let j = 0; j < height; j += 1) {
      for (let i = 0; i < width; i += 1) {
        const k = (j * width + i) * 4
        expect([out[k], out[k + 1]]).toEqual([i, j])
        expect(out[k + 2], `texel (${i}, ${j})`).toBe(j < height / 2 ? 1 : 0)
        expect(out[k + 3]! > 0).toBe(j < height / 2)
      }
    }
    target.dispose()
  })

  it('addresses the weather cube’s atlas as CUBE_FACES lays it out', async () => {
    const next = draws(5)
    const count = 512
    const inputs = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) inputs.set(randomUnit(next), i * 3)
    const [tile, gutter, columns, rows] = [512, 1, 3, 2]
    const out = await run(count, inputs, 3, 2, (read, write) => {
      const uv = cubeAtlasUv(
        vec3(read(0), read(1), read(2)),
        tile,
        gutter,
        columns,
        rows,
      )
      write(0, uv.x)
      write(1, uv.y)
    })
    for (let i = 0; i < count; i += 1) {
      const d = [
        inputs[i * 3]!,
        inputs[i * 3 + 1]!,
        inputs[i * 3 + 2]!,
      ] as const
      const [ax, ay, az] = d.map(Math.abs) as [number, number, number]
      const face =
        ax >= ay && ax >= az
          ? d[0] >= 0
            ? 0
            : 1
          : ay >= az
            ? d[1] >= 0
              ? 2
              : 3
            : d[2] >= 0
              ? 4
              : 5
      const axes = CUBE_FACES[face]!
      const toArray = (v: { x: number; y: number; z: number }) =>
        [v.x, v.y, v.z] as const
      const depth = dot3(d, toArray(axes.normal))
      const a = (4 / Math.PI) * Math.atan(dot3(d, toArray(axes.a)) / depth)
      const b = (4 / Math.PI) * Math.atan(dot3(d, toArray(axes.b)) / depth)
      const span = tile + 2 * gutter
      const u =
        ((face % columns) * span + gutter + ((a + 1) / 2) * tile) /
        (columns * span)
      const v =
        (Math.floor(face / columns) * span + gutter + ((b + 1) / 2) * tile) /
        (rows * span)
      expect(Math.abs(out[i * 2]! - u), `direction ${i}`).toBeLessThan(2e-6)
      expect(Math.abs(out[i * 2 + 1]! - v), `direction ${i}`).toBeLessThan(2e-6)
    }
  })
})

describe('the shared nodes', () => {
  it('finiteOr passes every finite value and replaces a NaN or an infinity in any component', async () => {
    const values = [
      [1, 2, 3, 4],
      [-0, 1e-45, 3.4028234e38, -3.4028234e38],
      [Number.NaN, 0, 0, 0],
      [0, Infinity, 0, 0],
      [0, 0, -Infinity, 0],
      [0, 0, 0, Number.NaN],
    ]
    const out = await run(
      values.length,
      new Float32Array(values.flat()),
      4,
      4,
      (read, write) => {
        const kept = finiteOr(
          vec4(read(0), read(1), read(2), read(3)),
          vec4(7, 7, 7, 7),
        )
        write(0, kept.x)
        write(1, kept.y)
        write(2, kept.z)
        write(3, kept.w)
      },
    )
    expect([...out.subarray(0, 8)]).toEqual([
      1,
      2,
      3,
      4,
      -0,
      f32(1e-45),
      f32(3.4028234e38),
      f32(-3.4028234e38),
    ])
    for (let k = 2; k < values.length; k += 1)
      expect([...out.subarray(k * 4, k * 4 + 4)]).toEqual([7, 7, 7, 7])
  })

  it('traceJitter is in [0, 1), fixed by its frame, and still exact two billion frames in', async () => {
    const side = 16
    const frames = [0, 1, 2 ** 31 + 7]
    const count = side * side * frames.length
    const inputs = new Float32Array(count)
    const out = await run(count, inputs, 1, 2, (_read, write) => {
      const pixelIndex = instanceIndex.mod(uint(side * side))
      const frameSlot = instanceIndex.div(uint(side * side))
      const frame = frameSlot
        .equal(uint(0))
        .select(
          uint(frames[0]!),
          frameSlot.equal(uint(1)).select(uint(frames[1]!), uint(frames[2]!)),
        )
      const jitter = traceJitter(
        uvec2(pixelIndex.mod(uint(side)), pixelIndex.div(uint(side))),
        frame,
      )
      write(0, jitter.x)
      write(1, jitter.y)
    })
    for (const value of out) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
    const at = (slot: number, pixel: number, k: number) =>
      out[(slot * side * side + pixel) * 2 + k]!
    let moved = 0
    let mean = 0
    for (let p = 0; p < side * side; p += 1) {
      if (at(1, p, 0) !== at(0, p, 0)) moved += 1
      mean += at(0, p, 0) / (side * side)
      // The R1 offset is the u32 product's top 24 bits: exact at any frame.
      const step =
        Number(((BigInt(frames[2]!) * 2654435769n) % 2n ** 32n) >> 8n) / 2 ** 24
      const expected = (at(0, p, 0) + step) % 1
      const wrapped = Math.abs(at(2, p, 0) - expected)
      expect(Math.min(wrapped, 1 - wrapped)).toBeLessThan(2e-7)
    }
    expect(moved).toBe(side * side)
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.05)
  })

  it('slabMedium holds its slabs by altitude, the first winning, and nothing outside them', async () => {
    const heights = [500, 1000, 1500, 2399, 2400, 5000, 9000, 9999.5]
    const medium = slabMedium([
      { base: 1000, top: 2400, sigma: 0.068, radius: 8 },
      { base: 2000, top: 3000, sigma: 1 },
      { base: 9000, top: 10_000, sigma: 0.0002, fraction: 0.5, radius: 32 },
    ])
    const out = await run(
      heights.length,
      new Float32Array(heights),
      1,
      4,
      (read, write) => {
        const sample = { altitude: read(0) } as never
        const m = medium(sample, {} as never)
        write(0, m.sigma)
        write(1, m.fraction)
        write(2, float(m.layer))
        write(3, m.radius)
      },
    )
    const rows = heights.map((_, i) => [...out.subarray(i * 4, i * 4 + 4)])
    expect(rows).toEqual([
      [0, 0, -1, 10],
      [f32(0.068), 1, 0, 8],
      [f32(0.068), 1, 0, 8],
      [f32(0.068), 1, 0, 8],
      [1, 1, 1, 10],
      [0, 0, -1, 10],
      [f32(0.0002), 0.5, 2, 32],
      [f32(0.0002), 0.5, 2, 32],
    ])
  })
})
