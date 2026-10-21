import type { Meters } from '@inertialref/shared'
import { smoothstep } from '@inertialref/procedural'

/*
 * The shape of a channel and its valley: the numbers the drainage is built
 * and read with, and the cross-section a segment carves. Its own module
 * because two walks read it — the lattice's in `drainage.ts` and the
 * refinement's in `drainageRefinement.ts` — and the second is read by the
 * first, so the shape cannot live in either without a cycle.
 */

/**
 * The numbers the graph is built and read with. Exported for the reason
 * `bands.ts` gives: the TSL port in `apps/game/src/render/terrainKernel.ts`
 * reads the same constants and a tolerance test holds the two together.
 */
export const DRAINAGE_SHAPE = {
  /**
   * Cells per face edge of the lattice — 6 × 64², 24,576 nodes. A cell is
   * 156 km on Earth and 43 km on Luna, and the build across the zoo is what
   * sets it: the macro bands at every node are most of the cost, and the
   * flood is `n log n` over them. The plan's 128 is four times the nodes
   * and measured at four times the time; the lattice size is the CPU's
   * budget, and this is where it lands today.
   */
  lattice: 64,
  /** How far a node sits from its cell's center, in cells, per axis. */
  jitter: 0.25,
  /** The valley's half-width — where the carve reaches zero — in cells. */
  reach: 0.6,
  /** The deepest cut at full drainage, as a fraction of the relief budget. */
  depth: 0.13,
  /** How much of the ground's height above base a channel may take. */
  headGain: 0.85,
  /** Upstream area, in cells, at which a channel earns its full cut. */
  cutArea: 64,
  cutPower: 0.35,
  /**
   * Flint's law: the channel slope is `S₀ · A^(−θ)` with `A` in cells and
   * `S₀ = slopeGain · budget / R` — the landform's own characteristic slope
   * times a gain, so a one-cell headwater climbs steeply and a thousand-cell
   * trunk climbs at a twentieth of that.
   */
  slopeGain: 40,
  concavity: 0.45,
  /**
   * Hydraulic geometry (Leopold & Maddock 1953): channel width
   * `w = a · Q^0.5`, depth `h = c · Q^0.4`, discharge `Q = p · A`. `widthGain`
   * is the full width in meters per √(m²) of area at a meter a year of rain;
   * a 10⁶ km² catchment comes out 900 m wide and 25 m deep, which is the
   * Mississippi's order.
   */
  widthGain: 9e-4,
  depthGain: 0.4,
  depthPower: 0.4,
  /** A meter a year, in meters a second. */
  precipitation: 3.2e-8,
  /** The floodplain's half-width, in channel widths: the meander belt. */
  floodplain: 9,
  /**
   * How much of the landform's relief the floodplain keeps, past the bank.
   * A plain cut to the floor exactly is a plane thirty kilometers wide, and
   * a great river's plain read as a canal across a desert; a few percent is
   * the terraces and the old channels a plain actually has.
   */
  plainRelief: 0.06,
  /** Where the bank starts, as a fraction of the channel half-width. */
  bank: 0.6,
  /**
   * How far below its base level a river reaches the sea or a lake, as a
   * fraction of the coast width: the valley is cut before the water rose
   * into it, and the sea floods the last of it — a ria.
   */
  ria: 0.5,
  /**
   * A fill shallower than this fraction of the relief budget is a flat the
   * river crosses at its spill level and not a lake: a noise pit filled by
   * a few meters is a plain, and on a dry world with one outlet every pit
   * fills, so without the floor a fifth of Titan stood under a film.
   */
  lakeFloor: 0.0025,
  /** How far a lake node's level reaches, in cells. */
  lakeReach: 1.2,
  /**
   * How far a body's share of the kernel's weight may fall behind the
   * leading body's and still have a say in the level, as a fraction of the
   * weight in reach. A sample within reach of two bodies of standing water
   * reads the level of the one whose nodes carry the most weight, and the
   * two blend only where neither leads by this much: a tenth puts the blend
   * on a few percent of the overlap. Zero would read the leader alone, and
   * that is a step wherever the lead changes hands — wherever the weights
   * tie, with the ground under it at whatever height the lattice did not
   * sample, so the sheet and the clamp both show it, and the CPU and the
   * GPU, each comparing its own float, can name different bodies there.
   */
  lakeMargin: 0.1,
  /**
   * The fewest nodes a fill may span and be a lake. A crater under one
   * node fills to its spill like any pit, and a level read over a cell
   * around one node paints every hollow within reach at that level — which
   * is the flooded-crater field the graph exists to end. A lake is a basin
   * the lattice can see: three nodes at one level, adjacent.
   */
  lakeNodes: 3,
  /**
   * A warp under the lookup, so a segment between two nodes is a meander
   * rather than a chord: cycles per cell and amplitude in cells.
   *
   * The product is what matters. A gradient noise at `c` cycles moves at
   * up to about three times `c` per unit, so the warp's own slope is near
   * `3 · cycles · amount` — under one, the map is one to one and a
   * monotone floor stays monotone along the warped channel; over one it
   * folds, a channel is drawn twice and a bed runs uphill between the two
   * copies. Three cycles at 0.12 cells was 2.3, and folded.
   */
  warpCycles: 2,
  warpAmount: 0.08,
} as const

