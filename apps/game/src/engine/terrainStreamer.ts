import { getLogger, type Meters, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  type FramePose,
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
  DEFAULT_MAX_PATCHES,
  DEFAULT_VIEWPORT,
  type PatchPlacement,
  patchPlacement,
  type RenderBody,
  type RenderPatch,
  pixelsPerRadian,
  type SelectedPatch,
  selectTerrain,
  type TerrainEye,
  type TerrainViewport,
  terrainPatchKey,
} from '@inertialref/rendering'
import { generateHeightfieldTask, type WorkerPool } from '@inertialref/workers'

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
 *     selected with a `ready` test against the heightfield cache, so a patch
 *     whose field has not arrived is not a hole — its parent is drawn instead,
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
 * How far ahead of the camera the request set is taken, in seconds.
 *
 * Long enough for a worker to answer — a patch is 12.8 ms of generation and the
 * pool is a handful of them — and short enough that a turn does not spend the
 * budget on ground nobody looks at. The extrapolation is linear in the eye's
 * own motion and ignores the body's rotation over the interval, which at two
 * seconds is meters on anything you could be landing on.
 */
const PREFETCH_SECONDS: Seconds = 2

/** Heightfields to queue in one frame. Beyond this they are queueing, not working. */
const REQUESTS_PER_FRAME = 8

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
 * A bordered 65×65 field is 19 KB, so this is about 44 MB.
 */
const FIELD_CACHE = DEFAULT_MAX_PATCHES * 3

/**
 * Patch geometries held.
 *
 * Only drawn patches get geometry, so the ceiling is the selection itself plus
 * enough slack that a camera turning back finds the ground where it left it.
 * A patch is 203 KB of vertex buffers, which is the expensive half of terrain's
 * memory and the half attribute packing would halve.
 */
const GEOMETRY_CACHE = DEFAULT_MAX_PATCHES + 128

interface CachedField {
  readonly elevations: Float32Array
  readonly region: RegionAddress
  readonly border: number
}

/** A patch's static geometry, where it belongs this frame, and how it morphs. */
export interface PlacedPatch {
  readonly patch: RenderPatch
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
   * The body's own published color, linear.
   *
   * Terrain has no material of its own yet — Phase 3 is the biome splat, the
   * crater rays and the mapped bodies' albedo — and one flat sandstone color
   * for every world was survivable while the streamed set was nine patches near
   * the ground. It is not survivable now that the quadtree draws the whole
   * disk: the ground *is* the picture of the planet, and Callisto and Mars are
   * not the same color. This is the same number the datum sphere is tinted
   * with, so the two agree until there is something better to say.
   */
  readonly colour: { r: number; g: number; b: number }
}

export class TerrainStreamer {
  readonly #pool: WorkerPool | null
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
  #colour = { r: 0.61, g: 0.51, b: 0.4 }
  /** Last eye, for the velocity the request set is extrapolated along. */
  #previous: { camera: UniverseVector; time: Seconds } | null = null

  /**
   * The drawable height the selection is measured against, in physical pixels.
   *
   * A presentation input like `fov`, set by the scene from the drawing buffer,
   * and it belongs to the streamer rather than to the selection because a
   * two-times display genuinely wants twice the patches for the same picture.
   */
  viewport: TerrainViewport | null = null

  constructor(pool: WorkerPool | null) {
    this.#pool = pool
  }

  /**
   * What is held and what it costs, without building a placement for any of it.
   *
   * `state()` maps every patch through `patchPlacement` — render-space
   * arithmetic these counters throw away immediately — and the renderer already
   * calls it once a frame. `ir.terrain()` asking through `state()` paid for a
   * second complete placement pass it never read.
   */
  summary(): {
    readonly bodyAddress: string | null
    readonly level: number
    readonly shallowestLevel: number
    readonly pending: number
    readonly cached: number
    readonly patches: number
    readonly vertices: number
    readonly triangles: number
    readonly visited: number
    readonly culled: number
    readonly starved: number
    readonly saturated: boolean
  } {
    let vertices = 0
    let triangles = 0
    for (const selected of this.#drawn) {
      const patch = this.#patches.get(this.#key(selected.region))
      if (patch === undefined) continue
      vertices += patch.positions.length / 3
      triangles += patch.indices.length / 3
    }
    return {
      bodyAddress: this.#bodyAddress,
      level: this.#deepest,
      shallowestLevel: this.#shallowest,
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      patches: this.#drawn.length,
      vertices,
      triangles,
      visited: this.#visited,
      culled: this.#culled,
      starved: this.#starved,
      saturated: this.#saturated,
    }
  }

