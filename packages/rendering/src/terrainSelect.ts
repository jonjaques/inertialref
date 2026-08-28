import type { Meters, Radians } from '@inertialref/shared'
import { Vec, type Vec3 } from '@inertialref/spatial'
import {
  BASELINE_VIEWPORT,
  type Lens,
  LENS_PRESETS,
  pixelsPerRadian,
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
 * It was a 60° field over 1080 pixels that arrived from nowhere: neither the
 * flight lens nor the cinematic one nor anything the field-of-view slider passes
 * through except in transit. A node refines while `distance < spacing · scale`
 * and `scale` goes as `pixelsPerRadian`, so doubling it is one more level of
 * refinement everywhere on the visible disk and the square of that in patches —
 * 16× of scale and 263× the patches between the two ends of controls a player
 * reaches with two sliders. The lens is what the picture is actually taken
 * with, so it is what the predicate reads.
 *
 * `LENS_PRESETS.flight` over `BASELINE_VIEWPORT` — 65° over 1080 display
 * pixels, 848 px/rad against the old assumption's 935. The streamer passes the
 * live lens; this is what the headless probe and the tests measure against, and
 * naming it here is what keeps those numbers comparable between runs.
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
 * where *that* field stops having anything to add — level 7 to 10 across the
 * zoo, against the 12 the old rule saturated at. This is the fallback for a
 * caller holding numbers rather than a body, and it is deliberately the old
 * ceiling so that nothing gets quietly shallower by forgetting to pass one.
 */
export const DEFAULT_MAX_LEVEL = 12

/**
 * How many patches may be selected at once.
 *
 * A safety net rather than a working limit, and the lens is what says how much
 * of a net it is. At the flight lens a restricted whole-disk selection settles
 * between 294 and 438 across the zoo at two meters and peaks at 449 over a
 * whole descent; at the wide end of the slider it is lower still. So for every
 * lens a player flies with, this never binds.
 *
 * **It binds at the telephoto end, and by how much is measured rather than
 * adjectival.** At 20° the same descents want 808 to 1,418 patches and get 768,
 * which degrades the disk by one level on 60–84% of their steps and is reported
 * as `saturated`. Raising the cap to cover it is the wrong trade: 1,418 patches
 * is 6.0 M vertices and 288 MB of buffers, on a lens the player has narrowed
 * deliberately and where one level coarser is a 4-pixel error rather than a
 * 2-pixel one. The number is here so that the next person to want it raised
 * knows what they are buying.
 */
export const DEFAULT_MAX_PATCHES = 768

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

export interface TerrainSelectOptions {
  readonly maxLevel?: number
  readonly cellPixels?: number
  /** The lens the picture is taken with. Defaults to the flight lens. */
  readonly lens?: Lens
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
   * Refine only into regions this says are drawable.
   *
   * The streamer's answer is "its heightfield is in the cache". Refining into a
   * region whose field has not arrived is what produces a hole; stopping at the
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
   * Nodes that stopped short because `ready` said a child was not there.
   *
   * The regions rather than a count, because they are what a streamer has to do
   * something about: these are the patches being drawn coarse right now, and
   * their four children are the next thing worth a worker. Empty when no
   * `ready` was given, which is the question the request set asks.
   */
  readonly starved: readonly RegionAddress[]
  /**
   * True when `maxPatches` stopped the refinement a level early — or when the
   * balance pass, which never leaves a 2:1 violation unsplit, carried a
   * saturated selection past the cap. The cap is a safety net, not a bound:
   * an unsplit violation is a lit crack, which is strictly worse than a
   * flagged overrun.
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
  /** Distance at which this patch's cells subtend exactly `cellPixels`. */
  readonly range: Meters
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
  const maxLevel = options.maxLevel ?? DEFAULT_MAX_LEVEL
  const cellPixels = options.cellPixels ?? DEFAULT_CELL_PIXELS
  const lens = options.lens ?? DEFAULT_LENS
  const viewport = options.viewport ?? DEFAULT_VIEWPORT
  const resolution = options.resolution ?? HEIGHTFIELD_RESOLUTION
  const maxPatches = options.maxPatches ?? DEFAULT_MAX_PATCHES
  const ready = options.ready
  const scale = pixelsPerRadian(lens, viewport) / cellPixels
  const reach = horizonReach(eye)

  let visited = 0
  let culled = 0
  const starved: RegionAddress[] = []
  let saturated = false

  const consider = (region: RegionAddress): Node | null => {
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
    return {
      region,
      cone,
      spacing,
      distance: nodeDistance(eye, cone),
      range: spacing * scale,
    }
  }

  let frontier: Node[] = []
  for (let face = 0; face < 6; face += 1) {
    const node = consider(regionAddress(face, 0, 0, 0))
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
        const seen = consider(child)
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
    return {
      region: node.region,
      spacing: node.spacing,
      distance: node.distance,
      morphStart: root ? NO_MORPH_DISTANCE : node.range * MORPH_START,
      morphEnd: root ? NO_MORPH_DISTANCE : node.range * MORPH_END,
    }
  })

  return {
    patches,
    deepestLevel: deepest,
    shallowestLevel: patches.length === 0 ? 0 : shallowest,
    visited,
    culled,
    starved,
    saturated: saturated || patches.length > maxPatches,
  }
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
 * Levels to twelve keep `i` and `j` under 4,096, which packs a whole address
 * into 2.9e9 — exact in a double, and free to compare. Deeper than that it
 * falls back to a string, which is slower and correct; nothing asks for deeper
 * than twelve today because `surfaceDetailFloor` does not return it.
 *
 * The reason this is not `terrainPatchKey`: the balance pass builds a key for
 * every node's eight neighbors and for every ancestor of every node, which on
 * a whole-disk selection is nine thousand of them per pass. Built as template
 * strings that was 1.8 ms — sixteen times the cost of the traversal it is
 * correcting, and over the frame budget by itself.
 */
const regionKey = (region: RegionAddress): number | string =>
  packed(region.face, region.level, region.i, region.j)

const packed = (
  face: number,
  level: number,
  i: number,
  j: number,
): number | string =>
  level <= 12
    ? ((face * 32 + level) * 4096 + i) * 4096 + j
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
    readonly consider: (region: RegionAddress) => Node | null
    readonly starved: RegionAddress[]
    readonly seen: Set<number | string>
  },
): readonly Node[] {
  let current = nodes
  for (let pass = 0; pass <= context.maxLevel; pass += 1) {
    /*
     * The deepest selected level anywhere under each region, for every region
     * that has one. A region absent from this is covered by something coarser,
     * which can never be the finer half of a mismatch.
     *
     * Walked by halving `i` and `j` rather than through `regionParent`, which
     * allocates a fresh address per ancestor per node per pass, none of it
     * read — the halving walk is the same arithmetic without the objects.
     */
    const depth = new Map<number | string, number>()
    for (const node of current) {
      const { face } = node.region
      let { level, i, j } = node.region
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
      for (const child of children) {
        const seen = context.consider(child)
        if (seen !== null) next.push(seen)
      }
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
