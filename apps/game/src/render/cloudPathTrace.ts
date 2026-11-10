import {
  type ComputeNode,
  type Node,
  StorageBufferAttribute,
  Vector3,
} from 'three/webgpu'
import {
  Break,
  float,
  floor,
  Fn,
  If,
  instanceIndex,
  int,
  ivec3,
  log,
  Loop,
  max,
  min,
  sign,
  sqrt,
  storage,
  uint,
  uniform,
  vec3,
  vec4,
  wgslFn,
} from 'three/tsl'
import { deriveSeed, type Seed } from '@inertialref/procedural'
import {
  PHASE_CONE_NODE,
  PHASE_NODE,
  phaseConeReach,
  TRACE_BRICK,
  type TraceMedium,
  type TracePhase,
} from '@inertialref/rendering'

/*
 * The WebGPU path tracer: the float64 tracer's walk
 * (`apps/ingest/src/transport/pathTrace.ts`) as a compute kernel, a pixel a
 * thread. It is imported by its test alone. What it shares with the CPU
 * tier is in `@inertialref/rendering`'s `cumulusFixture.ts`: the medium's
 * cell coordinates, the bricks, the phase's sampled form and the cone about
 * the sun. What the estimator is, and why the sun's light is split between
 * a walk and its chains, is the CPU tier's header; this file says only what
 * a kernel changes.
 *
 * **A path is a state, and a dispatch advances it by a fixed count of
 * events.** A path through a cumulus's core scatters hundreds of times and
 * each scattering sends a shadow ray of a hundred steps, so a kernel that
 * ran a path to its end would run for seconds in one pass. Each thread
 * holds its path in a storage buffer (its ray, the shadow ray it is
 * waiting on, the chain it has out) and one dispatch is `events` steps of a
 * machine of five modes. A sample always runs to its end before the next
 * starts, however many dispatches that takes, so a long path is not
 * dropped for being long.
 *
 * **One event is one flight in one brick.** The mode says which ray it is
 * on: the walk's, a shadow ray's or a chain's. The flight either leaves the
 * brick, leaves the domain, or meets a tentative collision, and what
 * follows is the mode's. The CPU tier loops inside a brick; a thread cannot
 * hold a loop's state between dispatches, so the brick and the distance to
 * its face are found again each event from the point itself.
 *
 * **Float32.** A cell coordinate runs to 168 and resolves 1.5 × 10⁻⁵ of a
 * cell, so the nudge that puts a point on a brick's face into the brick
 * ahead is 10⁻³ of a cell where the CPU's is 10⁻⁷; the bricks' bound takes
 * one voxel more on every side for exactly this. A uniform draw keeps 24
 * bits, `(u32 >> 8)·2⁻²⁴`, because a `u32` converted whole rounds up to
 * one. A scattering angle is carried as `1 − cos` and `1 + cos`, never as
 * the cosine.
 *
 * **The stream is `xoshiro128**`'s,** one a pixel, seeded on the CPU by the
 * pixel's index and continued across its samples. The two tiers draw in
 * different orders, so they agree as two estimates of one radiance and not
 * sample for sample.
 */

type F = Node<'float'>
type I = Node<'int'>
type U4 = Node<'uvec4'>
type V3 = Node<'vec3'>
type V4 = Node<'vec4'>
type Bool = Node<'bool'>

const asF = (node: unknown): F => node as F
const asI = (node: unknown): I => node as I
const asV3 = (node: unknown): V3 => node as V3
const asV4 = (node: unknown): V4 => node as V4
const asBool = (node: unknown): Bool => node as Bool

type Triple = readonly [number, number, number]

export interface PathTraceScene {
  readonly medium: TraceMedium
  readonly phase: TracePhase
  /** The image's side: `pixels²` threads, `viewRay`'s rays. */
  readonly pixels: number
  /** Unit and toward the sun; a band's irradiance; the disk's angular radius, radians, or zero. */
  readonly sun: {
    readonly direction: Triple
    readonly irradiance: Triple
    readonly angularRadius: number
  } | null
  /** The sky's mean radiance and its two irradiance differences, per band. */
  readonly sky: {
    readonly mean: Triple
    readonly up: Triple
    readonly sunward: Triple
  }
  /** A Lambertian ground: its height, meters from the grid's low corner, and its albedo. */
  readonly ground: { readonly height: number; readonly albedo: number } | null
  /** Scatterings a path may make; `Infinity` for every order. */
  readonly orders: number
  /** Samples a pixel takes in each band before its thread idles. */
  readonly samples: number
  readonly seed: Seed
}

/** Vec4 slots a thread's path holds, and a pixel's sums. */
const STATE = 8
const SUMS = 3

const START = 0
const WALK = 1
const SHADOW = 2
const CHAIN = 3
const DONE = 4

