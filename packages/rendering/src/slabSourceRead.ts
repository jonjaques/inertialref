/*
 * The CPU read of the higher orders' source table, `SLAB_VIEW_SOURCE`: the
 * arithmetic a march's node performs on the GPU, written once where both the
 * generator in `apps/ingest` and the game's tests can import it. The table's
 * header figures are taken through these functions, so a node held to them is
 * held to the read the figures describe, not to a second reading of the
 * header.
 *
 * A read is in two halves. What depends on the ray alone, the hemisphere, the
 * pair of view cosines, the blend between them and the bearing's four
 * weights, is `viewReads`. What depends on the sample, the two transport
 * depths and the sun's cosine, is `readSource`, the trilinear read a linear 3D
 * texture returns, and `sourceAt` sums the reads.
 */

/** The table's axes. */
export interface SlabSourceGrid {
  /** Nodes along each depth axis. */
  readonly nodes: number
  /** Sun cosines, evenly from `sunMuMin` to one. */
  readonly suns: number
  readonly sunMuMin: number
  /** u(t) = ln(1 + t/depthScale)/ln(1 + depthMax/depthScale). */
  readonly depthScale: number
  readonly depthMax: number
}

/**
 * A table as a march reads it: a 3D texture of four channels, `nodes` square
 * in the two depths and `slabs`·`suns` deep. A slab is one stack of the sun's
 * slices, and what a slab's four channels are is its form's to say.
 */
export interface SlabSourceTable extends SlabSourceGrid {
  readonly slabs: number
  /** Four numbers a texel, laid out [slab][sun][bottom][top][channel]. */
  readonly terms: ArrayLike<number>
}

/** The transport depth's place on its axis, 0 to 1; clamped past `depthMax`. */
export function depthCoordinate(grid: SlabSourceGrid, depth: number): number {
  return Math.min(
    1,
    Math.log1p(Math.max(0, depth) / grid.depthScale) /
      Math.log1p(grid.depthMax / grid.depthScale),
  )
}

/**
 * How far inside its slab's first and last slices the sun's coordinate
 * s·(suns − 1) is held, in slices. In exact arithmetic s = 0 and s = 1 land
 * on those slices' centers, but the texture coordinate formed in float32
 * lands up to 1.5 × 10⁻⁵ of a texel past them in 18 of the 20 slabs, and
 * the slice past is the next slab's, whose mean term is 42 times the read's
 * at the median and 90 at worst. A sampler that weighs exactly adds 0.13%
 * there; one that floors its weight to 1/256 adds 16% at the median, on
 * every sample under the sun's floor. A 64th moves the sun's cosine by
 * 0.001 at the two ends and keeps the read a slice's 64th clear.
 */
export const SLAB_SUN_HOLD = 1 / 64

/**
 * Twice the diffusion's extrapolation length, 2 × 0.7104 transport depths:
 * how far past each face the diffuse light's linear fall reaches zero.
 */
export const SLAB_DIFFUSION_REACH = 1.42

/** The read's two conventions, each on unless it is named off. */
export interface SlabSourceReadOptions {
  /** Hold the sun's coordinate `SLAB_SUN_HOLD` inside its slab. */
  readonly holdSun?: boolean
  /**
   * Past the last depth node from the lit face, extend the clamped read by
   * diffusion's law rather than hold it.
   */
  readonly extend?: boolean
}

/**
 * Deep in a slab the diffuse light falls linearly to the far face, so the
 * source at depths (t_d, t_b) from the two faces goes as
 * (t_b + q)/(t_d + t_b + 2q), q the extrapolation length. Past the last
 * node from the lit face the read is at (depthMax, min(t_b, depthMax)), and
 * this is what turns it into the source at (t_d, t_b): where t_b is inside
 * the table it is (depthMax + t_b + 2q)/(t_d + t_b + 2q). Held instead,
 * transmitted light reads +62% at τ 200 and +217% at τ 400, at 10 µm. The
 * reflected side, a far face past the last node under a lit face inside
 * it, is held: its light is made near the lit face.
 */
