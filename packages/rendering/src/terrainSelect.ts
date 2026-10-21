import type { Meters, Radians } from '@inertialref/shared'
import { Vec, type Vec3 } from '@inertialref/spatial'
import {
  aspectRatio,
  BASELINE_VIEWPORT,
  type Lens,
  LENS_PRESETS,
  pixelAngle,
  pixelsPerRadian,
  verticalFov,
  type Viewport,
} from './lens.ts'
import {
  type BodyFixedDirection,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  regionAddress,
  regionChildren,
  regionDirection,
  regionNeighbor,
  regionSize,
} from '@inertialref/universe'

/*
 * Which patches of ground the camera is asking for.
 *
 * A quadtree walked once per frame from the six cube faces, refined where a
 * patch's own grid is coarser than the screen can tell, and stopped everywhere
 * else. It replaces a 3×3 window at one level, which was a few patches wide,
 * had holes at every cube-face edge, and faded out entirely an octave above the
 * ground — so the horizon was the datum sphere and two of Miranda's six survey
 * sites were ground that could not be looked at from any altitude.
 *
 * Three things this owns, and each is here rather than in the streamer for the
 * same reason the window was: the streamer needs a browser and a GPU to answer
 * a question, and this needs a function call. `ir.descend` measures a descent
 * because of it.
 *
 * **The metric is a patch's grid spacing, not its height error.** Ulrich's
 * screen-space-error predicate wants the mesh's true vertical deviation from
 * the surface, and on a planet that number is startlingly small: Earth's 20 km
 * of relief across a 10,000 km cube face is two parts in a thousand, and a
 * patch's 64 quads cut it by another 64 — so a height-error metric alone says a
 * 156 km patch is close enough to stand on. Cesium's shipping tiles carry a
 * geometric error equal to their own sample spacing for exactly this reason.
 * The number used here is that spacing: the size of the smallest thing a patch
 * can express, which is what detail means to someone looking at it whether or
 * not the field happened to put relief at that scale. Refine while one grid
 * cell subtends more than `cellPixels`.
 *
 * **Distance is measured to the ground, not to the datum.** The old rules took
 * `distance − radius`, which for a camera standing on a mountain is
 * `elevation + height` — so a summit streamed a level coarse, a summit above
 * `radius · 2^(5.5 − maxLevel)` was not drawn at all, and flying level across
 * Iapetus re-requested the world as the ground rose and fell beneath it. Here a
 * node is a cone of directions crossed with the shell the ground can occupy,
 * `[radius − relief, radius + relief]`, and the distance is to the nearest
 * point of *that* — which is zero when the eye is inside the shell, which is
 * what standing on the ground means.
 *
 * **The far side costs nothing.** A node is dropped when its cone lies wholly
 * beyond the horizon, allowing for the fact that a peak at `radius + relief`
 * stays visible some way past the horizon of the sphere at `radius − relief`.
 * Cesium's occlusion-point construction is the same idea with the bookkeeping
 * attached to a precomputed point rather than to a cone.
 */

/**
 * The optics the predicate is a statement about.
 *
 * A node refines while `distance < spacing · scale` and `scale` goes as
 * `pixelsPerRadian`, so doubling it is one more level of refinement everywhere
 * on the visible disk. The focal-length control spans 8.1× of it — 378 px/rad
 * at 110° to 3,062 at 20° — which is three levels, and the zoom channel
 * multiplies another 8× for six levels across the two sliders together. The
 * patches do not follow the square of it: refinement runs out of *levels* at
 * `surfaceDetailFloor` before it runs out of budget, so 20° at zoom 1 measures
 * 1.9× to 3.2× the demand rather than the 66× the arithmetic suggests —
 * `DEFAULT_MAX_PATCHES` below carries the counts, including the corner where
 * the floor is reached and the square starts to bite again. That is why the
 * predicate takes the lens the picture is actually composed through rather than
 * a nominal angle: a fixed one is right for exactly one setting of the two
 * controls and wrong by six levels at their ends.
 *
 * `LENS_PRESETS.flight` over `BASELINE_VIEWPORT` — 65° over 1080 display
 * pixels, which is 848 px/rad. The streamer passes the live lens; this is what
 * the headless probe and the tests measure against, and naming it here is what
 * keeps those numbers comparable between runs.
 */
export const DEFAULT_LENS: Lens = LENS_PRESETS.flight
export const DEFAULT_VIEWPORT: Viewport = BASELINE_VIEWPORT

/**
 * How many pixels one grid cell of a patch may cover before it is refined.
 *
 * Less of a dial than it looks, once the tree is restricted. A balanced
 * quadtree grading from the level underfoot out to the level at the horizon has
 * a floor of its own — standing on Miranda at the flight lens, 408 patches at
 * 32 px and 414 at 24 — and below about sixteen pixels the error predicate
 * starts adding on top of it: 438 at 16, 597 at 8, 720 at 6. So this sits where
 * the two curves meet.
 *
 * Measured at 16 px, at the flight lens over 1080 display pixels, standing at
 * two meters: 294 patches on Earth, 330 to 438 across the zoo — 1.24 to 1.85 M
 * vertices, which at four vec3 attributes is 60 to 89 MB of vertex buffers, and
 * 2.4 to 3.6 M triangles selected, of which the renderer's own frustum culling
 * draws roughly a third. Packing the four vertex attributes below float32 is
 * worth about half the memory and frustum-culling the *selection* about half
 * again; both are measured-before-optimized rather than done here.
 *
 * The near field does not depend on this at all: the patch underfoot is at
 * `maxLevel`, where the predicate is switched off, so what this decides is how
 * fast detail falls away with distance.
 */
export const DEFAULT_CELL_PIXELS = 16

/**
 * The deepest level to ask for when the caller does not say.
 *
 * Callers with a body should pass `surfaceDetailFloor` instead, which measures
 * where *that* field stops having anything to add — level 12 to 19 across the
 * zoo now that the presentational tail carries sub-floor craters, against 10 to
 * 16 for the canonical field alone and 7 to 10 for the three bands before it.
 * This is the fallback for a caller holding numbers rather than a body, and it
 * is deliberately no deeper than any of them — it *is* the shallowest the zoo
 * measures — so forgetting to pass one is visible as coarse ground rather than
 * as a budget that will not close. Twelve rather than thirteen because Miranda
 * is the shallowest and it is twelve; a fallback one level past a body's own
 * floor is the failure this constant exists to prevent, arriving through the
 * constant.
 */
