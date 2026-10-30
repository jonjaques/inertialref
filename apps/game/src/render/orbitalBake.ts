import {
  BufferAttribute,
  type Camera,
  CubeCamera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  Scene,
  type Texture,
  CubeRenderTarget,
  Vector3,
  type WebGPURenderer,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import type {
  HeightfieldResponse,
  Heightfields,
  JobHandle,
} from '@inertialref/workers'
import {
  type Body,
  type DepositSlopeTable,
  type SurfaceParameters,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  regionAddress,
} from '@inertialref/universe'
import {
  buildPatch,
  patchIndices,
  patchWater,
  terrainPalette,
  type TerrainPalette,
} from '@inertialref/rendering'
import type { TerrainMaterial } from './terrain.ts'
import {
  disposeKeepingSharedIndex,
  patchGeometry,
  wearGround,
} from './groundWear.ts'

/*
 * The orbital bake: a generated world's sphere learns what its ground looks
 * like.
 *
 * Below the eight-pixel relief gate the streamed ground carries the sea, the
 * rivers, the biosphere, the maria and the caps; above it the archive's
 * sphere is drawn instead, and for a generated body that sphere is one flat
 * tint — the class color, then the family color. From orbit a temperate
 * ocean world was a ball of one color until the gate opened and it turned
 * blue and green. [The terrain plan](../../../../design/plans/terrain.md)
 * names the fix and this is it: the ground's own picture, taken once per
 * body and worn by the sphere at every distance.
 *
 * **The picture is taken by the ground material, not by a copy of it.** The
 * ninety-six level-2 regions of a body are asked of the same
 * `Heightfields` module a patch is, with the same adapter selection and
 * recovery, built with the same `buildPatch`, and drawn with the
 * same `render/terrain.ts` graph in its bake mode into a cube target from a
 * camera at the body's center. What the sphere then samples by direction is
 * the deposit stack, the mineral tint and the rivers the ground draws, by
 * construction rather than by a second implementation kept in step; the
 * seam rule in `AGENTS.md` holds because there is one graph. A second pass
 * writes the relief record — the mesh normal's slopes east and north, and
 * the sea mask — in the layout the sphere reads the archive's normal map
 * in, so a generated disk shades its mountains and keys its ocean color
 * and sun-glint exactly as a photographed one does.
 *
 * **The work is spread across frames, and the sphere sees none of it until
 * it is done.** Ninety-six patches built on the main thread and twelve
 * renders of them — six faces of each record — taken in the frame the tiles
 * arrive are a hitch of tens of milliseconds, once per body. The tiles
 * arrive whenever the producer answers; `advance`, called once a frame
 * before anything draws, builds patches for `BUILD_BUDGET_MS` of a frame and
 * then draws one face a frame. Until the twelfth face is drawn `textureFor`
 * answers null and the sphere keeps the flat tint it wore before the bake
 * was asked for, so no viewer ever sees a target with five faces in it.
 *
 * A bake is a presentation cache — regenerable from the seed, never saved —
 * and a few are kept: a body that leaves the frame and comes back should not
 * pay for a second one.
 */

const log = getLogger('game.bake')

/** Texels a cube face is across. Half a megapixel a face; 25 km a texel on Earth. */
const FACE_SIZE = 512

/** The region level the faces are drawn from: sixteen patches a face. */
const BAKE_LEVEL = 2

/** Bakes kept after their bodies leave the frame. */
const KEPT = 4

/**
 * How long after its last ask a bake is safe from eviction, ms.
 *
 * A body in the frame asks every frame. With more such bodies than `KEPT`,
 * evicting the least-recently-asked to make room would evict one asked a
 * frame ago, which asks again next frame and evicts the next — ninety-six
 * tiles a body a frame into the producer, and none of them ever drawn. Past
 * the kept set a body keeps its tint until one leaves the frame instead.
 */
const RESIDENCY_MS = 500

/**
 * The main thread a bake may spend building patches in one frame, ms.
 *
 * Two, the allowance the streamer takes for the same `buildPatch` while the
 * ground converges, for the frames a bake takes and nothing once it has. A
 * time rather than a count, because the build's cost is not one number:
 * measured at 0.9 ms a patch under Dawn and 2.4 ms in Chrome, with the cover
 * and its morph twin, on a machine running other suites — where the
 * streamer's eight-a-frame was sized on 0.25 ms. The frame stops before the
 * build that would take it past this, and always builds one, so a bake on a
 * slow machine is slower rather than stuck.
 */
const BUILD_BUDGET_MS = 2

/** The draws a bake makes: six faces of the reflectance, then six of the relief. */
const FACE_DRAWS = 12

/**
 * The relief record's face size.
 *
 * The bake is drawn from level-2 patches, sixty-four cells across a quarter
 * face, so a face holds 256 mesh normals a side and a texel per normal is
 * the whole of what there is to keep; the reflectance is drawn at twice
 * that because the deposits and the rivers are per pixel, not per vertex.
 */
const RELIEF_SIZE = 256

/** What a finished bake hands the sphere. */
export interface OrbitalBakeMaps {
  /** The ground's reflectance, six faces, linear, half float. */
  readonly albedo: Texture
  /**
   * The relief record, six faces, half float: the mesh normal's slopes east
   * and north in RG as `x / 2 + 1/2`, and the sea mask in B — the archive
   * normal map's own layout and encoding.
   *
   * Half float rather than the byte a photograph's map is stored in, because
   * a slope at forty kilometers a cell is a few hundredths: a byte resolves
   * that to five steps, and the sphere's relief exaggeration draws every one
   * of them as a facet. Half float about one half resolves it to forty.
   */
  readonly relief: Texture
}

/**
 * A bake between its tiles and its last face: what is built, and what is
 * drawn. Held on the bake so an eviction mid-way disposes what it built.
 */
interface BakeWork {
  readonly regions: readonly RegionAddress[]
  readonly fields: readonly HeightfieldResponse[]
  readonly palette: TerrainPalette
  /** The body's deposit slope table, or null to draw the slope as drawn. */
  readonly slopes: DepositSlopeTable | null
  /** The patches built so far, each at its anchor. */
  readonly meshes: Mesh[]
  /** One scene a face, holding the patches that face's camera looks at. */
  readonly scenes: readonly Scene[]
  /** One camera per record, at the body's center, aimed. */
  readonly cameras: readonly [CubeCamera, CubeCamera]
  /** Where each face's camera looks, body-fixed. */
  readonly looks: readonly Vector3[]
  /** Faces drawn, of `FACE_DRAWS`. */
  drawn: number
}

/** One bake's state: the targets it renders into, and whether it has. */
interface Bake {
  readonly address: string
  readonly body: Body
  readonly target: CubeRenderTarget
  readonly reliefTarget: CubeRenderTarget
  /** The tile jobs in flight, canceled if the bake is evicted under them. */
  readonly jobs: JobHandle<HeightfieldResponse | null>[]
  /** When the body last asked, in `performance.now()` ms. */
  asked: number
  /** When it was asked first, for the log line that says how long it took. */
  readonly started: number
  /** Set when the tiles are in hand, cleared when the last face is drawn. */
  work: BakeWork | null
  ready: boolean
  failed: boolean
}

export interface OrbitalBaker {
  /**
   * The bake for `body`, or null while none is ready. Asking is what starts
   * one; the answer arrives a few frames later and is then the same texture
   * every frame.
   */
  textureFor(address: string): OrbitalBakeMaps | null
  /**
   * One frame's share of the bakes in flight: `BUILD_BUDGET_MS` of patch
   * builds, or one face once every patch is built. Called once a frame, before
   * anything draws with the ground material — a face draw writes the
   * material's palette, and the streamed ground writes it back after.
   */
  advance(): void
  /** The bakes held, for the harness: which bodies, and whether each is ready. */
  report(): readonly { address: string; ready: boolean; failed: boolean }[]
  /** A held bake's targets, for a readback. Null while none is held. */
  targetFor(
    address: string,
  ): { albedo: CubeRenderTarget; relief: CubeRenderTarget } | null
  dispose(): void
}

/**
 * The producer the bake asks for its tiles, and the material it draws them
 * with — the renderer's own, so the program is the ground's.
 *
 * The pipeline is not the one the boot warmed. A pipeline is keyed on the
 * sample count and formats of the target it draws into, and the boot warms
 * the scene pass's four-sample layout where a face is one sample; so the
 * first face of a session's first bake builds the bake's variant in its
 * frame, measured in Chrome at 26–32 ms of `advance` against 7.7 ms for the
 * first face of a second bake on a machine running other suites.
 */
export interface OrbitalBakeHost {
  readonly renderer: WebGPURenderer
  readonly terrain: TerrainMaterial
  bodyFor(address: string): Body | null
  readonly heightfields: Heightfields
  /** The clock the build budget is spent against; `performance.now` by default. */
  readonly now?: () => number
  /**
   * The body's deposit slope table once a worker has measured it, null where
   * it never will be. The bake waits for it: the sphere's reflectance is the
   * ground's at level 2, and drawn without its row the far half of a descent
   * would wear the uncorrected tone the near half no longer does.
   */
  slopesFor(surface: SurfaceParameters): Promise<DepositSlopeTable | null>
}

export function createOrbitalBaker(host: OrbitalBakeHost): OrbitalBaker {
  const bakes = new Map<string, Bake>()
  const now = host.now ?? (() => performance.now())
  let disposed = false
  /*
   * The patch's triangle list with every triangle turned over. The camera
   * is at the body's center and looks at the ground from *inside* the shell,
   * where the ground's own winding is clockwise and the material's single
   * side culls all of it — a bake of nothing, which reads as a black sphere
   * under the veil. Reversing the index rather than the material's side
   * keeps the pipeline the one the boot warmed: a cull mode is pipeline
   * state, and a second one would compile in the frame the first bake ran.
   */
  const indices = new BufferAttribute(
    insideOut(patchIndices(HEIGHTFIELD_RESOLUTION)),
    1,
  )

  function textureFor(address: string): OrbitalBakeMaps | null {
    if (disposed) return null
    const asked = performance.now()
    const body = host.bodyFor(address)
    const held = bakes.get(address)
    if (held !== undefined && held.body === body) {
      held.asked = asked
      bakes.delete(address)
      bakes.set(address, held)
      return held.ready
        ? { albedo: held.target.texture, relief: held.reliefTarget.texture }
        : null
    }
    if (held !== undefined) drop(address, held)
    if (body === null || body.surface.maxElevation <= 0) return null
    if (host.heightfields.kind === null) return null
    if (bakes.size >= KEPT && !evictOne(asked)) return null
    const target = new CubeRenderTarget(FACE_SIZE, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    })
    const reliefTarget = new CubeRenderTarget(RELIEF_SIZE, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    })
    const bake: Bake = {
      address,
      body,
      target,
      reliefTarget,
      jobs: [],
      asked,
      started: asked,
      work: null,
      ready: false,
      failed: false,
    }
    bakes.set(address, bake)
    void run(body, bake).catch((error: unknown) => {
      // Evicted under its tiles: the cancellation is the rejection.
      if (!stillHeld(bake)) return
      cancelJobs(bake)
      bake.failed = true
      log.warn('orbital bake failed', { address, error: String(error) })
    })
    return null
  }

  /**
   * Evicts the least-recently-asked bake outside its residency; false when
   * every held one is still being asked for.
   */
  function evictOne(now: number): boolean {
    for (const [address, bake] of bakes) {
      if (stillHeld(bake) && now - bake.asked < RESIDENCY_MS) continue
      drop(address, bake)
      return true
    }
    return false
  }

  function drop(address: string, bake: Bake): void {
    if (bakes.get(address) !== bake) return
    bakes.delete(address)
    cancelJobs(bake)
    release(bake)
    bake.target.dispose()
    bake.reliefTarget.dispose()
  }

  /** Let go of a bake's built patches. Every one holds the shared index. */
  function release(bake: Bake): void {
    const work = bake.work
    bake.work = null
    if (work === null) return
    for (const mesh of work.meshes) disposeKeepingSharedIndex(mesh)
  }

  function cancelJobs(bake: Bake): void {
    for (const job of bake.jobs) job.cancel()
    bake.jobs.length = 0
  }

  async function run(body: Body, bake: Bake): Promise<void> {
    const regions = bakeRegions()
    // The streamer's request half, so the bake's ground is the streamer's.
    const { seabed } = patchWater(body)
    const slopes = host.slopesFor(body.surface)
    const fields = await Promise.all(
      regions.map((region) => {
        /*
         * In the background lane: the producer and the pool both serve the
         * streamer's ground ahead of these, so a bake that starts on a
         * descent waits behind the ground the descent needs. Residency stops
         * a bake thrashing; this is what stops it being in the way.
         */
        const job = host.heightfields.submit(
          body.surface,
          {
            region,
            resolution: HEIGHTFIELD_RESOLUTION,
            border: HEIGHTFIELD_BORDER,
            seabed,
          },
          'background',
        )
        if (job === null) return null
        bake.jobs.push(job)
        return job.result
      }),
    )
    bake.jobs.length = 0
    const table = await slopes
    // Evicted while the tiles were in flight: nothing to draw into.
    if (!stillHeld(bake)) return
    const completed = fields.filter((field) => field !== null)
    if (completed.length !== regions.length) {
      drop(bake.address, bake)
      return
    }
    // Nothing is built here: this runs whenever the producer answered, and
    // `advance` is what spends the frame on it.
    const near = body.radius * 0.5
    const far = body.radius * 1.5
    const cameras = [
      aimCube(host.renderer, new CubeCamera(near, far, bake.target)),
      aimCube(host.renderer, new CubeCamera(near, far, bake.reliefTarget)),
    ] as const
    bake.work = {
      regions,
      fields: completed,
      palette: terrainPalette(body),
      slopes: table,
      meshes: [],
      scenes: cameras[0].children.map(() => new Scene()),
      cameras,
      looks: cameras[0].children.map((camera) =>
        camera.getWorldDirection(new Vector3()),
      ),
      drawn: 0,
    }
  }

  function advance(): void {
    if (disposed) return
    for (const bake of bakes.values()) {
      if (bake.work === null || !stillHeld(bake)) continue
      // One bake's share a frame: a second body arriving in the same frame
      // waits for the first rather than doubling the frame's cost.
      try {
        step(bake, bake.work)
      } catch (error: unknown) {
        // A bake is a picture of the ground, not the frame: one that cannot
        // be drawn leaves the sphere its tint rather than taking the frame
        // loop with it, and is not asked for again.
        release(bake)
        bake.failed = true
        log.warn('orbital bake failed', {
          address: bake.address,
          error: String(error),
        })
      }
      return
    }
  }

  /** Build the next patches, or draw the next face; finish after the last. */
  function step(bake: Bake, work: BakeWork): void {
    const { body } = bake
    if (work.meshes.length < work.fields.length) {
      // One clock read a build: the cost of the last one is the forecast for
      // the next, and the frame stops before the one that would overrun.
      const started = now()
      let previous = started
      do {
        buildNext(body, work)
        const at = now()
        const cost = at - previous
        previous = at
        if (at - started + cost > BUILD_BUDGET_MS) break
      } while (work.meshes.length < work.fields.length)
      return
    }
    drawFace(body, work)
    work.drawn += 1
    if (work.drawn < FACE_DRAWS) return
    release(bake)
    bake.ready = true
    log.info('orbital bake ready', {
      address: bake.address,
      ms: Math.round(performance.now() - bake.started),
    })
  }

  function stillHeld(bake: Bake): boolean {
    if (bakes.get(bake.address) !== bake) return false
    // A world can replace a surface without replacing its address or renderer.
    if (host.bodyFor(bake.address) === bake.body) return true
    drop(bake.address, bake)
    return false
  }

  /** The next region's patch, at its anchor in its face's scene. */
  function buildNext(body: Body, work: BakeWork): void {
    const i = work.meshes.length
    const field = work.fields[i] as HeightfieldResponse
    const patch = buildPatch({
      region: work.regions[i] as RegionAddress,
      resolution: HEIGHTFIELD_RESOLUTION,
      border: field.border,
      elevations: field.elevations,
      cover: field.cover,
      bodyRadius: body.radius,
      // The bake draws ground only, so no sheet is built for it to drop.
      seaLevel: null,
      water: null,
    })
    const mesh = new Mesh(patchGeometry(patch, indices), host.terrain.material)
    mesh.position.set(patch.anchor.x, patch.anchor.y, patch.anchor.z)
    mesh.frustumCulled = false
    // At its anchor and unmorphed: the bake draws every patch at one level,
    // and its deposits read that level's row of the slope table.
    wearGround(mesh, patch.anchor, body.radius, patch.region.level)
    work.scenes[faceOf(work.looks, patch.anchor)]?.add(mesh)
    work.meshes.push(mesh)
  }

  /**
   * One face from the body's center, at true meters with the body at the
   * origin: every patch at its anchor, unmorphed, through the ground material
   * in bake mode with this body's palette on it. The six reflectance faces
   * first, then the six of the relief record.
   *
   * The material's uniforms are the streaming body's and are written back by
   * `TerrainPatches` every frame before the frame's own draw — `advance` runs
   * ahead of it — so the palette this writes is overwritten before anyone
   * sees it; the bake mode is put back here, because nothing else knows it
   * was set.
   */
  function drawFace(body: Body, work: BakeWork): void {
    const { renderer, terrain } = host
    const relief = work.drawn >= 6
    terrain.setPalette(work.palette, body.radius)
    terrain.setSlopeTable(work.slopes)
    terrain.setAlbedoMap(null, false)
    terrain.setQuality('lean')
    // A texel is kilometers of ground: every detail octave is faded out by
    // its footprint, which is the anti-aliasing the bake gets.
    terrain.setPixelAngle(Math.PI / 2 / FACE_SIZE)
    try {
      terrain.setBakeMode(relief ? 2 : 1)
      const face = work.drawn % 6
      drawCubeFace(
        renderer,
        work.cameras[relief ? 1 : 0],
        work.scenes[face] as Scene,
        face,
      )
    } finally {
      terrain.setBakeMode(0)
    }
  }

  return {
    textureFor,
    advance,
    report: () =>
      [...bakes.values()].filter(stillHeld).map((bake) => ({
        address: bake.address,
        ready: bake.ready,
        failed: bake.failed,
      })),
    targetFor: (address) => {
      const bake = bakes.get(address)
      return bake === undefined || !stillHeld(bake)
        ? null
        : { albedo: bake.target, relief: bake.reliefTarget }
    },
    dispose() {
      disposed = true
      for (const [address, bake] of bakes) drop(address, bake)
    },
  }
}

