import { getLogger, type Meters, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  type FramePose,
  localToUniverse,
  Quaternion as Q,
  type RenderOrigin,
  UV,
  type UniverseVector,
  universeToLocal,
  Vec,
  type Vec3,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  type Body,
  findBody,
  hasSolidSurface,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  parseAddress,
  type RegionAddress,
  regionChildren,
  regionParent,
  surfaceDetailFloor,
} from '@inertialref/universe'
import {
  buildPatch,
  DEFAULT_LENS,
  DEFAULT_MAX_PATCHES,
  DEFAULT_VIEWPORT,
  type LensView,
  type PatchPlacement,
  patchPlacement,
  type RenderBody,
  type RenderPatch,
  pixelsPerRadian,
  type SelectedPatch,
  selectTerrain,
  type TerrainEye,
  type TerrainPalette,
  terrainPalette,
  terrainPatchKey,
} from '@inertialref/rendering'
import { generateHeightfieldTask, type WorkerPool } from '@inertialref/workers'
import { PhaseClock, TERRAIN_PHASE, TERRAIN_SHORT } from './frameTiming.ts'
import { ScatterField, type ScatterState } from './scatterField.ts'

/*
 * Terrain streaming.
 *
 * Walks the quadtree against the presentation eye, asks the worker pool for the
 * heightfields it does not hold, builds geometry from the ones it does, and
 * re-places all of it every frame as the planet turns.
 *
 * Geometry is built once per region and never rebuilt. It used to be rebuilt on
 * every render-origin rebase, because the vertices were baked in render space
 * against the body's pose at the moment of building — which meant that between
 * rebases the ground was frozen at a pose the planet had already left. Landed on
 * a world orbiting at 52 km/s that is ~865 m of slide per frame, snapping back
 * ten times a second: the strobe you could see and not screenshot.
 *
 * Loading and unloading are ordinary operations here, not a mode: the streamer
 * is asked what should be visible every frame and reconciles.
 *
 * Three rules the quadtree adds, all of them about *when* rather than *what*:
 *
 *   - **Refinement only enters ground that is already there.** The draw set is
 *     selected with a `ready` test against the *geometry* cache — the mesh, not
 *     the field, for the reason `#build`'s gate gives — so a patch that is not
 *     built yet is not a hole; its parent is drawn instead,
 *     covering the same ground more coarsely. A descent therefore sharpens
 *     rather than filling in.
 *   - **The request set leads the camera.** It is selected again at where the
 *     eye will be in `PREFETCH_SECONDS`, so the ground a descent is about to
 *     want is queued before it is needed. Outrun it and the picture goes coarse
 *     rather than absent, which is the failure worth having.
 *   - **Both are budgeted per frame.** A worker queue with two hundred entries
 *     serves none of them sooner, and building a patch's geometry is main-thread
 *     work in the middle of a frame.
 */

const log = getLogger('game.terrain')

/**
 * What the selection is measured against before a display has reported itself.
 *
 * The flight lens over the baseline, which is the same pair `LOD_THRESHOLDS`
 * resolves to — so in the frames before `TerrainPatches` has a drawing buffer,
 * the tier a body draws at and the ground selected under it are statements
 * about one camera rather than two.
 */
const DEFAULT_LENS_VIEW: LensView = {
  lens: DEFAULT_LENS,
  viewport: DEFAULT_VIEWPORT,
}

/**
 * How far ahead of the camera the request set is taken, in seconds.
 *
 * Long enough for a worker to answer — a patch is 9 to 37 ms of generation
 * across the zoo and the pool is a handful of them — and short enough that a
 * turn does not spend the budget on ground nobody looks at. The extrapolation is linear in the eye's
 * own motion and ignores the body's rotation over the interval, which at two
 * seconds is meters on anything you could be landing on.
 */
const PREFETCH_SECONDS: Seconds = 2

/**
 * Heightfields to queue in one frame.
 *
 * It was eight, against a quadtree that bottomed out around level 10. The band
 * stack put crater rims into the field and `surfaceDetailFloor` moved to 10–16
 * to resolve them, which is three times as much tree to fetch: a landing that
 * used to sharpen in eighty frames wanted two hundred and fifty, and the
 * ladder is strictly serial — a level cannot refine until all four children of
 * every node on it have arrived, so a frame that under-asks is a frame the next
 * level waits for.
 *
 * Twenty-four rather than more because these go to a **pool**, not to this
 * thread: a request beyond what the workers can chew is a request that queues,
 * and a queue is what a camera turn has to throw away. Three times the depth,
 * three times the rate, same amount of ground in flight.
 */
const REQUESTS_PER_FRAME = 24

/**
 * How many heightfields may be outstanding at once.
 *
 * `REQUESTS_PER_FRAME` is a *rate* and this is the *depth*, and without the
 * second the first is unbounded: `#request` filtered on "not cached and not
 * already asked for" and nothing consulted how much was already in flight, so at
 * 24 a frame it committed the whole 400-to-1,024-patch wanted set inside forty
 * frames. `WorkerPool`'s queue is uncapped and the pool is two to four workers
 * at 9 to 37 ms a patch, which drains 50 to 400 a second against a submit rate
 * of 1,440 — so after a camera turn the pool spent seconds generating ground
 * nobody was looking at before it reached the new selection, and
 * `PREFETCH_SECONDS` was describing a queue rather than a lookahead.
 *
 * A hundred and twenty-eight is a little over one rung of a whole-disk
 * selection, which is about ninety patches. That is the unit that matters,
 * because the ladder is strictly serial — a level cannot refine until all four
 * children of every node on it have arrived — so a cap below a rung would stall
 * the descent for exactly the reason the rate was tripled. Above it, the extra
 * is only queue.
 */
