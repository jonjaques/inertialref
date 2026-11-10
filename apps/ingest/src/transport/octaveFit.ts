import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SLAB_REFERENCE, type CloudOctaveFit } from '@inertialref/rendering'
import { firstOrder, scatteringCosine } from './addingDoubling.ts'
import { henyeyGreenstein } from './legendre.ts'

/*
 * The octave series fitted to the slab oracle:
 * `node apps/ingest/src/transport/octaveFit.ts` writes
 * `packages/rendering/src/cloudOctaves.ts`, then `pnpm exec prettier -w`
 * formats it.
 *
 * The series stands in for the orders past the first with scaled copies of
 * first order (Wrenninge, Kulla and Lundqvist, "Oz: the great and
 * volumetric", SIGGRAPH 2013 talks): octave i attenuates the sun by aⁱ of
 * its depth, scatters bⁱ of it, and spreads it by a Henyey–Greenstein phase
 * of asymmetry cⁱ·g′, with the view's own attenuation whole. In a slab that
 * is a closed form, first order's with the sun's cosine at μ₀/aⁱ:
 *
 *   L = L₁ + Σ_{i=1}^{N−1} bⁱ·HG(ν; cⁱ·g′)·K(τ′, μ₀/aⁱ, μ)
 *
 * The three constants are shared by every band and radius, fitted on the
 * committed reference's grid slabs to the smallest worst relative error in
 * radiance, under b ≤ a: an octave never scatters more than it extinguishes
 * (the bound Wrenninge's letters give). The held-out slabs judge.
 */

/** One row of the reference as the fit reads it: the three bands as one. */
export interface OctaveRow {
  /** The scaled depth. */
  readonly depth: number
  readonly sunMu: number
  readonly viewMu: number
  readonly side: 'reflected' | 'transmitted'
  /** The scattering cosine. */
  readonly nu: number
  /** g′ at the row's radius. */
  readonly asymmetry: number
  /** First order, and the oracle's whole radiance. */
  readonly first: number
  readonly whole: number
}

/** The committed reference's rows of one set, inside the domain. */
export function octaveRows(set: 'grid' | 'held'): OctaveRow[] {
  const rows: OctaveRow[] = []
  for (const row of SLAB_REFERENCE.rows) {
    if (row.set !== set || !row.domain) continue
    const media = SLAB_REFERENCE.media.find(
      (item) => item.radius === row.radius,
    )!
    const mean = (values: readonly number[]): number =>
      (values[0]! + values[1]! + values[2]!) / 3
    rows.push({
      depth: row.depth * (1 - media.share),
      sunMu: row.sunMu,
      viewMu: row.viewMu,
      side: row.side,
      nu: scatteringCosine(
        row.sunMu,
        row.viewMu,
        (row.azimuth * Math.PI) / 180,
        row.side,
      ),
      asymmetry: media.asymmetry,
      first: mean(row.first),
      whole: mean(row.scaled),
    })
  }
  return rows
}

/** The series' radiance past first order, for a row. */
export function octaveRadiance(
  count: number,
  a: number,
  b: number,
  c: number,
  row: OctaveRow,
): number {
  let sum = 0
  for (let i = 1; i < count; i += 1)
    sum +=
      b ** i *
      henyeyGreenstein(row.nu, c ** i * row.asymmetry) *
      firstOrder(row.depth, row.sunMu / a ** i, row.viewMu, row.side)
  return sum
}

/** The worst relative error of first order plus the series, over rows. */
export function octaveError(
  count: number,
  a: number,
  b: number,
  c: number,
  rows: readonly OctaveRow[],
): number {
  let worst = 0
  for (const row of rows)
    worst = Math.max(
      worst,
      Math.abs(
        (row.first + octaveRadiance(count, a, b, c, row)) / row.whole - 1,
      ),
    )
  return worst
}

/** Steps a side of the first sweep, and the halvings of the search after it. */
const SWEEP = 10
const HALVINGS = 12

/**
 * The constants of a series of `count` orders: a sweep of the box
 * 0 < b ≤ a ≤ 1, 0 ≤ c ≤ 1, then a pattern search from its best point with
 * the step halved each time no neighbor is better. Both are deterministic,
 * so a rerun returns the same constants to the last digit.
 */
