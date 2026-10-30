import { vec3 } from '@inertialref/spatial'
import type { SurfaceParameters } from './system.ts'
import {
  directionToFace,
  drawnElevation,
  HEIGHTFIELD_RESOLUTION,
  regionDirection,
  regionForDirection,
  seaDatumElevation,
  surfaceDetailFloor,
} from './terrain.ts'

/*
 * The slope a deposit reads, made the same at every level of detail.
 *
 * The material chooses bedrock against mantle, and the flat-ground deposits
 * against both, from the slope of the mesh normal under the pixel — and the
 * mesh is a level of detail. A patch's normal is a central difference over
 * its own cell, so a coarse patch reports the slope of the ground smoothed
 * over its cell and a fine one the slope of the ground it resolves: the same
 * ground draws rockier the finer it is drawn, by 0.4 to 1.4% of the drawn
 * value at each level boundary on Iapetus and the shore world, and up to 4.1%
 * over a single patch. That is a ring of tone around the camera at every
 * morph band.
 *
 * The slope at a fixed baseline in place of the patch's own does not end it.
 * A point sample of a slope taken over a few meters, read at a vertex a
 * hundred meters from the next, is aliased: the mean comes right and every
 * coarse vertex draws a different random answer, 8 to 10% apart from the
 * level beside it against 2.5 to 3.1% for the mesh, at three times a patch's
 * cost. What a coarse patch should draw is the *distribution* of slopes the
 * floor would, not any one of them.
 *
 * So the slope a level draws is mapped onto the floor's distribution: for
 * each level, the quantile a drawn slope holds among that level's drawn
 * slopes is the quantile it is given among the floor's. Rank is kept — the
 * steepest ground at a coarse level is still where its bedrock goes — and the
 * fraction of the ground past any threshold the material draws is the floor's
 * at every level, so the tone a level draws on average is the floor's. It is
 * measured per body, over probes of the drawn field, and it is a model: a
 * region rougher or smoother than its body's average draws its level's
 * correction regardless, which is the spread that remains.
 */

/** Knots per level, uniform on log₁₀ tan² from `…_LOW` to `…_HIGH`. */
export const DEPOSIT_SLOPE_KNOTS = 32

/** tan² of 10⁻⁷ is 0.02° — flat to any threshold — and 10 is 72°. */
export const DEPOSIT_SLOPE_LOG_LOW = -7
export const DEPOSIT_SLOPE_LOG_HIGH = 1

/**
 * Probe directions a body's table is measured over.
 *
 * The thresholds the material draws against — the mantle sheds from 25° and
 * is gone by 49° — sit in the upper tenth of the slope distribution on an
 * airless body, so the table's useful half is a tail, and a tail wants
 * counts. At 256 probes the mean step left was 0.4 to 1.0% from one body to
 * the next, sampling noise in the tail; at 1,024 the largest left at any
 * level is 0.28% on Iapetus, 0.29% on the shore world and 0.16% on Gliese
 * 908 IV.
 */
export const DEPOSIT_SLOPE_PROBES = 1_024

/**
 * A body's slope table: `levels` rows of `DEPOSIT_SLOPE_KNOTS`, row L the
 * log₁₀ tan² a level-L patch's drawn slope maps to at each knot. The floor's
 * row is the identity.
 */
export interface DepositSlopeTable {
  /** Rows: the detail floor plus one, one per level a patch is drawn at. */
  readonly levels: number
  readonly table: Float32Array
}

const tables = new WeakMap<SurfaceParameters, DepositSlopeTable>()

/**
 * The knot k's tan², the value the table is sampled at.
 */
export const depositSlopeKnot = (k: number): number =>
  10 **
  (DEPOSIT_SLOPE_LOG_LOW +
    ((DEPOSIT_SLOPE_LOG_HIGH - DEPOSIT_SLOPE_LOG_LOW) * k) /
      (DEPOSIT_SLOPE_KNOTS - 1))

/**
 * The table for a body. Deterministic — probes on a golden-angle spiral, the
 * drawn field at each — and memoized on the surface. Presentational: nothing
 * canonical reads it, and nothing reads it but the material.
 *
 * Cost is the probes: `DEPOSIT_SLOPE_PROBES` directions, ten drawn samples at
 * each level from the root to the floor — 133,000 to 205,000 samples across
 * the zoo, which is a worker's job and never a frame's.
 */
