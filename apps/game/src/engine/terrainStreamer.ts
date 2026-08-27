import { getLogger, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  type FramePose,
  Quaternion as Q,
  type RenderOrigin,
  UV,
  type UniverseVector,
} from '@inertialref/spatial'
import type { World } from '@inertialref/simulation'
import {
  bodyFixedDirection,
  bodyFixedFrameId,
  bodyFrameId,
  type Body,
  findBody,
  HEIGHTFIELD_RESOLUTION,
  parseAddress,
  type RegionAddress,
} from '@inertialref/universe'
import {
  buildPatch,
  type PatchPlacement,
  patchPlacement,
  type RenderPatch,
  terrainLevelFor,
  terrainOpacity,
  terrainPatchKey,
  terrainWindow,
} from '@inertialref/rendering'
import { generateHeightfieldTask, type WorkerPool } from '@inertialref/workers'

/*
 * Terrain streaming.
 *
 * Requests the patches under the player from the worker pool, caches the
 * heightfields and the geometry built from them, and re-places that geometry
 * every frame as the planet turns.
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
 */

const log = getLogger('game.terrain')

interface CachedField {
  readonly elevations: Float32Array
  readonly region: RegionAddress
}

/** A patch's static geometry plus where it belongs this frame. */
export interface PlacedPatch {
  readonly patch: RenderPatch
  readonly placement: PatchPlacement
}

export interface TerrainState {
  readonly bodyAddress: string | null
  readonly patches: readonly PlacedPatch[]
  readonly pending: number
  readonly cached: number
  readonly level: number
  /** `terrainOpacity` for this frame; the view maps it straight onto the material. */
  readonly opacity: number
}