export const DEFAULT_MAX_LEVEL = 12

/**
 * How many patches may be selected at once.
 *
 * A safety net rather than a working limit, and the lens is what says how much
 * of a net it is. At the flight lens an uncapped whole-disk selection wants
 * between 476 and 1,077 patches across the zoo's twenty-four site descents, so
 * this never binds on a lens a player flies with; at the wide end of the
 * slider it is lower still.
 *
 * **It was 768, then 1,024, and each time it was the field getting deeper.** A
 * whole-disk selection costs about ninety patches per level between the horizon
 * and the ground. The band stack pushed `surfaceDetailFloor` from 7–10 to 10–16
 * because crater rims are sharp; the presentational tail pushed it to 12–19,
 * because the sub-floor crater band cuts up to 0.8 m and that is over the
 * tolerance a cell is refined against. Every extra level underfoot is another ring of
 * patches. Holding the old cap would have spent this phase's whole point: the
 * worst of the twenty-four descents wants 1,077 and would degrade by a level on
 * the ground, which is exactly where the new detail is.
 *
 * **What that buys costs 346 MB in the corner case.** A patch carries
 * positions, normals and both morph targets — 65² vertices, twelve floats
 * apiece, 203 KB — plus **two** eight-byte cover records, the vertex's own and
 * its morph target's, which is 67.6 KB rather than the 34 one of them is. So a
 * patch is 270 KB, 1,280 of them is 5.4 M vertices and 346 MB of buffers, and
 * the old cap was 243 MB. The number is here so that the next person to want it
 * raised knows what they are buying, and `GEOMETRY_CACHE` is twice this, which
 * is the number that actually sizes the resident set. Packing the four vertex
 * attributes below float32 halves both and is the outstanding lever; it is
 * measured-before-optimized rather than done here.
 *
 * **It binds at the telephoto end and on a retina window, and by how much is
 * measured rather than adjectival.** At 20° the same descents want two to
 * three times the flight lens's count; a 1600×900 window at DPR 2 is 3200×1800
 * display pixels, one level deeper everywhere, and the Mars landing's hover
 * wants 1,583 patches there against 874 at DPR 1. What the cap does when it
 * binds is `COARSEN_STEP` below: the tolerance is loosened and the walk
 * retaken, so the disk goes coarse by a stated fraction of a level everywhere
 * the eye is not standing, and the ground underfoot keeps the floor.
 *
 * **The zoom channel goes three levels past that, and no cap covers it.** At 20°
 * with the zoom racked to 8× the picture is a 2.5° field at 24,500 px/rad, and
 * Miranda's basin descent wanted **20,174** patches at the old detail floor —
 * an order of magnitude past any cap, past the loosest tolerance, and
 * `saturated` on every step. That is a telephoto held on a subject rather than
 * a lens anything is flown behind, and the honest answer is the one the cap
 * gives: the disk goes coarse, by a stated amount, rather than the frame going
 * away.
 */
export const DEFAULT_MAX_PATCHES = 1_280

/**
 * How the tolerance is loosened when the cap binds, and how far.
 *
 * A selection over `maxPatches` is not truncated at the level that overflowed.
 * It is retaken with `cellPixels` multiplied by this, and again, up to
 * `COARSEN_STEPS` times, until it fits; only past the loosest tolerance is the
 * tree cut off where it stands and reported `saturated`.
 *
 * The breadth-first cut is the wrong degradation for a camera on the ground,
 * and the Mars landing is where it showed. It takes the deepest level from
 * everybody at once, and everybody includes the node the eye is standing in:
 * at 3200×1800 display pixels the hover wants 1,583 patches against 1,280, and
 * the cut tree stops at level 13 with the camera a meter off ground whose
 * floor is 16 — three levels, eight times the cell, and it arrives in steps,
 * 16→15→14→13, as the lens narrows through the settle. Loosened to 1.5× the
 * same eye wants 1,011 and the ground underfoot is still level 16, because a
 * node the eye is inside is at distance zero and refines at any tolerance.
 * Every ring further out moves in by the step instead — a fraction of a level
 * spread over the whole disk, which the morph carries, rather than a level
 * taken from the one place the picture is looking.
 *
 * Crack-free by construction: a coarsened walk is the same predicate with a
 * different constant, so the handover argument in `regionSpacing` holds
 * unchanged. The step is 1.5 rather than 2 because 2 is a whole level and a
 * whole level arriving in one frame is the pop this exists to remove; three
 * steps reach 3.4×, a level and three quarters, which covers a DPR 2 window at
 * the telephoto end and stops short of pretending a racked zoom fits. The
 * retry is a second walk on the frames it fires — the first walk stops at the
 * overflow and skips the balance pass, so it costs less than a full one — and
 * a caller that hands back `coarsening` pays it on the frame the cap first
 * binds rather than on every frame after.
 *
 * **It buys nothing where the tree is balance-limited**, and the cut is the
 * answer there as before. `DEFAULT_CELL_PIXELS` says the graded tree has a
 * floor of its own; at the flight lens over 3200×1800, a meter off the
 * ground, the 2:1 rings are what set the count and the predicate is not what
 * binds — loosening 16 px to 54 px cuts under 5% of the patches across
 * thirty-six eyes on Mars and on Earth. The ladder is climbed and reports
 * `saturated` at the top. Where the predicate binds, the same eyes through
 * the landing's 34° lens, one step is the 1,583 → 1,011 above.
 */
export const COARSEN_STEP = 1.5
export const COARSEN_STEPS = 3