/**
 * `CubeCamera.update`, one face of it.
 *
 * Three draws a cube camera's six faces in one call, which is the stall this
 * module spreads; what it does around each face is reproduced here for one:
 * the coordinate system its six cameras are aimed in, which is the
 * renderer's and differs between WebGPU and WebGL; the depth clear a
 * reversed buffer needs when the renderer is not clearing for itself, which
 * this one is outside the sensor's own pass; and the target, face and mip
 * level it found, put back after — in a `finally`, where `update` has none,
 * because a face that throws is a failed bake `advance` survives, and the
 * frame it survives into must not find the renderer still bound to a face of
 * the bake's target, which the bake's eviction disposes. The bake's targets
 * carry no mipmaps, so the mipmap toggle `update` makes around its last face
 * has nothing to do.
 */
export function drawCubeFace(
  renderer: WebGPURenderer,
  cube: CubeCamera,
  scene: Scene,
  face: number,
): void {
  aimCube(renderer, cube)
  const target = renderer.getRenderTarget()
  const activeFace = renderer.getActiveCubeFace()
  const activeLevel = renderer.getActiveMipmapLevel()
  renderer.setRenderTarget(cube.renderTarget, face, cube.activeMipmapLevel)
  try {
    const reversed = (renderer as { readonly reversedDepthBuffer?: boolean })
      .reversedDepthBuffer
    if (reversed === true && !renderer.autoClear) renderer.clearDepth()
    renderer.render(scene, cube.children[face] as Camera)
  } finally {
    renderer.setRenderTarget(target, activeFace, activeLevel)
  }
}

