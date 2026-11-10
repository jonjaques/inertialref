import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { fileURLToPath } from 'node:url'
import { Rng, rootSeed } from '@inertialref/procedural'

/*
 * The spatiotemporal blue-noise mask's generator:
 * `node apps/ingest/src/blueNoise.ts` writes
 * `packages/rendering/src/blueNoise.generated.ts`, then
 * `pnpm exec prettier -w` formats it.
 *
 * Void-and-cluster (Ulichney 1993) under Wolfe et al.'s spatiotemporal
 * energy (arXiv 2112.09629, eq. 3): two texels exchange energy through a
 * Gaussian of their distance in the slice when they share a slice, through a
 * Gaussian of their distance in time when they share a pixel, and not at all
 * otherwise.
 * A 3D Gaussian would make the volume blue and no slice of it: a slice of a
 * 3D blue-noise volume is a cut through a dark sphere in frequency, and the
 * paper finds it a poor blue noise both in space and in time (§4.2). Every
 * distance wraps, so a slice tiles the screen and the sequence repeats
 * every sixteen samples with no seam.
 *
 * The energy is integers. Each kernel value is rounded to 2⁻²⁴ of its peak,
 * so a texel's energy is an exact integer sum that adding and removing the
 * same texel returns to the bit, and a tie between two texels is a real tie,
 * broken by a seeded 16-bit priority rather than by the index, which would
 * pull every tie toward the first row. A float sum depends on the order of
 * its additions in its last bits, so in floats a near-tie would be decided by
 * the order the texels were turned on and off, not by their energy.
 */

/** The mask's dimensions and the paper's parameters. */
export const BLUE_NOISE_MASK = {
  width: 64,
  height: 64,
  slices: 16,
  /** Texels: the paper's σ, the same on every axis (§4.1). */
  sigma: 1.9,
  /** The initial binary pattern's share of the texels: the paper's 10%. */
  density: 0.1,
  seed: 'inertialref/blue-noise',
} as const

export interface BlueNoiseOptions {
  readonly width: number
  readonly height: number
  readonly slices: number
  readonly sigma: number
  readonly density: number
  readonly seed: string
}

/** A kernel value of one, as an integer. */
const KERNEL_SCALE = 2 ** 24
/**
 * The tie-break's range, below the energy's least step. The largest key is
 * the energy's sum, under 2²⁹ at σ = 1.9, times 2¹⁶: under 2⁵³, so exact.
 */
const TIE_SCALE = 2 ** 16

interface Kernel {
  /** The spatial offsets with a nonzero value, (dx, dy, value) flat. */
  readonly spatial: Int32Array
  /** Value at a slice offset dz, 0 at dz = 0, which the spatial term holds. */
  readonly temporal: Float64Array
}

/** The toroidal distance between two coordinates `delta` apart on a ring of `size`. */
const ring = (delta: number, size: number): number =>
  Math.min(delta, size - delta)

function kernelOf(options: BlueNoiseOptions): Kernel {
  const { width, height, slices, sigma } = options
  const weight = (squared: number): number =>
    Math.round(KERNEL_SCALE * Math.exp(-squared / (2 * sigma * sigma)))
  const spatial: number[] = []
  // Every offset on the torus once, at its wrapped distance: a ring narrower
  // than the kernel would otherwise count one neighbor at two offsets.
  for (let dy = 0; dy < height; dy += 1) {
    for (let dx = 0; dx < width; dx += 1) {
      const value = weight(ring(dx, width) ** 2 + ring(dy, height) ** 2)
      if (value > 0) spatial.push(dx, dy, value)
    }
  }
  const temporal = new Float64Array(slices)
  for (let dz = 1; dz < slices; dz += 1)
    temporal[dz] = weight(ring(dz, slices) ** 2)
  return { spatial: Int32Array.from(spatial), temporal }
}

/**
 * The void-and-cluster state: which texels are on, and every texel's
 * energy from the ones that are, scaled by TIE_SCALE with its priority
 * added, so a single comparison orders energy and then the tie.
 */
class Field {
  readonly on: Uint8Array
  readonly key: Float64Array
  readonly #options: BlueNoiseOptions
  readonly #kernel: Kernel

