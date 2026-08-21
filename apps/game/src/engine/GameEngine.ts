import { getLogger, LIGHT_YEAR, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  type RenderOrigin,
  UV,
  type UniverseVector,
  vec3,
} from '@inertialref/spatial'
import {
  snapshot,
  type World,
  type WorldSnapshot,
} from '@inertialref/simulation'
import {
  type CatalogStar,
  cellKey,
  cellOf,
  type EntityId,
  type StarCatalog,
  type SystemId,
} from '@inertialref/universe'
import {
  buildScene,
  originForCamera,
  type RenderScene,
} from '@inertialref/rendering'
import {
  surveyRegionTask,
  type WorkerFactory,
  WorkerPool,
} from '@inertialref/workers'
import {
  type FrameStats,
  type GameHarness,
  openSession,
  type PresentationHost,
  type Session,
} from '@inertialref/devtools'
import { DEFAULT_SLOT, type SaveStore } from '@inertialref/persistence'
import type { RendererHandle } from '../render/createRenderer.ts'
import { createBrowserWorkerPort, poolSize } from './browserWorker.ts'
import type { Camera, Object3D } from 'three/webgpu'
import { FrameMetrics, usedHeapMb } from './frameMetrics.ts'
import { IndexedDbSaveStore } from './indexedDbStore.ts'
import { TerrainStreamer, type TerrainState } from './terrainStreamer.ts'

/*
 * The engine.
 *
 * Owns the world, the worker pool, the render origin and the scene, and is
 * driven by one call per animation frame. React does not own any of this: the
 * components below read `engine.scene` and `engine.snapshot`, and the only
 * thing that ever writes canonical state is the fixed-step simulation.
 *
 * That split is what makes the frame loop honest. `frame(delta)` hands the
 * wall-clock delta to the clock, which decides how many fixed ticks to run;
 * everything after that is presentation.
 */

const log = getLogger('game.engine')

const EMPTY_STAR_FIELD: StarField = {
  positions: [],
  names: [],
  colours: [],
  luminosities: [],
}

/** How far the player must move before the starfield is surveyed again. */
const STARFIELD_HYSTERESIS = 8 * LIGHT_YEAR

export interface StarField {
  readonly positions: readonly UniverseVector[]
  readonly names: readonly string[]
  /**
   * Linear sRGB per star, from the blackbody colour of its temperature.
   *
   * Carried per star rather than picked in the shader because the temperature
   * comes from a published colour index for the catalogued half of the sky and
   * from a mass for the rest, and neither is available to a vertex program.
   */
  readonly colours: readonly [number, number, number][]
  /**
   * Bolometric luminosity in solar units. The renderer turns this and the
   * distance into an apparent brightness; a star's size on screen is not a
   * constant.
   */
  readonly luminosities: readonly number[]
}

export interface GameEngineOptions {
  readonly seed?: string
  /** The star catalogue this world is generated against. */
  readonly catalog?: StarCatalog
  /**
   * Where worker tasks run. Omit for the browser default; pass `null` to
   * generate on the main thread; pass an in-process factory to run the whole
   * engine under Node.
   */
  readonly workers?: WorkerFactory | null
  readonly store?: SaveStore
  readonly now?: () => number
}

/**
 * The engine is the *presentation* half of a session.
 *
 * It used to be the whole thing: the constructor built a `World`, an
 * `IndexedDbSaveStore`, a browser `WorkerPool` and a console log sink, then
 * spawned a ship and put it in orbit. Every one of those had a port underneath
 * it built precisely so it could be swapped — and none of them could be,
 * because the engine reached past its own seams to the concrete adapter. That
 * is why nothing under `apps/` had a test.
 *
 * `openSession` now owns assembly and the mutable (world, player) pair. What is
 * left here is what genuinely belongs to a rendering host: the frame loop, the
 * render origin, the scene, the terrain streamer and the starfield.
 */
export class GameEngine implements PresentationHost {
  readonly session: Session
  readonly harness: GameHarness
  readonly saves: SaveStore
  readonly terrain: TerrainStreamer
  /** Rolling per-frame samples for the performance overlay. */
  readonly metrics = new FrameMetrics()

  /*
   * The scene and camera R3F built, for measurements that drive the renderer
   * directly rather than watch it.
   *
   * Held because `measureGpuFrameMs` submits its own frames and there is no
   * other way to reach them: R3F keeps its root state in a store keyed by the
   * canvas element and does not hand it out. `null` until `onCreated`.
   */
  view: { readonly scene: Object3D; readonly camera: Camera } | null = null