const IN_FLIGHT_CAP = 128

/**
 * Every level of the selection, coarsest first.
 *
 * The ideal selection is all *leaves* — it refines past every ancestor — so a
 * streamer asking only for it climbs the ladder one worker round-trip per
 * level: draw six cube faces, wait, request twenty-four, wait, and nine levels
 * later there is ground. Asking for the ancestors as well queues every rung at
 * once, so how fast the ground arrives is a question about throughput rather
 * than about latency times depth.
 *
 * It is also not much more to ask for. A quadtree's ancestors are shared, so
 * the pyramid over a couple of hundred leaves is about a third again as many
 * regions — and every one of them is a patch the descent is about to draw on
 * the way down, or is drawing right now out toward the horizon.
 */
function pyramid(leaves: readonly SelectedPatch[]): readonly RegionAddress[] {
  const byLevel = new Map<number, Map<string, RegionAddress>>()
  for (const leaf of leaves) {
    let region: RegionAddress | null = leaf.region
    while (region !== null) {
      const held = byLevel.get(region.level) ?? new Map()
      const key = `${region.face}.${region.i}.${region.j}`
      if (held.has(key)) break
      held.set(key, region)
      byLevel.set(region.level, held)
      region = regionParent(region)
    }
  }
  return [...byLevel.entries()]
    .sort((a, b) => a[0] - b[0])
    .flatMap(([, held]) => [...held.values()])
}

/**
 * Patches to turn into geometry in one frame.
 *
 * This is main-thread work inside the frame — 4,761 directions and two normal
 * passes — so it is the one part of streaming that shows up as a hitch rather
 * than as latency. It is **0.25 ms** a patch, so four of them is a millisecond,
 * and a cold whole-disk selection of 450 fills in about 110 frames — which is
 * roughly what the worker pool takes to generate them anyway.
 *
 * It was 6.26 ms a patch before the mesh loops were written in scalars, which
 * is six frames of terrain budget for one patch and the reason this constant
 * was 2. Moving the build into the worker entirely is the next step and is a
 * payload change rather than an algorithm one; it is not free, because
 * `packages/workers` and `packages/rendering` are the same layer and the mesh
 * arithmetic would have to move down to `packages/universe` first.
 */
const BUILDS_PER_FRAME = 4

/**
 * How many pixels a body's relief must cover before terrain is drawn at all.
 *
 * The one thing the quadtree is *for* is that the silhouette and the shading
 * are the ground rather than a sphere pretending to be it. Past the distance
 * where a body's whole relief is a pixel wide, that claim is empty: the mesh
 * and the datum sphere are the same picture, and the sphere already carries a
 * normal map and, on four bodies in Sol, a photograph.
 *
 * Without this, Earth at two and a half radii is five level-0 patches of flat
 * tinted ground over the top of the map — a generated picture replacing a
 * measured one, which is precisely the doctrine's inversion. With it, Earth
 * draws its map until 2,000 km of altitude and its ground below that, and
 * Miranda — 10 km of relief on a 236 km moon — keeps terrain out to eight
 * thousand kilometers, because there the relief is genuinely the shape of the
 * body.
 *
 * The plan's unconditional sphere-tier shell wants Phase 3's per-face normal
 * and albedo bake underneath it. That is what would let a level-0 patch carry
 * something the sphere does not, and this threshold is where it goes when it
 * arrives.
 *
 * The cost is a switch rather than a fade, and the size of the switch is this
 * number: one pixel of silhouette, against the whole ground appearing that the
 * opacity fade traded for a transparency ramp.
 */
const TERRAIN_RELIEF_PIXELS = 8

/**
 * Heightfields held, as a multiple of the largest selection.
 *
 * **A cache smaller than the working set does not degrade, it oscillates.** At
 * a flat 512 against a selection of six hundred, every frame evicted ground the
 * next frame wanted: the draw set collapsed from 350 patches at level 9 to 19
 * at level 3, refined back over the following frames, and collapsed again —
 * terrain strobing at every altitude, with `cached` pinned at exactly the cap.
 * The two sets in play are the drawn one and the request one, and they diverge
 * by design because the second is taken from where the eye is *going*, so three
 * times the cap is the working set with room to spare.
 *
 * A bordered 65×65 field is 19 KB of elevations and 17 KB of cover — 36 KB — so
 * at a cap of 1,024 this is 3,072 fields and 110 MB. Both numbers move with
 * `DEFAULT_MAX_PATCHES` rather than with anything here, which is why they are
 * stated as arithmetic.
 */
export const FIELD_CACHE = DEFAULT_MAX_PATCHES * 3