  constructor(options: BlueNoiseOptions, kernel: Kernel, ties: Float64Array) {
    this.#options = options
    this.#kernel = kernel
    this.on = new Uint8Array(ties.length)
    this.key = Float64Array.from(ties)
  }

  set(index: number, on: boolean): void {
    if ((this.on[index] === 1) === on) return
    this.on[index] = on ? 1 : 0
    const sign = on ? TIE_SCALE : -TIE_SCALE
    const { width, height, slices } = this.#options
    const { spatial, temporal } = this.#kernel
    const x = index % width
    const y = Math.floor(index / width) % height
    const z = Math.floor(index / (width * height))
    const key = this.key
    const slice = z * width * height
    for (let k = 0; k < spatial.length; k += 3) {
      const tx = (x + spatial[k]!) % width
      const ty = (y + spatial[k + 1]!) % height
      key[slice + ty * width + tx]! += sign * spatial[k + 2]!
    }
    const pixel = y * width + x
    for (let dz = 1; dz < slices; dz += 1) {
      key[((z + dz) % slices) * width * height + pixel]! += sign * temporal[dz]!
    }
  }

  /** The on texel of most energy. */
  tightestCluster(): number {
    const { on, key } = this
    let best = -1
    let most = -Infinity
    for (let i = 0; i < key.length; i += 1) {
      if (on[i] === 1 && key[i]! > most) {
        most = key[i]!
        best = i
      }
    }
    return best
  }

  /** The off texel of least energy. */
  largestVoid(): number {
    const { on, key } = this
    let best = -1
    let least = Infinity
    for (let i = 0; i < key.length; i += 1) {
      if (on[i] === 0 && key[i]! < least) {
        least = key[i]!
        best = i
      }
    }
    return best
  }
}

/**
 * Each texel's rank, 0 to N − 1, by void-and-cluster: the initial pattern
 * relaxed until its tightest cluster is its largest void, then ranked down
 * from it (phase I), up to half the texels (phase II), and the rest from the
 * inverted pattern (phase III), as the paper's §3 sets out.
 */