/** A cell coordinate's nudge along the ray: see the header on float32. */
const NUDGE = 1e-3
/** Below this a shadow ray's transmittance is dropped as zero, as on the CPU. */
const DARK = 1e-12
/** The CPU tier's cap on a path's scatterings. */
const MAX_SCATTERINGS = 1_000_000

/** `xoshiro128**`'s output for a state: `rotl(s1·5, 7)·9` (`packages/procedural/src/rng.ts`). */
const xoshiroValue = wgslFn(`
  fn xoshiroValue(s: vec4<u32>) -> u32 {
    let x = s.y * 5u;
    return ((x << 7u) | (x >> 25u)) * 9u;
  }
`)

/** The state after that output, in `Rng.nextUint32`'s order of lanes. */
const xoshiroStep = wgslFn(`
  fn xoshiroStep(s: vec4<u32>) -> vec4<u32> {
    let t = s.y << 9u;
    var r = s;
    r.z ^= r.x;
    r.w ^= r.y;
    r.y ^= r.z;
    r.x ^= r.w;
    r.z ^= t;
    r.w = (r.w << 11u) | (r.w >> 21u);
    return r;
  }
`)

/** The kernel's generator, for the test that holds it to `Rng`. */
export const pathTraceRandom = { value: xoshiroValue, step: xoshiroStep }

/**
 * A unit direction at `m = 1 − cos θ`, `s = 1 + cos θ` from `axis`, at
 * `azimuth` about it: the CPU tier's `turn`, in Duff et al.'s frame.
 */
const turnCode = wgslFn(`
  fn turnAbout(axis: vec3<f32>, m: f32, s: f32, azimuth: f32) -> vec3<f32> {
    let sgn = select(-1.0, 1.0, axis.z >= 0.0);
    let a = -1.0 / (sgn + axis.z);
    let b = axis.x * axis.y * a;
    let sine = sqrt(max(0.0, m * s));
    let cosine = 1.0 - m;
    let c = sine * cos(azimuth);
    let d = sine * sin(azimuth);
    let t1 = vec3<f32>(1.0 + sgn * axis.x * axis.x * a, sgn * b, -sgn * axis.x);
    let t2 = vec3<f32>(b, sgn + axis.y * axis.y * a, -axis.y);
    return normalize(t1 * c + t2 * d + axis * cosine);
  }
`)

/**
 * The index of an angle on the table's grid, from `m` and `s`:
 * `(n − 1)(2/π)·asin√(θ/π)` in the forward half and the same from the far
 * end in the backward, each by the half-angle, as `phaseDensity` has it.
 */
const angleIndexCode = wgslFn(`
  fn phaseAngleIndex(m: f32, s: f32, last: f32) -> f32 {
    let forward = m <= 1.0;
    let theta = 2.0 * asin(sqrt(clamp(select(s, m, forward) * 0.5, 0.0, 1.0)));
    let along = last * 0.6366197723675814 * asin(sqrt(theta * 0.3183098861837907));
    return select(last - along, along, forward);
  }
`)

/**
 * Where a ray meets the domain, as meters to its near and far faces: the
 * CPU tier's `enter`. A ray that never does returns a far under its near.
 * WGSL and a loop over the axes, because a TSL `select` on a vector of
 * conditions compiles to one branch on `all()` of them.
 */
const domainSpan = wgslFn(`
  fn domainSpan(at: vec3<f32>, along: vec3<f32>, high: vec3<f32>) -> vec2<f32> {
    var near = 0.0;
    var far = 1e30;
    for (var k = 0; k < 3; k++) {
      if (along[k] == 0.0) {
        if (at[k] < 0.0 || at[k] >= high[k]) {
          return vec2<f32>(1.0, 0.0);
        }
      } else {
        let t0 = -at[k] / along[k];
        let t1 = (high[k] - at[k]) / along[k];
        near = max(near, min(t0, t1));
        far = min(far, max(t0, t1));
      }
    }
    return vec2<f32>(near, far);
  }
`)

/** The meters from a point to the far face of its brick: the CPU tier's `reach`. */
const brickReach = wgslFn(`
  fn brickReach(at: vec3<f32>, along: vec3<f32>, brick: vec3<f32>) -> f32 {
    var t = 1e30;
    for (var k = 0; k < 3; k++) {
      if (along[k] != 0.0) {
        let face = (brick[k] + select(0.0, 1.0, along[k] > 0.0)) * ${TRACE_BRICK}.0;
        t = min(t, (face - at[k]) / along[k]);
      }
    }
    return max(t, 0.0);
  }
`)

export interface CloudPathTracer {
  /** One dispatch: `events` events of every thread's path. */
  readonly kernel: ComputeNode
  /**
   * Three vec4 a pixel: the bands' sums and the paths cut at the cap; the
   * sums of squares; the samples each band has finished.
   */
  readonly sums: StorageBufferAttribute
  readonly pixels: number
}

