import type { Data3DTexture, Node } from 'three/webgpu'
import {
  cos,
  dot,
  float,
  Fn,
  ivec3,
  length,
  max,
  min,
  mix,
  normalize,
  select,
  sin,
  texture3D,
  uint,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { NOISE_CELLS, NOISE_GRADIENT_SCALE } from './noiseTexture.ts'

/*
 * Noise as node graphs, shared by the ground and the sea.
 *
 * Every octave either material spends is a fetch of the noise baked into
 * `noiseTexture()`: one trilinear read where a lattice evaluation was eight
 * hashes and eight dot products, on a field that is periodic by
 * construction. The sub-meter bands need the periodicity — their domain is
 * a patch-local position offset by an origin reduced modulo the period on
 * the CPU, and two patches agree where they overlap only because the field
 * closes on it (`render/terrain.ts` § `GRAIN_PERIOD`) — and the coarse bands
 * get it for free.
 */

/**
 * The two node shapes the noise above passes around, and the two re-narrowings
 * that keep it readable.
 *
 * TSL's builders each return their own node class — `vec3()` a join, `.mul()` an
 * operator, `mix()` a math node — so an arithmetic chain changes type at every
 * step and a helper typed against one of them cannot be called with the result
 * of another. Every one of them is the same thing at runtime and generates the
 * same WGSL; the cast is a re-narrowing rather than a lie, and it is the same
 * one `sampled` in `render/terrain.ts` makes for the same reason.
 */
export type Vector = ReturnType<typeof vec3>
/** A value and its gradient, as one `vec4`: `x` the value, `yzw` the slope. */
export type Field = ReturnType<typeof vec4>
export const asVector = (node: unknown): Vector => node as Vector
export const asField = (node: unknown): Field => node as Field

/*
 * Where the typings are narrower than WGSL, and the two operations the
 * materials need from the gap. Each builds the same node the typed call
 * would; the cast is the whole of the difference. Augmenting the typings is
 * not an option — `Mix` and `MinMax` are interfaces the module does not
 * export — so the re-narrowing lives here, once, beside the others.
 */

/**
 * `mix` with one weight per channel. The typings admit only a scalar `t`;
 * WGSL's `mix(vec3, vec3, vec3)` is the operation a transmittance needs, one
 * weight per wavelength.
 */
export const mixPerChannel = (
  a: Node<'vec3'>,
  b: Node<'vec3'>,
  t: Node<'vec3'>,
): Node<'vec3'> => mix(a, b, t as unknown as Node<'float'>)

/** `max` on two ints. The typings admit floats and vectors alone; the int operator is the same node. */
export const maxInt = (a: Node<'int'>, b: Node<'int'>): Node<'int'> =>
  max(
    a as unknown as Node<'float'>,
    b as unknown as Node<'float'>,
  ) as unknown as Node<'int'>

/**
 * The baked noise as a node: one `texture3D` over `noiseTexture()`, made per
 * material because a texture node is a binding and a binding belongs to the
 * graph that reads it.
 */
export type NoiseSampler = ReturnType<typeof texture3D>
export const noiseSampler = (map: Data3DTexture): NoiseSampler => texture3D(map)

/**
 * One octave of the baked noise at `point`, in lattice cells: the value in
 * [-1, 1] in `x`, and its gradient with respect to `point` in `yzw`.
 *
 * The sampler wraps, so the division by the period is the whole of the
 * addressing: a coordinate of 40 cells is the same texel as one of 8.
 */
export function noiseFetch(sampler: NoiseSampler, point: Vector): Field {
  const uvw = asVector(point.mul(float(1 / NOISE_CELLS)))
  const texel = asField(sampler.sample(uvw))
  const unpacked = asField(texel.mul(2).sub(1))
  return asField(
    vec4(
      unpacked.x,
      unpacked.y.mul(NOISE_GRADIENT_SCALE),
      unpacked.z.mul(NOISE_GRADIENT_SCALE),
      unpacked.w.mul(NOISE_GRADIENT_SCALE),
    ),
  )
}

/**
 * Fractal noise from the baked texture: `octaves` fetches at doubling
 * frequency and halving amplitude, normalized to [-1, 1] — the value in `x`
 * and the gradient with respect to `point` in `yzw`, each octave's gradient
 * scaled by its frequency as the chain rule says. The replacement for
 * `mx_fractal_noise_float` and for a lattice fBm alike: eight hashes and
 * eight dot products an octave against one trilinear fetch, and a gradient
 * that costs nothing more.
 */
export function fbmFetch(
  sampler: NoiseSampler,
  point: Vector,
  octaves: number,
  lacunarity = 2,
  gain = 0.5,
): Field {
  let sum: Field = asField(vec4(0))
  let norm = 0
  let amplitude = 1
  let scale = 1
  for (let i = 0; i < octaves; i += 1) {
    const octave = noiseFetch(sampler, asVector(point.mul(float(scale))))
    sum = asField(
      sum.add(vec4(octave.x.mul(amplitude), octave.yzw.mul(amplitude * scale))),
    )
    norm += amplitude
    amplitude *= gain
    scale *= lacunarity
  }
  return asField(sum.mul(float(1 / norm)))
}

/**
 * A normal perturbed by a height field's gradient: the surface normal, less
 * the part of the gradient that lies in the tangent plane, renormalized.
 *
 * `gradient` is the slope of the height in meters per meter along each
 * body-fixed axis. Its tangential part is the slope of the height across
 * the surface, which is exactly what tilts the normal; its radial part is
 * the field changing with altitude, which a surface cannot see and which
 * the projection discards.
 */
export function bumped(normal: Vector, gradient: Vector): Vector {
  const along = asVector(gradient.sub(normal.mul(dot(gradient, normal))))
  return asVector(normalize(normal.sub(along)))
}

/* ------------------------------------------------------------------------ */
/* The unbounded lattice                                                      */
/* ------------------------------------------------------------------------ */

/*
 * Two bands may not repeat, so they are evaluated on the lattice rather than
 * fetched from the texture.
 *
 * Everything the texture holds closes on `NOISE_CELLS`, which is the point
 * of it for the sub-meter bands and the defect for a coarse one: an octave
 * fetched from it repeats every thirty-two of its own cells, and a band at
 * kilometers draws the same tile sixteen times across a frame seen from a
 * few hundred meters a pixel. The macro band and the gullies are evaluated
 * here instead — the texture's own construction, on a lattice with no
 * period — at the cost of the arithmetic the texture was baked to avoid,
 * which two octaves of a kilometer-scale band and two of the gullies can
 * afford where eight octaves over the whole ground could not.
 *
 * **The lattice coordinate arrives split.** `cell` is a whole lattice
 * point, exact in float32 because the caller forms it from integers — the
 * patch anchor's cell, found in float64 on the CPU, plus the `floor` of a
 * small offset — and `fraction` is the position inside it. A body-fixed
 * position divided by a wavelength in float32 resolves half a meter on Earth
 * before the division, which a kilometer octave survives and a gully does
 * not; and nothing here takes a `floor` of a planetary-sized number
 * (`render/terrain.ts` § the macro band).
 */

/** `gradientNoise`'s range scale; the two must agree. */
const LATTICE_SCALE = 1.06

/**
 * The cube-edge gradient `latticeHash` picks, built from the hash's bits.
 *
 * `LATTICE_GRADIENTS` in that order — a sign pair from the low two bits of
 * `h mod 12` and the zero axis from the rest — rather than read out of a
 * WGSL `array`. A constant array indexed by a runtime value is a stack
 * array on Metal: measured in the GPU harness, twenty-four evaluations a
 * pixel over a megapixel drew in 85 ms through the table and 19 ms through
 * this, against 24 ms for the same count of texture fetches, and the spill
 * slowed the whole ground material rather than the noise alone.
 */
const cornerGradient = /*@__PURE__*/ Fn(([h]: [Node<'uint'>]) => {
  const g = h.mod(uint(12))
  const first = float(g.bitAnd(uint(1)))
    .mul(-2)
    .add(1)
  const second = float(g.shiftRight(uint(1)).bitAnd(uint(1)))
    .mul(-2)
    .add(1)
  const zero = g.shiftRight(uint(2))
  return vec3(
    select(zero.equal(uint(2)), float(0), first),
    select(
      zero.equal(uint(0)),
      second,
      select(zero.equal(uint(2)), first, float(0)),
    ),
    select(zero.equal(uint(0)), float(0), second),
  )
}).setLayout({
  name: 'latticeGradient',
  type: 'vec3',
  inputs: [{ name: 'h', type: 'uint' }],
})

/** The finalizer `latticeHash` ends with, on a `u32`. */
const mix32 = /*@__PURE__*/ Fn(([v]: [Node<'uint'>]) => {
  const h = v.toVar()
  h.bitXorAssign(h.shiftRight(16))
  h.mulAssign(uint(0x85ebca6b))
  h.bitXorAssign(h.shiftRight(13))
  h.mulAssign(uint(0xc2b2ae35))
  h.bitXorAssign(h.shiftRight(16))
  return h
}).setLayout({
  name: 'latticeMix32',
  type: 'uint',
  inputs: [{ name: 'v', type: 'uint' }],
})

/** The quintic fade and its slope, per axis. */
const quintic = (t: Vector): Vector =>
  asVector(
    t
      .mul(t)
      .mul(t)
      .mul(t.mul(t.mul(6).sub(15)).add(10)),
  )
const quinticSlope = (t: Vector): Vector =>
  asVector(
    t
      .mul(t)
      .mul(30)
      .mul(t.mul(t.sub(2)).add(1)),
  )

/**
 * The hash of each of a cell's eight corners, as `latticeHash` computes it:
 * the three per-axis products are shared between the corners that share an
 * axis, which is six multiplies where eight corners spelled out would be
 * twenty-four.
 */
function cornerHashes(cell: Vector, seed: Node<'uint'>): Node<'uint'>[] {
  const whole = ivec3(cell)
  const axis = (k: Node<'int'>, offset: number, prime: number) =>
    uint(k.add(offset)).mul(uint(prime))
  const x = [axis(whole.x, 1, 0x9e3779b1), axis(whole.x, 2, 0x9e3779b1)]
  const y = [axis(whole.y, 1, 0x85ebca6b), axis(whole.y, 2, 0x85ebca6b)]
  const z = [axis(whole.z, 1, 0xc2b2ae35), axis(whole.z, 2, 0xc2b2ae35)]
  const out: Node<'uint'>[] = []
  for (let k = 0; k < 2; k += 1)
    for (let j = 0; j < 2; j += 1)
      for (let i = 0; i < 2; i += 1)
        out.push(mix32(x[i]!.bitXor(seed).bitXor(y[j]!).bitXor(z[k]!)))
  return out
}

/**
 * Gradient noise at `cell + fraction`, on a lattice that never repeats: the
 * value in `x`, in [-1, 1], and its gradient with respect to the lattice
 * coordinate in `yzw` — `gradientNoise` in `noiseTexture.ts` with no
 * period, which `noiseNodes.gpu.test.ts` holds it to. `cell` must hold
 * whole numbers.
 */
export const latticeNoise = /*@__PURE__*/ Fn(
  ([cell, fraction]: [Vector, Vector]) => {
    const corners = cornerHashes(cell, uint(0)).map((h) =>
      asVector(cornerGradient(h)),
    )
    const [g000, g100, g010, g110, g001, g101, g011, g111] = corners as [
      Vector,
      Vector,
      Vector,
      Vector,
      Vector,
      Vector,
      Vector,
      Vector,
    ]
    const f = fraction
    const u = quintic(f)
    const du = quinticSlope(f)
    const a = dot(g000, f)
    const b = dot(g100, f.sub(vec3(1, 0, 0)))
    const c = dot(g010, f.sub(vec3(0, 1, 0)))
    const d = dot(g110, f.sub(vec3(1, 1, 0)))
    const e = dot(g001, f.sub(vec3(0, 0, 1)))
    const ff = dot(g101, f.sub(vec3(1, 0, 1)))
    const g = dot(g011, f.sub(vec3(0, 1, 1)))
    const h = dot(g111, f.sub(vec3(1, 1, 1)))
    const k1 = b.sub(a)
    const k2 = c.sub(a)
    const k3 = e.sub(a)
    const k4 = a.sub(b).sub(c).add(d)
    const k5 = a.sub(b).sub(e).add(ff)
    const k6 = a.sub(c).sub(e).add(g)
    const k7 = b.add(c).sub(a).sub(d).add(e).sub(ff).sub(g).add(h)
    const uv = u.x.mul(u.y)
    const uw = u.x.mul(u.z)
    const vw = u.y.mul(u.z)
    const uvw = uv.mul(u.z)
    const value = a
      .add(k1.mul(u.x))
      .add(k2.mul(u.y))
      .add(k3.mul(u.z))
      .add(k4.mul(uv))
      .add(k5.mul(uw))
      .add(k6.mul(vw))
      .add(k7.mul(uvw))
    const lanes = g000
      .add(g100.sub(g000).mul(u.x))
      .add(g010.sub(g000).mul(u.y))
      .add(g001.sub(g000).mul(u.z))
      .add(g000.sub(g100).sub(g010).add(g110).mul(uv))
      .add(g000.sub(g100).sub(g001).add(g101).mul(uw))
      .add(g000.sub(g010).sub(g001).add(g011).mul(vw))
      .add(
        g100
          .add(g010)
          .add(g001)
          .add(g111)
          .sub(g000)
          .sub(g110)
          .sub(g101)
          .sub(g011)
          .mul(uvw),
      )
    const fades = vec3(
      du.x.mul(k1.add(k4.mul(u.y)).add(k5.mul(u.z)).add(k7.mul(vw))),
      du.y.mul(k2.add(k4.mul(u.x)).add(k6.mul(u.z)).add(k7.mul(uw))),
      du.z.mul(k3.add(k5.mul(u.x)).add(k6.mul(u.y)).add(k7.mul(uv))),
    )
    // The texture's scale: cube-edge noise peaks near ±0.94.
    return vec4(value, lanes.add(fades)).mul(LATTICE_SCALE)
  },
).setLayout({
  name: 'latticeNoise',
  type: 'vec4',
  inputs: [
    { name: 'cell', type: 'vec3' },
    { name: 'fraction', type: 'vec3' },
  ],
})

/**
 * Stripes running down a slope: a phasor field whose phase advances along
 * `across` — a unit vector in the tangent plane, square to the fall line —
 * and stays nearly constant down it, so its crests and troughs run downhill.
 *
 * The construction is the one Johansen's erosion filter and Grenier et al.'s
 * phasor ravines share. Each corner of the cell holds a wave along `across`
 * at `STRIPES_PER_CELL` cycles a cell with a phase of its own, from its
 * hash; the eight are blended by the same quintic weights the noise uses, as
 * phasors rather than as values. Blending the values of two misaligned waves
 * is a wave of smaller amplitude, which reads as gullies fading in and out
 * along their length; blending the phasors and renormalizing keeps the
 * stripe at full strength wherever the corners roughly agree, and the phase
 * jumps where they do not are where a gully ends or forks. The length is
 * renormalized by `2L` clamped at one rather than divided out, so a point
 * where the corners cancel fades to the midline instead of picking a phase
 * from noise.
 *
 * Returns the unit phasor `(cos θ, sin θ)`, shortened toward zero only where
 * the corners cancel. The gradient of `cos θ` is `−sin θ · 2π ·
 * STRIPES_PER_CELL · across` per cell, with the weights' own slope left out:
 * it is small against the wave's, and it is what makes a stripe bend rather
 * than what makes it a stripe.
 */
export const STRIPES_PER_CELL = 2

export const stripes = /*@__PURE__*/ Fn(
  ([cell, fraction, across, seed]: [Vector, Vector, Vector, Node<'uint'>]) => {
    const u = quintic(fraction)
    const hashes = cornerHashes(cell, seed)
    let sum: Node<'vec2'> = vec2(0, 0)
    for (let corner = 0; corner < 8; corner += 1) {
      const ox = corner & 1
      const oy = (corner >> 1) & 1
      const oz = (corner >> 2) & 1
      const weight = (ox === 1 ? u.x : u.x.oneMinus())
        .mul(oy === 1 ? u.y : u.y.oneMinus())
        .mul(oz === 1 ? u.z : u.z.oneMinus())
      // In turns: the wave's own advance, and the corner's offset from its hash.
      const turns = dot(fraction.sub(vec3(ox, oy, oz)), across)
        .mul(STRIPES_PER_CELL)
        .add(float(hashes[corner]!).mul(1 / 4294967296))
      const angle = turns.mul(2 * Math.PI)
      sum = sum.add(vec2(cos(angle), sin(angle)).mul(weight))
    }
    const reach = length(sum)
    return sum.mul(min(reach.mul(2), float(1)).div(max(reach, float(1e-4))))
  },
).setLayout({
  name: 'gullyStripes',
  type: 'vec2',
  inputs: [
    { name: 'cell', type: 'vec3' },
    { name: 'fraction', type: 'vec3' },
    { name: 'across', type: 'vec3' },
    { name: 'seed', type: 'uint' },
  ],
})