/**
 * Where a patch starts and finishes sliding onto its parent's grid, as
 * multiples of the distance its own cells subtend `cellPixels` at.
 *
 * A patch is selected from that distance outward and its parent takes over at
 * twice it, so the whole band is [1, 2]. Below `MORPH_START` a patch draws its
 * own tessellation; above `MORPH_END` it is exactly its parent's, which is what
 * makes the handover invisible.
 *
 * `MORPH_END` is 1.8 rather than 2 because the band has to close *before* the
 * parent's range rather than at it. A patch is selected from its own range
 * outward, so a coarser neighbor that did not refine is at least its own range
 * away — which is exactly twice this patch's, since `regionSpacing` is nominal
 * per level and therefore the same everywhere on the cube. 1.8 leaves a tenth
 * of the band as margin for the eye's own motion between the frame the
 * selection was taken on and the frame it is drawn on, and costs a sliver of
 * detail at the far end of a patch's life.
 */
export const MORPH_START = 1.25
export const MORPH_END = 1.8

/**
 * The lens the ground outside the frame is refined at, when the picture's own
 * lens is longer.
 *
 * A telephoto's pixel angle is a claim about what is inside its frame and
 * nothing else. Refining the whole disk at it spends the cap on ground behind
 * the camera, so a selection that knows where the picture looks refines at
 * the lens only inside the frame and at this lens everywhere else.
 *
 * The flight lens, because it is the one the whole disk is already sized for,
 * and because it makes the claim about a turn of the head exact rather than
 * approximate: at the flight lens and anything wider nothing changes, and at
 * any longer lens what a turn streams is the telephoto's increment over ground
 * already resident at the flight lens's detail — never a hole.
 */
export const REFERENCE_LENS: Lens = LENS_PRESETS.flight

/**
 * How far past the frame's corners the long lens's refinement reaches, in the
 * lens's own display pixels.
 *
 * In pixels rather than an angle because both things it has to cover scale
 * with the lens. A drag turns the head one pixel angle a pixel (rule 36), so a
 * turn is a number of pixels whatever the focal length; and a patch near its
 * own range is `(resolution − 1) · cellPixels` across — 1,024 px at 16 px a
 * cell — whatever the focal length too. The regime boundary costs the patches
 * along it their own level, because their morph is taken at the reference
 * scale to keep the handover crack-free (`selectTerrain` says why), so the
 * margin is what keeps that ring of patches out of the frame.
 */
export const VIEW_MARGIN_PIXELS = 1_024

/** A node's extent: the cone of directions it covers. */
export interface RegionCone {
  /** Unit direction of the node's center. */
  readonly axis: Vec3
  /** Angle from `axis` to the farthest corner. */
  readonly halfAngle: Radians
}

/**
 * The cone a region occupies, measured from its own corners.
 *
 * The four edges of a cell are great-circle arcs — fixing u traces a plane
 * through the origin — so the cell is a convex spherical quadrilateral and its
 * farthest point from the center is a corner. The cone therefore contains it
 * exactly, which is what lets the horizon test and the distance be conservative
 * without a fudge factor.
 */
export function regionCone(region: RegionAddress): RegionCone {
  const axis = regionDirection(region, 0.5, 0.5)
  let cosine = 1
  for (const [s, t] of CORNERS) {
    const dot = Vec.dot(axis, regionDirection(region, s, t))
    if (dot < cosine) cosine = dot
  }
  return { axis, halfAngle: Math.acos(Math.min(1, Math.max(-1, cosine))) }
}

const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
]

/**
 * Ground covered by one grid cell of a patch at this level.
 *
 * The patch's geometric error, and the thing the whole selection turns on, so
 * it is one function: `terrainMesh` sizes a patch's morph band with it and the
 * traversal decides to refine with it. A disagreement between those two puts a
 * patch's handover somewhere other than where its neighbor expects it, which is
 * a crack.
 *
 * **It is the nominal size for the level, not the region's measured span, and
 * that is deliberate.** The gnomonic map is not equal-area — a cell at the
 * middle of a cube face covers up to 2.1× the ground of one at a corner — so
 * measuring each region gives a strictly better description of how big a patch
 * is, and correcting for it is what Zucker & Higashi (JCGT 2018) is about. It
 * was measured here, and it breaks the property the whole phase is for.
 *
 * The no-crack argument is: a patch is fully morphed onto its parent's grid
 * wherever a coarser patch abuts it, because the coarser one did not refine and
 * so is at least its own range away. That needs the finer patch's handover
 * distance to be under the coarser patch's range — and with measured spans,
 * those two are measured at *different points on the face*, where the scale
 * differs by up to 22% at level 2. A patch would be 15% short of its neighbor's
 * grid, which is a lit gap. The distortion is smooth in position and the level
 * is not, and no per-node number can be both.
 *
 * So the correction is not applied, and what it costs is stated rather than
 * hidden: a cell near a cube corner is refined as though it were up to twice
 * its real size, which is one extra level over the eight regions around the
 * cube's corners. Measured across the zoo that is 6–11% more patches — against
 * a hairline seam wherever two levels meet.
 */
export const regionSpacing = (
  radius: Meters,
  region: RegionAddress,
  resolution: number = HEIGHTFIELD_RESOLUTION,
): Meters => regionSize(radius, region.level) / (resolution - 1)

/** Where the camera is, and the shell of ground it is looking at. */
export interface TerrainEye {
  readonly radius: Meters
  /**
   * Peak-to-datum relief, meters.
   *
   * Bounds the shell `[radius − relief, radius + relief]` that ground can
   * occupy. It is used for the distance and for the horizon and nothing else,
   * so an over-estimate costs patches and an under-estimate cuts off a peak —
   * `surface.maxElevation` is the generator's own bound and is the right
   * number.
   */
  readonly relief: Meters
  /** Eye distance from the body's center. */
  readonly distance: Meters
  /** Eye direction in the body's rotating axes. */
  readonly direction: BodyFixedDirection
}

/**
 * Where the picture looks, for a selection that may refine a long lens only
 * inside its frame.
 */
export interface TerrainView {
  /**
   * The camera's forward: a unit vector in the body's rotating axes, the same
   * axes `TerrainEye.direction` is in.
   */
  readonly forward: Vec3
}

