import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  type Scene,
  SphereGeometry,
} from 'three/webgpu'
import { getLogger } from '@inertialref/shared'
import type { GameEngine } from '../engine/GameEngine.ts'
import type { RendererHandle } from './createRenderer.ts'
import { scatteringFor } from './atmosphereLuts.ts'
import { createAtmosphereMaterial, createStarMaterial } from './materials.ts'
import {
  createCloudMaterial,
  createPlanetMaterial,
  createRingMaterial,
} from './planet.ts'
import { preloadAllTextures, SHIPPED_TEXTURE_COUNT } from './planetTextures.ts'
import { scatteringBakes } from './preloadPlan.ts'
import { DEFAULT_SHIP, loadShipModel } from './shipModels.ts'
import {
  beginWarmup,
  breathe,
  type BootProgress,
  warmCompile,
} from './warmup.ts'

/*
 * Everything a first encounter used to pay for, paid once at boot instead.
 *
 * Measured before this existed (2026-08-23, M-series, WebGPU, dev build): the
 * first look at a cold body was one 98–119 ms frame — ~50 ms atmosphere LUT
 * bake, the rest material graph construction, first-use pipeline compilation
 * and texture upload — followed by 6–16 ms frames as each surface map's
 * decode landed. Steady state everywhere was p50 ≤ 0.8 ms. On the WebGL
 * fallback the pipeline half is far worse: program linking is synchronous
 * there, which is why Safari and Firefox stuttered hardest. So the boot
 * sequence now fetches and uploads every shipped texture, bakes every
 * atmosphere the loaded systems can ask for, and compiles one pipeline per
 * material archetype — all behind the loading overlay, whose whole purpose is
 * to buy this work its time.
 *
 * Two facts this module leans on, both established elsewhere:
 *
 * - One pipeline per archetype is enough. `planet.ts` documents the
 *   single-graph design: per-body differences are uniforms and texture
 *   bindings, and the backend keys pipelines on generated WGSL source — so a
 *   default-constructed material compiles the very pipeline every body uses.
 *
 * - The warm meshes must stay alive. Three's pipeline cache is refcounted
 *   (`Pipelines.delete` releases a pipeline at zero use), so disposing the
 *   warm-up materials would evict exactly what was just compiled. The group
 *   is held in module state for the life of the session; it is never added
 *   to the scene, so it costs memory and nothing else.
 *
 * This file used to be the whole warm-up and carried a disclaimer saying so —
 * "the others warm their own real instances" — because three scene components
 * compiled their own pipelines at mount and nothing counted them. It is four
 * registered producers among several now: `warmup.ts` owns the recipe, the
 * census and the progress total, and this file owns what to warm.
 */

const log = getLogger('game.preload')

export type { BootProgress }

/**
 * Layout twin of the ring annulus in `Bodies.tsx`: position, normal, index.
 * The segment count is irrelevant — a pipeline is keyed on the vertex layout
 * and the shader, not the vertex count — but the attribute set must match or
 * this compiles a pipeline no real ring ever draws with.
 */
