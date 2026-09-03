import {
  BufferAttribute,
  BufferGeometry,
  CubeCamera,
  Group,
  HalfFloatType,
  LinearFilter,
  Mesh,
  Scene,
  type Texture,
  WebGLCubeRenderTarget,
  type WebGPURenderer,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import type {
  HeightfieldResponse,
  HeightfieldSource,
  JobHandle,
} from '@inertialref/workers'
import {
  type Body,
  HEIGHTFIELD_BORDER,
  HEIGHTFIELD_RESOLUTION,
  type RegionAddress,
  regionAddress,
} from '@inertialref/universe'
import {
  buildPatch,
  patchIndices,
  type RenderPatch,
  seaSheetDatum,
  terrainPalette,
} from '@inertialref/rendering'
import type { TerrainMaterial } from './terrain.ts'
import { patchGeometry, wearGround } from './groundWear.ts'

/*
 * The orbital bake: a generated world's sphere learns what its ground looks
 * like.
 *
 * Below the eight-pixel relief gate the streamed ground carries the sea, the
 * rivers, the biosphere, the maria and the caps; above it the archive's
 * sphere is drawn instead, and for a generated body that sphere is one flat
 * tint — the class colour, then the family colour. From orbit a temperate
 * ocean world was a ball of one colour until the gate opened and it turned
 * blue and green. [The terrain plan](../../../../design/plans/terrain.md)
 * names the fix and this is it: the ground's own picture, taken once per
 * body and worn by the sphere at every distance.
 *
 * **The picture is taken by the ground material, not by a copy of it.** The
 * ninety-six level-2 regions of a body are asked of the same
 * `HeightfieldSource` a patch is — the GPU kernel or the pool, whichever the
 * streamer would use — built with the same `buildPatch`, and drawn with the
 * same `render/terrain.ts` graph in its bake mode into a cube target from a
 * camera at the body's centre. What the sphere then samples by direction is
 * the deposit stack, the mineral tint and the rivers the ground draws, by
 * construction rather than by a second implementation kept in step; the
 * seam rule in `AGENTS.md` holds because there is one graph. The alpha lane
 * carries the sea mask, which is what the sphere's ocean colour and sun-glint
 * key on, as they do for a photographed body's mask.
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

/** The sea mask's face size. A mask needs fewer texels than a picture. */
const MASK_SIZE = 256

/** What a finished bake hands the sphere. */
export interface OrbitalBakeMaps {
  /** The ground's reflectance, six faces, linear, half float. */
  readonly albedo: Texture
  /** Where the sea is, six faces, as a grey in every lane. */
  readonly mask: Texture
}

/** One bake's state: the targets it renders into, and whether it has. */
interface Bake {
  readonly target: WebGLCubeRenderTarget
  readonly maskTarget: WebGLCubeRenderTarget
  /** The tile jobs in flight, cancelled if the bake is evicted under them. */
  readonly jobs: JobHandle<HeightfieldResponse>[]
  /** When the body last asked, in `performance.now()` ms. */
  asked: number
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
  /** The bakes held, for the harness: which bodies, and whether each is ready. */
  report(): readonly { address: string; ready: boolean; failed: boolean }[]
  /** A held bake's targets, for a readback. Null while none is held. */
  targetFor(
    address: string,
  ): { albedo: WebGLCubeRenderTarget; mask: WebGLCubeRenderTarget } | null
  dispose(): void
}

/**
 * The producer the bake asks for its tiles, and the material it draws them
 * with — the renderer's own, so the pipeline the boot warmed is the one the
 * six draws use.
 */
export interface OrbitalBakeHost {
  readonly renderer: WebGPURenderer
  readonly terrain: TerrainMaterial
  bodyFor(address: string): Body | null
  heightfieldSource(): HeightfieldSource | null
}

export function createOrbitalBaker(host: OrbitalBakeHost): OrbitalBaker {
  const bakes = new Map<string, Bake>()
  /*
   * The patch's triangle list with every triangle turned over. The camera
   * is at the body's centre and looks at the ground from *inside* the shell,
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

  /**
   * Bodies with no relief: nothing to bake, and a body's relief does not
   * change, so the verdict is kept rather than re-derived — `bodyFor` is an
   * address parse and a system walk, and the ask comes every frame.
   */
  const flat = new Set<string>()

  function textureFor(address: string): OrbitalBakeMaps | null {
    const now = performance.now()
    const held = bakes.get(address)
    if (held !== undefined) {
      // Touch, so the least-recently-asked is the one evicted.
      held.asked = now
      bakes.delete(address)
      bakes.set(address, held)
      return held.ready
        ? { albedo: held.target.texture, mask: held.maskTarget.texture }
        : null
    }
    if (flat.has(address)) return null
    const body = host.bodyFor(address)
    const source = host.heightfieldSource()
    if (body === null || source === null) return null
    if (body.surface.maxElevation <= 0) {
      flat.add(address)
      return null
    }
    if (bakes.size >= KEPT && !evictOne(now)) return null
    const target = new WebGLCubeRenderTarget(FACE_SIZE, {
      type: HalfFloatType,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    })
    const maskTarget = new WebGLCubeRenderTarget(MASK_SIZE, {
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    })
    const bake: Bake = {
      target,
      maskTarget,
      jobs: [],
      asked: now,
      ready: false,
      failed: false,
    }
    bakes.set(address, bake)
    void run(body, source, bake)
      .then(() => {
        if (bake.ready) {
          log.info('orbital bake ready', {
            address,
            ms: Math.round(performance.now() - now),
          })
        }
      })
      .catch((error: unknown) => {
        // Evicted under its tiles: the cancellation is the rejection.
        if (!stillHeld(bake)) return
        /*
         * The source's own stand-down — the GPU producer retiring rejects
         * everything it holds with this — is not the bake's failure: the
         * next `heightfieldSource()` is the pool, and the next ask should
         * reach it. A failure of anything else would repeat, and is kept.
         */
        if (String(error).includes('producer unavailable')) {
          drop(address, bake)
          return
        }
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
      if (now - bake.asked < RESIDENCY_MS) continue
      drop(address, bake)
      return true
    }
    return false
  }

  function drop(address: string, bake: Bake): void {
    if (bakes.get(address) !== bake) return
    bakes.delete(address)
    for (const job of bake.jobs) job.cancel()
    bake.jobs.length = 0
    bake.target.dispose()
    bake.maskTarget.dispose()
  }

  async function run(
    body: Body,
    source: HeightfieldSource,
    bake: Bake,
  ): Promise<void> {
    const regions = bakeRegions()
    // The sheet's datum, where one is drawn — the same answer the streamer
    // gives `buildPatch`, and the same flag it sends the producer.
    const sheet = seaSheetDatum(body)
    const fields = await Promise.all(
      regions.map((region) => {
        const job = source.submit({
          surfaceSeed: formatSeed(body.surface.seed),
          maxElevation: body.surface.maxElevation,
          roughness: body.surface.roughness,
          seaLevel: body.surface.seaLevel,
          grammar: body.surface.grammar,
          region,
          resolution: HEIGHTFIELD_RESOLUTION,
          border: HEIGHTFIELD_BORDER,
          seabed: sheet !== null,
        })
        bake.jobs.push(job)
        return job.result
      }),
    )
    bake.jobs.length = 0
    // Evicted while the tiles were in flight: nothing to draw into.
    if (!stillHeld(bake)) return
    const patches = fields.map((field, i) =>
      buildPatch({
        region: regions[i] as RegionAddress,
        resolution: HEIGHTFIELD_RESOLUTION,
        border: field.border,
        elevations: field.elevations,
        cover: field.cover,
        bodyRadius: body.radius,
        seaLevel: sheet,
      }),
    )
    render(body, patches, bake)
  }

  function stillHeld(bake: Bake): boolean {
    for (const held of bakes.values()) if (held === bake) return true
    return false
  }

  /**
   * Six faces from the body's centre, at true meters with the body at the
   * origin: every patch at its anchor, unmorphed, through the ground material
   * in bake mode with this body's palette on it.
   *
   * The material's uniforms are the streaming body's between frames and are
   * written back by `TerrainPatches` every frame before the frame's own draw,
   * so the palette this writes is overwritten before anyone sees it; the
   * bake mode is put back here, because nothing else knows it was set.
   */
  function render(
    body: Body,
    patches: readonly RenderPatch[],
    bake: Bake,
  ): void {
    const { renderer, terrain } = host
    const scene = new Scene()
    const group = new Group()
    scene.add(group)
    const geometries: BufferGeometry[] = []
    for (const patch of patches) {
      const mesh = new Mesh(patchGeometry(patch, indices), terrain.material)
      geometries.push(mesh.geometry)
      mesh.position.set(patch.anchor.x, patch.anchor.y, patch.anchor.z)
      mesh.frustumCulled = false
      // At its anchor and unmorphed: the bake draws every patch at one level.
      wearGround(mesh, patch.anchor, body.radius)
      group.add(mesh)
    }

    const palette = terrainPalette(body)
    terrain.setPalette(palette, body.radius)
    terrain.setAlbedoMap(null, false)
    terrain.setQuality('lean')
    // A texel is kilometers of ground: every detail octave is faded out by
    // its footprint, which is the anti-aliasing the bake gets.
    terrain.setPixelAngle(Math.PI / 2 / FACE_SIZE)
    const near = body.radius * 0.5
    const far = body.radius * 1.5
    try {
      terrain.setBakeMode(1)
      new CubeCamera(near, far, bake.target).update(renderer, scene)
      terrain.setBakeMode(2)
      new CubeCamera(near, far, bake.maskTarget).update(renderer, scene)
      bake.ready = true
    } finally {
      terrain.setBakeMode(0)
      for (const geometry of geometries) {
        geometry.setIndex(null)
        geometry.dispose()
      }
    }
  }

  return {
    textureFor,
    report: () =>
      [...bakes.entries()].map(([address, bake]) => ({
        address,
        ready: bake.ready,
        failed: bake.failed,
      })),
    targetFor: (address) => {
      const bake = bakes.get(address)
      return bake === undefined
        ? null
        : { albedo: bake.target, mask: bake.maskTarget }
    },
    dispose() {
      for (const bake of bakes.values()) {
        bake.target.dispose()
        bake.maskTarget.dispose()
      }
      bakes.clear()
    },
  }
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