export interface TerrainSelectOptions {
  readonly maxLevel?: number
  readonly cellPixels?: number
  /** The lens the picture is taken with. Defaults to the flight lens. */
  readonly lens?: Lens
  /**
   * Where the picture looks. Omitted, the whole disk is refined at `lens`,
   * which is the conservative answer for a caller that does not know.
   *
   * Given, and with `lens` longer than `reference`, ground the frame cannot
   * see — outside the frame's cone widened by `viewMarginPixels` — is refined
   * at `reference` instead. At a lens no longer than `reference` the view
   * changes nothing.
   */
  readonly view?: TerrainView
  /** The lens ground outside the view is refined at. `REFERENCE_LENS`. */
  readonly reference?: Lens
  /** The view's margin past the frame's corners. `VIEW_MARGIN_PIXELS`. */
  readonly viewMarginPixels?: number
  /**
   * The picture's size in *display* pixels.
   *
   * Not the drawing buffer's. Supersampling raises the sample count, not the
   * detail a viewer can resolve, so feeding a 4× AA buffer height in here asks
   * for 6.5× the patches to draw geometry the resolve filter averages away. The
   * caller divides its own factor out; the place to spend on sharper terrain is
   * `cellPixels`, where it is a decision with a number on it.
   */
  readonly viewport?: Viewport
  readonly resolution?: number
  readonly maxPatches?: number
  /**
   * The multiple of `cellPixels` to start from — the `coarsening` the last
   * selection settled at, handed back by a caller that walks every frame.
   *
   * Starting from 1 every frame is a wasted walk on every frame the cap
   * binds; starting from the last answer is one walk while nothing changes.
   * The caller decides when to try a finer tolerance again, because only it
   * knows how far under the cap the last selection came in.
   */
  readonly coarsening?: number
  /**
   * Refine only into regions this says are drawable.
   *
   * The streamer's answer is "its geometry is built" — the mesh rather than the
   * heightfield, because a region whose field has arrived but whose vertices
   * have not is one `state()` cannot place. Refining into a region that is not
   * drawable is what produces a hole; stopping at the
   * parent produces a coarser picture of the same ground, which is what a
   * descent should look like while it loads. Omitted means everything is ready,
   * which is the question the *request* set asks.
   */
  readonly ready?: (region: RegionAddress) => boolean
}

export interface SelectedPatch {
  readonly region: RegionAddress
  /** Ground one grid cell covers, meters. */
  readonly spacing: Meters
  /** Eye to the nearest point the node's ground can occupy, meters. */
  readonly distance: Meters
  /** Beyond this the patch begins sliding onto its parent's grid. */
  readonly morphStart: Meters
  /** At this distance it has arrived, and the parent takes over. */
  readonly morphEnd: Meters
  /**
   * Refined at the picture's own lens rather than at the reference: the
   * node's ground can be in the frame. Always true without a view.
   */
  readonly inView: boolean
}

export interface TerrainSelection {
  /**
   * Everything to draw.
   *
   * Deterministic — the same eye and body give the same array, which is the
   * property that matters — but the order is the traversal's own and is not
   * sorted by anything a caller would want. A streamer spending a per-frame
   * budget on it has to order it itself.
   */
  readonly patches: readonly SelectedPatch[]
  readonly deepestLevel: number
  readonly shallowestLevel: number
  /** Nodes the traversal looked at — what the selection cost. */
  readonly visited: number
  /** Nodes dropped beyond the horizon. Most of a planet, most of the time. */
  readonly culled: number
  /**
   * Selected patches refined at the reference lens because the frame cannot
   * reach them. Zero without a view, and at any lens no longer than the
   * reference.
   */
  readonly outside: number
  /**
   * Nodes that stopped short because `ready` said a child was not there.
   *
   * The regions rather than a count, because they are what a streamer has to do
   * something about: these are the patches being drawn coarse right now, and
   * their four children are the next thing worth a worker. Empty when no
   * `ready` was given, which is the question the request set asks.
   */
  readonly starved: readonly RegionAddress[]
  /**
   * The multiple of `cellPixels` the selection is made at: 1 when the cap
   * never bound, a power of `COARSEN_STEP` when it did. Reported so a count
   * can be read beside the tolerance that produced it, and handed back as
   * the next walk's `coarsening`.
   */
  readonly coarsening: number
  /**
   * True when `maxPatches` stopped the refinement a level early at the
   * loosest tolerance — or when the balance pass, which never leaves a 2:1
   * violation unsplit, carried a saturated selection past the cap. The cap is
   * a safety net, not a bound: an unsplit violation is a lit crack, which is
   * strictly worse than a flagged overrun.
   */
  readonly saturated: boolean
}

/**
 * The morph band of a patch with no parent: both ends past any distance.
 *
 * Finite on purpose. `Infinity` survives the float32 uniform upload, and the
 * material's morph factor divides by `max(morphEnd − morphStart, 1)` — which
 * for an infinite band is `max(Inf − Inf, 1)` = `max(NaN, 1)`, a result WGSL
 * leaves indeterminate. On hardware whose `max` propagates the NaN, every
 * level-0 patch of the orbital shell renders as garbage. At 1e30 meters the
 * subtraction stays finite, the factor saturates to zero, and "never morph"
 * is arithmetic rather than driver luck.
 */
export const NO_MORPH_DISTANCE: Meters = 1e30

/** Below this the arithmetic divides by something indistinguishable from zero. */
const MIN_DISTANCE: Meters = 1

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

/**
 * Eye to the nearest point of the shell of ground a node can occupy.
 *
 * The node is a cone of half-angle `halfAngle` about `axis`; ground inside it
 * lies between `radius ± relief`. The nearest point is found by minimizing the
 * law of cosines over that radius band at the angle the cone's edge leaves —
 * so an eye directly over a node, at any height inside the shell, is zero
 * meters from ground it might be standing on, and an eye in orbit is its
 * altitude above the highest thing the node could contain.
 */
export function nodeDistance(eye: TerrainEye, cone: RegionCone): Meters {
  const separation = Math.acos(clamp(Vec.dot(eye.direction, cone.axis), -1, 1))
  const angle = Math.max(0, separation - cone.halfAngle)
  const low = Math.max(MIN_DISTANCE, eye.radius - eye.relief)
  const high = eye.radius + eye.relief
  const cosine = Math.cos(angle)
  const nearest = clamp(eye.distance * cosine, low, high)
  const square =
    eye.distance * eye.distance +
    nearest * nearest -
    2 * eye.distance * nearest * cosine
  return Math.max(MIN_DISTANCE, Math.sqrt(Math.max(0, square)))
}

