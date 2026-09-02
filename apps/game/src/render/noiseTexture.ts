import {
  Data3DTexture,
  LinearFilter,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
} from 'three/webgpu'

/*
 * The detail noise, baked once into a tiling 3D texture.
 *
 * Every per-pixel octave the ground and the sea evaluate — the macro band on
 * the direction, the micro band on the patch, the grain, the swell and the
 * chop — is gradient noise on a lattice, and evaluating one octave is eight
 * lattice hashes, eight gradient dot products and a trilinear blend, per
 * pixel, per octave. At a retina size the ground is nine million pixels and
 * eight octaves, and that arithmetic was most of the frame: 25 ms of an
 * 82 ms frame at a two-meter stance, measured by switching the bands off.
 *
 * A texture fetch is the same trilinear blend done by hardware built for
 * nothing else, on a cache the whole texture fits in. So the lattice is
 * evaluated once here, at four texels a cell over `NOISE_CELLS` cells, and
 * every octave is one fetch of it at its own scale. The field is periodic by
 * construction — the lattice hashes wrap at `NOISE_CELLS` — which is the
 * property the sub-meter bands need anyway: their domain is a patch-local
 * position offset by an origin reduced modulo the period on the CPU, and two
 * patches agree where they overlap only because the field closes on it.
 *
 * Four channels: the value, and its gradient. A normal built by differencing
 * a trilinear fetch in screen space is piecewise constant across each texel,
 * and the texel grid shows through it as a moiré on the sea and a crease on
 * the ground at arm's length. The gradient is smooth where the value is only
 * continuous, so it is baked beside the value — the analytic derivative of
 * the same lattice — and a shading normal is one more lane of the same
 * fetch. Eight megabytes, no mip chain: the bands fade themselves out by the
 * pixel footprint before an octave would alias, which is what the graphs did
 * before the texture and is the whole of their anti-aliasing.
 */

/**
 * What a gradient byte is divided by. Cube-edge gradient noise has a slope
 * of at most about 2.4 per cell in any axis, and the range is spent on it.
 */
export const NOISE_GRADIENT_SCALE = 2.5

/**
 * Lattice cells per axis, and the period every octave closes on.
 *
 * Twenty-four, and the number is the cache's. At thirty-two cells the
 * four-channel texture is eight megabytes and the fine octaves stride
 * through it: measured at 1920×1200 over a device pixel ratio of 2, the
 * frame went from 19.4 fps with a one-channel two-megabyte texture to 11.9
 * with four channels at the same size. Three and a half megabytes fits.
 * The grain repeats every 17 m of ground and the swell every 290 m, both
 * under the distance the band survives to.
 */
export const NOISE_CELLS = 32

/** Texels per lattice cell. Four is where trilinear stops showing the lattice. */
const TEXELS_PER_CELL = 4

/** Texels per axis. */
export const NOISE_TEXTURE_SIZE = NOISE_CELLS * TEXELS_PER_CELL

let held: Data3DTexture | null = null

/**
 * The texture, built on first use and kept for the session.
 *
 * One object shared by every material that samples it, because the backend
 * uploads per texture and two megabytes uploaded twice is the same two
 * megabytes on the GPU twice.
 */
export function noiseTexture(): Data3DTexture {
  if (held !== null) return held
  const size = NOISE_TEXTURE_SIZE
  const data = new Uint8Array(size * size * size * 4)
  const sample: NoiseSample = { value: 0, dx: 0, dy: 0, dz: 0 }
  const byte = (v: number): number =>
    Math.round((Math.max(-1, Math.min(1, v)) * 0.5 + 0.5) * 255)
  let at = 0
  for (let z = 0; z < size; z += 1) {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        periodicNoise(
          x / TEXELS_PER_CELL,
          y / TEXELS_PER_CELL,
          z / TEXELS_PER_CELL,
          sample,
        )
        // [-1, 1] to a byte in every lane. The graphs undo it with `2x − 1`,
        // and the gradient lanes with `NOISE_GRADIENT_SCALE` on top.
        data[at] = byte(sample.value)
        data[at + 1] = byte(sample.dx / NOISE_GRADIENT_SCALE)
        data[at + 2] = byte(sample.dy / NOISE_GRADIENT_SCALE)
        data[at + 3] = byte(sample.dz / NOISE_GRADIENT_SCALE)
        at += 4
      }
    }
  }
  const texture = new Data3DTexture(data, size, size, size)
  texture.format = RGBAFormat
  texture.type = UnsignedByteType
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.wrapR = RepeatWrapping
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  held = texture
  return texture
}

/*
 * Gradient noise on a lattice that wraps at `NOISE_CELLS`, in [-1, 1].
 *
 * The same construction as `noise3` in `packages/procedural` — twelve
 * cube-edge gradients picked by a lattice hash, a quintic fade, a trilinear
 * blend — with the one difference that makes it a texture: the lattice
 * coordinate is reduced modulo the period before it is hashed, so texel 127
 * blends toward texel 0 and the sampler's repeat is seamless. It is not
 * `noise3` itself and does not share its seed, because nothing canonical
 * reads this field: it is presentation, and the only thing that has to agree
 * with it is the texture it was baked into.
 */
