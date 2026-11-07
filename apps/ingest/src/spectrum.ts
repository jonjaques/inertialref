/*
 * Whether a "lossless" file is lossless.
 *
 * A FLAC is a container, not a certificate. Anything decoded from an MP3 and
 * written back out as FLAC is a perfectly valid FLAC, `flac -t` passes it, and
 * ffprobe reports 16 bits at 44.1 kHz — the encoder's damage is still in it.
 * What gives it away is the spectrum: every lossy encoder low-passes before it
 * quantizes, at 16 kHz for a 128 kbit/s MP3 and somewhere from 19 to 20 kHz
 * for the high rates, and the content above that line is gone rather than
 * quiet. A genuine master rolls off; a transcode falls off a cliff.
 *
 * So this measures the cliff: the long-term mean power spectrum, and the
 * steepest fall in it above 12 kHz. Music that simply has nothing up there —
 * a drone that is all fundamentals — rolls off gradually and is not a cliff,
 * which is why the test is the slope across a narrow window rather than the
 * level at a frequency.
 *
 * It is a heuristic and is recorded as one: `manifest.json` carries the
 * frequency and the depth of the fall for every master, and a person reads
 * the spectrogram before trusting a file it flags.
 */

/**
 * The frame size: 8192 samples is 5.4 Hz per bin at 44.1 kHz, fine enough to
 * place an encoder's cutoff within a bin or two and cheap enough to take
 * hundreds of frames from a track in a second.
 */
export const SPECTRUM_SIZE = 8192

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  if (n !== im.length || n === 0 || (n & (n - 1)) !== 0) {
    throw new Error(`fft: a power-of-two length is required, got ${n}`)
  }
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const r = re[i]!
      re[i] = re[j]!
      re[j] = r
      const m = im[i]!
      im[i] = im[j]!
      im[j] = m
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length
    const stepRe = Math.cos(angle)
    const stepIm = Math.sin(angle)
    for (let start = 0; start < n; start += length) {
      let wRe = 1
      let wIm = 0
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k
        const b = a + length / 2
        const tRe = re[b]! * wRe - im[b]! * wIm
        const tIm = re[b]! * wIm + im[b]! * wRe
        re[b] = re[a]! - tRe
        im[b] = im[a]! - tIm
        re[a] = re[a]! + tRe
        im[a] = im[a]! + tIm
        const nextRe = wRe * stepRe - wIm * stepIm
        wIm = wRe * stepIm + wIm * stepRe
        wRe = nextRe
      }
    }
  }
}

/**
 * The mean power spectrum of a stream of mono samples, a frame at a time.
 *
 * Streaming because the long tracks are long: eighteen minutes of 44.1 kHz
 * mono is 49 million samples, and nothing here needs more than the frame it
 * is looking at. `stride` keeps one frame in that many, which over a whole
 * track is still hundreds of frames and makes the pass a few seconds.
 */
export class SpectrumAccumulator {
  readonly #size: number
  readonly #stride: number
  readonly #window: Float64Array
  readonly #frame: Float64Array
  readonly #re: Float64Array
  readonly #im: Float64Array
  readonly #sum: Float64Array
  #filled = 0
  #seen = 0
  #frames = 0

  constructor(size = SPECTRUM_SIZE, stride = 4) {
    this.#size = size
    this.#stride = Math.max(1, stride)
    this.#window = new Float64Array(size)
    // Hann: its sidelobes fall at 18 dB per octave, so the power of a loud
    // midrange cannot leak far enough to fill in an encoder's empty band.
    for (let i = 0; i < size; i += 1) {
      this.#window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
    }
    this.#frame = new Float64Array(size)
    this.#re = new Float64Array(size)
    this.#im = new Float64Array(size)
    this.#sum = new Float64Array(size / 2 + 1)
  }

  get frames(): number {
    return this.#frames
  }

  push(samples: ArrayLike<number>): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.#frame[this.#filled] = samples[i]!
      this.#filled += 1
      if (this.#filled < this.#size) continue
      this.#filled = 0
      this.#seen += 1
      if ((this.#seen - 1) % this.#stride !== 0) continue
      this.#analyze()
    }
  }

  #analyze(): void {
    let energy = 0
    for (let i = 0; i < this.#size; i += 1) {
      const value = this.#frame[i]! * this.#window[i]!
      this.#re[i] = value
      this.#im[i] = 0
      energy += value * value
    }
    // A frame of digital silence says nothing about the spectrum, and a track
    // that opens on ten seconds of it would otherwise drag every bin's mean
    // toward zero by the same amount — harmless to the cliff, but it is also
    // the frame count the manifest reports as evidence.
    if (energy === 0) return
    fft(this.#re, this.#im)
    for (let k = 0; k <= this.#size / 2; k += 1) {
      this.#sum[k] =
        this.#sum[k]! +
        this.#re[k]! * this.#re[k]! +
        this.#im[k]! * this.#im[k]!
    }
    this.#frames += 1
  }

  /** Mean power per bin, `size / 2 + 1` of them, DC first. */
  mean(): Float64Array {
    const out = new Float64Array(this.#sum.length)
    if (this.#frames === 0) return out
    for (let k = 0; k < out.length; k += 1)
      out[k] = this.#sum[k]! / this.#frames
    return out
  }
}

export interface Cutoff {
  /**
   * Where the spectrum falls off a cliff, in hertz, or null when it does not —
   * which is what a genuine master's spectrum does.
   */
  readonly frequency: number | null
  /** How far it falls across the cliff, in dB. The evidence, not the verdict. */
  readonly drop: number
}

/** How deep a fall has to be to count as an encoder's low-pass. */
export const CLIFF_DB = 30

/**
 * The steepest fall in a mean power spectrum above `from` hertz.
 *
 * The fall is the difference between the mean level in a window just below a
 * frequency and a window just above it. 700 Hz each side: wide enough that a
 * single loud partial cannot pass for a band edge, narrow enough that a
 * gradual roll-off — 12 dB per octave from 15 kHz loses about 3 dB across it —
 * never approaches `CLIFF_DB`.
 */
export function findCutoff(
  power: Float64Array,
  sampleRate: number,
  { from = 12_000, window = 700 } = {},
): Cutoff {
  const bins = power.length
  const binHz = sampleRate / 2 / (bins - 1)
  const level = new Float64Array(bins)
  for (let k = 0; k < bins; k += 1) {
    level[k] = 10 * Math.log10(power[k]! + 1e-30)
  }
  const span = Math.max(1, Math.round(window / binHz))
  const prefix = new Float64Array(bins + 1)
  for (let k = 0; k < bins; k += 1) prefix[k + 1] = prefix[k]! + level[k]!
  const meanOf = (a: number, b: number): number =>
    (prefix[b]! - prefix[a]!) / (b - a)

  let best = -Infinity
  let at = -1
  const first = Math.max(span, Math.ceil(from / binHz))
  const last = bins - span
  for (let k = first; k < last; k += 1) {
    const drop = meanOf(k - span, k) - meanOf(k, k + span)
    if (drop > best) {
      best = drop
      at = k
    }
  }
  if (at < 0) return { frequency: null, drop: 0 }
  const drop = Math.round(best * 10) / 10
  return {
    frequency: drop >= CLIFF_DB ? Math.round(at * binHz) : null,
    drop,
  }
}