/** One sample's mean and standard error in a band, as the CPU tier's `estimateOf` gives them. */
export interface PathTraceEstimate {
  readonly mean: Triple
  readonly error: Triple
  readonly samples: number
  readonly truncated: number
}

/** A pixel's estimate from a readback of `sums`. */
export function pathTraceEstimate(
  sums: Float32Array,
  pixel: number,
): PathTraceEstimate {
  const at = pixel * SUMS * 4
  const band = (b: number): readonly [number, number] => {
    const n = sums[at + 8 + b]!
    const mean = n > 0 ? sums[at + b]! / n : 0
    const variance =
      n > 1
        ? Math.max(0, sums[at + 4 + b]! / n - mean * mean) * (n / (n - 1))
        : 0
    return [mean, Math.sqrt(variance / Math.max(n, 1))]
  }
  const bands = [band(0), band(1), band(2)]
  return {
    mean: [bands[0]![0], bands[1]![0], bands[2]![0]],
    error: [bands[0]![1], bands[1]![1], bands[2]![1]],
    samples: sums[at + 10]!,
    truncated: sums[at + 3]!,
  }
}

/** Whether every pixel of a readback has finished its samples. */
export function pathTraceDone(sums: Float32Array, samples: number): boolean {
  for (let at = 10; at < sums.length; at += SUMS * 4)
    if (sums[at]! < samples) return false
  return true
}

/**
 * A tracer of one scene, at `events` events a dispatch. Its buffers are
 * the scene's, uploaded once: the voxels, the bricks' bounds and the
 * phase's nodes as float32.
 */
