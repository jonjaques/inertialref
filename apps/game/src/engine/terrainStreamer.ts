import { getLogger } from '@inertialref/shared'
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
  regionAddress,
  regionForDirection,
} from '@inertialref/universe'
import { buildPatch, type RenderPatch, terrainLevelFor } from '@inertialref/rendering'
import { generateHeightfieldTask, type WorkerPool } from '@inertialref/workers'

/*
 * Terrain streaming.
 *
 * Requests the patches under the player from the worker pool, caches the
 * heightfields (not the meshes — a rebase invalidates meshes and heightfields
 * are the expensive half), and rebuilds geometry when the render origin moves.
 *
 * Loading and unloading are ordinary operations here, not a mode: the streamer
 * is asked what should be visible every frame and reconciles.
 */

const log = getLogger('game.terrain')

/** How many rings of neighbours around the player's own region. */
const RADIUS = 1

interface CachedField {
  readonly elevations: Float32Array
  readonly region: RegionAddress
}

export interface TerrainState {
  readonly bodyAddress: string | null
  readonly patches: readonly RenderPatch[]
  readonly pending: number
  readonly cached: number
  readonly level: number
}

export class TerrainStreamer {
  readonly #pool: WorkerPool | null
  readonly #fields = new Map<string, CachedField>()
  readonly #patches = new Map<string, RenderPatch>()
  readonly #inFlight = new Set<string>()
  #bodyAddress: string | null = null
  #level = 0

  constructor(pool: WorkerPool | null) {
    this.#pool = pool
  }

  state(): TerrainState {
    return {
      bodyAddress: this.#bodyAddress,
      patches: [...this.#patches.values()],
      pending: this.#inFlight.size,
      cached: this.#fields.size,
      level: this.#level,
    }
  }

  /**
   * Reconcile the loaded set against where the camera is.
   *
   * Called every frame; cheap when nothing has changed, because the work is
   * keyed by (body, region) and both are stable while the player hovers.
   */
  update(world: World, camera: UniverseVector, origin: RenderOrigin, bodyAddress: string | null): void {
    if (bodyAddress === null) {
      this.clear()
      return
    }
    if (bodyAddress !== this.#bodyAddress) {
      this.clear()
      this.#bodyAddress = bodyAddress
    }

    const resolved = this.#resolve(world, bodyAddress)
    if (resolved === null) return
    const { body, bodyPose, spinPose } = resolved

    const distance = UV.distance(camera, bodyPose.position)
    // Which patch of ground is under the camera. `bodyFixedDirection` is the
    // only producer of the branded direction the terrain functions accept, so
    // this cannot drift back to an inertial sample the way it once did.
    const direction = bodyFixedDirection(spinPose, camera)
    this.#level = terrainLevelFor(body.radius, distance)

    const centre = regionForDirection(direction, this.#level)
    const span = 2 ** this.#level
    const wanted = new Set<string>()

    for (let di = -RADIUS; di <= RADIUS; di += 1) {
      for (let dj = -RADIUS; dj <= RADIUS; dj += 1) {
        const i = centre.i + di
        const j = centre.j + dj
        // Patches that fall off the edge of a cube face belong to a different
        // face; stitching those is a later refinement, so they are skipped
        // rather than wrapped into the wrong place.
        if (i < 0 || j < 0 || i >= span || j >= span) continue
        const region = regionAddress(centre.face, this.#level, i, j)
        const key = this.#key(bodyAddress, region)
        wanted.add(key)
        this.#ensure(key, body, region, bodyPose.position, spinPose.orientation, origin)
      }
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
   */
  #resolve(
    world: World,
    bodyAddress: string,
  ): { body: Body; bodyPose: FramePose; spinPose: FramePose } | null {
    const address = parseAddress(bodyAddress)
    if (address.kind !== 'body') return null
    const system = world.system(address.system)
    if (system === undefined) return null
    const body = findBody(system, address.body)
    if (body === undefined) return null
    const time = world.clock.time
    return {
      body,
      bodyPose: world.frames.pose(bodyFrameId(body.address), time),
      spinPose: world.frames.pose(bodyFixedFrameId(body.address), time),
    }
  }

  #ensure(
    key: string,
    body: Body,
    region: RegionAddress,
    bodyCentre: UniverseVector,
    bodyOrientation: Q.Quat,
    origin: RenderOrigin,
  ): void {
    const cached = this.#fields.get(key)
    if (cached !== undefined) {
      const existing = this.#patches.get(key)
      if (existing === undefined || existing.originGeneration !== origin.generation) {
        this.#patches.set(
          key,
          buildPatch(
            {
              region,
              resolution: HEIGHTFIELD_RESOLUTION,
              elevations: cached.elevations,
              bodyRadius: body.radius,
              bodyCentre,
              bodyOrientation,
            },
            origin,
          ),
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
  }

  #key(bodyAddress: string, region: RegionAddress): string {
    return `${bodyAddress}|${region.face}.${region.level}.${region.i}.${region.j}`
  }
}