/**
 * Patch geometries held.
 *
 * **Sized against the request set, not the drawn one.** Only drawn patches are
 * *placed*, but three sets get geometry built and a fourth decides what may be
 * dropped: `#build` takes the drawn set *and* the rung below it, and `#evict`
 * keeps whatever the frame requested — the drawn set, the starved children, and
 * the whole pyramid under the ideal selection.
 *
 * **That keep set is two selections, not one, so it is not bounded by
 * `DEFAULT_MAX_PATCHES`.** `wanted` is a second `selectTerrain` at the
 * look-ahead eye and is capped independently of the drawn one, so the union's
 * ceiling is `|drawn| + 4·|starved| + |pyramid(wanted)|` — around 2.3× the
 * selection cap in the limit, which this number does *not* clear. What makes 2×
 * safe is measurement rather than arithmetic, and the thing that moves it is the
 * camera's speed over the ground as much as the buffer: the two selections
 * coincide at a hover and separate as the lead grows. Worst measured, across
 * Luna, Ganymede and Triton at 500 m and 2 km with leads to 20 km:
 *
 * | buffer     | hover | 5 km lead | 20 km lead |
 * | ---------- | ----- | --------- | ---------- |
 * | 1600×900   | 957   | 1,267     | 1,450      |
 * | 3840×2400  | 1,085 | 1,506     | 1,668      |
 * | 5120×2880  | 1,193 | 1,711     | **1,824**  |
 *
 * So the margin here is about 11%, not the 2× the multiple suggests. Standing
 * at Earthrise — a hover, where the two selections coincide — one frame's
 * request list names 1,323 regions and 1,597 are resident once the ladder
 * converges; both are above the 1,152 this was.
 *
 * A cache under its working set does not degrade, it oscillates, and this one
 * did it where nothing was watching. `#build` added four patches a frame,
 * `#evict` dropped four it had wanted a moment earlier, `starved` sat at ~70
 * forever instead of falling to zero, and every twenty-six frames the rotation
 * took a patch the traversal was refining through: `ready` failed, the walk
 * stopped ten nodes in, and the whole disk snapped from 760 patches at level 7
 * to four at level 1 for a frame. On screen that is the ground jumping two to
 * three times a second, and only once the finest level is in play. What decides
 * whether it happens is the *ratio* of keep set to cap, which is why a hover at
 * 1600×900 never showed it and a moving camera at the old cap would have:
 * 1,450 against 1,152. `FIELD_CACHE` above carries the same argument for
 * heightfields; geometry never got it.
 *
 * A patch is 220 KB of vertex buffers — 203 KB of positions and normals, plus
 * the 17 KB of morph cover it owns; the unmorphed cover beside it is the
 * field's array by reference and is counted there. That is the expensive half
 * of terrain's memory and the half attribute packing would halve. This is a
 * *ceiling*, not an allocation — what is resident is the working set, ~700
 * patches and 154 MB at 1600×900, 1,597 and 351 MB at 3840×2400 — so raising it
 * costs nothing at the sizes that already fit. Full, it is **450 MB**, which is
 * the number to weigh against a strobe and against the 208 MB the selection
 * alone quotes.
 */
export const GEOMETRY_CACHE = DEFAULT_MAX_PATCHES * 2

interface CachedField {
  readonly elevations: Float32Array
  /** Four bytes of surface cover per vertex, unbordered. See `cover.ts`. */
  readonly cover: Uint8Array
  readonly region: RegionAddress
  readonly border: number
}

/** A patch's static geometry, where it belongs this frame, and how it morphs. */
export interface PlacedPatch {
  readonly patch: RenderPatch
  /**
   * `terrainPatchKey(body, region)` — the identity the renderer's mesh cache
   * keys on. Carried here because the streamer computes it anyway and a cache
   * key rebuilt from the region alone omits the body: retained meshes would
   * collide across a retarget, and the six face roots collide on *every* pair
   * of bodies.
   */
  readonly key: string
  readonly placement: PatchPlacement
  /**
   * The eye in this patch's own frame — body-fixed axes, anchor-relative, true
   * meters.
   *
   * The vertex stage needs the distance from the eye to each vertex to decide
   * how far the morph has run, and it cannot take that from view space: past
   * `NEAR_LIMIT` the mesh carries the body's compression, so a view-space
   * length is in compressed meters while the morph band is in real ones.
   * Handing the eye over in the patch's own coordinates leaves the subtraction
   * in the units the selection used.
   */
  readonly eyeLocal: Vec3
  /** Eye distance at which this patch starts sliding onto its parent's grid. */
  readonly morphStart: Meters
  /** And where it has arrived. The material interpolates between the two. */
  readonly morphEnd: Meters
}

export interface TerrainState {
  readonly bodyAddress: string | null
  readonly patches: readonly PlacedPatch[]
  readonly pending: number
  readonly cached: number
  readonly level: number
  /**
   * What the ground on this body is made of, or null when nothing is streaming.
   *
   * Kept against the resolved `Body` rather than rebuilt each frame, and the
   * cost that decides it is allocation rather than arithmetic: the palette is
   * twenty multiplies but about twenty short-lived objects, six of them nested
   * records with a color apiece, and `update` runs every frame terrain streams.
   * There is nothing to invalidate — the body is an immutable object out of the
   * world, so a different world, a retarget or a reseed is a different
   * reference, and the identity check catches all three the way
   * `terrainSketch`'s `WeakMap` does.
   */
  readonly palette: TerrainPalette | null
  /**
   * Body-fixed axes to render space — the rotation every patch is drawn with.
   *
   * On the state rather than read off `patches[0]` because the renderer needs
   * it in the frame where the drawn set is *empty*: that is exactly the frame a
   * body is acquired, and the material's uniforms are written before there is
   * anything to draw with them.
   */
  readonly orientation: Q.Quat | null
  /** The body's centre in render space, for the direction of its star. */
  readonly centre: Vec3 | null
  /**
   * The radius the patches were **built** on, meters.
   *
   * `body.radius`, which is the equatorial one, because that is what `#build`
   * hands `buildPatch` and therefore what every vertex is measured from. Not
   * the mean radius, and the difference is not academic: on Earth they are 7 km
   * apart, which is twenty times the ocean datum. Read against the mean, an
   * altitude of "at sea level" came out at 7,356 m — so no water was ever
   * detected, and the highland, dune and evaporite gates were all reading a
   * relief fraction of 0.74 on ground at the shoreline.
   */
  readonly datumRadius: Meters
  /**
   * The optics the selection was made against, or null when nothing streams.
   *
   * The material composes through the same lens the predicate refined against,
   * which is what keeps the detail fading out exactly where the mesh carrying
   * it stops being refined — and what makes a zoom move both together instead
   * of leaving one behind.
   */
  readonly lens: LensView | null
  /**
   * The rocks lying on it, or an empty field when nothing is close enough.
   *
   * On the terrain state rather than beside it because the two are one answer
   * about one body: the scatter's anchor, its placement and its lens all come
   * from the pose this streamer resolved, and a second producer of "which body
   * is being looked at" would disagree with this one for a frame every time the
   * target changed. `ScatterField` carries the argument.
   */
  readonly scatter: ScatterState
}

