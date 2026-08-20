import { rotl32 } from './hash.ts'
import { deriveSeed, type Seed } from './seed.ts'

/*
 * xoshiro128** — 32-bit state, 2^128 period, passes BigCrush-class tests, and
 * (the part that matters here) is expressible in exact 32-bit integer ops so
 * every JS engine produces identical streams.
 *
 * An Rng is a short-lived object: you derive a seed for an address, draw the
 * handful of values that address needs, and drop it. Nothing shares a stream
 * across addresses — that is the order-dependence trap seed.ts exists to avoid.
 */
export class Rng {
  #s0: number
  #s1: number
  #s2: number
  #s3: number

  constructor(seed: Seed) {
    this.#s0 = seed.a >>> 0
    this.#s1 = seed.b >>> 0
    this.#s2 = seed.c >>> 0
    this.#s3 = seed.d >>> 0
  }

  static fromSeed(seed: Seed): Rng {
    return new Rng(seed)
  }

  /** Uniform uint32. */
  nextUint32(): number {
    const result = Math.imul(rotl32(Math.imul(this.#s1, 5), 7), 9) >>> 0
    const t = (this.#s1 << 9) >>> 0
    this.#s2 ^= this.#s0
    this.#s3 ^= this.#s1
    this.#s1 ^= this.#s2
    this.#s0 ^= this.#s3
    this.#s2 = (this.#s2 ^ t) >>> 0
    this.#s3 = rotl32(this.#s3, 11)
    this.#s0 >>>= 0
    this.#s1 >>>= 0
    return result
  }

  /** Uniform in [0, 1) with 32 bits of resolution. */
  next(): number {
    return this.nextUint32() / 0x1_0000_0000
  }

  /** Uniform in [0, 1) with the full 53 bits a double can hold. */
  nextFloat53(): number {
    const hi = this.nextUint32() >>> 5
    const lo = this.nextUint32() >>> 6
    return (hi * 2 ** 26 + lo) / 2 ** 53
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min)
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1))
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability
  }

  /** Standard normal, Box–Muller. Both draws are consumed so streams stay aligned. */
  gaussian(mean = 0, stdDev = 1): number {
    // Guard against log(0); nextFloat53 can legitimately return exactly 0.
    const u1 = this.nextFloat53() || Number.MIN_VALUE
    const u2 = this.nextFloat53()
    return (
      mean + stdDev * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    )
  }

  /**
   * Power-law sample in [min, max] with exponent `alpha`, by inverse CDF.
   * Stellar masses and asteroid sizes both want this rather than a uniform.
   */
  powerLaw(alpha: number, min: number, max: number): number {
    const u = this.nextFloat53()
    if (alpha === -1) return min * (max / min) ** u
    const p = alpha + 1
    return (u * (max ** p - min ** p) + min ** p) ** (1 / p)
  }

  /** Uniformly distributed direction on the unit sphere (Marsaglia). */
  unitVector(): { x: number; y: number; z: number } {
    const z = this.range(-1, 1)
    const theta = this.range(0, 2 * Math.PI)
    const r = Math.sqrt(Math.max(0, 1 - z * z))
    return { x: r * Math.cos(theta), y: r * Math.sin(theta), z }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)]
    if (item === undefined) throw new Error('Rng.pick on an empty array')
    return item
  }

  /** Index into a weight table, proportional to the weights. */
  weightedIndex(weights: readonly number[]): number {
    let total = 0
    for (const w of weights) total += w
    let target = this.next() * total
    for (let i = 0; i < weights.length; i += 1) {
      target -= weights[i] ?? 0
      if (target <= 0) return i
    }
    return weights.length - 1
  }

  /** Fisher–Yates, in place. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i)
      const a = items[i] as T
      const b = items[j] as T
      items[i] = b
      items[j] = a
    }
    return items
  }

  /**
   * Branch off an independent stream by label.
   *
   * Use this rather than continuing to draw from the parent when the number of
   * draws a sub-generator makes might change: a branch keeps the parent's
   * subsequent values stable.
   */
  fork(label: string): Rng {
    return new Rng(
      deriveSeed({ a: this.#s0, b: this.#s1, c: this.#s2, d: this.#s3 }, label),
    )
  }
}

export function rng(seed: Seed): Rng {
  return new Rng(seed)
}
