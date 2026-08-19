import { getLogger, LIGHT_YEAR, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { type RenderOrigin, UV, type UniverseVector, vec3 } from '@inertialref/spatial'
import { snapshot, type World, type WorldSnapshot } from '@inertialref/simulation'
import { cellOf, type EntityId, type SystemId } from '@inertialref/universe'
import { buildScene, originForCamera, type RenderScene } from '@inertialref/rendering'
import { surveyRegionTask, type WorkerFactory, WorkerPool } from '@inertialref/workers'
import {
  type FrameStats,
  type GameHarness,
  openSession,
  type PresentationHost,
  type Session,
} from '@inertialref/devtools'
import { DEFAULT_SLOT, type SaveStore } from '@inertialref/persistence'
import { createBrowserWorkerPort, poolSize } from './browserWorker.ts'
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

/** How far the player must move before the starfield is surveyed again. */
const STARFIELD_HYSTERESIS = 8 * LIGHT_YEAR

export interface StarField {
  readonly positions: readonly UniverseVector[]
  readonly names: readonly string[]
}

export interface GameEngineOptions {
  readonly seed?: string
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

  origin: RenderOrigin | null = null
  snapshot: WorldSnapshot | null = null

  #scene: RenderScene | null = null
  #frameMs = 16
  #fps = 60
  #ticksLastFrame = 0
  #starField: StarField = { positions: [], names: [] }
  #starFieldCentre: UniverseVector | null = null
  #starFieldPending = false

  constructor(options: GameEngineOptions = {}) {
    this.session = openSession({
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      // `undefined` means "the browser default"; `null` means "no pool at all".
      workers: options.workers === undefined ? () => createBrowserWorkerPort() : options.workers,
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
    return { fps: this.#fps, frameMs: this.#frameMs, ticksLastFrame: this.#ticksLastFrame }
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
    this.#starField = { positions: [], names: [] }
    this.#starFieldCentre = null
    this.terrain.clear()
    log.info('world replaced, derived state dropped', { tick: this.world.clock.tick })
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
    // No rebase branch here. `TerrainStreamer.#ensure` already rebuilds any
    // patch whose `originGeneration` is stale, and it does it only for the
    // patches that should be visible. The explicit `rebuild()` this replaces
    // walked the whole 64-entry heightfield cache instead, re-adding patches
    // `update()` had just pruned — one frame of off-screen geometry uploads on
    // every rebase, which is every 4096 m of camera travel.
    this.terrain.update(this.world, camera.position, this.origin, surfaceBody?.address ?? null)

    this.#maybeSurveyStars(camera.position)

    const elapsed = performance.now() - started
    this.#frameMs = this.#frameMs * 0.9 + elapsed * 0.1
    this.#fps = delta > 0 ? this.#fps * 0.9 + (1 / delta) * 0.1 : this.#fps
  }

  /**
   * Keep a local starfield around the player.
   *
   * Re-surveyed only when the player has actually gone somewhere, because a
   * 40 ly sweep is tens of thousands of stars and belongs in a worker — which
   * is exactly where it goes.
   */
  #maybeSurveyStars(centre: UniverseVector): void {
    if (this.#starFieldPending) return
    const moved =
      this.#starFieldCentre === null ||
      UV.distance(this.#starFieldCentre, centre) > STARFIELD_HYSTERESIS
    if (!moved) return

    this.#starFieldCentre = centre
    this.#starFieldPending = true
    const radiusCells = 2
    // `cellOf`, not a hand-inlined copy of it. The copy restated CELL_SIZE as
    // `20 * 9.4607304725808e15` and recomputed `approxMeters` three times, so
    // changing the galaxy's cell size would have left the client surveying
    // cells that no longer correspond to where the player is — a compile-clean
    // change that presents as "the stars are in the wrong place".
    const cell = cellOf(centre)
    const payload = {
      seed: formatSeed(this.world.galaxySeed),
      min: { x: cell.x - radiusCells, y: cell.y - radiusCells, z: cell.z - radiusCells },
      max: { x: cell.x + radiusCells, y: cell.y + radiusCells, z: cell.z + radiusCells },
    }

    const run =
      this.pool() === null
        ? Promise.resolve(surveyRegionTask.run(payload, { cancelled: () => false }))
        : (this.pool() as WorkerPool).run(surveyRegionTask, payload)

    void Promise.resolve(run)
      .then((cells) => {
        const positions: UniverseVector[] = []
        const names: string[] = []
        for (const entry of cells) {
          for (const star of entry.stars) {
            const [sx, sy, sz, ox, oy, oz] = star.position
            positions.push(UV.universeVector(sx, sy, sz, ox, oy, oz))
            names.push(star.name)
          }
        }
        this.#starField = { positions, names }
        log.info('starfield surveyed', { stars: positions.length })
      })
      .catch((cause: unknown) => log.warn('starfield survey failed', { cause: String(cause) }))
      .finally(() => {
        this.#starFieldPending = false
      })
  }

  /* --------------------------------------------------------------------- */
  /* Player commands                                                        */
  /* --------------------------------------------------------------------- */

  setControl(translation: [number, number, number], rotation: [number, number, number]): void {
    const player = this.session.player()
    if (player === null) return
    this.world.setControl(player, vec3(...translation), vec3(...rotation))
  }

  toggleFlightAssist(): boolean {
    const player = this.session.player()
    if (player === null) return false
    return this.world.setFlightAssist(player, !this.world.entities.require(player).flightAssist)
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