export function createCloudPathTracer(
  scene: PathTraceScene,
  events: number,
): CloudPathTracer {
  const { medium, phase } = scene
  const threads = scene.pixels * scene.pixels
  const [nx, ny, nz] = medium.size
  const [bx, by, bz] = medium.bricks
  const voxelCount = nx * ny * nz
  const nodeCount = phase.rows * 3 * phase.angles
  const angles = phase.angles
  const half = angles / 2

  const voxels = storage(
    new StorageBufferAttribute(medium.voxels, 2),
    'vec2',
    voxelCount,
  ).toReadOnly()
  const bounds = storage(
    new StorageBufferAttribute(medium.majorant, 1),
    'float',
    bx * by * bz,
  ).toReadOnly()
  const nodes = storage(
    new StorageBufferAttribute(Float32Array.from(phase.nodes), PHASE_NODE),
    'vec4',
    nodeCount,
  ).toReadOnly()
  const seeds = new Uint32Array(threads * 4)
  for (let pixel = 0; pixel < threads; pixel += 1) {
    const { a, b, c, d } = deriveSeed(scene.seed, `gpu:${pixel}`)
    seeds.set([a, b, c, d], pixel * 4)
  }
  const streams = storage(
    new StorageBufferAttribute(seeds, 4),
    'uvec4',
    threads,
  )
  const states = storage(
    new StorageBufferAttribute(new Float32Array(threads * STATE * 4), 4),
    'vec4',
    threads * STATE,
  )
  const sumsAttribute = new StorageBufferAttribute(
    new Float32Array(threads * SUMS * 4),
    4,
  )
  const sums = storage(sumsAttribute, 'vec4', threads * SUMS)

  // The scene, as constants of the graph: a tracer is one scene's.
  const cell = vec3(...medium.cell)
  const size = ivec3(nx, ny, nz)
  const high = vec3(bx * TRACE_BRICK, by * TRACE_BRICK, bz * TRACE_BRICK)
  const width = nx * medium.cell[0]
  const height = ny * medium.cell[1]
  const side = Math.max(width, height)
  const sunOn = scene.sun !== null && scene.sun.irradiance.some((e) => e > 0)
  const sunDirection = scene.sun?.direction ?? ([0, 1, 0] as const)
  const sunAxis = uniform(new Vector3(...sunDirection))
  const flat = Math.hypot(sunDirection[0], sunDirection[2])
  const sunward = vec3(
    flat > 0 ? sunDirection[0] / flat : 0,
    0,
    flat > 0 ? sunDirection[2] / flat : 0,
  )
  const irradiance = vec3(...(scene.sun?.irradiance ?? [0, 0, 0]))
  const diskReach = float(
    scene.sun === null ? 0 : 2 * Math.sin(scene.sun.angularRadius / 2) ** 2,
  )
  const coneReach = float(phaseConeReach(phase))
  const orders = float(Math.min(scene.orders, 2 * MAX_SCATTERINGS))
  const samples = float(scene.samples)
  const groundOn = scene.ground !== null
  const albedo = float(scene.ground?.albedo ?? 0)
  const groundHeight = float(scene.ground?.height ?? 0)

  const kernel = Fn(() => {
    const thread = instanceIndex
    const slot = (k: number) => states.element(thread.mul(STATE).add(k))
    const tally = (k: number) => sums.element(thread.mul(SUMS).add(k))

    const s0 = asV4(slot(0)).toVar()
    const s1 = asV4(slot(1)).toVar()
    const s2 = asV4(slot(2)).toVar()
    const s3 = asV4(slot(3)).toVar()
    const s4 = asV4(slot(4)).toVar()
    const s5 = asV4(slot(5)).toVar()
    const s6 = asV4(slot(6)).toVar()
    const s7 = asV4(slot(7)).toVar()
    const q = asV3(s0.xyz).toVar()
    const mode = asF(s0.w).toVar()
    const u = asV3(s1.xyz).toVar()
    const throughput = asF(s1.w).toVar()
    const light = asF(s2.x).toVar()
    const scatterings = asF(s2.y).toVar()
    const band = asF(s2.z).toVar()
    const after = asF(s2.w).toVar()
    const chainAt = asV3(s3.xyz).toVar()
    const chainWeight = asF(s3.w).toVar()
    const chainAlong = asV3(s4.xyz).toVar()
    const chainLevel = asF(s4.w).toVar()
    const chainOrder = asF(s5.x).toVar()
    const shadowAt = asV3(s6.xyz).toVar()
    const pending = asF(s6.w).toVar()
    const shadowAlong = asV3(s7.xyz).toVar()
    const transmittance = asF(s7.w).toVar()
    const stream = (streams.element(thread) as unknown as U4).toVar()
    const total = asV4(tally(0)).toVar()
    const squares = asV4(tally(1)).toVar()
    const counts = asV4(tally(2)).toVar()

    /** A uniform draw in [0, 1), 24 bits. */
    const draw = (): F => {
      const value = asF(
        float(
          (xoshiroValue({ s: stream }) as unknown as Node<'uint'>).shiftRight(
            uint(8),
          ),
        ).mul(2 ** -24),
      ).toVar()
      stream.assign(xoshiroStep({ s: stream }) as unknown as U4)
      return value
    }

    const turn = (axis: V3, m: F, s: F, azimuth: F): V3 =>
      asV3(turnCode({ axis, m, s, azimuth }))
    const fromSun = (direction: V3): F => {
      const off = direction.sub(sunAxis)
      return asF(off.dot(off).mul(0.5))
    }

    /** The medium at a point in cells: its extinction and the radius of what scatters there. */
    const mediumAt = (point: V3): { sigma: F; radius: F } => {
      const cellOf = floor(point)
      const share = point.sub(cellOf)
      const corner = ivec3(cellOf).sub(1)
      const sigma = float(0).toVar()
      const weighted = float(0).toVar()
      for (let dy = 0; dy < 2; dy += 1)
        for (let dz = 0; dz < 2; dz += 1)
          for (let dx = 0; dx < 2; dx += 1) {
            const at = corner.add(ivec3(dx, dy, dz))
            const within = at.x
              .greaterThanEqual(0)
              .and(at.y.greaterThanEqual(0))
              .and(at.z.greaterThanEqual(0))
              .and(at.x.lessThan(size.x))
              .and(at.y.lessThan(size.y))
              .and(at.z.lessThan(size.z))
            // A corner outside the grid reads voxel 0 and weighs nothing.
            const voxel = voxels.element(
              within.select(at.y.mul(nz).add(at.z).mul(nx).add(at.x), int(0)),
            ) as unknown as Node<'vec2'>
            const wx = dx === 1 ? share.x : float(1).sub(share.x)
            const wy = dy === 1 ? share.y : float(1).sub(share.y)
            const wz = dz === 1 ? share.z : float(1).sub(share.z)
            const part = asF(
              within.select(wx.mul(wy).mul(wz).mul(voxel.x), float(0)),
            ).toVar()
            sigma.addAssign(part)
            weighted.addAssign(part.mul(voxel.y))
          }
      return {
        sigma,
        radius: asF(
          sigma.greaterThan(0).select(weighted.div(max(sigma, 1e-30)), 0),
        ),
      }
    }

    /** The node a row and band start at. */
    const nodeAt = (row: I, bandIndex: I): I =>
      asI(row.mul(3).add(bandIndex).mul(angles))
    const nodeOf = (at: I, i: I): V4 => asV4(nodes.element(at.add(i))).toVar()
    /** The cosine's fall across the interval from node `i`, and the coordinate it is measured in. */
    const interval = (a: V4, b: V4, i: I) => {
      const forward = i.add(1).lessThan(half)
      const backFrom = asF(i.lessThan(half).select(float(2).sub(a.z), a.z))
      return {
        forward,
        backFrom,
        width: asF(forward.select(b.z.sub(a.z), backFrom.sub(b.z))),
      }
    }

    /** A row's density at an angle: `phaseDensity`. */
    const density = (at: I, m: F, s: F): F => {
      const index = asF(angleIndexCode({ m, s, last: float(angles - 1) }))
      const i = asI(int(index.clamp(0, angles - 2))).toVar()
      const a = nodeOf(at, i)
      const b = nodeOf(at, asI(i.add(1)))
      const { forward, backFrom, width: w } = interval(a, b, i)
      const t = asF(
        forward.select(m.sub(a.z), backFrom.sub(s)).div(max(w, 1e-37)),
      ).clamp(0, 1)
      return asF(a.x.add(b.x.sub(a.x).mul(t))).toVar()
    }
    /** The blend of two rows' density. */
    const blend = (row: I, share: F, bandIndex: I, m: F, s: F): F => {
      const low = density(nodeAt(row, bandIndex), m, s)
      const upper = density(nodeAt(asI(row.add(1)), bandIndex), m, s)
      return asF(low.add(upper.sub(low).mul(share))).toVar()
    }

    /** An angle drawn from a row for `value` in [0, 1): `phaseSample`'s `(m, s, density)`. */
    const sample = (name: string, at: I, value: F): V3 => {
      const low = int(0).toVar()
      const top = int(angles - 1).toVar()
      Loop(
        { start: 0, end: 10, type: 'int', condition: '<', name } as never,
        () => {
          const middle = asI(low.add(top).shiftRight(int(1)))
          If(asV4(nodes.element(at.add(middle))).y.lessThanEqual(value), () => {
            low.assign(middle)
          }).Else(() => {
            top.assign(middle)
          })
        },
      )
      const a = nodeOf(at, low)
      const b = nodeOf(at, asI(low.add(1)))
      const { forward, backFrom, width: w } = interval(a, b, low)
      const slope = b.x.sub(a.x)
      const c = asF(max(value.sub(a.y), 0).div(w.mul(2 * Math.PI)))
      const root = asF(
        a.x.add(sqrt(max(a.x.mul(a.x).add(slope.mul(c).mul(2)), 0))),
      )
      const t = asF(
        root.greaterThan(0).select(min(c.mul(2).div(max(root, 1e-37)), 1), 0),
      ).toVar()
      const m = asF(
        forward.select(a.z.add(t.mul(w)), float(2).sub(backFrom.sub(t.mul(w)))),
      )
      const s = asF(
        forward.select(float(2).sub(a.z.add(t.mul(w))), backFrom.sub(t.mul(w))),
      )
      return asV3(vec3(m, s, a.x.add(slope.mul(t)))).toVar()
    }

    /** The lower row a radius blends and the share of the one above: `phaseRow`. */
    const rowOf = (radius: F): { row: I; share: F } => {
      const index = asF(
        log(max(radius, 1e-30).div(phase.radiusMin))
          .mul((phase.rows - 1) / Math.log(phase.radiusMax / phase.radiusMin))
          .clamp(0, phase.rows - 1),
      ).toVar()
      const row = asI(int(min(floor(index), phase.rows - 2))).toVar()
      return { row, share: asF(index.sub(float(row))).toVar() }
    }

    /** A point of the sun's disk: the axis itself for a point sun. */
    const drawSun = (): V3 => {
      const m = asF(draw().mul(diskReach)).toVar()
      const azimuth = asF(draw().mul(2 * Math.PI))
      return asV3(turn(sunAxis, m, asF(float(2).sub(m)), azimuth)).toVar()
    }
    /** A direction in the cone by a row's phase laid about the sun, and its density. */
    const drawCone = (name: string, at: I): { direction: V3; lobe: F } => {
      const coneShare = asV4(nodes.element(at.add(PHASE_CONE_NODE))).y
      const drawn = sample(name, at, asF(draw().mul(coneShare)))
      const azimuth = asF(draw().mul(2 * Math.PI))
      return {
        direction: asV3(
          turn(sunAxis, asF(drawn.x), asF(drawn.y), azimuth),
        ).toVar(),
        lobe: asF(drawn.z.div(max(coneShare, 1e-37))).toVar(),
      }
    }
    /** `1 − cos` and `1 + cos` between two unit directions. */
    const between = (a: V3, b: V3): { m: F; s: F } => {
      const off = a.sub(b)
      const on = a.add(b)
      return { m: asF(off.dot(off).mul(0.5)), s: asF(on.dot(on).mul(0.5)) }
    }

    // The band's index and its mask, set at the top of each event: an
    // expression over `band` left to the builder is computed where it is
    // first used and not again when the band moves on.
    const bandIndex = int(0).toVar()
    const bandMask = vec3(1, 0, 0).toVar()
    const pick = (values: V3): F => asF(values.dot(bandMask))
    const sky = (direction: V3): F =>
      asF(
        pick(vec3(...scene.sky.mean)).mul(
          max(
            float(1).add(
              pick(vec3(...scene.sky.up))
                .mul(direction.y)
                .add(
                  pick(vec3(...scene.sky.sunward)).mul(direction.dot(sunward)),
                )
                .mul(0.75),
            ),
            0,
          ),
        ),
      )

    Loop(
      {
        start: 0,
        end: events,
        type: 'int',
        condition: '<',
        name: 'event',
      } as never,
      () => {
        If(mode.equal(DONE), () => {
          Break()
        })
        If(mode.equal(START), () => {
          If(counts.z.greaterThanEqual(samples), () => {
            mode.assign(DONE)
          }).Else(() => {
            // `viewRay`: a square image over the grid's east and up, row 0 at
            // the top, every ray north from south of the grid.
            const px = float(thread.mod(uint(scene.pixels)))
            const py = float(thread.div(uint(scene.pixels)))
            q.assign(
              vec3(
                px
                  .add(0.5)
                  .div(scene.pixels)
                  .sub(0.5)
                  .mul(side)
                  .add(width / 2),
                float(0.5)
                  .sub(py.add(0.5).div(scene.pixels))
                  .mul(side)
                  .add(height / 2),
                float(-medium.cell[2]),
              )
                .div(cell)
                .add(0.5),
            )
            u.assign(vec3(0, 0, 1))
            throughput.assign(1)
            light.assign(0)
            scatterings.assign(0)
            mode.assign(WALK)
            if (sunOn)
              // An eye that looks into the cone starts a run of its own.
              If(fromSun(u).lessThan(coneReach), () => {
                chainAt.assign(q)
                chainAlong.assign(u)
                chainWeight.assign(1)
                chainLevel.assign(-1)
                chainOrder.assign(0)
                mode.assign(CHAIN)
              })
          })
        }).ElseIf(mode.notEqual(DONE), () => {
          bandIndex.assign(int(band))
          bandMask.assign(
            vec3(
              float(band.equal(0)),
              float(band.equal(1)),
              float(band.equal(2)),
            ),
          )
          // The ray this event is on, held: the mode changes before the
          // event is over.
          const onShadow = asBool(asBool(mode.equal(SHADOW)).toVar())
          const onChain = asBool(asBool(mode.equal(CHAIN)).toVar())
          const at = asV3(
            onShadow.select(shadowAt, onChain.select(chainAt, q)),
          ).toVar()
          const along = asV3(
            onShadow.select(shadowAlong, onChain.select(chainAlong, u)),
          ).toVar()
          const step = asV3(along.div(cell)).toVar()
          const ahead = asV3(sign(step).mul(NUDGE))
          const hit = float(0).toVar()
          const left = float(0).toVar()
          const sigma = float(0).toVar()
          const radius = float(0).toVar()
          const inDomain = (point: V3): Bool => {
            const nudged = point.add(ahead)
            return asBool(
              nudged.x
                .greaterThanEqual(0)
                .and(nudged.y.greaterThanEqual(0))
                .and(nudged.z.greaterThanEqual(0))
                .and(nudged.x.lessThan(high.x))
                .and(nudged.y.lessThan(high.y))
                .and(nudged.z.lessThan(high.z)),
            )
          }
          If(inDomain(at).not(), () => {
            // Outside: to where the ray enters the domain, or gone.
            const span = (
              domainSpan({ at, along: step, high }) as unknown as Node<'vec2'>
            ).toVar()
            If(span.y.greaterThan(span.x), () => {
              at.addAssign(step.mul(span.x))
              If(inDomain(at).not(), () => {
                left.assign(1)
              })
            }).Else(() => {
              left.assign(1)
            })
          }).Else(() => {
            const brick = floor(at.add(ahead).div(TRACE_BRICK))
            const bound = asF(
              bounds.element(
                int(brick.y)
                  .mul(bz)
                  .add(int(brick.z))
                  .mul(bx)
                  .add(int(brick.x)),
              ),
            ).toVar()
            const exit = asF(brickReach({ at, along: step, brick })).toVar()
            If(bound.greaterThan(0), () => {
              const flight = asF(
                log(float(1).sub(draw())).negate().div(bound),
              ).toVar()
              If(flight.lessThan(exit), () => {
                at.addAssign(step.mul(flight))
                const there = mediumAt(at)
                sigma.assign(there.sigma)
                radius.assign(there.radius)
                If(onShadow, () => {
                  transmittance.mulAssign(float(1).sub(sigma.div(bound)))
                }).ElseIf(draw().mul(bound).lessThan(sigma), () => {
                  hit.assign(1)
                })
              }).Else(() => {
                at.addAssign(step.mul(exit))
              })
            }).Else(() => {
              at.addAssign(step.mul(exit))
            })
          })
          If(onShadow, () => {
            shadowAt.assign(at)
          })
            .ElseIf(onChain, () => {
              chainAt.assign(at)
            })
            .Else(() => {
              q.assign(at)
            })

          const finished = float(0).toVar()
          If(onShadow, () => {
            If(left.equal(1).or(transmittance.lessThan(DARK)), () => {
              If(left.equal(1), () => {
                light.addAssign(pending.mul(transmittance))
              })
              mode.assign(after)
            })
          })
            .ElseIf(left.equal(1), () => {
              If(onChain, () => {
                mode.assign(WALK)
              }).Else(() => {
                const bounce = groundOn ? u.y.lessThan(0) : null
                const toSky = (): void => {
                  light.addAssign(throughput.mul(sky(u)))
                  finished.assign(1)
                }
                if (bounce === null) toSky()
                else
                  If(bounce, () => {
                    // The ground, under the medium: a Lambertian bounce.
                    const drop = asF(
                      groundHeight.sub(q.y.sub(0.5).mul(cell.y)).div(u.y),
                    )
                    q.addAssign(u.div(cell).mul(drop))
                    const next = float(WALK).toVar()
                    const owed = float(0).toVar()
                    if (sunOn) {
                      const toSun = drawSun()
                      If(toSun.y.greaterThan(0), () => {
                        owed.assign(
                          throughput
                            .mul(albedo)
                            .mul(toSun.y.div(Math.PI))
                            .mul(pick(irradiance)),
                        )
                        shadowAt.assign(q)
                        shadowAlong.assign(toSun)
                        transmittance.assign(1)
                      })
                      const cone = drawCone(
                        'ground',
                        nodeAt(int(phase.rows >> 1), bandIndex),
                      )
                      If(cone.direction.y.greaterThan(0), () => {
                        const reward = asF(
                          albedo.mul(cone.direction.y).div(Math.PI),
                        )
                        chainAt.assign(q)
                        chainAlong.assign(cone.direction)
                        chainLevel.assign(reward)
                        chainWeight.assign(reward.div(max(cone.lobe, 1e-37)))
                        chainOrder.assign(scatterings)
                        next.assign(CHAIN)
                      })
                    }
                    throughput.mulAssign(albedo)
                    const lift = draw()
                    const azimuth = asF(draw().mul(2 * Math.PI))
                    const level = sqrt(float(1).sub(lift))
                    u.assign(
                      vec3(
                        level.mul(azimuth.cos()),
                        sqrt(lift),
                        level.mul(azimuth.sin()),
                      ),
                    )
                    If(owed.greaterThan(0), () => {
                      pending.assign(owed)
                      after.assign(next)
                      mode.assign(SHADOW)
                    }).Else(() => {
                      mode.assign(next)
                    })
                  }).Else(toSky)
              })
            })
            .ElseIf(hit.equal(1), () => {
              // A scattering, with the medium there in `sigma` and `radius`.
              If(onChain, () => {
                chainOrder.addAssign(1)
              })
              const over = asBool(
                onChain.select(
                  chainOrder.greaterThan(orders),
                  scatterings.greaterThanEqual(orders),
                ),
              )
              If(over, () => {
                If(onChain, () => {
                  mode.assign(WALK)
                }).Else(() => {
                  finished.assign(1)
                })
              })
                .ElseIf(
                  onChain
                    .not()
                    .and(scatterings.greaterThanEqual(MAX_SCATTERINGS)),
                  () => {
                    total.assign(vec4(total.xyz, total.w.add(1)))
                    finished.assign(1)
                  },
                )
                .Else(() => {
                  If(onChain.not(), () => {
                    scatterings.addAssign(1)
                  })
                  const { row, share } = rowOf(radius)
                  const next = float(WALK).toVar()
                  const owed = float(0).toVar()
                  if (sunOn)
                    // Under the cone's split a vertex the walk reached along
                    // the cone is a chain's to light, and a chain's own
                    // vertices are always lit.
                    If(
                      onChain.or(fromSun(along).greaterThanEqual(coneReach)),
                      () => {
                        const toSun = drawSun()
                        const angle = between(along, toSun)
                        const scattered = blend(
                          row,
                          share,
                          bandIndex,
                          angle.m,
                          angle.s,
                        )
                        const open = groundOn
                          ? scattered.greaterThan(0).and(toSun.y.greaterThan(0))
                          : scattered.greaterThan(0)
                        If(open, () => {
                          owed.assign(
                            throughput
                              .mul(pick(irradiance))
                              .mul(scattered)
                              .mul(onChain.select(chainWeight, 1)),
                          )
                          shadowAt.assign(at)
                          shadowAlong.assign(toSun)
                          transmittance.assign(1)
                        })
                        // The chain's next direction: two candidates, by the
                        // phase about the ray and by the phase about the sun,
                        // each weighed by the balance of the two densities, and
                        // one of them chosen by what it is worth.
                        const lower = nodeAt(row, bandIndex)
                        const coneShare = asV4(
                          nodes.element(lower.add(PHASE_CONE_NODE)),
                        ).y
                        const upper = asBool(draw().lessThan(share))
                        const ownNode = nodeAt(
                          asI(row.add(int(upper))),
                          bandIndex,
                        )
                        const otherNode = nodeAt(
                          asI(row.add(int(upper.not()))),
                          bandIndex,
                        )
                        const drawn = sample('own', ownNode, draw())
                        const other = density(
                          otherNode,
                          asF(drawn.x),
                          asF(drawn.y),
                        )
                        const own = asF(
                          upper.select(
                            other.add(drawn.z.sub(other).mul(share)),
                            drawn.z.add(other.sub(drawn.z).mul(share)),
                          ),
                        )
                        const ownWay = asV3(
                          turn(
                            along,
                            asF(drawn.x),
                            asF(drawn.y),
                            asF(draw().mul(2 * Math.PI)),
                          ),
                        ).toVar()
                        const ownOff = asF(fromSun(ownWay)).toVar()
                        const about = asF(
                          ownOff
                            .lessThan(coneReach)
                            .select(
                              density(
                                lower,
                                ownOff,
                                asF(float(2).sub(ownOff)),
                              ).div(max(coneShare, 1e-37)),
                              0,
                            ),
                        ).toVar()
                        const first = asF(
                          about
                            .greaterThan(0)
                            .select(
                              own.div(max(own.add(about), 1e-37)).mul(about),
                              0,
                            ),
                        ).toVar()
                        const cone = drawCone('cone', lower)
                        const coneAngle = between(along, cone.direction)
                        const through = blend(
                          row,
                          share,
                          bandIndex,
                          coneAngle.m,
                          coneAngle.s,
                        )
                        const second = asF(
                          through
                            .div(max(through.add(cone.lobe), 1e-37))
                            .mul(cone.lobe),
                        ).toVar()
                        const worth = asF(first.add(second)).toVar()
                        If(worth.greaterThan(0), () => {
                          const takeOwn = asBool(
                            draw().mul(worth).lessThan(first),
                          )
                          const chosen = asF(takeOwn.select(about, cone.lobe))
                          const weight = asF(
                            onChain
                              .select(chainWeight, 1)
                              .mul(worth)
                              .div(max(chosen, 1e-37)),
                          ).toVar()
                          const reward = asF(weight.mul(chosen)).toVar()
                          const level = asF(onChain.select(chainLevel, -1))
                          // A chain whose terms have shrunk goes on with the
                          // chance they shrank by, at the size they were.
                          const lives = float(1).toVar()
                          If(
                            level
                              .lessThan(0)
                              .or(reward.greaterThanEqual(level)),
                            () => {
                              chainLevel.assign(reward)
                            },
                          )
                            .ElseIf(draw().mul(level).lessThan(reward), () => {
                              weight.mulAssign(level.div(max(reward, 1e-37)))
                              chainLevel.assign(level)
                            })
                            .Else(() => {
                              lives.assign(0)
                            })
                          If(lives.equal(1), () => {
                            chainAlong.assign(
                              takeOwn.select(ownWay, cone.direction),
                            )
                            chainWeight.assign(weight)
                            If(onChain.not(), () => {
                              chainAt.assign(at)
                              chainOrder.assign(scatterings)
                            })
                            next.assign(CHAIN)
                          })
                        })
                      },
                    )
                  If(onChain.not(), () => {
                    // The walk's own new direction, analog.
                    const upper = asBool(draw().lessThan(share))
                    const drawn = sample(
                      'walk',
                      nodeAt(asI(row.add(int(upper))), bandIndex),
                      draw(),
                    )
                    u.assign(
                      turn(
                        along,
                        asF(drawn.x),
                        asF(drawn.y),
                        asF(draw().mul(2 * Math.PI)),
                      ),
                    )
                  })
                  If(owed.greaterThan(0), () => {
                    pending.assign(owed)
                    after.assign(next)
                    mode.assign(SHADOW)
                  }).Else(() => {
                    mode.assign(next)
                  })
                })
            })

          If(finished.equal(1), () => {
            total.assign(vec4(total.xyz.add(bandMask.mul(light)), total.w))
            squares.assign(
              vec4(squares.xyz.add(bandMask.mul(light.mul(light))), 0),
            )
            counts.assign(vec4(counts.xyz.add(bandMask), 0))
            band.assign(band.equal(2).select(0, band.add(1)))
            mode.assign(START)
          })
        })
      },
    )

    slot(0).assign(vec4(q, mode))
    slot(1).assign(vec4(u, throughput))
    slot(2).assign(vec4(light, scatterings, band, after))
    slot(3).assign(vec4(chainAt, chainWeight))
    slot(4).assign(vec4(chainAlong, chainLevel))
    slot(5).assign(vec4(chainOrder, 0, 0, 0))
    slot(6).assign(vec4(shadowAt, pending))
    slot(7).assign(vec4(shadowAlong, transmittance))
    streams.element(thread).assign(stream)
    tally(0).assign(total)
    tally(1).assign(squares)
    tally(2).assign(counts)
  })().compute(threads)

  return { kernel, sums: sumsAttribute, pixels: scene.pixels }
}