export function fitOctaves(
  count: 2 | 3 | 4,
  grid: readonly OctaveRow[],
  held: readonly OctaveRow[],
): CloudOctaveFit & { readonly gridError: number } {
  const inside = (a: number, b: number, c: number): boolean =>
    a > 0 && a <= 1 && b > 0 && b <= a && c >= 0 && c <= 1
  let best = [1, 1, 1]
  let error = Infinity
  const offer = (a: number, b: number, c: number): boolean => {
    if (!inside(a, b, c)) return false
    const at = octaveError(count, a, b, c, grid)
    if (!(at < error)) return false
    error = at
    best = [a, b, c]
    return true
  }
  for (let i = 1; i <= SWEEP; i += 1)
    for (let j = 1; j <= i; j += 1)
      for (let k = 0; k <= SWEEP; k += 1) offer(i / SWEEP, j / SWEEP, k / SWEEP)
  let step = 0.5 / SWEEP
  for (let halving = 0; halving < HALVINGS;) {
    const [a, b, c] = best as [number, number, number]
    let moved = false
    for (const [da, db, dc] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
      // Along the bound, where the best series sits: a and b together.
      [1, 1, 0],
      [-1, -1, 0],
    ] as const)
      moved = offer(a + da * step, b + db * step, c + dc * step) || moved
    if (!moved) {
      step /= 2
      halving += 1
    }
  }
  const round = (value: number): number => Number(value.toFixed(4))
  const [a, b, c] = best.map(round) as [number, number, number]
  return {
    count,
    a,
    b: Math.min(a, b),
    c,
    heldOutError: Number(
      octaveError(count, a, Math.min(a, b), c, held).toPrecision(4),
    ),
    gridError: Number(
      octaveError(count, a, Math.min(a, b), c, grid).toPrecision(4),
    ),
  }
}

/** The three fits, in order of count. */
export function fitAll(): (CloudOctaveFit & { readonly gridError: number })[] {
  const grid = octaveRows('grid')
  const held = octaveRows('held')
  return ([2, 3, 4] as const).map((count) => fitOctaves(count, grid, held))
}

/** `cloudOctaves.ts`'s text, before prettier. */
export function octavesText(
  fits: readonly (CloudOctaveFit & { readonly gridError: number })[],
): string {
  const percent = (value: number): string => `${(100 * value).toFixed(1)}%`
  const passes = fits.some((fit) => fit.heldOutError <= 0.05)
  const lines = fits.map(
    (fit) =>
      `  { count: ${fit.count}, a: ${fit.a}, b: ${fit.b}, c: ${fit.c}, heldOutError: ${fit.heldOutError} },`,
  )
  return `/*
 * The octave series' fitted constants: the higher orders as a few scaled
 * copies of first order, \`Σ bⁱ·sun.octave(aⁱ)·p(ν; cⁱ)\` for \`i\` from 1 to
 * \`count − 1\`, with \`p(ν; cⁱ)\` a Henyey–Greenstein phase of asymmetry
 * \`cⁱ·g′\`, fitted to the slab oracle's radiance on the reference's grid
 * slabs under \`b ≤ a\`, with the worst relative error each fit leaves at the
 * oracle's held-out slabs.
 *
 * The constants are written by \`node apps/ingest/src/transport/octaveFit.ts\`
 * from \`slabReference.generated.ts\`; rerun it rather than editing them, then
 * \`pnpm exec prettier -w\` this file. On the grid the fits' worst errors are
 * ${fits.map((fit) => `${percent(fit.gridError)} at ${fit.count} orders`).join(', ')}.
 *
 * **${passes ? 'A fit is inside the bound.' : 'No fit is inside the bound.'}** \`cloudOctavesPass\` is ${passes}, so the march
 * ${passes ? 'may draw' : 'draws no'} octave branch.
 */

export interface CloudOctaveFit {
  /** Orders the series stands for, first order among them: 2, 3 or 4. */
  readonly count: 2 | 3 | 4
  /** An octave's extinction scale, its scattering scale, and its phase's asymmetry scale. */
  readonly a: number
  readonly b: number
  readonly c: number
  /** The fit's worst relative error in radiance at the held-out points. */
  readonly heldOutError: number
}

/** One fit a count, in order of count. */
export const CLOUD_OCTAVES: readonly CloudOctaveFit[] = [
${lines.join('\n')}
]

/** The bound a fit's held-out error must be inside for the series to be drawn at all. */
export const CLOUD_OCTAVE_BOUND = 0.05

/** Whether any fit is inside the bound: what decides that the octave branch is built. */
export function cloudOctavesPass(
  fits: readonly CloudOctaveFit[] = CLOUD_OCTAVES,
): boolean {
  return fits.some((fit) => fit.heldOutError <= CLOUD_OCTAVE_BOUND)
}
`
}

if (import.meta.main) {
  const fits = fitAll()
  const out = fileURLToPath(
    new URL(
      '../../../../packages/rendering/src/cloudOctaves.ts',
      import.meta.url,
    ),
  )
  writeFileSync(out, octavesText(fits))
  for (const fit of fits) console.log(fit)
  console.log(`octaveFit: wrote ${out}; now run pnpm exec prettier -w on it`)
}
