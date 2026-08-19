import { createConsoleSink, getLogger, logHub, type Seconds } from '@inertialref/shared'
import { formatSeed } from '@inertialref/procedural'
import { type RenderOrigin, UV, type UniverseVector, Vec, vec3 } from '@inertialref/spatial'
import { snapshot, World, type WorldSnapshot } from '@inertialref/simulation'
import {
  bodyFrameId,
  type EntityId,
  systemId,
  type SystemId,
  walkBodies,
} from '@inertialref/universe'
import { buildScene, nearestBody, originForCamera, type RenderScene } from '@inertialref/rendering'
import { createTaskRegistry, surveyRegionTask, WorkerPool } from '@inertialref/workers'
import { GameHarness, type HarnessHost } from '@inertialref/devtools'
import { captureSave, DEFAULT_SLOT, serializeSave, type SaveStore } from '@inertialref/persistence'
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

export interface FrameStats {
  readonly fps: number
  readonly frameMs: number
  readonly ticksLastFrame: number
}

export interface StarField {
  readonly positions: readonly UniverseVector[]
  readonly names: readonly string[]
}

/**
 * The engine *is* the harness host.
 *
 * Implementing the interface directly rather than building an object literal
 * around the engine keeps `world` a live property read: a literal would have to
 * capture `this`, and a captured world reference is precisely the bug that made
 * loading a save appear to do nothing.
 */
export class GameEngine implements HarnessHost {
  world: World
  origin: RenderOrigin | null = null
  snapshot: WorldSnapshot | null = null
  readonly harness: GameHarness
  readonly saves: SaveStore
  readonly terrain: TerrainStreamer

  #playerId: EntityId | null = null
  #scene: RenderScene | null = null
  #pool: WorkerPool | null = null
  #frameMs = 16
  #fps = 60
  #ticksLastFrame = 0
  #starField: StarField = { positions: [], names: [] }
  #starFieldCentre: UniverseVector | null = null
  #starFieldPending = false