  origin: RenderOrigin | null = null
  snapshot: WorldSnapshot | null = null

  /*
   * The host's renderer, once it has one. `null` under Node, and for as long as
   * the capability probe is still running.
   *
   * Here rather than only in React state because a renderer you cannot reach
   * from the console is a renderer you cannot debug: `engine.gl.description`
   * answers "am I actually on WebGPU", `engine.gl.tone.shoulder.value = 0.6`
   * retunes the highlight roll-off without a reload, and `engine.gl.renderer.info`
   * is the draw-call count. The dock reads the same object, so what is displayed
   * and what is inspected cannot disagree.
   */
  gl: RendererHandle | null = null

  #scene: RenderScene | null = null
  #frameMs = 16
  #fps = 60
  #ticksLastFrame = 0
  #starField: StarField = EMPTY_STAR_FIELD
  #starFieldCentre: UniverseVector | null = null
  #starFieldPending = false
  /*
   * Which world the in-flight survey belongs to. A survey is asynchronous and
   * the world can be replaced under it; without this, its result landed in the
   * new world's starfield — a save loaded in another system briefly wore the
   * old system's stars. Masked for as long as terrain tasks queued ahead of
   * the survey delayed it past every observer, and surfaced the moment the
   * streamer stopped requesting patches from orbit.
   */
  #starFieldWorld = 0

  constructor(options: GameEngineOptions = {}) {
    this.session = openSession({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      // `undefined` means "the browser default"; `null` means "no pool at all".
      workers:
        options.workers === undefined
          ? () => createBrowserWorkerPort()
          : options.workers,
      poolSize: poolSize(),
      now: options.now ?? (() => performance.now()),
      store: options.store ?? new IndexedDbSaveStore(),
      presentation: {
        scene: () => this.#scene,
        frameStats: () => this.frameStats(),
      },
      onWorldReplaced: () => this.#invalidateDerived(),
    })
    this.harness = this.session.harness
    this.saves = this.session.store
    this.terrain = new TerrainStreamer(this.session.pool())
    this.#start()
  }

  /** Live read, never a captured reference — loading a save replaces it. */
  get world(): World {
    return this.session.world
  }

  /* ----------------------------------------------------------------------- */
  /* PresentationHost                                                         */
  /* ----------------------------------------------------------------------- */

  scene(): RenderScene | null {
    return this.#scene
  }

  frameStats(): FrameStats {
    return {
      fps: this.#fps,
      frameMs: this.#frameMs,
      ticksLastFrame: this.#ticksLastFrame,
    }
  }

  player(): EntityId | null {
    return this.session.player()
  }

  pool(): WorkerPool | null {
    return this.session.pool()
  }

  get starField(): StarField {
    return this.#starField
  }

  terrainState(): TerrainState {
    return this.terrain.state()
  }