export class TerrainStreamer {
  readonly #pool: WorkerPool | null
  readonly #scatter = new ScatterField()
  readonly #fields = new Map<string, CachedField>()
  readonly #patches = new Map<string, RenderPatch>()
  readonly #inFlight = new Set<string>()
  #bodyAddress: string | null = null
  #drawn: readonly SelectedPatch[] = []
  #deepest = 0
  #shallowest = 0
  #visited = 0
  #culled = 0
  #starved = 0
  #saturated = false
  /**
   * The streamer's own four phases, inside the Engine track's one `terrain`.
   *
   * See `frameTiming.ts`: the clock steps in 100 µs here, so `select` at
   * 40–90 µs for a whole disk cannot be read one frame at a time. It is still
   * worth a phase — over a 240-frame window the rounding is unbiased and the
   * mean is good to well under a microsecond — and the tiling means the four
   * sum to the `terrain` phase exactly rather than drifting from it.
   */
  readonly #phases = new PhaseClock('game.terrain')

  /**
   * How much of the drawn selection is waiting on geometry, and whether the
   * walk hit its patch ceiling.
   *
   * Beside `summary()` for the reason `pool.queued` sits beside `stats()`: the
   * frame loop reads these every frame to color a trace entry, and `summary()`
   * allocates an object and a nested one for the scatter field. An entry that
   * turns red when the ground is going coarse is the one thing a screenshot of
   * a profile can say at a glance, and it must not cost a per-frame allocation
   * to say it.
   */
  get starved(): number {
    return this.#starved
  }

