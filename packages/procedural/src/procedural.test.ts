import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { fbm3, noise3 } from './noise.ts'
import { Rng } from './rng.ts'
import {
  deriveSeed,
  derivePath,
  formatSeed,
  parseSeed,
  rootSeed,
  seedEquals,
} from './seed.ts'

const ROOT = rootSeed('inertialref')

describe('seed derivation', () => {
  /*
   * Golden vectors. These are not testing that the numbers are "right" — any
   * stream would do — they are testing that the numbers never change. A silent
   * change to the PRNG or the derivation would regenerate every player's
   * universe from under their save file, and this is the tripwire for it. If a
   * change here is deliberate, bump the algorithm version and update these
   * together, in the same commit, on purpose.
   */
  it('matches golden vectors', () => {
    expect(formatSeed(ROOT)).toBe('0df87e57180611d601f6e442eb5fc374')
    expect(formatSeed(deriveSeed(ROOT, 'system:SOL'))).toBe(
      'aafc440b771aaf62551f650e4b099be0',
    )
    expect(formatSeed(derivePath(ROOT, ['system:SOL', 'body:2']))).toBe(
      'b1e23aa109393ae28bd09fba800e2331',
    )
    const rng = new Rng(ROOT)
    expect([
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
      rng.nextUint32(),
    ]).toEqual([2_291_224_860, 3_225_986_370, 2_608_961_050, 2_565_227_618])
    expect(noise3(ROOT, 1.5, -2.25, 3.125).toFixed(12)).toBe('-0.279786154628')
    expect(fbm3(ROOT, 0.3, 0.7, -0.1).toFixed(12)).toBe('0.017432449097')
  })

  it('is a pure function of the path', () => {
    expect(
      seedEquals(
        derivePath(ROOT, ['a', 'b', 'c']),
        derivePath(ROOT, ['a', 'b', 'c']),
      ),
    ).toBe(true)
    expect(
      seedEquals(derivePath(ROOT, ['a', 'b']), derivePath(ROOT, ['b', 'a'])),
    ).toBe(false)
    expect(
      seedEquals(deriveSeed(ROOT, 'ab'), derivePath(ROOT, ['a', 'b'])),
    ).toBe(false)
  })

  it('does not depend on derivation order', () => {
    // The whole point of path derivation: whoever asks first gets the same answer.
    const labels = Array.from({ length: 500 }, (_, i) => `body:${i}`)
    const forward = new Map(
      labels.map((l) => [l, formatSeed(deriveSeed(ROOT, l))]),
    )
    const shuffled = new Rng(rootSeed('shuffle')).shuffle(labels.slice())
    for (const label of shuffled) {
      expect(formatSeed(deriveSeed(ROOT, label))).toBe(forward.get(label))
    }
  })

  it('gives unrelated seeds to adjacent labels', () => {
    // Sibling addresses differ by one character. If their seeds correlated,
    // neighboring planets would come out suspiciously similar.
    const seen = new Set<string>()
    let bitDifferenceTotal = 0
    let comparisons = 0
    let previous = deriveSeed(ROOT, 'body:0')
    for (let i = 0; i < 5_000; i += 1) {
      const seed = deriveSeed(ROOT, `body:${i}`)
      const hex = formatSeed(seed)
      expect(seen.has(hex)).toBe(false)
      seen.add(hex)
      if (i > 0) {
        for (const [x, y] of [
          [seed.a, previous.a],
          [seed.b, previous.b],
          [seed.c, previous.c],
          [seed.d, previous.d],
        ] as const) {
          let diff = (x ^ y) >>> 0
          while (diff !== 0) {
            bitDifferenceTotal += diff & 1
            diff >>>= 1
          }
        }
        comparisons += 1
      }
      previous = seed
    }
    // Good avalanche puts half of the 128 bits apart, on average.
    expect(bitDifferenceTotal / comparisons).toBeGreaterThan(56)
    expect(bitDifferenceTotal / comparisons).toBeLessThan(72)
  })

  it('round-trips through its text form (property)', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const seed = rootSeed(text)
        expect(seedEquals(parseSeed(formatSeed(seed)), seed)).toBe(true)
      }),
    )
  })
})

