import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  CLIFF_DB,
  fft,
  findCutoff,
  SPECTRUM_SIZE,
  SpectrumAccumulator,
} from './spectrum.ts'

/** A deterministic uniform source, so a failing noise case reproduces. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

const RATE = 44_100
const BINS = SPECTRUM_SIZE / 2 + 1
const BIN_HZ = RATE / SPECTRUM_SIZE

describe('fft', () => {
  it('agrees with the definition of the DFT', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }).chain((power) =>
          fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
            minLength: 2 ** power,
            maxLength: 2 ** power,
          }),
        ),
        (signal) => {
          const n = signal.length
          const re = Float64Array.from(signal)
          const im = new Float64Array(n)
          fft(re, im)
          for (let k = 0; k < n; k += 1) {
            let sumRe = 0
            let sumIm = 0
            for (let t = 0; t < n; t += 1) {
              const angle = (-2 * Math.PI * k * t) / n
              sumRe += signal[t]! * Math.cos(angle)
              sumIm += signal[t]! * Math.sin(angle)
            }
            expect(re[k]).toBeCloseTo(sumRe, 9)
            expect(im[k]).toBeCloseTo(sumIm, 9)
          }
        },
      ),
    )
  })

  it('preserves energy (Parseval)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -1, max: 1, noNaN: true }), {
          minLength: 256,
          maxLength: 256,
        }),
        (signal) => {
          const re = Float64Array.from(signal)
          const im = new Float64Array(signal.length)
          fft(re, im)
          const time = signal.reduce((sum, x) => sum + x * x, 0)
          let frequency = 0
          for (let k = 0; k < re.length; k += 1)
            frequency += re[k]! * re[k]! + im[k]! * im[k]!
          expect(frequency / signal.length).toBeCloseTo(time, 8)
        },
      ),
    )
  })

  it('refuses a length that is not a power of two', () => {
    expect(() => fft(new Float64Array(12), new Float64Array(12))).toThrow(
      /power-of-two/,
    )
  })
})

/** A mean power spectrum that is `below` up to `edge` hertz and `above` after it. */
function step(edge: number, below = 1, above = 1e-9): Float64Array {
  const power = new Float64Array(BINS)
  for (let k = 0; k < BINS; k += 1) power[k] = k * BIN_HZ < edge ? below : above
  return power
}

describe('findCutoff', () => {
  it('places a brick wall within a bin of where it is', () => {
    fc.assert(
      fc.property(fc.integer({ min: 13_000, max: 21_000 }), (edge) => {
        const found = findCutoff(step(edge), RATE)
        expect(found.frequency).not.toBeNull()
        expect(Math.abs(found.frequency! - edge)).toBeLessThanOrEqual(BIN_HZ)
        expect(found.drop).toBeGreaterThan(CLIFF_DB)
      }),
    )
  })

  it('finds no cliff in a flat spectrum', () => {
    expect(
      findCutoff(new Float64Array(BINS).fill(1), RATE).frequency,
    ).toBeNull()
  })

  /*
   * The case the heuristic exists not to trip over: a master with nothing at
   * the top because the music has nothing there. 24 dB per octave above 15 kHz
   * is steeper than anything mastered, and still nowhere near a cliff across a
   * 1.4 kHz window.
   */
  it('finds no cliff in a steep but continuous roll-off', () => {
    const power = new Float64Array(BINS)
    for (let k = 0; k < BINS; k += 1) {
      const hz = Math.max(1, k * BIN_HZ)
      const octaves = Math.max(0, Math.log2(hz / 15_000))
      power[k] = 10 ** ((-24 * octaves) / 10)
    }
    const found = findCutoff(power, RATE)
    expect(found.frequency).toBeNull()
    expect(found.drop).toBeLessThan(CLIFF_DB)
  })
})

describe('SpectrumAccumulator', () => {
  it('puts a sine in the bin of its frequency', () => {
    const accumulator = new SpectrumAccumulator(SPECTRUM_SIZE, 1)
    const hz = 1_000
    const samples = new Float32Array(SPECTRUM_SIZE * 4)
    for (let i = 0; i < samples.length; i += 1)
      samples[i] = Math.sin((2 * Math.PI * hz * i) / RATE)
    accumulator.push(samples)
    const mean = accumulator.mean()
    let peak = 0
    for (let k = 1; k < mean.length; k += 1)
      if (mean[k]! > mean[peak]!) peak = k
    expect(Math.abs(peak * BIN_HZ - hz)).toBeLessThan(BIN_HZ)
    expect(accumulator.frames).toBe(4)
  })

  it('does not count frames of digital silence', () => {
    const accumulator = new SpectrumAccumulator(SPECTRUM_SIZE, 1)
    accumulator.push(new Float32Array(SPECTRUM_SIZE * 3))
    expect(accumulator.frames).toBe(0)
  })

  it('keeps one frame in `stride`', () => {
    const accumulator = new SpectrumAccumulator(SPECTRUM_SIZE, 4)
    const next = lcg(7)
    const samples = new Float32Array(SPECTRUM_SIZE * 9)
    for (let i = 0; i < samples.length; i += 1) samples[i] = next() - 0.5
    accumulator.push(samples)
    // Frames 1, 5 and 9 of nine.
    expect(accumulator.frames).toBe(3)
  })

  /*
   * End to end, from samples: the spectrum an encoder leaves behind, built the
   * way an encoder leaves it — energy up to the low-pass and none above — and
   * the spectrum a master has, which is energy all the way up.
   */
  it('finds the low-pass in band-limited noise and none in full-band noise', () => {
    const next = lcg(42)
    const length = SPECTRUM_SIZE * 12
    const limited = new Float32Array(length)
    const partials = 600
    for (let p = 0; p < partials; p += 1) {
      const hz = 40 + next() * (16_000 - 40)
      const phase = next() * 2 * Math.PI
      const step = (2 * Math.PI * hz) / RATE
      for (let i = 0; i < length; i += 1)
        limited[i] = limited[i]! + Math.sin(phase + step * i) / partials
    }
    const lossy = new SpectrumAccumulator(SPECTRUM_SIZE, 1)
    lossy.push(limited)
    const cut = findCutoff(lossy.mean(), RATE)
    expect(cut.frequency).not.toBeNull()
    expect(Math.abs(cut.frequency! - 16_000)).toBeLessThan(300)

    const full = new Float32Array(length)
    for (let i = 0; i < length; i += 1) full[i] = next() - 0.5
    const lossless = new SpectrumAccumulator(SPECTRUM_SIZE, 1)
    lossless.push(full)
    expect(findCutoff(lossless.mean(), RATE).frequency).toBeNull()
  })
})