export class TerrainStreamer {
  readonly #pool: WorkerPool | null
  readonly #fields = new Map<string, CachedField>()
  readonly #patches = new Map<string, RenderPatch>()
  readonly #inFlight = new Set<string>()
  #bodyAddress: string | null = null
  #level = 0
  #opacity = 0
  /*
   * The transform the patches are drawn with, refreshed by `update` every frame.
   *
   * Held rather than passed to `state()` because the answer is the same for
   * every patch on the body and stale for all of them together — one place to
   * be wrong is better than nine.
   */
  #pose: {
    origin: RenderOrigin
    centre: UniverseVector
    orientation: Q.Quat
  } | null = null

  constructor(pool: WorkerPool | null) {
    this.#pool = pool
  }

  /**
   * How much geometry is held, without building a placement for any of it.
   *
   * `state()` maps every patch through `patchPlacement` — render-space
   * arithmetic these counters throw away immediately — and the renderer already
   * calls it once a frame. `ir.terrain()` asking through `state()` paid for a
   * second complete placement pass it never read.
   */
  summary(): {
    readonly bodyAddress: string | null
    readonly level: number
    readonly opacity: number
    readonly pending: number
    readonly cached: number
    readonly patches: number
    readonly vertices: number
    readonly triangles: number
  } {
    let vertices = 0
    let triangles = 0
    for (const patch of this.#patches.values()) {
      vertices += patch.positions.length / 3
      triangles += patch.indices.length / 3
    }
    return {
      bodyAddress: this.#bodyAddress,
      level: this.#level,
      opacity: this.#opacity,
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      patches: this.#patches.size,
      vertices,
      triangles,
    }
  }

  state(): TerrainState {
    const pose = this.#pose
    return {
      bodyAddress: this.#bodyAddress,
      patches:
        pose === null
          ? []
          : [...this.#patches.values()].map((patch) => ({
              patch,
              placement: patchPlacement(
                patch,
                pose.origin,
                pose.centre,
                pose.orientation,
              ),
            })),
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      level: this.#level,
      opacity: this.#opacity,
    }
  }

  /**
   * Reconcile the loaded set against where the camera is.
   *
   * Called every frame; cheap when nothing has changed, because the work is
   * keyed by (body, region) and both are stable while the player hovers.
   */
  update(
    world: World,
    renderTime: Seconds,
    camera: UniverseVector,
    origin: RenderOrigin,
    bodyAddress: string | null,
  ): void {
    if (bodyAddress === null) {
      this.clear()
      return
    }
    if (bodyAddress !== this.#bodyAddress) {
      this.clear()
      this.#bodyAddress = bodyAddress
    }

    const resolved = this.#resolve(world, renderTime, bodyAddress)
    if (resolved === null) return
    const { body, bodyPose, spinPose } = resolved
    this.#pose = {
      origin,
      centre: bodyPose.position,
      orientation: spinPose.orientation,
    }

    const distance = UV.distance(camera, bodyPose.position)
    /*
     * The fade first, and the window only if there is one.
     *
     * Away from the ground the 3×3 window is a lone tile on the datum sphere,
     * not a representation of the surface, so it is neither drawn nor worth a
     * worker's time. The heightfield cache is kept: a descent should fade the
     * ground in, not re-generate it.
     *
     * `terrainWindow` computes its regions whatever the opacity — deliberately,
     * for the descent probe, which wants to know what the window *would* be at
     * every altitude it passes through. That is the wrong bargain in a frame
     * loop: opacity is only non-zero within about an octave of the surface, so
     * on nearly every frame of every orbit, approach and interstellar view the
     * streamer would run a gnomonic projection and allocate nine region objects
     * to throw all of them away. The check is one multiply.
     */
    this.#opacity = terrainOpacity(body.radius, distance)
    if (this.#opacity === 0) {
      this.#level = terrainLevelFor(body.radius, distance)
      this.#patches.clear()
      return
    }

    // Which patch of ground is under the camera. `bodyFixedDirection` is the
    // only producer of the branded direction the terrain functions accept, so
    // this cannot drift back to an inertial sample the way it once did.
    const direction = bodyFixedDirection(spinPose, camera)
    // The selection rule itself lives in `packages/rendering`, where it can be
    // asked a question without a browser — that is what makes `ir.descend` a
    // measurement rather than a manual fly-down. Nothing about the rule changed
    // when it moved.
    const window = terrainWindow(body.radius, distance, direction)
    this.#level = window.level

    const wanted = new Set<string>()
    for (const region of window.regions) {
      const key = terrainPatchKey(bodyAddress, region)
      wanted.add(key)
      this.#ensure(key, body, region)
    }

    for (const key of [...this.#patches.keys()]) {
      if (!wanted.has(key)) this.#patches.delete(key)
    }
    for (const key of [...this.#fields.keys()]) {
      if (!wanted.has(key) && this.#fields.size > 64) this.#fields.delete(key)
    }
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
  ): { body: Body; bodyPose: FramePose; spinPose: FramePose } | null {
    const address = parseAddress(bodyAddress)
    if (address.kind !== 'body') return null
    const system = world.system(address.system)
    if (system === undefined) return null
    const body = findBody(system, address.body)
    if (body === undefined) return null
    return {
      body,
      bodyPose: world.frames.pose(bodyFrameId(body.address), time),
      spinPose: world.frames.pose(bodyFixedFrameId(body.address), time),
    }
  }

  #ensure(key: string, body: Body, region: RegionAddress): void {
    const cached = this.#fields.get(key)
    if (cached !== undefined) {
      // Built once. The geometry is body-fixed, so nothing that happens to the
      // planet or to the render origin can invalidate it.
      if (!this.#patches.has(key)) {
        this.#patches.set(
          key,
          buildPatch({
            region,
            resolution: HEIGHTFIELD_RESOLUTION,
            elevations: cached.elevations,
            bodyRadius: body.radius,
          }),
        )
      }
      return
    }

    if (this.#inFlight.has(key) || this.#pool === null) return
    this.#inFlight.add(key)
    void this.#pool
      .run(generateHeightfieldTask, {
        surfaceSeed: formatSeed(body.surface.seed),
        maxElevation: body.surface.maxElevation,
        roughness: body.surface.roughness,
        seaLevel: body.surface.seaLevel,
        region,
        resolution: HEIGHTFIELD_RESOLUTION,
      })
      .then((result) => {
        this.#fields.set(key, { elevations: result.elevations, region })
      })
      .catch((cause: unknown) => {
        log.warn('terrain patch failed', { key, cause: String(cause) })
      })
      .finally(() => {
        this.#inFlight.delete(key)
      })
  }

  /** Drop everything. The world was replaced; none of this describes it. */
  clear(): void {
    this.#fields.clear()
    this.#patches.clear()
    this.#bodyAddress = null
    this.#pose = null
    this.#opacity = 0
  }
}