  state(): TerrainState {
    const pose = this.#pose
    const patches: PlacedPatch[] = []
    if (pose !== null) {
      for (const selected of this.#drawn) {
        const patch = this.#patches.get(this.#key(selected.region))
        if (patch === undefined) continue
        patches.push({
          patch,
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
      colour: this.#colour,
    }
  }

  /**
   * Reconcile the loaded set against where the camera is.
   *
   * Called every frame; cheap when nothing has changed, because the work is
   * keyed by (body, region) and both are stable while the player hovers. The
   * selection itself is 40–90 µs for a whole disk, which is what lets it run
   * unconditionally rather than behind an altitude gate.
   */
  update(
    world: World,
    renderTime: Seconds,
    camera: UniverseVector,
    origin: RenderOrigin,
    body: RenderBody | null,
  ): void {
    const previous = this.#previous
    this.#previous = { camera, time: renderTime }

    if (body === null) {
      this.clear()
      return
    }
    if (body.address !== this.#bodyAddress) {
      this.clear()
      this.#bodyAddress = body.address
    }

    const resolved = this.#resolve(world, renderTime, body.address)
    if (resolved === null) return
    const { surface, bodyPose, spinPose } = resolved
    /*
     * Solid bodies only. A gas giant has no surface to stream and the tier must
     * never fire for one.
     *
     * And *every* solid body, mapped or not — which is the one place this
     * departs from the plan's carve-out, deliberately. Mapped Sol bodies keep
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

    this.#pose = {
      position: body.placement.position,
      orientation: Q.multiply(
        Q.conjugate(origin.orientation),
        spinPose.orientation,
      ),
      scale: body.placement.compression,
      eye: universeToLocal(spinPose, camera),
    }
    this.#colour = surface.appearance.colour

    const viewport = this.viewport ?? DEFAULT_VIEWPORT
    const eye = this.#eye(surface, spinPose, bodyPose.position, camera)
    const height = Math.max(1, eye.distance - eye.radius)
    if (
      (eye.relief * pixelsPerRadian(viewport)) / height <
      TERRAIN_RELIEF_PIXELS
    ) {
      this.#forget()
      return
    }

    const options = {
      maxLevel: surfaceDetailFloor(surface.radius, surface.surface),
      viewport,
    }

    // What to draw: refine only into ground already in the cache, so a patch
    // that has not arrived costs detail rather than leaving a hole.
    const drawn = selectTerrain(eye, {
      ...options,
      ready: (region) => this.#fields.has(this.#key(region)),
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
        camera,
        renderTime,
        previous,
        eye,
      ),
      options,
    )

    this.#build(drawn.patches, surface)
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
    this.#request(
      [
        // What is drawn now and has no geometry yet.
        ...drawn.patches.map((patch) => patch.region),
        // What the drawn set is waiting on to refine.
        ...drawn.starved.flatMap((region) => [...regionChildren(region)]),
        // And the whole pyramid under the ideal selection, shallow first.
        ...pyramid(wanted.patches),
      ],
      surface,
    )
    this.#evict(drawn.patches, wanted.patches)
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
   * Linear in the observed motion between the last two frames, which is right
   * for a descent and harmless for a hover — the extrapolation collapses to the
   * present when the camera is still. A frame boundary that is not a frame — a
   * teleport, a resumed tab — produces a velocity that means nothing, so a step
   * longer than a second or shorter than nothing falls back to the eye itself.
   */
  #lookAhead(
    body: Body,
    spinPose: FramePose,
    centre: UniverseVector,
    camera: UniverseVector,
    time: Seconds,
    previous: { camera: UniverseVector; time: Seconds } | null,
    eye: TerrainEye,
  ): TerrainEye {
    if (previous === null) return eye
    const step = time - previous.time
    if (!(step > 0) || step > 1) return eye
    const drift = UV.difference(camera, previous.camera)
    const ahead = UV.translate(
      camera,
      Vec.scale(drift, PREFETCH_SECONDS / step),
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
      surface: hasSolidSurface(body) ? body : null,
      bodyPose: world.frames.pose(bodyFrameId(body.address), time),
      spinPose: world.frames.pose(bodyFixedFrameId(body.address), time),
    }
  }

  /** Build geometry for drawn patches that do not have it yet, under budget. */
  #build(drawn: readonly SelectedPatch[], body: Body): void {
    let built = 0
    for (const selected of drawn) {
      if (built >= BUILDS_PER_FRAME) return
      const key = this.#key(selected.region)
      if (this.#patches.has(key)) continue
      const field = this.#fields.get(key)
      if (field === undefined) continue
      // Built once. The geometry is body-fixed, so nothing that happens to the
      // planet or to the render origin can invalidate it.
      this.#patches.set(
        key,
        buildPatch({
          region: selected.region,
          resolution: HEIGHTFIELD_RESOLUTION,
          border: field.border,
          elevations: field.elevations,
          bodyRadius: body.radius,
        }),
      )
      built += 1
    }
  }

  /**
   * Queue the missing heightfields, coarsest first and then nearest.
   *
   * The order is the argument. The list arrives as the draw set followed by the
   * ideal one, and within each the nearest goes first — so a frame's budget
   * buys the ground being looked at rather than whichever cube face the walk
   * started on, and it buys the patch that is *drawn* before the patch that
   * will replace it. A stable sort keeps that grouping.
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
      .slice(0, REQUESTS_PER_FRAME)

    for (const region of missing) {
      const key = this.#key(region)
      this.#inFlight.add(key)
      void this.#pool
        .run(generateHeightfieldTask, {
          surfaceSeed: formatSeed(body.surface.seed),
          maxElevation: body.surface.maxElevation,
          roughness: body.surface.roughness,
          seaLevel: body.surface.seaLevel,
          region,
          resolution: HEIGHTFIELD_RESOLUTION,
          border: HEIGHTFIELD_BORDER,
        })
        .then((result) => {
          this.#fields.set(key, {
            elevations: result.elevations,
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
   * Drop what neither set wants, once there is too much of it.
   *
   * Above the caps rather than every frame, because the two sets change by a
   * patch or two as the camera moves and evicting on that cadence would
   * regenerate the ground behind a camera that turned around. A `Map` iterates
   * in insertion order, so the oldest entry that nothing wants goes first.
   */
  #evict(
    drawn: readonly SelectedPatch[],
    wanted: readonly SelectedPatch[],
  ): void {
    const keep = new Set<string>()
    for (const selected of drawn) keep.add(this.#key(selected.region))
    for (const selected of wanted) keep.add(this.#key(selected.region))

    for (const key of this.#fields.keys()) {
      if (this.#fields.size <= FIELD_CACHE) break
      if (!keep.has(key)) this.#fields.delete(key)
    }
    for (const key of this.#patches.keys()) {
      if (this.#patches.size <= GEOMETRY_CACHE) break
      if (!keep.has(key)) this.#patches.delete(key)
    }
  }

  /** Stop drawing, keep the cache. The body is here but the pipeline is not. */
  #forget(): void {
    this.#drawn = []
    this.#deepest = 0
    this.#shallowest = 0
    this.#pose = null
  }

  /** Drop everything. The world was replaced; none of this describes it. */
  clear(): void {
    this.#fields.clear()
    this.#patches.clear()
    this.#bodyAddress = null
    this.#previous = null
    this.#forget()
  }
}