export function diffusionExtension(
  grid: SlabSourceGrid,
  top: number,
  bottom: number,
): number {
  if (!(top > grid.depthMax)) return 1
  const reach = SLAB_DIFFUSION_REACH
  const far = Math.min(Math.max(0, bottom), grid.depthMax)
  const factor = (grid.depthMax + far + reach) / (top + far + reach)
  if (!(bottom > grid.depthMax)) return factor
  // The far face past the node as well: its own share of the source grows.
  return (
    factor *
    ((bottom + reach / 2) / (grid.depthMax + reach / 2)) *
    ((top + grid.depthMax + reach) / (top + bottom + reach))
  )
}

/**
 * A texel's four channels at transport depths `top` and `bottom` from the
 * two faces under a sun at `sunMu`, in one slab: the trilinear read a linear
 * 3D texture returns, clamped at the depths' ends and held inside the slab's
 * own first and last slices, so that no read blends two slabs, then
 * extended past the last node from the lit face (`diffusionExtension`).
 */
export function readSource(
  table: SlabSourceTable,
  slab: number,
  top: number,
  bottom: number,
  sunMu: number,
  out: Float64Array,
  options: SlabSourceReadOptions = {},
): void {
  const last = table.nodes - 1
  const x = depthCoordinate(table, top) * last
  const y = depthCoordinate(table, bottom) * last
  const hold = options.holdSun === false ? 0 : SLAB_SUN_HOLD
  const z = Math.min(
    table.suns - 1 - hold,
    Math.max(
      hold,
      ((sunMu - table.sunMuMin) / (1 - table.sunMuMin)) * (table.suns - 1),
    ),
  )
  const x0 = Math.min(last - 1, Math.floor(x))
  const y0 = Math.min(last - 1, Math.floor(y))
  const z0 = Math.min(table.suns - 2, Math.floor(z))
  const fx = x - x0
  const fy = y - y0
  const fz = z - z0
  out.fill(0, 0, 4)
  for (let corner = 0; corner < 8; corner += 1) {
    const dx = corner & 1
    const dy = (corner >> 1) & 1
    const dz = corner >> 2
    const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz)
    const cell =
      (((slab * table.suns + z0 + dz) * table.nodes + y0 + dy) * table.nodes +
        x0 +
        dx) *
      4
    for (let channel = 0; channel < 4; channel += 1)
      out[channel] = out[channel]! + weight * table.terms[cell + channel]!
  }
  if (options.extend === false) return
  const extension = diffusionExtension(table, top, bottom)
  if (extension !== 1)
    for (let channel = 0; channel < 4; channel += 1)
      out[channel] = out[channel]! * extension
}

/** One read of the table a step: a slab, and what its four channels are summed by. */
export interface SlabSourceRead {
  readonly slab: number
  readonly weights: readonly [number, number, number, number]
}

/** What of a ray the source depends on: all of it constant along a ray in a plane slab. */
export interface SlabSourceRay {
  readonly sunMu: number
  /** The cosine, to the lit face's outward normal, of light traveling to the eye. */
  readonly muV: number
  /** The part of that light's direction along the sun's own bearing: sin θ·cos φ. */
  readonly along: number
  /** The cosine between the sun's light and that light. */
  readonly nu: number
}

/**
 * The cosine of the light's bearing from the sun's. Straight toward the lit
 * face or away from it a ray has no bearing, and it is given a right angle:
 * every harmonic of a source is zero there but the mean.
 */
export function bearingCosine(
  ray: Pick<SlabSourceRay, 'muV' | 'along'>,
): number {
  const sine = Math.sqrt(Math.max(0, 1 - ray.muV * ray.muV))
  return sine < 1e-9 ? 0 : Math.max(-1, Math.min(1, ray.along / sine))
}

/**
 * cos kψ, with ψ the bearing stretched near the sun's own: ψ = π·(φ/π)^power,
 * φ = acos `cosine`. A power under one spends the harmonics where a source's
 * lobe is.
 */