export function depositSlopeTable(
  surface: SurfaceParameters,
  resolution: number = HEIGHTFIELD_RESOLUTION,
  count: number = DEPOSIT_SLOPE_PROBES,
): DepositSlopeTable {
  // Memoized at the production count and resolution only; a test asking for
  // fewer probes gets its own answer and leaves the body's alone.
  const canonical =
    resolution === HEIGHTFIELD_RESOLUTION && count === DEPOSIT_SLOPE_PROBES
  const held = canonical ? tables.get(surface) : undefined
  if (held !== undefined) return held
  const floor = surfaceDetailFloor(surface, resolution)
  const levels = floor + 1
  const samples: number[][] = Array.from({ length: levels }, () => [])
  const sea = seaDatumElevation(surface)
  // Four candidates a probe, so a world four-fifths sea still finds its count
  // on land; the sea's own ground is the seabed under a sheet, not a deposit.
  const candidates = count * 4
  let probes = 0
  for (let i = 0; i < candidates && probes < count; i += 1) {
    const z = 1 - (2 * i + 1) / candidates
    const around = i * Math.PI * (3 - Math.sqrt(5))
    const ring = Math.sqrt(Math.max(0, 1 - z * z))
    const d = vec3(Math.cos(around) * ring, z, Math.sin(around) * ring)
    if (sea !== null && drawnElevation(surface, d) <= sea) continue
    probes += 1
    for (let level = 0; level < levels; level += 1) {
      ;(samples[level] as number[]).push(
        drawnTan2(surface, d, level, resolution),
      )
    }
  }
  for (const level of samples) level.sort((a, b) => a - b)
  const reference = samples[floor] as number[]
  const table = new Float32Array(levels * DEPOSIT_SLOPE_KNOTS)
  for (let level = 0; level < levels; level += 1) {
    const from = samples[level] as number[]
    for (let k = 0; k < DEPOSIT_SLOPE_KNOTS; k += 1) {
      const knot = depositSlopeKnot(k)
      const mapped =
        level === floor || from.length === 0
          ? knot
          : quantileOf(reference, rankOf(from, knot))
      table[level * DEPOSIT_SLOPE_KNOTS + k] = Math.log10(
        Math.max(mapped, 1e-12),
      )
    }
  }
  const answer = { levels, table }
  if (canonical) tables.set(surface, answer)
  return answer
}

/**
 * The slope a deposit reads, for a drawn slope on a level-`level` patch slid
 * `morph` of the way onto its parent's grid — the material's arithmetic,
 * which `slopeTable.gpu.test.ts` holds the graph to.
 *
 * `slope` is `1 − cos θ`, the form the material reads, and so is the answer.
 * The table is read in log₁₀ tan², linear between knots, and the patch's row
 * and its parent's are mixed there by the morph. A negative level reads the
 * slope as drawn; a level past the table's rows, or no table, the identity.
 * Both conversions are taken in the forms that do not cancel near flat,
 * where every threshold the material draws against sits.
 */
export function depositSlopeAt(
  table: DepositSlopeTable | null,
  level: number,
  morph: number,
  slope: number,
): number {
  if (level < 0) return slope
  const cosine = Math.max(1 - slope, 1e-4)
  const tan2 = Math.max((slope * (2 - slope)) / (cosine * cosine), 1e-12)
  const at = Math.min(
    DEPOSIT_SLOPE_KNOTS - 1,
    Math.max(
      0,
      ((Math.log10(tan2) - DEPOSIT_SLOPE_LOG_LOW) /
        (DEPOSIT_SLOPE_LOG_HIGH - DEPOSIT_SLOPE_LOG_LOW)) *
        (DEPOSIT_SLOPE_KNOTS - 1),
    ),
  )
  const knot = Math.min(Math.floor(at), DEPOSIT_SLOPE_KNOTS - 2)
  const along = at - knot
  const rows = table?.levels ?? 0
  const value = (row: number, k: number): number =>
    row < rows
      ? ((table as DepositSlopeTable).table[
          row * DEPOSIT_SLOPE_KNOTS + k
        ] as number)
      : Math.log10(depositSlopeKnot(k))
  const read = (row: number): number =>
    value(row, knot) + (value(row, knot + 1) - value(row, knot)) * along
  const own = read(level)
  const mapped = own + (read(Math.max(level - 1, 0)) - own) * morph
  const t = 10 ** mapped
  const s = Math.sqrt(1 + t)
  return t / (s * (s + 1))
}