  constructor(seed: string, options: { workers?: boolean } = {}) {
    logHub.addSink(createConsoleSink(console, 'info'))
    this.world = new World({ seed })
    this.saves = new IndexedDbSaveStore()

    if (options.workers !== false) {
      try {
        this.#pool = new WorkerPool({
          factory: () => createBrowserWorkerPort(),
          size: poolSize(),
          now: () => performance.now(),
        })
      } catch (cause) {
        // A browser without module workers still gets a game, just a jerkier
        // one: generation falls back to the main thread rather than failing.
        log.warn('worker pool unavailable, generating on the main thread', { cause: String(cause) })
        this.#pool = null
      }
    }
    this.terrain = new TerrainStreamer(this.#pool)

    this.harness = new GameHarness(this)
    this.#start()
  }

  /* ----------------------------------------------------------------------- */
  /* HarnessHost                                                              */
  /* ----------------------------------------------------------------------- */

  player(): EntityId | null {
    return this.#playerId
  }

  setPlayer(id: EntityId): void {
    this.#playerId = id
  }

  scene(): RenderScene | null {
    return this.#scene
  }

  pool(): WorkerPool | null {
    return this.#pool
  }

  replaceWorld(world: World, player: EntityId | null): void {
    this.world = world
    this.#playerId = player
    this.origin = null
    this.#scene = null
    log.info('world replaced', { tick: world.clock.tick })
  }

  get starField(): StarField {
    return this.#starField
  }

  frameStats(): FrameStats {
    return { fps: this.#fps, frameMs: this.#frameMs, ticksLastFrame: this.#ticksLastFrame }
  }

  terrainState(): TerrainState {
    return this.terrain.state()
  }

  /** Set up the opening position: a ship in orbit around the first solid world. */
  #start(): void {
    const system = this.world.loadSystem(systemId('SOL'))
    const target =
      [...walkBodies(system)].find((body) => body.kind === 'rocky' && body.radius > 1e6) ??
      system.planets[0]
    if (target === undefined) throw new Error('Sol generated no planets')

    const ship = this.world.spawnShip('Debug One', bodyFrameId(target.address), vec3(target.radius * 2.5, 0, 0))
    this.#playerId = ship.id
    const address = target.id.slice(1)
    this.harness.orbit(address, 400)
    // Opening shot looks at the world you are orbiting rather than along the
    // orbit; the trajectory is unchanged either way.
    this.harness.face(address)
    log.info('universe ready', {
      seed: this.world.seedText,
      seedHex: formatSeed(this.world.rootSeed),
      system: system.name,
      target: target.name,
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

    const player = this.#playerId
    if (player === null) return

    const shot = snapshot(this.world)
    this.snapshot = shot
    const camera = shot.entities.find((entity) => entity.id === player)
    if (camera === undefined) return

    const previousGeneration = this.origin?.generation ?? -1
    this.origin = originForCamera(this.origin, camera.position)
    this.#scene = buildScene(shot, this.origin, player)

    const surfaceBody = this.#scene.terrainCandidates[0] ?? null
    this.terrain.update(this.world, camera.position, this.origin, surfaceBody?.address ?? null)
    if (this.origin.generation !== previousGeneration && previousGeneration >= 0) {
      this.terrain.rebuild(this.world, this.origin)
    }

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
      this.#starFieldCentre === null || UV.distance(this.#starFieldCentre, centre) > 8 * 9.4607304725808e15
    if (!moved) return

    this.#starFieldCentre = centre
    this.#starFieldPending = true
    const radiusCells = 2
    const cell = {
      x: Math.floor(UV.approxMeters(centre).x / (20 * 9.4607304725808e15)),
      y: Math.floor(UV.approxMeters(centre).y / (20 * 9.4607304725808e15)),
      z: Math.floor(UV.approxMeters(centre).z / (20 * 9.4607304725808e15)),
    }
    const payload = {
      seed: formatSeed(this.world.galaxySeed),
      min: { x: cell.x - radiusCells, y: cell.y - radiusCells, z: cell.z - radiusCells },
      max: { x: cell.x + radiusCells, y: cell.y + radiusCells, z: cell.z + radiusCells },
    }

    const run =
      this.#pool === null
        ? Promise.resolve(surveyRegionTask.run(payload, { cancelled: () => false }))
        : this.#pool.run(surveyRegionTask, payload)

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
    if (this.#playerId === null) return
    this.world.entities.update(this.#playerId, {
      control: { translation: vec3(...translation), rotation: vec3(...rotation) },
    })
  }

  toggleFlightAssist(): boolean {
    if (this.#playerId === null) return false
    const entity = this.world.entities.require(this.#playerId)
    const next = !entity.flightAssist
    this.world.entities.update(this.#playerId, { flightAssist: next })
    return next
  }

  killRotation(): void {
    if (this.#playerId === null) return
    const entity = this.world.entities.require(this.#playerId)
    this.world.entities.update(this.#playerId, {
      state: { ...entity.state, angularVelocity: Vec.ZERO },
    })
  }

  loadedSystemIds(): readonly SystemId[] {
    return this.world.loadedSystems().map((system) => system.id)
  }

  async save(slot: string = DEFAULT_SLOT): Promise<string> {
    const text = serializeSave(captureSave(this.world, this.#playerId))
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
    this.origin = null
    return true
  }

  dispose(): void {
    this.#pool?.terminate()
  }
}

/** The registry the worker entry serves, shared so both sides agree. */
export const taskRegistry = createTaskRegistry()

/** Bodies of the loaded system, for the HUD's target list. */
export function loadedBodies(engine: GameEngine): readonly { address: string; name: string; kind: string }[] {
  const system = engine.world.loadedSystems()[0]
  if (system === undefined) return []
  return [...walkBodies(system)].map((body) => ({
    address: `${body.id.slice(1)}`,
    name: body.name,
    kind: body.kind,
  }))
}

export { nearestBody }