  /**
   * Everything derived from the world, dropped in one place.
   *
   * Called whenever the world is replaced. Splitting this across `replaceWorld`
   * and `load` is how the starfield came to survive a jump of four light years.
   */
  #invalidateDerived(): void {
    this.origin = null
    this.snapshot = null
    this.#scene = null
    this.#starField = EMPTY_STAR_FIELD
    this.#starFieldCentre = null
    this.#starFieldWorld += 1
    this.terrain.clear()
    log.info('world replaced, derived state dropped', {
      tick: this.world.clock.tick,
    })
  }

  /** Frame the opening shot. The ship itself is placed by `openSession`. */
  #start(): void {
    const address = this.session.target.id.slice(1)
    this.harness.orbit(address, 400)
    // Opening shot looks at the world you are orbiting rather than along the
    // orbit; the trajectory is unchanged either way.
    this.harness.face(address)
    log.info('universe ready', {
      seed: this.world.seedText,
      seedHex: formatSeed(this.world.rootSeed),
      system: this.session.system.name,
      target: this.session.target.name,
    })
  }

  /**
   * One animation frame.
   *
   * `delta` is wall-clock seconds. It reaches the clock and nothing else — the
   * simulation is stepped a whole number of fixed ticks, and the leftover is
   * the interpolation alpha for presentation.
   */
  frame(delta: Seconds): void {
    const started = performance.now()
    this.#step(delta)
    const elapsed = performance.now() - started

    this.#frameMs = this.#frameMs * 0.9 + elapsed * 0.1
    this.#fps = delta > 0 ? this.#fps * 0.9 + (1 / delta) * 0.1 : this.#fps

    /*
     * Sampled out here rather than at the end of `#step`, because `#step`
     * returns early on a frame with no player and those are exactly the frames
     * worth seeing on a plot — a gap in the trace during a load is information,
     * and a plot that quietly omits them shows a frame rate the session never
     * had.
     *
     * `renderer.info` is last frame's, because this runs before the draw. That
     * is the correct pairing anyway: the draw call count belongs to the scene
     * that produced it, not the one being built now.
     *
     * Nothing here allocates. `clock.achievedTimeScale` and `pool.queued` exist
     * as getters precisely so this loop does not build two throwaway objects a
     * frame to read two numbers off them.
     */
    const render = this.gl?.renderer.info.render
    this.metrics.sample({
      periodMs: delta * 1000,
      engineMs: elapsed,
      ticks: this.#ticksLastFrame,
      achievedTimeScale: this.world.clock.achievedTimeScale,
      drawCalls: render?.drawCalls ?? Number.NaN,
      triangles: render?.triangles ?? Number.NaN,
      queuedJobs: this.pool()?.queued ?? Number.NaN,
      heapMb: usedHeapMb(),
    })

    // Now that the previous frame's counters have been recorded, clear them for
    // the draw that follows. `autoReset` is off for the reason given where it is
    // turned off; this is the other half of that decision.
    this.gl?.renderer.info.reset()
  }

  #step(delta: Seconds): void {
    this.#ticksLastFrame = this.world.advance(delta)

    const player = this.session.player()
    if (player === null) return

    const shot = snapshot(this.world)
    this.snapshot = shot
    const camera = shot.entities.find((entity) => entity.id === player)
    if (camera === undefined) return

    this.origin = originForCamera(this.origin, camera.position)
    this.#scene = buildScene(shot, this.origin, player)

    const surfaceBody = this.#scene.terrainCandidates[0] ?? null
    // `shot.renderTime`, not the clock: the snapshot presents the world one tick
    // in the past, and terrain that disagrees with the ship about what time it
    // is drifts from under it by 800 m at orbital speed.
    this.terrain.update(
      this.world,
      shot.renderTime,
      camera.position,
      this.origin,
      surfaceBody?.address ?? null,
    )

    this.#maybeSurveyStars(camera.position)
  }

  /**
   * Keep a local starfield around the player.
   *
   * Re-surveyed only when the player has actually gone somewhere, because a
   * 40 ly sweep is tens of thousands of stars and belongs in a worker — which
   * is exactly where it goes.
   *
   * Two halves. The worker invents the procedural stars, which is the expensive
   * part; the catalogued ones are read straight out of the local index, which is
   * cheaper than serialising them across a thread boundary would be, and means
   * the real sky is on screen on the first frame after a jump even if the worker
   * pool is busy or absent.
   */
  #maybeSurveyStars(centre: UniverseVector): void {
    if (this.#starFieldPending) return
    const moved =
      this.#starFieldCentre === null ||
      UV.distance(this.#starFieldCentre, centre) > STARFIELD_HYSTERESIS
    if (!moved) return

    this.#starFieldCentre = centre
    this.#starFieldPending = true
    const world = this.#starFieldWorld
    const radiusCells = 2
    // `cellOf`, not a hand-inlined copy of it. The copy restated CELL_SIZE as
    // `20 * 9.4607304725808e15` and recomputed `approxMeters` three times, so
    // changing the galaxy's cell size would have left the client surveying
    // cells that no longer correspond to where the player is — a compile-clean
    // change that presents as "the stars are in the wrong place".
    const cell = cellOf(centre)
    const catalog = this.world.catalog

    // The worker has no catalogue, so what it needs to know about one travels
    // with the request: how many stars are already in each cell, and the radius
    // inside which it should invent none. Only non-empty cells are listed.
    const catalogued: Record<string, number> = {}
    const catalogStars: CatalogStar[] = []
    for (let x = cell.x - radiusCells; x <= cell.x + radiusCells; x += 1)
      for (let y = cell.y - radiusCells; y <= cell.y + radiusCells; y += 1)
        for (let z = cell.z - radiusCells; z <= cell.z + radiusCells; z += 1) {
          const stars = catalog.inCell({ x, y, z })
          if (stars.length === 0) continue
          catalogued[cellKey({ x, y, z })] = stars.length
          catalogStars.push(...stars)
        }

    const payload = {
      seed: formatSeed(this.world.galaxySeed),
      min: {
        x: cell.x - radiusCells,
        y: cell.y - radiusCells,
        z: cell.z - radiusCells,
      },
      max: {
        x: cell.x + radiusCells,
        y: cell.y + radiusCells,
        z: cell.z + radiusCells,
      },
      catalogued,
      completeRadius: catalog.completeRadius,
    }

    // The catalogued half goes up *now*, not when the worker answers — that
    // is the header's promise about the real sky being on screen on the first
    // frame after a jump. Gated on the survey it waited behind a busy pool,
    // and a single failed survey dropped it entirely, with the hysteresis
    // then blocking any retry until the player had moved another 8 ly.
    {
      const positions: UniverseVector[] = []
      const names: string[] = []
      const colours: [number, number, number][] = []
      const luminosities: number[] = []
      for (const star of catalogStars) {
        positions.push(star.position)
        names.push(star.name)
        const c = star.physical.colour
        colours.push([c.r, c.g, c.b])
        luminosities.push(star.physical.solarLuminosities)
      }
      this.#starField = { positions, names, colours, luminosities }
    }

    const run =
      this.pool() === null
        ? Promise.resolve(
            surveyRegionTask.run(payload, { cancelled: () => false }),
          )
        : (this.pool() as WorkerPool).run(surveyRegionTask, payload)

    void Promise.resolve(run)
      .then((cells) => {
        // The world this survey was asked about is gone; let the next frame
        // start one against the world that replaced it.
        if (world !== this.#starFieldWorld) return
        const positions: UniverseVector[] = []
        const names: string[] = []
        const colours: [number, number, number][] = []
        const luminosities: number[] = []

        for (const star of catalogStars) {
          positions.push(star.position)
          names.push(star.name)
          const c = star.physical.colour
          colours.push([c.r, c.g, c.b])
          luminosities.push(star.physical.solarLuminosities)
        }
        for (const entry of cells) {
          for (const star of entry.stars) {
            const [sx, sy, sz, ox, oy, oz] = star.position
            positions.push(UV.universeVector(sx, sy, sz, ox, oy, oz))
            names.push(star.name)
            colours.push([...star.colour] as [number, number, number])
            luminosities.push(star.solarLuminosities)
          }
        }
        this.#starField = { positions, names, colours, luminosities }
        log.info('starfield surveyed', {
          stars: positions.length,
          catalogued: catalogStars.length,
        })
      })
      .catch((cause: unknown) =>
        log.warn('starfield survey failed', { cause: String(cause) }),
      )
      .finally(() => {
        this.#starFieldPending = false
      })
  }

  /* --------------------------------------------------------------------- */
  /* Player commands                                                        */
  /* --------------------------------------------------------------------- */

  setControl(
    translation: [number, number, number],
    rotation: [number, number, number],
  ): void {
    const player = this.session.player()
    if (player === null) return
    this.world.setControl(player, vec3(...translation), vec3(...rotation))
  }

  toggleFlightAssist(): boolean {
    const player = this.session.player()
    if (player === null) return false
    return this.world.setFlightAssist(
      player,
      !this.world.entities.require(player).flightAssist,
    )
  }

  killRotation(): void {
    const player = this.session.player()
    if (player === null) return
    this.world.killRotation(player)
  }

  loadedSystemIds(): readonly SystemId[] {
    return this.world.loadedSystems().map((system) => system.id)
  }

  async save(slot: string = DEFAULT_SLOT): Promise<string> {
    const text = this.harness.save()
    await this.saves.write(slot, text)
    log.info('saved', { slot, bytes: text.length })
    return text
  }

  async load(slot: string = DEFAULT_SLOT): Promise<boolean> {
    const contents = await this.saves.read(slot)
    if (!contents.ok) {
      log.warn('load failed', { slot, error: contents.error })
      return false
    }
    const result = this.harness.load(contents.value)
    if (!result.ok) {
      log.warn('load failed', { slot, error: result.error })
      return false
    }
    // No `this.origin = null` here: `onWorldReplaced` already dropped every
    // piece of derived state, which is the point of having one hook.
    return true
  }

  dispose(): void {
    this.session.dispose()
  }
}