/**
 * A cube camera's six cameras, aimed in the renderer's coordinate system the
 * way `CubeCamera.update` aims them before its first face. Idempotent.
 */
function aimCube(renderer: WebGPURenderer, cube: CubeCamera): CubeCamera {
  if (cube.coordinateSystem !== renderer.coordinateSystem) {
    cube.coordinateSystem = renderer.coordinateSystem
    cube.updateCoordinateSystem()
  }
  if (cube.parent === null) cube.updateMatrixWorld()
  return cube
}

/**
 * The face whose camera looks most squarely at `anchor`, which is the face
 * every point of its patch is seen in.
 *
 * A level-2 region is a sixteenth of one cube face, and the cube-sphere is
 * that face's view pyramid projected onto the sphere: every vertex of the
 * patch is a direction inside the pyramid or on its edge, and so is every
 * point of every triangle between them, because the pyramid is convex and a
 * radius does not change a direction. So a face draws its own sixteen
 * patches and nothing else, and each patch's buffers upload in the one face
 * that draws it — where three's frustum culling, which is conservative, also
 * draws the sixteen beside each edge whose bounding spheres straddle it, and
 * uploads a third of the body in the first face drawn.
 */
function faceOf(
  looks: readonly Vector3[],
  anchor: { x: number; y: number; z: number },
): number {
  let best = 0
  let most = -Infinity
  looks.forEach((look, face) => {
    const along = look.x * anchor.x + look.y * anchor.y + look.z * anchor.z
    if (along > most) {
      most = along
      best = face
    }
  })
  return best
}

/** The same triangles, wound the other way. */
function insideOut(indices: Uint32Array): Uint32Array {
  const out = new Uint32Array(indices.length)
  for (let i = 0; i + 2 < indices.length; i += 3) {
    out[i] = indices[i + 1] as number
    out[i + 1] = indices[i] as number
    out[i + 2] = indices[i + 2] as number
  }
  return out
}

/** Every region at `BAKE_LEVEL`: six faces of sixteen. */
function bakeRegions(): RegionAddress[] {
  const span = 2 ** BAKE_LEVEL
  const regions: RegionAddress[] = []
  for (let face = 0; face < 6; face += 1) {
    for (let i = 0; i < span; i += 1) {
      for (let j = 0; j < span; j += 1) {
        regions.push(regionAddress(face, BAKE_LEVEL, i, j))
      }
    }
  }
  return regions
}