/**
 * How far past the body's horizon a node may reach and still be seen.
 *
 * The occluding body is the sphere the ground cannot dip below; a peak standing
 * `2 · relief` above it stays visible for a further `acos(low / high)` of arc.
 * Returned as one angle so the traversal's test is a subtraction.
 */
function horizonReach(eye: TerrainEye): Radians {
  const low = Math.max(MIN_DISTANCE, eye.radius - eye.relief)
  const high = eye.radius + eye.relief
  if (eye.distance <= low) return Math.PI
  return (
    Math.acos(clamp(low / eye.distance, -1, 1)) +
    Math.acos(clamp(low / high, -1, 1))
  )
}

interface Node {
  readonly region: RegionAddress
  readonly cone: RegionCone
  readonly spacing: Meters
  readonly distance: Meters
  /**
   * Distance at which this patch's cells subtend exactly the tolerance —
   * `cellPixels` times the walk's coarsening — at the scale of the regime the
   * node is in.
   */
  readonly range: Meters
  /** Refined at the lens rather than at the reference. */
  readonly inView: boolean
}

/** The frame's cone in body-fixed axes: what a node must reach to be refined at the lens. */
interface Framing {
  readonly eye: Vec3
  readonly forward: Vec3
  /** Half the frame's diagonal plus the margin, radians. */
  readonly halfAngle: Radians
  /** `pixelsPerRadian / cellPixels` at the reference lens, before coarsening. */
  readonly referenceScale: number
}

/**
 * The view's cone, or null when the view would change nothing.
 *
 * Null without a view, and null when the reference is at least as fine as the
 * lens: a wide lens's own pixel angle is coarser than the reference's, and
 * refining the ground behind the camera finer than the frame would be
 * spending the cap backwards. At those lenses the selection is the whole-disk
 * one exactly, which is what keeps every figure measured before the view
 * existed true at the flight lens and wider.
 */
function framingFor(
  eye: TerrainEye,
  options: TerrainSelectOptions,
  lens: Lens,
  viewport: Viewport,
  cellPixels: number,
): Framing | null {
  const view = options.view
  if (view === undefined) return null
  const reference = options.reference ?? REFERENCE_LENS
  const referenceScale = pixelsPerRadian(reference, viewport) / cellPixels
  if (referenceScale >= pixelsPerRadian(lens, viewport) / cellPixels)
    return null
  // The frame's half-diagonal through the projection: the corners are where a
  // turn first uncovers ground, and the cone has to hold them.
  const vertical = Math.tan(verticalFov(lens) / 2)
  const corner = Math.atan(
    Math.hypot(vertical, vertical * aspectRatio(viewport)),
  )
  const margin =
    (options.viewMarginPixels ?? VIEW_MARGIN_PIXELS) *
    pixelAngle(lens, viewport)
  return {
    eye: Vec.scale(eye.direction, eye.distance),
    forward: Vec.normalize(view.forward),
    halfAngle: Math.min(Math.PI, corner + margin),
    referenceScale,
  }
}

/**
 * Whether any ground a node can hold is inside the frame's cone.
 *
 * The ground a node can hold is its cone of directions crossed with the shell
 * `[radius − relief, radius + relief]`: a column, twice the body's relief tall
 * and only the node's own width across. It is bounded here by a capsule — the
 * segment of the node's axis from `(radius − relief)·cos θ` to
 * `radius + relief`, thickened by the column's widest half-width
 * `(radius + relief)·sin θ` — and the capsule is tested against the frame's
 * cone exactly: the nearest direction on the arc the segment sweeps from the
 * eye, less the angle its thickness subtends.
 *
 * **A bounding sphere is the obvious construction and it does not work.** Its
 * radius cannot be less than the relief, and on Earth that is 9.9 km — so
 * every node within ten kilometers of the eye, behind it as much as in front,
 * holds the eye inside its sphere and is in view by definition. Standing on
 * Earth at 11.4° that put the three finest levels wholly in view, 1,785
 * patches of a 3,289-patch selection; the capsule takes the same eye to
 * 1,756, against 5,504 for the whole disk. The relief is a vertical claim — a summit can
 * rise into the frame, a canyon can fall into it — and the capsule keeps it
 * vertical: a node behind the camera is out of view however tall its ground
 * could be.
 */
function reaches(framing: Framing, eye: TerrainEye, cone: RegionCone): boolean {
  const low = Math.max(MIN_DISTANCE, eye.radius - eye.relief)
  const high = eye.radius + eye.relief
  const thickness = high * Math.sin(cone.halfAngle)
  const u = Vec.sub(
    Vec.scale(cone.axis, low * Math.cos(cone.halfAngle)),
    framing.eye,
  )
  const v = Vec.sub(Vec.scale(cone.axis, high), framing.eye)
  const nearest = segmentDistance(u, v)
  if (nearest <= thickness) return true
  const off = arcAngle(framing.forward, u, v)
  return off - Math.asin(thickness / nearest) <= framing.halfAngle
}

/** Distance from the origin to the segment between two points. */
function segmentDistance(u: Vec3, v: Vec3): number {
  const along = Vec.sub(v, u)
  const square = Vec.lengthSquared(along)
  const t = square > 0 ? clamp(-Vec.dot(u, along) / square, 0, 1) : 0
  return Vec.length(Vec.add(u, Vec.scale(along, t)))
}

/**
 * The least angle between `forward` and any direction from the origin to a
 * point of the segment `u`–`v`.
 *
 * Those directions sweep one great-circle arc, the short one from `û` to `v̂`
 * in the plane the segment and the origin share. The nearest point of a great
 * circle to `forward` is `forward` projected into its plane; if that falls
 * inside the arc it is the answer, and otherwise one end of the arc is.
 */