function warmAnnulus(): BufferGeometry {
  const segments = 8
  const positions = new Float32Array((segments + 1) * 2 * 3)
  const indices: number[] = []
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2
    const base = i * 6
    positions[base] = Math.cos(angle) * 0.25
    positions[base + 2] = Math.sin(angle) * 0.25
    positions[base + 3] = Math.cos(angle)
    positions[base + 5] = Math.sin(angle)
    if (i < segments) {
      const a = i * 2
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * One mesh per body-material archetype.
 *
 * The floor, not the whole job: an archetype twin does not cover the
 * instance-level shader build, which is where the measured cost actually
 * lives. `Bodies.tsx` warms the real instances one a frame and `WarpFx` and
 * `TerrainPatches` warm theirs at mount — all three are registered producers
 * in the same census now, so "what boot warms" is a list rather than a
 * disclaimer.
 */
function buildWarmGroup(): Group {
  const group = new Group()
  const sphere = new SphereGeometry(1, 8, 4)

  group.add(new Mesh(sphere, createPlanetMaterial().material))
  group.add(new Mesh(sphere, createAtmosphereMaterial().material))
  group.add(new Mesh(sphere, createCloudMaterial().material))
  group.add(new Mesh(sphere, createStarMaterial().material))
  group.add(new Mesh(warmAnnulus(), createRingMaterial().material))

  group.traverse((object) => {
    object.visible = true
    object.frustumCulled = false
  })
  return group
}

/**
 * Held for the session — see the header for why disposal would undo the work.
 */
let warmGroup: Group | null = null

/** One warm-up per renderer build; a rebuilt canvas gets a fresh pass. */
const inFlight = new WeakMap<RendererHandle, Promise<void>>()

/**
 * Fetch, decode, upload, bake and compile everything the loaded systems can
 * ask of a frame. Resolves when a first encounter with any shipped body costs
 * the same as a revisit.
 */
export function warmScene(
  handle: RendererHandle,
  engine: GameEngine,
  onProgress?: (progress: BootProgress) => void,
): Promise<void> {
  const existing = inFlight.get(handle)
  if (existing !== undefined) return existing
  const run = warm(handle, engine, onProgress).catch((cause: unknown) => {
    // A failed warm-up is a slower first encounter, not a broken boot.
    log.warn('scene warm-up failed; first encounters will pay as they go', {
      cause: String(cause),
    })
  })
  inFlight.set(handle, run)
  return run
}

async function warm(
  handle: RendererHandle,
  engine: GameEngine,
  onProgress?: (progress: BootProgress) => void,
): Promise<void> {
  const started = performance.now()
  const renderer = handle.renderer
  const anisotropy = renderer.getMaxAnisotropy()
  const warmup = beginWarmup()
  let textureCount = 0
  let bakeCount = 0

  /* Every shipped surface map: fetched together, then uploaded one per
   * macrotask — `initTexture` is where the decode-to-GPU copy and the mip
   * chain actually happen, and nineteen of those in one task would stall the
   * overlay's own compositing. */
  warmup.register({
    label: 'warming surface maps',
    units: SHIPPED_TEXTURE_COUNT,
    run: async (done) => {
      const textures = await preloadAllTextures(anisotropy)
      textureCount = textures.length
      for (const texture of textures) {
        renderer.initTexture(texture)
        done()
        await breathe()
      }
    },
  })

  /* Every atmosphere in the loaded systems, ~50 ms of CPU each. The bake
   * cache in `atmosphereLuts.ts` is keyed identically (same function), so the
   * draw-time ask in `Bodies.tsx` becomes a lookup. */
  const bakes = scatteringBakes(engine.world.loadedSystems())
  bakeCount = bakes.length
  warmup.register({
    label: 'baking atmospheres',
    units: bakes.length,
    run: async (done) => {
      for (const bake of bakes) {
        const set = scatteringFor(bake.haze, bake.topRatio)
        renderer.initTexture(set.transmittance)
        renderer.initTexture(set.multiScatter)
        done()
        await breathe()
      }
    },
  })

  /* One compile per pipeline the scene can ask for. This is the *floor*: it
   * guarantees every planet-class pipeline exists before the cover lifts, even
   * if the per-instance build-ahead in `Bodies.tsx` has not had a frame yet. */
  warmup.register({
    label: 'compiling the sky',
    units: 1,
    run: async (done) => {
      const view = await sceneView(engine)
      if (view === null) return
      warmGroup ??= buildWarmGroup()
      await warmCompile(renderer, {
        object: warmGroup,
        camera: view.camera,
        scene: view.scene as Scene,
      })
      done()
    },
  })

  /* The hull the player flies: same promise `ShipModel` awaits, so this adds
   * no second fetch — only the compile of its converted node materials. */
  warmup.register({
    label: 'compiling the ship',
    units: 1,
    run: async (done) => {
      const view = await sceneView(engine)
      if (view === null) return
      const hull = await loadShipModel(DEFAULT_SHIP, anisotropy)
      if (hull === null) return
      await warmCompile(renderer, {
        object: hull.group,
        camera: view.camera,
        scene: view.scene as Scene,
      })
      done()
    },
  })

  await warmup.run(onProgress)

  log.info('scene warmed', {
    ms: Math.round(performance.now() - started),
    textures: textureCount,
    atmospheres: bakeCount,
    backend: handle.description.backend,
  })
}

/**
 * The live camera and scene, once R3F has published them.
 *
 * `engine.view` is set by R3F's `onCreated`, which has always run by the time
 * the renderer handle reaches App state — the wait is for the one commit race
 * StrictMode can manufacture. A hundred macrotasks is far more than that race
 * has ever needed and still bounded, because a pipeline warm-up with no scene
 * to warm against is a slower first frame, not a boot that never lifts.
 */
async function sceneView(
  engine: GameEngine,
): Promise<GameEngine['view'] | null> {
  for (let waited = 0; engine.view === null && waited < 100; waited += 1) {
    await breathe()
  }
  if (engine.view === null) {
    log.warn('no scene view arrived; skipping pipeline warm-up')
    return null
  }
  return engine.view
}

/**
 * Keep atmospheres warm as new systems load mid-session.
 *
 * A jump to a procedural system generates bodies whose hazes the boot pass
 * has never seen, and the first look at one would pay the 50 ms bake on the
 * spot. This polls the loaded-system set — once a second, two string
 * compares — and bakes anything new one table per macrotask, which is far
 * more air than the flight to any body takes. The renderer upload is left to
 * first use: a LUT is 4 KB, not a 4096² surface map.
 */
export function watchSystemAtmospheres(engine: GameEngine): () => void {
  let known = ''
  let queue: readonly ReturnType<typeof scatteringBakes>[number][] = []
  let draining = false

  const drain = (): void => {
    const next = queue[0]
    if (next === undefined) {
      draining = false
      return
    }
    queue = queue.slice(1)
    scatteringFor(next.haze, next.topRatio)
    setTimeout(drain, 0)
  }

  const timer = setInterval(() => {
    const systems = engine.world.loadedSystems()
    const key = systems.map((system) => system.id).join(',')
    if (key === known) return
    known = key
    // Re-plan the lot; the bake cache turns the already-warm entries into
    // string lookups, so only genuinely new atmospheres cost anything.
    queue = scatteringBakes(systems)
    if (!draining) {
      draining = true
      setTimeout(drain, 0)
    }
  }, 1_000)

  return () => clearInterval(timer)
}