export function stretchedHarmonic(
  k: number,
  power: number,
  cosine: number,
): number {
  return Math.cos(k * Math.PI * (Math.acos(cosine) / Math.PI) ** power)
}

/**
 * How a ray between two of the table's cosines blends them: in the polar
 * angle, in the cosine, or not at all. A source's first harmonic goes as
 * sin θ, which is a square root in the cosine at the pole, so a blend in the
 * cosine reads it 30% low halfway between 0.94 and 1; in the angle it is a
 * line at the pole and at the horizon both. `nearest` reads the nearer
 * cosine alone: one read a step.
 */
export type SlabViewBlend = 'angle' | 'cosine' | 'nearest'

/** A slab a ray reads, and the share of the source it carries. */
export interface SlabViewSlab {
  readonly slab: number
  readonly share: number
}

/**
 * The slabs a ray reads in a table tabulated at `cosines` of the view in
 * each hemisphere, ascending: slab = (μ_v ≥ 0 ? 0 : cosines.length) + i. A
 * ray reads the two whose cosines its |μ_v| lies between, and a ray steeper
 * or shallower than every node reads the nearest alone.
 */
export function viewSlabs(
  cosines: readonly number[],
  muV: number,
  blend: SlabViewBlend = 'angle',
): SlabViewSlab[] {
  const count = cosines.length
  const first = muV >= 0 ? 0 : count
  const mu = Math.abs(muV)
  let low = 0
  while (low + 2 < count && cosines[low + 1]! <= mu) low += 1
  if (count === 1 || mu <= cosines[0]!) return [{ slab: first, share: 1 }]
  if (mu >= cosines[count - 1]!) return [{ slab: first + count - 1, share: 1 }]
  const along = blend === 'cosine' ? (x: number) => x : Math.acos
  const share =
    (along(mu) - along(cosines[low]!)) /
    (along(cosines[low + 1]!) - along(cosines[low]!))
  if (blend === 'nearest')
    return [{ slab: first + low + (share > 0.5 ? 1 : 0), share: 1 }]
  return [
    { slab: first + low, share: 1 - share },
    { slab: first + low + 1, share },
  ]
}

/** What of the view table a ray's reads need. */
export interface SlabViewForm {
  /** The cosines the view is tabulated at in each hemisphere, ascending. */
  readonly cosines: readonly number[]
  /** The bearing's stretch: ψ = π·(φ/π)^stretch. */
  readonly stretch: number
  readonly blend?: SlabViewBlend
}

/**
 * A ray's reads of the view table: the hemisphere, the pair of cosines, the
 * blend, and the bearing's four stretched weights, (1, cos ψ, cos 2ψ, cos 3ψ)
 * times each slab's share.
 */
export function viewReads(
  form: SlabViewForm,
  ray: SlabSourceRay,
): SlabSourceRead[] {
  return viewSlabs(form.cosines, ray.muV, form.blend).map(({ slab, share }) => {
    const at = (k: number): number =>
      share * stretchedHarmonic(k, form.stretch, bearingCosine(ray))
    return { slab, weights: [at(0), at(1), at(2), at(3)] }
  })
}

/**
 * The source a ray's reads sum to at transport depths `top` and `bottom`
 * under a sun at `sunMu`, per unit of the sun's irradiance and of scaled
 * depth. `texel` is scratch for the reads.
 */
export function sourceAt(
  table: SlabSourceTable,
  reads: readonly SlabSourceRead[],
  top: number,
  bottom: number,
  sunMu: number,
  texel: Float64Array = new Float64Array(4),
  options: SlabSourceReadOptions = {},
): number {
  let source = 0
  for (const read of reads) {
    readSource(table, read.slab, top, bottom, sunMu, texel, options)
    for (let channel = 0; channel < 4; channel += 1)
      source += texel[channel]! * read.weights[channel]!
  }
  return source
}
