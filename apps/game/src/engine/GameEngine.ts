import { getLogger, LIGHT_YEAR, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import {
  orientationToRenderSpace,
  type Quat,
  type RenderOrigin,
  toRenderSpace,
  UV,
  type UniverseVector,
  type Vec3,
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
  type CinematicEffects,
  type CinematicTextState,
  NO_EFFECTS,
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
import type { LoadedShip } from '../render/shipModels.ts'
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

/**
 * The camera's vertical field of view, degrees. One definition: the `<Canvas>`
 * starts from it, the camera panel's slider resets to it, and `CameraRig`
 * applies whatever the panel chose — three places that must agree on what
 * "default" means.
 */
export const DEFAULT_FOV = 65

const EMPTY_STAR_FIELD: StarField = {
  positions: [],
  names: [],
  colours: [],
  luminosities: [],
}

/** How far the player must move before the starfield is surveyed again. */
const STARFIELD_HYSTERESIS = 8 * LIGHT_YEAR

/**
 * A cutscene frame, converted to render space for the scene components.
 *
 * `texts` and `effects` pass through untouched — they are screen-space — and
 * `NO_EFFECTS` is re-exported beside this so the effects layer has a stable
 * "dormant" value to compare against rather than allocating one per frame.
 */
export interface CinematicView {
  readonly frame: number
  readonly fov: number
  readonly camera: { readonly position: Vec3; readonly orientation: Quat }
  readonly ship: {
    readonly position: Vec3
    readonly orientation: Quat
    readonly visible: boolean
  }
  readonly texts: readonly CinematicTextState[]
  readonly effects: CinematicEffects
}

export { NO_EFFECTS }
export type { CinematicEffects, CinematicTextState }

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
   * Whether to draw the debug ship and the metre-scale reference props.
   *
   * Presentation only — nothing canonical moves — which is why it lives here
   * rather than in the harness: the headless runner has no ship to draw. It
   * exists for the camera bookmarks, where a grey cone parked dead centre of
   * every composition defeats the point of composing.
   */
  showShip = true

  /*
   * Presentation switches the dock's graphics and camera panels drive.
   *
   * Plain fields like `showShip`, and for the same reason: the frame loop
   * reads them every frame, React persists and edits them, and neither side
   * needs the other to re-render. `fov` is applied by `CameraRig` rather than
   * written to the camera here, because the camera belongs to R3F and is
   * replaced whenever the canvas remounts — a value pushed at a camera object
   * would be lost with it.
   */
  lensFlare = true
  fov = DEFAULT_FOV

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

  /*
   * The modelled hull the player is flying, once its glTF resolves.
   *
   * Three scene components need it every frame — `ShipModel` mounts it,
   * `CameraRig` scales the chase distance from its length, `NearFieldProps`
   * steps aside from its beam — and it changes exactly once per session. On
   * the engine rather than in module state in `SceneView`, because Vite
   * re-evaluates an edited render module while Fast Refresh preserves the
   * mounted components' hook state: a module-level copy resets to null mid-
   * session and the chase camera snaps back to the 6 m framing, inside the
   * saucer. The engine is the one singleton every HMR generation shares.
   * Null means the debug cone is standing in.
   */
  hull: LoadedShip | null = null

  /*
   * The frame's cinematic state, in render space, when a cutscene is playing.
   *
   * The director (in devtools) speaks universe coordinates; this is its output
   * converted through the frame's origin, ready for the scene components to
   * copy onto objects. On the engine rather than in any module for the same
   * reason `hull` is: `CameraRig`, `ShipModel`, the effects layer and the DOM
   * overlay all read it every frame, and module state in an edited render file
   * silently resets under Fast Refresh. `null` means no cutscene — the whole
   * system dormant, which is the normal state of the game.
   */
  cinematic: CinematicView | null = null

  /**
   * URL of an audio track the cutscene overlay should sync to the playhead.
   *
   * The reference edit is timed against a piece of music this repository does
   * not carry. Set from the console (`engine.cutsceneAudio = '/tng-intro.m4a'`
   * after dropping a local file into `apps/game/public/`) and the overlay
   * keeps the element within a lip-sync tolerance of the reference clock.
   */
  cutsceneAudio: string | null = null

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
    /*
     * Earth, three-quarter lit, from the `gibbous` bookmark — not the session's
     * default target in a 400 km sunward orbit, which opened on a flat
     * full-phase wall of Mercury. The first frame is the one place the game
     * chooses its own composition, and Earth is the one disc every player can
     * judge at a glance. The galaxy-relative form, because the address resolves
     * against whatever galaxy this seed named; Sol itself is in every world —
     * it is home.
     */
    this.harness.shot('gibbous', 's:SOL/b:2')
    log.info('universe ready', {
      seed: this.world.seedText,
      seedHex: formatSeed(this.world.rootSeed),
      system: this.session.system.name,
      opening: 'Earth · gibbous',
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

    /*
     * The cutscene director's per-frame ask, against `renderTime` so a paused
     * or stepped clock gives frame-exact stills. Everything downstream — the
     * origin, the scene build, terrain, the star survey — follows the
     * *cinematic* eye when there is one: the origin must stay within its
     * rebase window of wherever the camera actually is, and a scene built
     * around a ship an AU behind the shot would light and sort for nobody.
     */
    const cinematic = this.harness.cutsceneSample(shot.renderTime)
    const eye = cinematic === null ? camera.position : cinematic.camera.position

    this.origin = originForCamera(this.origin, eye)
    this.#scene = buildScene(
      shot,
      this.origin,
      player,
      cinematic === null ? undefined : cinematic.camera,
    )
    this.cinematic =
      cinematic === null
        ? null
        : {
            frame: cinematic.frame,
            fov: cinematic.fov,
            camera: {
              position: toRenderSpace(this.origin, cinematic.camera.position),
              orientation: orientationToRenderSpace(
                this.origin,
                cinematic.camera.orientation,
              ),
            },
            ship: {
              position: toRenderSpace(this.origin, cinematic.ship.position),
              orientation: orientationToRenderSpace(
                this.origin,
                cinematic.ship.orientation,
              ),
              visible: cinematic.ship.visible,
            },
            texts: cinematic.texts,
            effects: cinematic.effects,
          }

    const surfaceBody = this.#scene.terrainCandidates[0] ?? null
    // `shot.renderTime`, not the clock: the snapshot presents the world one tick
    // in the past, and terrain that disagrees with the ship about what time it
    // is drifts from under it by 800 m at orbital speed.
    this.terrain.update(
      this.world,
      shot.renderTime,
      eye,
      this.origin,
      surfaceBody?.address ?? null,
    )

    this.#maybeSurveyStars(eye)
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