function arcAngle(forward: Vec3, u: Vec3, v: Vec3): Radians {
  const angle = (a: Vec3, b: Vec3): Radians =>
    Math.acos(clamp(Vec.dot(a, b) / (Vec.length(a) * Vec.length(b)), -1, 1))
  const ends = Math.min(angle(forward, u), angle(forward, v))
  const normal = Vec.cross(u, v)
  const square = Vec.lengthSquared(normal)
  // Collinear with the eye: the arc is a point, and its ends are the answer.
  if (square <= 1e-24 * Vec.lengthSquared(u) * Vec.lengthSquared(v)) return ends
  const projected = Vec.sub(
    forward,
    Vec.scale(normal, Vec.dot(forward, normal) / square),
  )
  if (Vec.lengthSquared(projected) <= 1e-24) return Math.PI / 2
  const inside =
    Vec.dot(Vec.cross(u, projected), normal) >= 0 &&
    Vec.dot(Vec.cross(projected, v), normal) >= 0
  return inside ? Math.min(ends, angle(forward, projected)) : ends
}

/**
 * Walk the quadtree and return the patches to draw.
 *
 * Breadth-first by level, which is what makes `maxPatches` graceful: a budget
 * that will not stretch to the next level leaves the frontier where it is, so
 * the whole disk degrades by one level together rather than the last cube face
 * visited losing all of its detail. It is also what makes the result
 * order-independent — the output is a function of the eye and the body, and
 * generating a different patch first cannot change it.
 */
export function selectTerrain(
  eye: TerrainEye,
  options: TerrainSelectOptions = {},
): TerrainSelection {
  const cellPixels = options.cellPixels ?? DEFAULT_CELL_PIXELS
  const lens = options.lens ?? DEFAULT_LENS
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const optics = pixelsPerRadian(lens, viewport)
  const framing = framingFor(eye, options, lens, viewport, cellPixels)
  const loosest = COARSEN_STEP ** COARSEN_STEPS
  let coarsening = Math.max(1, options.coarsening ?? 1)
  for (;;) {
    // The loosest tolerance takes the cut tree; every tighter one hands the
    // overflow to the next step instead.
    const last = coarsening * COARSEN_STEP > loosest * (1 + 1e-9)
    const selection = walk(
      eye,
      options,
      framing,
      optics / (cellPixels * coarsening),
      { coarsening, last },
    )
    if (selection !== null) return selection
    coarsening *= COARSEN_STEP
  }
}

/**
 * One walk at one tolerance, or null when it overflowed the cap and a looser
 * tolerance is still to be tried — returned before the balance pass, which
 * is most of what a saturated walk would otherwise spend.
 */
function walk(
  eye: TerrainEye,
  options: TerrainSelectOptions,
  framing: Framing | null,
  scale: number,
  attempt: { readonly coarsening: number; readonly last: boolean },
): TerrainSelection | null {
  const maxLevel = options.maxLevel ?? DEFAULT_MAX_LEVEL
  const resolution = options.resolution ?? HEIGHTFIELD_RESOLUTION
  const maxPatches = options.maxPatches ?? DEFAULT_MAX_PATCHES
  const ready = options.ready
  const reach = horizonReach(eye)
  // The coarsening loosens both regimes together: it is a multiple of the
  // tolerance, and the tolerance is one number whichever lens it is read at.
  const outScale =
    framing === null ? scale : framing.referenceScale / attempt.coarsening

  let visited = 0
  let culled = 0
  const starved: RegionAddress[] = []
  let saturated = false

  /*
   * A node is in view only if its parent was, as well as by its own test.
   * The bounding spheres do not nest — a child's can poke out where its
   * parent's sphere test said no — and a child finer than its parent's regime
   * is a scale that rises down the tree, which the handover argument in
   * `MORPH_END` does not allow for. Carried, the scale never rises.
   */
  const consider = (
    region: RegionAddress,
    parentInView: boolean,
  ): Node | null => {
    visited += 1
    const cone = regionCone(region)
    const separation = Math.acos(
      clamp(Vec.dot(eye.direction, cone.axis), -1, 1),
    )
    if (separation - cone.halfAngle > reach) {
      culled += 1
      return null
    }
    const spacing = regionSpacing(eye.radius, region, resolution)
    const inView =
      framing === null || (parentInView && reaches(framing, eye, cone))
    return {
      region,
      cone,
      spacing,
      distance: nodeDistance(eye, cone),
      range: spacing * (inView ? scale : outScale),
      inView,
    }
  }

  let frontier: Node[] = []
  for (let face = 0; face < 6; face += 1) {
    const node = consider(regionAddress(face, 0, 0, 0), true)
    if (node !== null) frontier.push(node)
  }

  const done: Node[] = []
  while (frontier.length > 0) {
    const keep: Node[] = []
    const refining: Node[] = []
    const next: Node[] = []
    for (const node of frontier) {
      if (node.region.level >= maxLevel || node.distance >= node.range) {
        keep.push(node)
        continue
      }
      const children = regionChildren(node.region)
      if (ready !== undefined && !children.every(ready)) {
        starved.push(node.region)
        keep.push(node)
        continue
      }
      refining.push(node)
      for (const child of children) {
        const seen = consider(child, node.inView)
        if (seen !== null) next.push(seen)
      }
    }
    if (
      done.length + keep.length + refining.length + next.length >
      maxPatches
    ) {
      /*
       * The next level does not fit. The nodes that wanted it stay at their own
       * level rather than half of them refining — a budget spent on the first
       * half of a traversal is a planet with a seam down the middle of it.
       */
      saturated = true
      if (!attempt.last) return null
      done.push(...keep, ...refining)
      break
    }
    done.push(...keep)
    frontier = next
  }

  const balanced = balance(done, {
    maxLevel,
    ready,
    consider,
    starved,
    seen: new Set(starved.map((region) => regionKey(region))),
  })
  /*
   * The cap bounds what is drawn, and what is drawn is the balanced tree. A
   * walk that fits can still balance past the cap, and with two regimes it
   * routinely does: the 2:1 rings have to grade the level gap between the
   * frame and the reference across the frame's edges, which is hundreds of
   * patches the walk's own count never sees — measured at 11.4°, a descent
   * onto Luna whose every walk fit came back over the cap on 22 of 32 steps.
   * So the overrun climbs the ladder exactly as an overflow mid-walk does.
   */
  if (!attempt.last && balanced.length > maxPatches) return null

  /*
   * Outside regions, by key, for the one question the morph below asks: does
   * a patch in view abut coarser ground the view does not reach? Empty, and
   * never consulted, without a framing.
   */
  const outside = new Set<number | string>()
  if (framing !== null)
    for (const node of balanced)
      if (!node.inView) outside.add(regionKey(node.region))

  let deepest = 0
  let shallowest = maxLevel
  const patches = balanced.map((node) => {
    if (node.region.level > deepest) deepest = node.region.level
    if (node.region.level < shallowest) shallowest = node.region.level
    /*
     * Level 0 has no parent, so it never morphs — there is nothing coarser for
     * it to become, and a body far enough away for a cube face to want a parent
     * has already left the surface tier.
     */
    const root = node.region.level === 0
    /*
     * The one place the two regimes meet, and the handover has to hold there.
     *
     * `MORPH_END` is crack-free because a coarser neighbor that did not refine
     * is at least its own range away, and its range is twice this patch's
     * when both are measured at one scale. Across the regime boundary they
     * are not: the coarser neighbor stopped at the reference's range, which
     * is a fraction of this patch's range at the lens, so a band taken at the
     * lens would still be sliding where the neighbor's edge is — a lit seam.
     * Taken at the reference scale instead, the band closes before the
     * neighbor's nearest point exactly as it does within one regime, and what
     * that costs is this patch's own level: it reads as its parent wherever it
     * is further than the reference's range. The margin is what keeps that
     * ring of patches outside the frame.
     */
    const range =
      node.inView && outside.size > 0 && bordersOutside(node.region, outside)
        ? node.spacing * outScale
        : node.range
    return {
      region: node.region,
      spacing: node.spacing,
      distance: node.distance,
      morphStart: root ? NO_MORPH_DISTANCE : range * MORPH_START,
      morphEnd: root ? NO_MORPH_DISTANCE : range * MORPH_END,
      inView: node.inView,
    }
  })

  return {
    patches,
    deepestLevel: deepest,
    shallowestLevel: patches.length === 0 ? 0 : shallowest,
    visited,
    culled,
    outside: outside.size,
    starved,
    coarsening: attempt.coarsening,
    saturated: saturated || patches.length > maxPatches,
  }
}