/** Where `x` falls in a sorted sample, as a fraction 0..1, interpolated. */
function rankOf(sorted: readonly number[], x: number): number {
  const n = sorted.length
  if (x <= (sorted[0] as number)) return 0
  if (x >= (sorted[n - 1] as number)) return 1
  let low = 0
  let high = n - 1
  while (high - low > 1) {
    const mid = (low + high) >> 1
    if ((sorted[mid] as number) <= x) low = mid
    else high = mid
  }
  const a = sorted[low] as number
  const b = sorted[high] as number
  return (low + (b > a ? (x - a) / (b - a) : 0)) / (n - 1)
}

/** The value at fraction `q` of a sorted sample, interpolated. */
function quantileOf(sorted: readonly number[], q: number): number {
  const at = q * (sorted.length - 1)
  const low = Math.floor(at)
  const high = Math.min(sorted.length - 1, low + 1)
  const a = sorted[low] as number
  return a + ((sorted[high] as number) - a) * (at - low)
}

/**
 * tan² of the slope a level-L patch draws at a direction: the three vertex
 * normals of the triangle under it, each a central difference over one cell
 * as `buildPatch` takes it, interpolated as the material interpolates them.
 * The drawn statistic rather than the vertex one, because interpolation is
 * itself a smoothing at each level's own scale, and a table measured on the
 * vertices leaves half a percent of step behind.
 */
function drawnTan2(
  surface: SurfaceParameters,
  d: { readonly x: number; readonly y: number; readonly z: number },
  level: number,
  resolution: number,
): number {
  const region = regionForDirection(d, level)
  const { u, v } = directionToFace(d)
  const span = 2 ** level
  const step = resolution - 1
  const col = (((u + 1) / 2) * span - region.i) * step
  const row = (((v + 1) / 2) * span - region.j) * step
  const c0 = Math.min(step - 1, Math.floor(col))
  const r0 = Math.min(step - 1, Math.floor(row))
  const fx = col - c0
  const fy = row - r0
  const cache = new Map<number, readonly [number, number, number]>()
  const at = (r: number, c: number): readonly [number, number, number] => {
    const key = r * 4096 + c
    const held = cache.get(key)
    if (held !== undefined) return held
    const p = regionDirection(region, c / step, r / step)
    const radius = 1 + drawnElevation(surface, p) / surface.grammar.meanRadius
    const point = [p.x * radius, p.y * radius, p.z * radius] as const
    cache.set(key, point)
    return point
  }
  let nx = 0
  let ny = 0
  let nz = 0
  const add = (r: number, c: number, weight: number): void => {
    const e = at(r, c + 1)
    const w = at(r, c - 1)
    const n = at(r + 1, c)
    const s = at(r - 1, c)
    const ux = e[0] - w[0]
    const uy = e[1] - w[1]
    const uz = e[2] - w[2]
    const vx = n[0] - s[0]
    const vy = n[1] - s[1]
    const vz = n[2] - s[2]
    let cx = uy * vz - uz * vy
    let cy = uz * vx - ux * vz
    let cz = ux * vy - uy * vx
    const length = Math.hypot(cx, cy, cz) || 1
    // Outward on every face, as `buildPatch` orients it.
    const sign = cx * d.x + cy * d.y + cz * d.z < 0 ? -1 : 1
    cx = (cx / length) * sign
    cy = (cy / length) * sign
    cz = (cz / length) * sign
    nx += cx * weight
    ny += cy * weight
    nz += cz * weight
  }
  if (fx + fy <= 1) {
    add(r0, c0, 1 - fx - fy)
    add(r0, c0 + 1, fx)
    add(r0 + 1, c0, fy)
  } else {
    add(r0 + 1, c0 + 1, fx + fy - 1)
    add(r0 + 1, c0, 1 - fx)
    add(r0, c0 + 1, 1 - fy)
  }
  const cos = Math.min(
    1,
    (nx * d.x + ny * d.y + nz * d.z) / (Math.hypot(nx, ny, nz) || 1),
  )
  return 1 / (cos * cos) - 1
}