describe('Rng', () => {
  it('produces the same stream from the same seed', () => {
    const a = new Rng(ROOT)
    const b = new Rng(ROOT)
    for (let i = 0; i < 100; i += 1) expect(a.nextUint32()).toBe(b.nextUint32())
  })

  it('is uniform enough for generation work', () => {
    const rng = new Rng(deriveSeed(ROOT, 'uniformity'))
    const buckets = new Array<number>(10).fill(0)
    const samples = 100_000
    let sum = 0
    for (let i = 0; i < samples; i += 1) {
      const v = rng.next()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      sum += v
      buckets[Math.floor(v * 10)] = (buckets[Math.floor(v * 10)] ?? 0) + 1
    }
    expect(sum / samples).toBeCloseTo(0.5, 2)
    for (const count of buckets)
      expect(Math.abs(count - samples / 10)).toBeLessThan(samples / 50)
  })

  it('draws a usable normal distribution', () => {
    const rng = new Rng(deriveSeed(ROOT, 'gaussian'))
    let sum = 0
    let sumSq = 0
    const n = 50_000
    for (let i = 0; i < n; i += 1) {
      const v = rng.gaussian(0, 1)
      sum += v
      sumSq += v * v
    }
    expect(sum / n).toBeCloseTo(0, 1)
    expect(Math.sqrt(sumSq / n)).toBeCloseTo(1, 1)
  })

  it('forks independent streams that do not disturb the parent', () => {
    const parent = new Rng(ROOT)
    const before = parent.nextUint32()
    const forkA = parent.fork('a')
    const forkB = parent.fork('b')
    expect(forkA.nextUint32()).not.toBe(forkB.nextUint32())

    const replay = new Rng(ROOT)
    expect(replay.nextUint32()).toBe(before)
    replay.fork('a').nextUint32()
    // Forking does not consume the parent stream, so the next value is unchanged.
    expect(replay.nextUint32()).toBe(parent.nextUint32())
  })

  it('respects weights and ranges', () => {
    const rng = new Rng(deriveSeed(ROOT, 'weights'))
    const counts = [0, 0, 0]
    for (let i = 0; i < 30_000; i += 1) {
      const idx = rng.weightedIndex([1, 3, 6])
      counts[idx] = (counts[idx] ?? 0) + 1
      const int = rng.int(5, 9)
      expect(int).toBeGreaterThanOrEqual(5)
      expect(int).toBeLessThanOrEqual(9)
    }
    expect((counts[0] ?? 0) / 30_000).toBeCloseTo(0.1, 1)
    expect((counts[2] ?? 0) / 30_000).toBeCloseTo(0.6, 1)
  })
})

describe('noise', () => {
  it('is stateless, so sampling order cannot change a planet', () => {
    const points = Array.from(
      { length: 200 },
      (_, i) => [i * 0.37, i * -0.11, i * 0.53] as const,
    )
    const inOrder = points.map(([x, y, z]) => noise3(ROOT, x, y, z))
    const shuffled = new Rng(rootSeed('order')).shuffle(
      points.map((p, i) => [p, i] as const),
    )
    for (const [[x, y, z], i] of shuffled) {
      expect(noise3(ROOT, x, y, z)).toBe(inOrder[i])
    }
  })

  it('stays in range and stays continuous', () => {
    const rng = new Rng(deriveSeed(ROOT, 'noise-range'))
    let worstJump = 0
    for (let i = 0; i < 5_000; i += 1) {
      const x = rng.range(-100, 100)
      const y = rng.range(-100, 100)
      const z = rng.range(-100, 100)
      const v = noise3(ROOT, x, y, z)
      expect(v).toBeGreaterThanOrEqual(-1.01)
      expect(v).toBeLessThanOrEqual(1.01)
      worstJump = Math.max(
        worstJump,
        Math.abs(v - noise3(ROOT, x + 1e-4, y, z)),
      )
    }
    // A 1e-4 lattice step must not produce a cliff, or terrain will crack.
    expect(worstJump).toBeLessThan(0.01)
  })

  it('separates octaves in fBm', () => {
    const low = fbm3(ROOT, 0.5, 0.5, 0.5, { octaves: 1 })
    const high = fbm3(ROOT, 0.5, 0.5, 0.5, { octaves: 8 })
    expect(low).not.toBe(high)
    expect(Math.abs(high)).toBeLessThanOrEqual(1.01)
  })
})