/** The four neighbors that share an edge — the only ones a morph can open a gap against. */
const EDGES: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]

/**
 * Whether a coarser patch outside the view shares an edge with this one.
 *
 * Coarser by exactly one level, because the tree is restricted: the patch
 * covering an edge-neighbor's ground is that neighbor, something finer, or
 * its parent, and only the parent can be the coarser half of a morph. A
 * corner-only contact is one vertex, and a corner is an even index, which the
 * morph never moves.
 */
function bordersOutside(
  region: RegionAddress,
  outside: ReadonlySet<number | string>,
): boolean {
  if (region.level === 0) return false
  const span = 2 ** region.level
  for (const [di, dj] of EDGES) {
    const ni = region.i + di
    const nj = region.j + dj
    const beside =
      ni >= 0 && ni < span && nj >= 0 && nj < span
        ? { face: region.face, level: region.level, i: ni, j: nj }
        : regionNeighbor(region, di, dj)
    const key = packed(
      beside.face,
      beside.level - 1,
      beside.i >> 1,
      beside.j >> 1,
    )
    if (outside.has(key)) return true
  }
  return false
}

/** The eight neighbors a balanced quadtree has to agree with. */
const RING: readonly (readonly [number, number])[] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]

/**
 * A region as one number, for the maps the balance pass lives in.
 *
 * Levels to twenty-two keep `i` and `j` under 2²², which packs a whole address
 * into 3.2e15 — inside a double's 2⁵³ of exact integers, and free to compare.
 * Deeper than that it falls back to a string, which is slower and correct.
 *
 * **The bound has to sit above what the streamer actually asks for**, which is
 * the mistake this carried: it was written at twelve on the reasoning that
 * `surfaceDetailFloor` never returned deeper, and the band stack moved the floor
 * to between twelve and sixteen across the zoo — seventeen on the worst
 * generated body. Every selection deeper than twelve took the string branch, the
 * fallback paying 1.8 ms a pass in the code whose whole purpose is to avoid
 * paying it. Twenty-two is the deepest level whose `i` and `j` still fit, so the
 * fallback is now unreachable rather than merely unlikely; `MAX_REGION_LEVEL` is
 * 24 and the two levels past it keep the branch honest.
 *
 * The reason this is not `terrainPatchKey`: the balance pass builds a key for
 * every node's eight neighbors and for every ancestor of every node, which on
 * a whole-disk selection is nine thousand of them per pass. Built as template
 * strings that was 1.8 ms — sixteen times the cost of the traversal it is
 * correcting, and over the frame budget by itself.
 *
 * Exported for the streamer's own caches, which key by region for the same
 * arithmetic-over-strings reason — its request filter names over a thousand
 * regions a frame. The body is deliberately absent from the key: a cache that
 * outlives its body is cleared, not disambiguated, and `terrainPatchKey` below
 * is the spelling for the one consumer that does retain across bodies.
 */
export const regionKey = (region: RegionAddress): number | string =>
  packed(region.face, region.level, region.i, region.j)

/** The span `packed` reserves for `i` and `j`, and the deepest level it fits. */
const PACKED_SPAN = 2 ** 22

const packed = (
  face: number,
  level: number,
  i: number,
  j: number,
): number | string =>
  level <= 22
    ? ((face * 32 + level) * PACKED_SPAN + i) * PACKED_SPAN + j
    : `${face}.${level}.${i}.${j}`

