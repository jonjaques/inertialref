import {
  DataTexture,
  LinearFilter,
  RGBAFormat,
  SRGBColorSpace,
  type Texture,
} from 'three/webgpu'

/*
 * Ring strips for ring systems that ship no photograph.
 *
 * A mapless ring used to fall back to an opaque white texel, which drew the
 * whole annulus as one uniform slab at the body's tint — Uranus wore its ring
 * system as a cyan charcoal compact disc four radii across, occluding the
 * starfield. The real thing is the opposite of a slab: Uranus is a dozen
 * threads of near-black rubble a few kilometres wide with thousands of
 * kilometres of nothing between them, and even a gas giant's sheet is banded
 * with gaps. So a mapless ring gets a strip *generated* from what kind of body
 * owns it, seeded from the body's address — deterministic, like everything
 * else generation does, so the same world always wears the same rings.
 *
 * The strip feeds both consumers of a ring texture — the ring slab itself and
 * the shadow it casts on its planet — so the shadow bands match the rings that
 * cast them.
 */

const STRIP_WIDTH = 512

const cache = new Map<string, Texture>()

/** Deterministic 32-bit hash of a string; the seed for a body's ring look. */
function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** mulberry32: tiny, deterministic, good enough for band placement. */
function rng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Band {
  readonly centre: number
  readonly width: number
  readonly alpha: number
  readonly grey: number
}

/**
 * The band list, by what kind of giant owns the ring.
 *
 * Ice giants get threads: narrow, sparse, dark — Uranus's ε ring analogue
 * sits wide and bright near the outer edge, the rest are hairlines. Gas
 * giants get a sheet: broad bands separated by gaps, brighter and warmer,
 * the generic reading of Saturn's architecture.
 */
function bands(kind: string, random: () => number): readonly Band[] {
  const result: Band[] = []
  if (kind === 'ice-giant') {
    const count = 6 + Math.floor(random() * 5)
    for (let i = 0; i < count; i += 1) {
      result.push({
        centre: 0.08 + random() * 0.78,
        width: 0.0015 + random() * 0.006,
        alpha: 0.35 + random() * 0.45,
        grey: 0.18 + random() * 0.14,
      })
    }
    // The dominant outer ring: wider, denser, the one worth naming.
    result.push({
      centre: 0.9 + random() * 0.06,
      width: 0.012 + random() * 0.01,
      alpha: 0.95,
      grey: 0.34 + random() * 0.1,
    })
    return result
  }
  const count = 3 + Math.floor(random() * 3)
  for (let i = 0; i < count; i += 1) {
    const start = i / count
    result.push({
      centre: start + (0.3 + random() * 0.4) / count,
      width: (0.28 + random() * 0.3) / count,
      alpha: 0.5 + random() * 0.4,
      grey: 0.55 + random() * 0.25,
    })
  }
  return result
}

/**
 * The strip for one mapless ring system, cached per body.
 *
 * RGBA like the shipped Saturn strip: colour in RGB, coverage in alpha —
 * the ring shader reads alpha as optical thickness per band, so the space
 * between bands is genuinely empty rather than faintly fogged.
 */
export function proceduralRingStrip(kind: string, address: string): Texture {
  const key = `${kind}:${address}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached

  const random = rng(hash(key))
  const profile = bands(kind, random)
  const warm = kind === 'ice-giant' ? 0.97 : 1.04

  const data = new Uint8Array(STRIP_WIDTH * 4)
  for (let x = 0; x < STRIP_WIDTH; x += 1) {
    const at = (x + 0.5) / STRIP_WIDTH
    let alpha = 0
    let grey = 0
    for (const band of profile) {
      // Gaussian-ish falloff, so a band has an edge without having a step.
      const spread = (at - band.centre) / band.width
      const contribution = band.alpha * Math.exp(-spread * spread * 2)
      if (contribution > alpha) {
        alpha = contribution
        grey = band.grey
      }
    }
    const index = x * 4
    data[index] = Math.round(Math.min(1, grey * warm) * 255)
    data[index + 1] = Math.round(grey * 255)
    data[index + 2] = Math.round(Math.min(1, grey * (2 - warm)) * 255)
    data[index + 3] = Math.round(Math.min(1, alpha) * 255)
  }

  const texture = new DataTexture(data, STRIP_WIDTH, 1, RGBAFormat)
  texture.colorSpace = SRGBColorSpace
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.needsUpdate = true
  cache.set(key, texture)
  return texture
}