  get saturated(): boolean {
    return this.#saturated
  }
  /*
   * The transform the patches are drawn with, refreshed by `update` every frame.
   *
   * Held rather than passed to `state()` because the answer is the same for
   * every patch on the body and stale for all of them together — one place to
   * be wrong is better than two hundred.
   */
  #pose: {
    position: Vec3
    orientation: Q.Quat
    scale: number
    /** The camera in body-fixed axes, from the body's center. */
    eye: Vec3
  } | null = null
  #palette: TerrainPalette | null = null
  /**
   * The body the kept palette was derived from, and the palette itself.
   *
   * Separate from `#palette`, which `#forget` nulls: a streamer that stops
   * drawing has no palette to report, but the one it derived is still the one
   * this body wants when the relief clears the gate again.
   */
  #paletteBody: Body | null = null
  #paletteValue: TerrainPalette | null = null
  #datumRadius = 1
  /**
   * Last eye in body-fixed axes, for the velocity the request set is
   * extrapolated along.
   *
   * Body-fixed rather than universe coordinates, because the extrapolated
   * point is converted with the body's *current* pose. A camera hovering over
   * a body co-moves with it at the body's orbital velocity — 47 km/s at
   * Mercury — so a universe-frame drift extrapolated two seconds ahead is a
   * request set aimed ~94 km from the ground under the camera, forever. The
   * body-fixed difference is the camera's track over the ground, which is the
   * thing a prefetch should lead.
   */
  #previous: { eye: Vec3; time: Seconds } | null = null
  /**
   * Bumped by `clear()`. A worker answer landing after the world it was asked
   * about is gone must be dropped: the keys carry the body address but not the
   * seed, so a stale field would be served — and, sitting in the drawn set's
   * keep list, never evicted.
   */
  #epoch = 0
  /**
   * What the last selection was actually made against, for `ir.terrain()`.
   *
   * The resolved pair rather than the two nullable fields above: a readout
   * saying "no lens" while the streamer was quietly using the flight default
   * would be a different claim from the one the numbers beside it describe.
   */
  #lensView: LensView | null = null

  /**
   * The optics the selection is measured against.
   *
   * A presentation input, written by the engine each frame under the pose's own
   * precedence — a cutscene's lens outranks the flight one, and the terrain a
   * scripted shot selects is the terrain that shot's lens asks for. The
   * viewport is in *display* pixels with any supersampling already divided out;
   * a two-times display genuinely wants twice the patches for the same picture
   * and a two-times supersample does not.
   *
   * **One field rather than two, because the pair is what a selection is made
   * against and half of it is not an answer.** Nullable independently, a live
   * cinematic lens could be measured over the 1920×1080 baseline on a display
   * that is neither — a `LensView` that never existed, reported by
   * `ir.terrain()` as the one the numbers beside it came from. `null` here
   * resolves to the same flight-lens default `selectLod` falls back to, so the
   * bodies and the ground under them agree about the optics in every frame,
   * including the ones before a drawing buffer has been reported.
   */
  lensView: LensView | null = null

  constructor(pool: WorkerPool | null) {
    this.#pool = pool
  }

  /**
   * What is held and what it costs, without building a placement for any of it.
   *
   * `state()` maps every patch through `patchPlacement` — render-space
   * arithmetic these counters throw away immediately — and the renderer already
   * calls it once a frame. Answering `ir.terrain()` through `state()` would be
   * a second complete placement pass whose only output is a count.
   */
  summary(): {
    readonly bodyAddress: string | null
    readonly level: number
    readonly shallowestLevel: number
    readonly pending: number
    readonly cached: number
    readonly geometry: number
    readonly patches: number
    readonly vertices: number
    readonly triangles: number
    readonly visited: number
    readonly culled: number
    readonly starved: number
    readonly saturated: boolean
    readonly lens: LensView | null
    readonly scatter: {
      readonly regions: number
      readonly resolving: number
      readonly rocks: number
      readonly range: Meters
    }
  } {
    let placed = 0
    let vertices = 0
    let triangles = 0
    for (const selected of this.#drawn) {
      const patch = this.#patches.get(this.#key(selected.region))
      if (patch === undefined) continue
      placed += 1
      vertices += patch.positions.length / 3
      triangles += patch.indices.length / 3
    }
    return {
      bodyAddress: this.#bodyAddress,
      level: this.#deepest,
      shallowestLevel: this.#shallowest,
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      geometry: this.#patches.size,
      // Placed, not selected: the report's contract is "built and placed this
      // frame", and the selection can hold regions whose geometry is still in
      // a worker. Counting those reported ground before any was drawn —
      // `patches: 6` over zero vertices on a cold arrival.
      patches: placed,
      vertices,
      triangles,
      visited: this.#visited,
      culled: this.#culled,
      starved: this.#starved,
      saturated: this.#saturated,
      lens: this.#lensView,
      scatter: this.#scatter.summary(),
    }
  }

  state(): TerrainState {
    const pose = this.#pose
    const patches: PlacedPatch[] = []
    if (pose !== null) {
      for (const selected of this.#drawn) {
        const key = this.#key(selected.region)
        const patch = this.#patches.get(key)
        if (patch === undefined) continue
        patches.push({
          patch,
          key,
          placement: patchPlacement(
            patch,
            pose.position,
            pose.orientation,
            pose.scale,
          ),
          eyeLocal: Vec.sub(pose.eye, patch.anchor),
          morphStart: selected.morphStart,
          morphEnd: selected.morphEnd,
        })
      }
    }
    return {
      bodyAddress: this.#bodyAddress,
      patches,
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      level: this.#deepest,
      palette: this.#palette,
      orientation: pose?.orientation ?? null,
      centre: pose?.position ?? null,
      datumRadius: this.#datumRadius,
      lens: this.#lensView,
      scatter: this.#scatter.state(),
    }
  }

  /**
   * Reconcile the loaded set against where the camera is.
   *
   * Called every frame; cheap when nothing has changed, because the work is
   * keyed by (body, region) and both are stable while the player hovers.
   *
   * **The selection is 40–90 µs for a whole disk seen from orbit, and 2.7 ms
   * standing on a summit.** Both are real; the first is the one that lets this
   * run unconditionally rather than behind an altitude gate, and the second is
   * what it costs where somebody is actually looking at ground. Measured on the
   * Terrain track on Earth's summit site, where a nine-level selection visits
   * 446 nodes: `terrain.select` was 2.733 ms of a 4.461 ms engine step — 61% of
   * everything the engine did — with `terrain.request` at 0.916 ms,
   * `terrain.build` at 0.225 ms and `terrain.scatter` at 0.046 ms behind it.
   * A figure measured at one operating point is a figure about that point.
   */
  update(
    world: World,
    renderTime: Seconds,
    camera: UniverseVector,
    origin: RenderOrigin,
    body: RenderBody | null,
  ): void {
    // Opened before the early exits so a frame that clears or forgets emits
    // nothing at all, which is the truthful picture — there was no terrain work
    // to decompose.
    this.#phases.open()
    if (body === null) {
      this.clear()
      return
    }
    if (body.address !== this.#bodyAddress) {
      this.clear()
      this.#bodyAddress = body.address
    }
    // Read after the clears above, which null it on a retarget: a snapshot
    // taken before them would difference this frame's eye in the new body's
    // axes against the old body's — one frame of the request budget aimed
    // tens of gigameters off.
    const previous = this.#previous

    const resolved = this.#resolve(world, renderTime, body.address)
    // Through `#forget`, like every other exit. A bare return leaves the pose,
    // the palette, the drawn set and the rocks describing a body this world
    // cannot resolve any more — a system unloaded under a target it still
    // names — and the frame draws last frame's ground at last frame's place.
    if (resolved === null) {
      this.#forget()
      return
    }
    const { surface, bodyPose, spinPose } = resolved
    /*
     * Solid bodies only. A gas giant has no surface to stream and the tier must
     * never fire for one.
     *
     * And every solid *unfigured* body, mapped or not — which is the one place
     * this departs from the plan's carve-out, deliberately. A figured body is
     * the opposite trade: its measured ellipsoid is the shape the contact test
     * and the stance camera use, so patches built on the spherical datum float
     * kilometers off it — those bodies wait for a producer that samples the
     * figure. Mapped Sol bodies keep
     * their own geology, and Phase 3 owes their patches a material that wears
     * the published map instead of a flat color. But the geometry cannot be
     * switched off for them, because `surfaceRadius` is one function and the
     * contact test lands a ship on procedural elevation whether the body has a
     * photograph or not. Mars's is ±14.7 km against a sphere drawn 29.4 km
     * under the datum, so a mapped body with no streamed ground is a ship
     * parked fifteen kilometers above a smooth planet. The carve-out is about
     * what may be *claimed* about a mapped surface, not about whether the
     * ground under the landing gear is drawn.
     */
    if (surface === null) {
      this.#forget()
      return
    }

    const eyeLocal = universeToLocal(spinPose, camera)
    this.#previous = { eye: eyeLocal, time: renderTime }
    this.#pose = {
      position: body.placement.position,
      orientation: Q.multiply(
        Q.conjugate(origin.orientation),
        spinPose.orientation,
      ),
      scale: body.placement.compression,
      eye: eyeLocal,
    }
    if (surface !== this.#paletteBody) {
      this.#paletteBody = surface
      this.#paletteValue = terrainPalette(surface)
    }
    this.#palette = this.#paletteValue
    this.#datumRadius = surface.radius

    const { lens, viewport } = this.lensView ?? DEFAULT_LENS_VIEW
    this.#lensView = this.lensView ?? DEFAULT_LENS_VIEW
    const eye = this.#eye(surface, spinPose, bodyPose.position, camera)
    const height = Math.max(1, eye.distance - eye.radius)
    if (
      (eye.relief * pixelsPerRadian(lens, viewport)) / height <
      TERRAIN_RELIEF_PIXELS
    ) {
      this.#forget()
      return
    }

    const options = {
      maxLevel: surfaceDetailFloor(surface.surface),
      lens,
      viewport,
    }

    // What to draw: refine only into ground already in the cache, so a patch
    // that has not arrived costs detail rather than leaving a hole.
    const drawn = selectTerrain(eye, {
      ...options,
      /*
       * Geometry, not the heightfield.
       *
       * `state()` can only place a patch it has vertex buffers for, and the
       * traversal *drops* a node the moment it refines — so a region whose
       * field had arrived but whose mesh had not was covered by nothing at
       * all: not by itself, and not by the parent that had already given way
       * to it. Measured on arrival at a landable body, 138 of 266 selected
       * regions had no geometry, which is half the visible disk missing.
       *
       * Gating on the mesh means refinement advances exactly as fast as
       * `#build` can feed it, which is the honest rate, and the picture is
       * never short of ground.
       */
      ready: (region) => this.#patches.has(this.#key(region)),
    })
    this.#drawn = drawn.patches
    this.#deepest = drawn.deepestLevel
    this.#shallowest = drawn.shallowestLevel
    this.#visited = drawn.visited
    this.#culled = drawn.culled
    this.#starved = drawn.starved.length
    this.#saturated = drawn.saturated

    // What to ask for: the same walk with nothing withheld, taken from where
    // the eye is going rather than where it is.
    const wanted = selectTerrain(
      this.#lookAhead(
        surface,
        spinPose,
        bodyPose.position,
        eyeLocal,
        renderTime,
        previous,
        eye,
      ),
      options,
    )

    /*
     * The rung below the drawn set — what makes the ladder climb: with
     * refinement gated on geometry, a node whose children have fields but no
     * meshes is starved until something builds them, and nothing else would.
     * Computed once because `#build`, `#request` and the evictor's keep set
     * must agree on it — two spellings of this list is the build set quietly
     * desynchronizing from the request set.
     */
    const starvedChildren = drawn.starved.flatMap((region) =>
      regionChildren(region),
    )
    /*
     * Both quadtree walks under one entry, and red when the ground is short.
     *
     * One phase rather than two because a single walk is 40–90 µs against a
     * 100 µs clock — the pair is the smallest thing here that resolves at all,
     * and splitting it would produce two bars whose difference is quantization.
     * `starved` and `saturated` are the streamer's own words for "the picture
     * is coarser than the selection asked for", and they are exactly what a
     * reader wants to see without reading a number.
     */
    this.#phases.step(
      'terrain.select',
      this.#starved > 0 || this.#saturated ? TERRAIN_SHORT : TERRAIN_PHASE,
    )

    this.#build(
      [...drawn.patches.map((patch) => patch.region), ...starvedChildren],
      surface,
    )
    // Main-thread vertex work: 0.25 ms a patch, four a frame by budget. The one
    // phase here that clears the clock's resolution comfortably.
    this.#phases.step('terrain.build', TERRAIN_PHASE)
    /*
     * The draw set first, then the ideal one.
     *
     * The ideal selection is all leaves — it refines past every ancestor — so
     * asking only for it never asks for the coarse patch the draw set is
     * *currently standing on*, and a streamer with an empty cache draws nothing
     * for as long as it takes the deepest level to arrive. Which, on a first
     * approach, is forever: the draw set stops at the roots, the roots are not
     * leaves, and nothing ever requests them. Coarse-first is also the right
     * order on its own merits — the ground appears immediately and sharpens.
     */
    const requested = [
      // What is drawn now and has no field yet, nearest first — a frame's
      // budget should buy the ground being looked at rather than whichever
      // cube face the traversal happened to emit first. Sorted here rather
      // than in `#request`, because sorting the whole list would dissolve
      // the grouping these three lines exist to create.
      ...[...drawn.patches]
        .sort((a, b) => a.distance - b.distance)
        .map((patch) => patch.region),
      // What the drawn set is waiting on to refine.
      ...starvedChildren,
      // And the whole pyramid under the ideal selection, shallow first.
      ...pyramid(wanted.patches),
    ]
    this.#request(requested, surface)
    // Together 0.916 ms on a summit, against a request list naming over a
    // thousand regions — so they clear the 100 µs step easily where it matters
    // and quantize together from orbit, where there is nothing to see anyway.
    this.#phases.step('terrain.request', TERRAIN_PHASE)

    this.#evict(requested)
    this.#phases.step('terrain.evict', TERRAIN_PHASE)

    /*
     * The rocks, last, because they stand on ground this frame has just decided
     * how to draw — and driven from here rather than from the engine because
     * everything they need is already resolved: the body, the eye in body-fixed
     * axes, the pose the patches are placed with, and the lens the whole picture
     * was selected against.
     */
    this.#scatter.update(
      surface,
      body.address,
      eyeLocal,
      // The branded direction this frame's own selection was made against,
      // rather than a second normalization of `eyeLocal` in the app layer —
      // `bodyFixedDirection` is one of the three producers and this keeps it
      // that way.
      eye.direction,
      this.#pose,
      this.#lensView,
    )
    /*
     * The one phase that most wants a timeline rather than a mean.
     *
     * `scatterField.ts` resolves a fixed budget of 128 candidate slots per
     * frame against a whole region that costs 2.6–5.8 ms, so the work is
     * deliberately smeared across frames — and a budget spread thin is
     * invisible to a scalar by construction, while on a track it is the obvious
     * repeating band.
     */
    this.#phases.step('terrain.scatter', TERRAIN_PHASE)
  }

  #key(region: RegionAddress): string {
    return terrainPatchKey(this.#bodyAddress ?? '', region)
  }

  #eye(
    body: Body,
    spinPose: FramePose,
    centre: UniverseVector,
    camera: UniverseVector,
  ) {
    return {
      radius: body.radius,
      relief: body.surface.maxElevation,
      distance: UV.distance(camera, centre),
      // `bodyFixedDirection` is the only producer of the branded direction the
      // terrain functions accept, so this cannot drift back to an inertial
      // sample the way it once did.
      direction: bodyFixedDirection(spinPose, camera),
    }
  }

  /**
   * Where the eye will be, for the set that gets queued.
   *
   * Linear in the observed motion between the last two frames, *in body-fixed
   * axes* — the frame the ground lives in. Measured in universe coordinates the
   * drift is dominated by the body's own orbital velocity, which the camera
   * shares while hovering, so the extrapolation aimed the request set tens of
   * kilometers along the orbit instead of along the camera's track over the
   * ground. Body-fixed, a hover collapses to the present and a descent leads
   * where the descent is going. A frame boundary that is not a frame — a
   * teleport, a resumed tab — produces a velocity that means nothing, so a step
   * longer than a second or shorter than nothing falls back to the eye itself.
   */
  #lookAhead(
    body: Body,
    spinPose: FramePose,
    centre: UniverseVector,
    eyeLocal: Vec3,
    time: Seconds,
    previous: { eye: Vec3; time: Seconds } | null,
    eye: TerrainEye,
  ): TerrainEye {
    if (previous === null) return eye
    const step = time - previous.time
    if (!(step > 0) || step > 1) return eye
    const drift = Vec.sub(eyeLocal, previous.eye)
    const ahead = localToUniverse(
      spinPose,
      Vec.add(eyeLocal, Vec.scale(drift, PREFETCH_SECONDS / step)),
    )
    return this.#eye(body, spinPose, centre, ahead)
  }

  /**
   * Resolve the streamed body and the two poses terrain needs.
   *
   * The `bf:` spin pose and the `b:` orbital pose are different frames and the
   * difference is the whole "terrain is sampled in body-fixed axes" rule, so
   * they are looked up in one place rather than at each caller.
   *
   * The time is a parameter rather than `world.clock.time`, and that is not a
   * detail. A snapshot presents the world one tick in the past so there is
   * always a pair of states to interpolate between, so the ship and the datum
   * sphere are drawn at `renderTime` while the clock has already moved on.
   * Reading the clock here put the ground up to a tick ahead of everything
   * standing on it — 800 m at orbital speed, oscillating at the frame rate.
   */
  #resolve(
    world: World,
    time: Seconds,
    bodyAddress: string,
  ): { surface: Body | null; bodyPose: FramePose; spinPose: FramePose } | null {
    const address = parseAddress(bodyAddress)
    if (address.kind !== 'body') return null
    const system = world.system(address.system)
    if (system === undefined) return null
    const body = findBody(system, address.body)
    if (body === undefined) return null
    return {
      /*
       * Solid, and no measured figure. Every patch is built on the spherical
       * datum (`bodyRadius` in `#build`), but a figured body's ground — the
       * contact test, `surfaceRadius`, the stance camera — is its measured
       * ellipsoid, up to half a radius inside that sphere on Haumea. Streaming
       * would draw a spherical shell floating around the shape model, with the
       * standing camera inside the mesh. This is the plan's carve-out: deep
       * terrain on figures is a projection problem, and until it is solved the
       * figure's own shape model is the honest ground.
       */
      surface: hasSolidSurface(body) && body.figure === null ? body : null,
      bodyPose: world.frames.pose(bodyFrameId(body.address), time),
      spinPose: world.frames.pose(bodyFixedFrameId(body.address), time),
    }
  }

  /** Build geometry for the regions that need it next, under budget. */
  #build(wanted: readonly RegionAddress[], body: Body): void {
    let built = 0
    for (const region of wanted) {
      if (built >= BUILDS_PER_FRAME) return
      const key = this.#key(region)
      if (this.#patches.has(key)) continue
      const field = this.#fields.get(key)
      if (field === undefined) continue
      // Built once. The geometry is body-fixed, so nothing that happens to the
      // planet or to the render origin can invalidate it.
      this.#patches.set(
        key,
        buildPatch({
          region,
          resolution: HEIGHTFIELD_RESOLUTION,
          border: field.border,
          elevations: field.elevations,
          cover: field.cover,
          bodyRadius: body.radius,
        }),
      )
      built += 1
    }
  }

  /**
   * Queue the missing heightfields, in the order the caller asked for them.
   *
   * The order is the argument and it belongs to the caller: the list arrives as
   * the drawn set nearest-first, then the rung the drawn set is waiting on,
   * then the ideal selection's pyramid shallow-first. Sorting here would
   * dissolve exactly that grouping, so this only filters and takes.
   */
  #request(wanted: readonly RegionAddress[], body: Body): void {
    if (this.#pool === null) return
    const seen = new Set<string>()
    const missing = wanted
      .filter((region) => {
        const key = this.#key(region)
        if (seen.has(key)) return false
        seen.add(key)
        return !this.#fields.has(key) && !this.#inFlight.has(key)
      })
      // `Math.max(0, …)` because a negative end index slices from the *back* of
      // the array — an over-full queue would have asked for the tail of the
      // wanted list rather than for nothing.
      .slice(
        0,
        Math.max(
          0,
          Math.min(REQUESTS_PER_FRAME, IN_FLIGHT_CAP - this.#inFlight.size),
        ),
      )

    for (const region of missing) {
      const key = this.#key(region)
      // Captured beside the key: a result that outlives its world is dropped
      // rather than cached, because the key alone cannot tell a new seed's
      // s:SOL/b:2 from the old one's.
      const epoch = this.#epoch
      this.#inFlight.add(key)
      void this.#pool
        .run(generateHeightfieldTask, {
          surfaceSeed: formatSeed(body.surface.seed),
          maxElevation: body.surface.maxElevation,
          roughness: body.surface.roughness,
          seaLevel: body.surface.seaLevel,
          grammar: body.surface.grammar,
          region,
          resolution: HEIGHTFIELD_RESOLUTION,
          border: HEIGHTFIELD_BORDER,
        })
        .then((result) => {
          if (epoch !== this.#epoch) return
          this.#fields.set(key, {
            elevations: result.elevations,
            cover: result.cover,
            region,
            border: result.border,
          })
        })
        .catch((cause: unknown) => {
          log.warn('terrain patch failed', { key, cause: String(cause) })
        })
        .finally(() => {
          this.#inFlight.delete(key)
        })
    }
  }

  /**
   * Drop what the frame's request list does not name, once there is too much.
   *
   * Above the caps rather than every frame, because the two sets change by a
   * patch or two as the camera moves and evicting on that cadence would
   * regenerate the ground behind a camera that turned around. A `Map` iterates
   * in insertion order, so the oldest entry that nothing wants goes first.
   *
   * The keep set is the whole request list — drawn set, starved children,
   * pyramid — rather than the two selections' leaves. `#request` re-asks for
   * every rung of the pyramid every frame, so a keep set without them turns
   * the cap into a treadmill: evict a rung, re-request it next frame,
   * regenerate it at 9 to 37 ms, evict it again.
   */
  #evict(requested: readonly RegionAddress[]): void {
    if (
      this.#fields.size <= FIELD_CACHE &&
      this.#patches.size <= GEOMETRY_CACHE
    ) {
      return
    }
    const keep = new Set<string>()
    for (const region of requested) keep.add(this.#key(region))

    for (const key of this.#fields.keys()) {
      if (this.#fields.size <= FIELD_CACHE) break
      if (!keep.has(key)) this.#fields.delete(key)
    }
    for (const key of this.#patches.keys()) {
      if (this.#patches.size <= GEOMETRY_CACHE) break
      if (!keep.has(key)) this.#patches.delete(key)
    }
  }

  /**
   * Stop drawing, keep the cache. The body is here but the pipeline is not.
   *
   * Every selection mirror goes, not just the drawn set: `summary()` reads
   * them after this, and a report that says `patches: 0` beside last frame's
   * `visited`/`starved` counters is a diagnostic lying in exactly the states
   * it exists to explain.
   */
  #forget(): void {
    this.#drawn = []
    this.#deepest = 0
    this.#shallowest = 0
    this.#visited = 0
    this.#culled = 0
    this.#starved = 0
    this.#saturated = false
    this.#pose = null
    // Same argument as the lens below: a palette beside `patches: 0` describes
    // a body this streamer is no longer drawing, and the material would keep
    // wearing the last world's ground.
    this.#palette = null
    // The lens is a selection mirror like the rest: reporting one beside
    // `patches: 0` claims a selection was made against it, and none was.
    this.#lensView = null
    // The rocks go with the ground they lie on. Their cache stays: the eight-
    // pixel gate is thousands of kilometers above the range they draw in, so a
    // frame that reaches this line has left the surface entirely.
    this.#scatter.forget()
  }

  /** Drop everything. The world was replaced; none of this describes it. */
  clear(): void {
    // In-flight answers are for the world this discards; see `#epoch`.
    this.#epoch += 1
    this.#fields.clear()
    this.#patches.clear()
    this.#bodyAddress = null
    this.#previous = null
    this.#scatter.clear()
    this.#forget()
  }
}