/**
 * Refine until no patch touches one more than one level finer than itself.
 *
 * **The morph closes a one-level gap and nothing wider**, which is the thing
 * this phase learned by looking at it. A patch slides onto its *parent's* grid,
 * so where a level L patch meets a level L+1 patch the finer one arrives
 * exactly on the coarser one's vertices and there is no seam. Where it meets a
 * level L+2 patch, the finer one arrives on the L+1 grid — which the L patch
 * has no vertex on — and the difference is a hairline of open sky.
 *
 * It was measurable and not rare. Standing on Miranda, 30 of 468 patch edges
 * had a gap of two levels or more and the worst was **six**, drawn as dashed
 * black arcs along each level ring. The cause is the refine test using a node's
 * *nearest* point: a node whose near corner is close refines while its neighbor
 * does not, and the difference compounds at every level below.
 *
 * A wide enough LOD band removes it by construction — measured, the tree comes
 * out balanced on its own once a level's band is 3.7 patches wide or more. That
 * costs 500 to 1,000 patches for one disk against 300 to 600, so the band stays
 * narrow and the tree is restricted here instead. It is the classical answer
 * and the same 2:1 rule Transvoxel's transition cells assume.
 *
 * Neighbors are checked around the whole ring rather than across the four
 * edges: a corner-only mismatch is a single vertex, and a single vertex is a
 * single visible point of sky.
 *
 * A node that must split but whose children have not arrived stays where it is
 * and is counted as starved — a transient seam beats a hole, and the request
 * set names those children first.
 */
function balance(
  nodes: readonly Node[],
  context: {
    readonly maxLevel: number
    readonly ready?: (region: RegionAddress) => boolean
    readonly consider: (
      region: RegionAddress,
      parentInView: boolean,
    ) => Node | null
    readonly starved: RegionAddress[]
    readonly seen: Set<number | string>
  },
): readonly Node[] {
  let current = nodes
  /*
   * The deepest selected level anywhere under each region, for every region
   * that has one. A region absent from this is covered by something coarser,
   * which can never be the finer half of a mismatch.
   *
   * Walked by halving `i` and `j` rather than through `regionParent`, which
   * allocates a fresh address per ancestor per node, none of it read — the
   * halving walk is the same arithmetic without the objects.
   *
   * **Carried across passes rather than rebuilt in each.** A summit selection
   * takes seven passes to settle and the first is the only large one: measured
   * on Earth's summit with a converged cache, the passes split 72, 29, 12, 10,
   * 5, 2 and 0 nodes, so six of the seven rebuilt nine hundred ancestor chains
   * to find at most twenty-nine splits. Depth is monotone — a pass replaces a
   * node with its own children and keeps everything else, so no region's
   * deepest descendant can ever get shallower — which is what makes carrying
   * it exact. The one case that breaks monotonicity is a split whose children
   * are *all* culled: the region empties and its entry is left too deep, so
   * that pass asks for a rebuild instead.
   *
   * **The rebuild lands at the top of the next pass, not at the moment the
   * guard fires**, and that is the same one-pass window a per-pass snapshot
   * has: a map built from `current` also names a node that empties later in
   * the pass. Nodes considered after it in that pass can therefore split on an
   * entry one level too deep, which costs extra refinement and never a seam.
   * Rebuilding in place would close it; nothing has measured a selection where
   * it changes, and the eyes that reach it are recorded on the guard below.
   */
  let depth = new Map<number | string, number>()
  let rebuild = true
  const deepen = (region: RegionAddress): void => {
    const { face } = region
    let { level, i, j } = region
    const deepest = level
    while (level >= 0) {
      const key = packed(face, level, i, j)
      const held = depth.get(key)
      if (held !== undefined && held >= deepest) break
      depth.set(key, deepest)
      level -= 1
      i >>= 1
      j >>= 1
    }
  }
  for (let pass = 0; pass <= context.maxLevel; pass += 1) {
    if (rebuild) {
      depth = new Map<number | string, number>()
      for (const node of current) deepen(node.region)
      rebuild = false
    }

    const next: Node[] = []
    let split = false
    for (const node of current) {
      const { face, level, i, j } = node.region
      let mismatched = false
      if (level < context.maxLevel) {
        const span = 2 ** level
        for (const [di, dj] of RING) {
          const ni = i + di
          const nj = j + dj
          // The step stays on this face almost everywhere, and there the key is
          // arithmetic. Only a face edge needs the gnomonic round trip.
          const key =
            ni >= 0 && ni < span && nj >= 0 && nj < span
              ? packed(face, level, ni, nj)
              : (() => {
                  const beside = regionNeighbor(node.region, di, dj)
                  return packed(beside.face, beside.level, beside.i, beside.j)
                })()
          const beside = depth.get(key)
          if (beside !== undefined && beside - level >= 2) {
            mismatched = true
            break
          }
        }
      }
      if (!mismatched) {
        next.push(node)
        continue
      }
      const children = regionChildren(node.region)
      if (context.ready !== undefined && !children.every(context.ready)) {
        // Once, however many passes it stays starved for: this list is a work
        // queue for the streamer and a counter in `ir.terrain()`, and a node
        // repeated per pass over-reports both.
        if (!context.seen.has(regionKey(node.region))) {
          context.seen.add(regionKey(node.region))
          context.starved.push(node.region)
        }
        next.push(node)
        continue
      }
      split = true
      let kept = 0
      for (const child of children) {
        const seen = context.consider(child, node.inView)
        if (seen === null) continue
        kept += 1
        next.push(seen)
        deepen(seen.region)
      }
      /*
       * Every child beyond the horizon, which is the one way the carried map
       * can lie: nothing is selected under this region any more, so the entry
       * left by the *parent's* own `deepen` — one level too deep, and read by
       * every ancestor — describes a subtree that no longer exists. A
       * neighbor two levels coarser would take it for a mismatch it is not.
       *
       * Defensive rather than demonstrated. It happens: ten of the hundred and
       * five eyes in the altitude sweep the 2:1 property walks reach it, at
       * radius/2^9 and radius/2^10 on every body size tried. What could not be
       * built is an eye where it *changes* the selection — patch counts and
       * visit counts came out identical with and without this line, because a
       * node only splits when its neighborhood is already deep and a
       * two-levels-coarser neighbor is not there to be misled. "Not
       * observable in the eyes tried" is not "cannot be", and the map is
       * carried on a claim of exactness, so the claim is kept exact.
       */
      if (kept === 0) rebuild = true
    }
    current = next
    if (!split) break
  }
  return current
}

/** The streamer's cache key for a patch: one definition, three readers. */
export const terrainPatchKey = (
  bodyAddress: string,
  region: RegionAddress,
): string =>
  `${bodyAddress}|${region.face}.${region.level}.${region.i}.${region.j}`
