import { getLogger } from '@inertialref/shared'
import { vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  type EntityId,
  isLandable,
  type StarSystem,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { type WorkerFactory, WorkerPool } from '@inertialref/workers'
import { MemorySaveStore, type SaveStore } from '@inertialref/persistence'
import { GameHarness, type PresentationHost, type SimulationHost } from './harness.ts'

/*
 * Opening a session.
 *
 * Seven steps have to happen in one order — derive the world from a seed, load
 * a system, choose somewhere to fly to, put a ship there, stand up a worker
 * pool, pick a save store, and wire the harness over the top — and until this
 * module existed every driver of the core wrote them out again. There were five
 * copies: the browser client, the headless runner, the capability checks, the
 * harness's own target search, and the devtools tests.
 *
 * They had already drifted. The client spawned at 2.5 body radii and everything
 * else at 3, which is the kind of difference that makes a bug reproduce in one
 * runtime and not the other, and nothing could have caught it because there was
 * nothing to compare against.
 *
 * The other thing this owns is the mutable pair (`world`, `player`). Loading a
 * save replaces both, and the reason `SimulationHost.world` is a getter is that
 * a host which captured the reference kept reporting on the discarded world.
 * That is now written once, here, instead of being a rule each host remembers.
 */

const log = getLogger('devtools.session')

/** Body radii between the ship and the surface at spawn. */
const SPAWN_DISTANCE = 3

export interface SessionOptions {
  readonly seed?: string
  readonly system?: string
  /**
   * Where worker tasks run. `null` means no pool at all — generation falls back
   * to the main thread, which is a degraded but working game.
   */
  readonly workers?: WorkerFactory | null
  readonly poolSize?: number
  /** Injected so nothing here reaches for a host clock. */
  readonly now?: () => number
  readonly store?: SaveStore
  /** Render-side answers, for hosts that have them. Omitted headlessly. */
  readonly presentation?: PresentationHost
  /**
   * Called after the world is replaced, so a host can drop derived state.
   *
   * There is exactly one question here — "what becomes stale when the world
   * changes?" — and before this hook the answer was spread over three methods
   * and answered differently in each. The client reset the origin and the scene
   * and forgot the starfield and the terrain, so loading a save taken four light
   * years away kept the old stars: the re-survey is gated on having *moved*, and
   * from the cache's point of view nothing had.
   */
  readonly onWorldReplaced?: () => void
  readonly shipName?: string
}

export interface Session extends SimulationHost {
  readonly harness: GameHarness
  readonly store: SaveStore
  /** The system loaded at open, and the body the ship was placed above. */
  readonly system: StarSystem
  readonly target: Body
  dispose(): void
}

/** The first body in a system worth flying to. */
export function landingTarget(system: StarSystem): Body {
  for (const body of walkBodies(system)) if (isLandable(body)) return body
  throw new Error(`No landable body in ${system.name}`)
}

/**
 * Build a running world with a ship in it, a worker pool and a harness.
 *
 * Everything varies through an argument rather than a branch: the browser
 * passes a Worker factory and an IndexedDB store, Node passes an in-process
 * factory and a memory store, and a test passes neither. That is what the ports
 * below were built for — the client used to construct all three directly and
 * was untestable for it.
 */
export function openSession(options: SessionOptions = {}): Session {
  const seed = options.seed ?? 'inertialref'
  let world = new World({ seed })
  const system = world.loadSystem(systemId(options.system ?? 'SOL'))
  const target = landingTarget(system)

  let player: EntityId | null = world.spawnShip(
    options.shipName ?? 'Debug One',
    bodyFrameId(target.address),
    vec3(target.radius * SPAWN_DISTANCE, 0, 0),
  ).id

  let pool: WorkerPool | null = null
  if (options.workers != null) {
    const factory = options.workers
    try {
      pool = new WorkerPool({
        factory,
        size: options.poolSize ?? 2,
        ...(options.now === undefined ? {} : { now: options.now }),
      })
    } catch (cause) {
      // A browser without module workers still gets a game, just a jerkier one:
      // generation falls back to the main thread rather than failing.
      log.warn('worker pool unavailable, generating on the main thread', { cause: String(cause) })
      pool = null
    }
  }

  const store = options.store ?? new MemorySaveStore()

  const host: SimulationHost & Partial<PresentationHost> = {
    get world() {
      return world
    },
    player: () => player,
    setPlayer: (id) => {
      player = id
    },
    pool: () => pool,
    replaceWorld: (next, nextPlayer) => {
      world = next
      player = nextPlayer
      options.onWorldReplaced?.()
    },
    ...(options.presentation ?? {}),
  }

  const harness = new GameHarness(host)

  return {
    get world() {
      return world
    },
    player: () => player,
    setPlayer: host.setPlayer,
    pool: () => pool,
    replaceWorld: host.replaceWorld,
    harness,
    store,
    system,
    target,
    dispose: () => {
      pool?.terminate()
      pool = null
    },
  }
}