export function blueNoiseRanks(options: BlueNoiseOptions): Uint32Array {
  const { width, height, slices, density } = options
  const count = width * height * slices
  const rng = Rng.fromSeed(rootSeed(options.seed))
  const ties = new Float64Array(count)
  for (let i = 0; i < count; i += 1) ties[i] = rng.nextUint32() >>> 16
  // The initial pattern: a seeded partial Fisher–Yates over every texel.
  const order = Uint32Array.from({ length: count }, (_, i) => i)
  const initial = Math.max(1, Math.round(density * count))
  for (let i = 0; i < initial; i += 1) {
    const j = rng.int(i, count - 1)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  const kernel = kernelOf(options)
  const field = new Field(options, kernel, ties)
  for (let i = 0; i < initial; i += 1) field.set(order[i]!, true)
  // Relax: move the tightest cluster to the largest void until they are the
  // same texel. Each move lowers the pattern's energy, so it ends; the cap
  // is a guard against a kernel that makes a cycle, which would be a bug.
  for (let moves = 0; ; moves += 1) {
    if (moves > count)
      throw new Error('blueNoise: the initial pattern did not settle')
    const cluster = field.tightestCluster()
    field.set(cluster, false)
    const hole = field.largestVoid()
    field.set(hole, true)
    if (hole === cluster) break
  }
  const pattern = Uint8Array.from(field.on)
  const settled = Float64Array.from(field.key)
  const ranks = new Uint32Array(count)
  // Phase I: the initial pattern's texels, tightest cluster first, take the
  // ranks below its size.
  for (let ones = initial; ones > 0;) {
    const cluster = field.tightestCluster()
    field.set(cluster, false)
    ones -= 1
    ranks[cluster] = ones
  }
  field.on.set(pattern)
  field.key.set(settled)
  // Phase II: the largest void takes the next rank, up to half the texels.
  for (let ones = initial; ones < count / 2; ones += 1) {
    const hole = field.largestVoid()
    ranks[hole] = ones
    field.set(hole, true)
  }
  // Phase III: the pattern inverted, its tightest cluster takes the next rank.
  const inverted = new Field(options, kernel, ties)
  for (let i = 0; i < count; i += 1)
    if (field.on[i] === 0) inverted.set(i, true)
  for (let ones = Math.ceil(count / 2); ones < count; ones += 1) {
    const cluster = inverted.tightestCluster()
    ranks[cluster] = ones
    inverted.set(cluster, false)
  }
  return ranks
}

/**
 * Ranks to bytes, slice by slice: a slice's texels in their rank order take
 * the values 0 to 255 in equal shares. The paper divides the global rank by
 * N, which leaves a slice's histogram as uneven as the ranks happened to
 * fall; within a slice the order, which is all the spatial property is, is
 * the same either way.
 */
export function blueNoiseBytes(
  ranks: Uint32Array,
  options: Pick<BlueNoiseOptions, 'width' | 'height' | 'slices'>,
): Uint8Array {
  const area = options.width * options.height
  const bytes = new Uint8Array(ranks.length)
  for (let z = 0; z < options.slices; z += 1) {
    const texels = Array.from({ length: area }, (_, i) => z * area + i)
    texels.sort((a, b) => ranks[a]! - ranks[b]!)
    texels.forEach((texel, order) => {
      bytes[texel] = Math.floor((order * 256) / area)
    })
  }
  return bytes
}

export function generateBlueNoise(
  options: BlueNoiseOptions = BLUE_NOISE_MASK,
): Uint8Array {
  return blueNoiseBytes(blueNoiseRanks(options), options)
}

/* ------------------------------------------------------------------------- */
/* The spectrum, against white noise                                          */
/* ------------------------------------------------------------------------- */

export interface MaskLayout {
  readonly width: number
  readonly height: number
  readonly slices: number
}

/** A texel's value as the trace reads it: the byte's interval's center. */
const value = (byte: number): number => (byte + 0.5) / 256

/** A frequency index's signed form on a ring of `size`. */
const signed = (k: number, size: number): number =>
  k < size / 2 ? k : k - size

/** |DFT|² of a real signal by the definition: the signals here are 16 or 64 long. */
function power1d(signal: Float64Array): Float64Array {
  const n = signal.length
  const out = new Float64Array(n)
  for (let k = 0; k < n; k += 1) {
    let re = 0
    let im = 0
    for (let t = 0; t < n; t += 1) {
      const angle = (-2 * Math.PI * k * t) / n
      re += signal[t]! * Math.cos(angle)
      im += signal[t]! * Math.sin(angle)
    }
    out[k] = re * re + im * im
  }
  return out
}

/** |DFT|² of a slice, rows then columns. */
function power2d(
  slice: Float64Array,
  width: number,
  height: number,
): Float64Array {
  const re = new Float64Array(width * height)
  const im = new Float64Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let k = 0; k < width; k += 1) {
      let a = 0
      let b = 0
      for (let x = 0; x < width; x += 1) {
        const angle = (-2 * Math.PI * k * x) / width
        a += slice[y * width + x]! * Math.cos(angle)
        b += slice[y * width + x]! * Math.sin(angle)
      }
      re[y * width + k] = a
      im[y * width + k] = b
    }
  }
  const power = new Float64Array(width * height)
  for (let kx = 0; kx < width; kx += 1) {
    for (let ky = 0; ky < height; ky += 1) {
      let a = 0
      let b = 0
      for (let y = 0; y < height; y += 1) {
        const angle = (-2 * Math.PI * ky * y) / height
        const c = Math.cos(angle)
        const s = Math.sin(angle)
        const r = re[y * width + kx]!
        const i = im[y * width + kx]!
        a += r * c - i * s
        b += r * s + i * c
      }
      power[ky * width + kx] = a * a + b * b
    }
  }
  return power
}

/** A signal's values less their mean, and the variance they had. */
function centered(values: Float64Array): {
  signal: Float64Array
  variance: number
} {
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  const signal = values.map((v) => v - mean)
  const variance = signal.reduce((sum, v) => sum + v * v, 0) / values.length
  return { signal, variance }
}