/**
 * The channel's half-width at an upstream area, radians on the unit sphere.
 *
 * `w = a·Q^0.5` with `Q = p·A`: the root of the area times a gain, halved
 * for the half-width and divided by the radius for an angle.
 */
export function channelHalfWidth(areaMeters: number, radius: Meters): number {
  return (0.5 * DRAINAGE_SHAPE.widthGain * Math.sqrt(areaMeters)) / radius
}

/** The channel's depth at an upstream area, meters: `h = c·Q^0.4`. */
export function channelDepth(areaMeters: number): Meters {
  return (
    DRAINAGE_SHAPE.depthGain *
    (DRAINAGE_SHAPE.precipitation * areaMeters) ** DRAINAGE_SHAPE.depthPower
  )
}

/**
 * The valley's cross-section: one over the bed, a few percent under one
 * across the floodplain, falling to zero at the reach. `d` is the distance
 * to the channel, `halfWidth` the channel's, `plain` the floodplain's and
 * `reach` the valley's, all in the same units.
 */
export function valleyShape(
  d: number,
  halfWidth: number,
  plain: number,
  reach: number,
): number {
  if (d >= reach) return 0
  const top =
    1 - DRAINAGE_SHAPE.plainRelief * smoothstep(halfWidth, 2 * halfWidth, d)
  if (d <= plain) return top
  return top * (1 - smoothstep(0, 1, (d - plain) / (reach - plain)))
}

/** The channel's own notch: one over the bed, zero past the bank. */
export function bedShape(d: number, halfWidth: number): number {
  return 1 - smoothstep(DRAINAGE_SHAPE.bank * halfWidth, halfWidth, d)
}

/** Where along the chord `b` (from `a`) the point `p − a` projects, clamped. */
export function along(
  px: number,
  py: number,
  pz: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const length = bx * bx + by * by + bz * bz
  return length > 0
    ? Math.min(1, Math.max(0, (px * bx + py * by + pz * bz) / length))
    : 0
}

/**
 * The distance from a point on the sphere to a segment's channel: to the
 * chord's foot at `t`, lifted back onto the sphere.
 *
 * A segment's chord runs under the ground it carves, by its length squared
 * over eight at the middle — 480 m on Earth's lattice and a hundred on a
 * refined creek's first level — and a channel 70 m wide measured to the
 * chord is a channel whose bed, notch and water vanish along the middle of
 * every segment, leaving the floodplain's six percent of relief showing
 * where the river should be. Measured to the arc over the chord, the bed
 * runs the whole length. The rasterizers list against the chord and widen
 * their test by the sag, which bounds the difference.
 */
export function toArc(
  x: number,
  y: number,
  z: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  t: number,
): number {
  const fx = ax + bx * t
  const fy = ay + by * t
  const fz = az + bz * t
  const lift = 1 / Math.sqrt(fx * fx + fy * fy + fz * fz)
  const ex = x - fx * lift
  const ey = y - fy * lift
  const ez = z - fz * lift
  return Math.sqrt(ex * ex + ey * ey + ez * ez)
}