const GRADIENTS: readonly (readonly [number, number, number])[] = [
  [1, 1, 0],
  [-1, 1, 0],
  [1, -1, 0],
  [-1, -1, 0],
  [1, 0, 1],
  [-1, 0, 1],
  [1, 0, -1],
  [-1, 0, -1],
  [0, 1, 1],
  [0, -1, 1],
  [0, 1, -1],
  [0, -1, -1],
]

function hash(x: number, y: number, z: number): number {
  // Wrapped first, so the lattice is periodic; then the MurmurHash3
  // finalizer over a mix of the three, which is what `hash3` does.
  const a = ((x % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS
  const b = ((y % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS
  const c = ((z % NOISE_CELLS) + NOISE_CELLS) % NOISE_CELLS
  let h =
    (Math.imul(a + 1, 0x9e3779b1) ^
      Math.imul(b + 1, 0x85ebca6b) ^
      Math.imul(c + 1, 0xc2b2ae35)) >>>
    0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b) >>> 0
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

interface NoiseSample {
  value: number
  dx: number
  dy: number
  dz: number
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10)
const fadeSlope = (t: number): number => 30 * t * t * (t * (t - 2) + 1)

function gradientAt(
  ix: number,
  iy: number,
  iz: number,
): readonly [number, number, number] {
  return GRADIENTS[hash(ix, iy, iz) % 12] as readonly [number, number, number]
}

/**
 * The value and its gradient, in the factored trilinear form `field.ts` in
 * `packages/procedural` uses for `gradientNoise3`: the eight corner
 * products blend through `k1…k7`, and the gradient is the blend of the
 * corner gradients plus the fade slopes against the same coefficients.
 */
function periodicNoise(
  x: number,
  y: number,
  z: number,
  out: NoiseSample,
): void {
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const iz = Math.floor(z)
  const fx = x - ix
  const fy = y - iy
  const fz = z - iz
  const u = fade(fx)
  const v = fade(fy)
  const w = fade(fz)
  const du = fadeSlope(fx)
  const dv = fadeSlope(fy)
  const dw = fadeSlope(fz)
  const g000 = gradientAt(ix, iy, iz)
  const g100 = gradientAt(ix + 1, iy, iz)
  const g010 = gradientAt(ix, iy + 1, iz)
  const g110 = gradientAt(ix + 1, iy + 1, iz)
  const g001 = gradientAt(ix, iy, iz + 1)
  const g101 = gradientAt(ix + 1, iy, iz + 1)
  const g011 = gradientAt(ix, iy + 1, iz + 1)
  const g111 = gradientAt(ix + 1, iy + 1, iz + 1)
  const x1 = fx - 1
  const y1 = fy - 1
  const z1 = fz - 1
  const a = g000[0] * fx + g000[1] * fy + g000[2] * fz
  const b = g100[0] * x1 + g100[1] * fy + g100[2] * fz
  const c = g010[0] * fx + g010[1] * y1 + g010[2] * fz
  const d = g110[0] * x1 + g110[1] * y1 + g110[2] * fz
  const e = g001[0] * fx + g001[1] * fy + g001[2] * z1
  const f = g101[0] * x1 + g101[1] * fy + g101[2] * z1
  const g = g011[0] * fx + g011[1] * y1 + g011[2] * z1
  const h = g111[0] * x1 + g111[1] * y1 + g111[2] * z1
  const k1 = b - a
  const k2 = c - a
  const k3 = e - a
  const k4 = a - b - c + d
  const k5 = a - b - e + f
  const k6 = a - c - e + g
  const k7 = -a + b + c - d + e - f - g + h
  const uv = u * v
  const uw = u * w
  const vw = v * w
  const uvw = uv * w
  // Gradient noise on the cube-edge set peaks near ±0.94; the scale keeps
  // the byte's range spent, on the value and the gradient alike.
  const scale = 1.06
  out.value =
    (a + k1 * u + k2 * v + k3 * w + k4 * uv + k5 * uw + k6 * vw + k7 * uvw) *
    scale
  const lane = (axis: 0 | 1 | 2): number =>
    g000[axis] +
    (g100[axis] - g000[axis]) * u +
    (g010[axis] - g000[axis]) * v +
    (g001[axis] - g000[axis]) * w +
    (g000[axis] - g100[axis] - g010[axis] + g110[axis]) * uv +
    (g000[axis] - g100[axis] - g001[axis] + g101[axis]) * uw +
    (g000[axis] - g010[axis] - g001[axis] + g011[axis]) * vw +
    (-g000[axis] +
      g100[axis] +
      g010[axis] -
      g110[axis] +
      g001[axis] -
      g101[axis] -
      g011[axis] +
      g111[axis]) *
      uvw
  out.dx = (lane(0) + du * (k1 + k4 * v + k5 * w + k7 * vw)) * scale
  out.dy = (lane(1) + dv * (k2 + k4 * u + k6 * w + k7 * uw)) * scale
  out.dz = (lane(2) + dw * (k3 + k5 * u + k6 * v + k7 * uv)) * scale
}