/**
 * A slice's spectral energy at radial frequencies under `cutoff` of Nyquist,
 * DC aside, over what white noise of the slice's own variance puts there:
 * 1 for white noise in expectation, and toward 0 the bluer the slice.
 *
 * White noise's expected |F(k)|² at every bin but DC is N·σ²·N/(N − 1),
 * from Parseval with the mean removed.
 */
export function sliceLowEnergy(
  bytes: Uint8Array,
  layout: MaskLayout,
  slice: number,
  cutoff = 0.25,
): number {
  const { width, height } = layout
  const area = width * height
  const values = Float64Array.from(
    bytes.subarray(slice * area, (slice + 1) * area),
    value,
  )
  const { signal, variance } = centered(values)
  const power = power2d(signal, width, height)
  const radius = cutoff * (Math.min(width, height) / 2)
  let energy = 0
  let bins = 0
  for (let ky = 0; ky < height; ky += 1) {
    for (let kx = 0; kx < width; kx += 1) {
      const fx = signed(kx, width)
      const fy = signed(ky, height)
      const r2 = fx * fx + fy * fy
      if (r2 === 0 || r2 >= radius * radius) continue
      energy += power[ky * width + kx]!
      bins += 1
    }
  }
  return energy / (bins * variance * area * (area / (area - 1)))
}

/**
 * Each pixel's sequence through the slices, its energy at temporal
 * frequencies under `cutoff` of Nyquist over white noise's, averaged over
 * pixels. With sixteen slices and a quarter of Nyquist that is the first
 * harmonic alone, the slowest drift a sequence can have.
 */
export function temporalLowEnergy(
  bytes: Uint8Array,
  layout: MaskLayout,
  cutoff = 0.25,
): number {
  const { width, height, slices } = layout
  const area = width * height
  const limit = cutoff * (slices / 2)
  let ratio = 0
  for (let pixel = 0; pixel < area; pixel += 1) {
    const values = Float64Array.from({ length: slices }, (_, z) =>
      value(bytes[z * area + pixel]!),
    )
    const { signal, variance } = centered(values)
    const power = power1d(signal)
    let energy = 0
    let bins = 0
    for (let k = 1; k < slices; k += 1) {
      if (Math.abs(signed(k, slices)) >= limit) continue
      energy += power[k]!
      bins += 1
    }
    if (bins === 0)
      throw new Error('temporalLowEnergy: no frequency under the cutoff')
    ratio += energy / (bins * variance * slices * (slices / (slices - 1)))
  }
  return ratio / area
}

/**
 * The error of a pixel's mean over `samples` consecutive slices, the
 * history's window, as a variance over white noise's: σ²/n for n
 * independent samples of the mask's own variance. Every pixel and every
 * starting slice, wrapping.
 */
export function windowMeanVariance(
  bytes: Uint8Array,
  layout: MaskLayout,
  samples = 8,
): number {
  const { width, height, slices } = layout
  const area = width * height
  const values = Float64Array.from(bytes, value)
  const { variance } = centered(values)
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  let squared = 0
  for (let pixel = 0; pixel < area; pixel += 1) {
    for (let start = 0; start < slices; start += 1) {
      let sum = 0
      for (let k = 0; k < samples; k += 1)
        sum += values[((start + k) % slices) * area + pixel]!
      squared += (sum / samples - mean) ** 2
    }
  }
  return squared / (area * slices) / (variance / samples)
}

/**
 * The mask's figures beside a white mask's of the same histogram: each
 * slice's own values shuffled by a seeded Rng, so only the order differs.
 */
export function whiteMask(
  bytes: Uint8Array,
  layout: MaskLayout,
  seed: string,
): Uint8Array {
  const area = layout.width * layout.height
  const rng = Rng.fromSeed(rootSeed(seed))
  const white = Uint8Array.from(bytes)
  for (let z = 0; z < layout.slices; z += 1) {
    const slice = white.subarray(z * area, (z + 1) * area)
    for (let i = area - 1; i > 0; i -= 1) {
      const j = rng.int(0, i)
      ;[slice[i], slice[j]] = [slice[j]!, slice[i]!]
    }
  }
  return white
}

/* ------------------------------------------------------------------------- */
/* The generated file                                                         */
/* ------------------------------------------------------------------------- */

/**
 * The generated file's text, before prettier. Every figure in the header is
 * read from the options, so a change to them cannot leave the committed file
 * describing a mask it no longer holds. Nothing in it differs between two
 * runs: the machine, the Node version and the seconds go to the console.
 */
export function sourceText(
  bytes: Uint8Array,
  options: BlueNoiseOptions = BLUE_NOISE_MASK,
): string {
  const { width, height, slices, sigma, density, seed } = options
  const header = [
    'Generated by `node apps/ingest/src/blueNoise.ts`; rerun it rather than',
    'editing, then `pnpm exec prettier -w` this file.',
    '',
    `The spatiotemporal blue-noise mask: ${width} × ${height} texels a slice, ${slices} slices,`,
    'one byte a texel, as base64, laid out [slice][y][x]. A pixel reads its own',
    'texel, wrapped, in the slice of its sample count.',
    '',
    'Void-and-cluster (Ulichney 1993) under the spatiotemporal energy of Wolfe,',
    'Morrical, Akenine-Möller and Ramamoorthi, "Scalar Spatiotemporal Blue Noise',
    `Masks" (arXiv 2112.09629, eq. 3): a Gaussian of σ = ${sigma} texels in the`,
    'slice between texels of one slice, the same in time between texels of one',
    'pixel, nothing otherwise, every distance wrapped. The initial pattern is',
    `${density * 100}% of the texels, drawn by xoshiro128** from rootSeed('${seed}').`,
    'A slice’s texels in rank order take the 256 values in equal shares.',
  ]
  const body = {
    format: 'inertialref/blue-noise',
    version: 1,
    width,
    height,
    slices,
    bytes: Buffer.from(bytes).toString('base64'),
  }
  return (
    '/*\n' +
    header.map((line) => (line ? ` * ${line}` : ' *')).join('\n') +
    '\n */\nexport const BLUE_NOISE = ' +
    JSON.stringify(body, null, 2) +
    ' as const\n'
  )
}

// `import.meta.main` rather than `process.argv[1]`, as `mieTable.ts` says:
// run through a symlink, argv names the link and nothing is written.
if (import.meta.main) {
  const start = process.hrtime.bigint()
  const bytes = generateBlueNoise()
  const seconds = Number(process.hrtime.bigint() - start) / 1e9
  const out = fileURLToPath(
    new URL(
      '../../../packages/rendering/src/blueNoise.generated.ts',
      import.meta.url,
    ),
  )
  writeFileSync(out, sourceText(bytes))
  const layout = BLUE_NOISE_MASK
  const white = whiteMask(bytes, layout, `${layout.seed}/white`)
  const spatial = (mask: Uint8Array): string => {
    const each = Array.from({ length: layout.slices }, (_, z) =>
      sliceLowEnergy(mask, layout, z),
    )
    return `mean ${(each.reduce((a, b) => a + b, 0) / each.length).toFixed(4)}, worst ${Math.max(...each).toFixed(4)}`
  }
  const cpu = cpus()[0]?.model.trim() ?? 'an unnamed CPU'
  const sha = createHash('sha256').update(bytes).digest('hex')
  console.log(
    [
      `blueNoise: wrote ${out} in ${seconds.toFixed(1)} s (${cpu}, Node ${process.version}); now run pnpm exec prettier -w on it`,
      `  bytes sha256 ${sha}`,
      `  slice energy under ¼ Nyquist / white: mask ${spatial(bytes)}; white ${spatial(white)}`,
      `  temporal energy under ¼ Nyquist / white: mask ${temporalLowEnergy(bytes, layout).toFixed(4)}; white ${temporalLowEnergy(white, layout).toFixed(4)}`,
      `  temporal energy under ½ Nyquist / white: mask ${temporalLowEnergy(bytes, layout, 0.5).toFixed(4)}; white ${temporalLowEnergy(white, layout, 0.5).toFixed(4)}`,
      `  8-slice mean variance / white: mask ${windowMeanVariance(bytes, layout).toFixed(4)}; white ${windowMeanVariance(white, layout).toFixed(4)}`,
    ].join('\n'),
  )
}
