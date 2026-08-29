import { getLogger } from '@inertialref/shared'
import { vec3 } from '@inertialref/spatial'
import { World } from '@inertialref/simulation'
import {
  type Body,
  bodyFrameId,
  type EntityId,
  isLandable,
  SOL_ONLY_CATALOG,
  type StarCatalog,
  type StarSystem,
  systemId,
  walkBodies,
} from '@inertialref/universe'
import { type WorkerFactory, WorkerPool } from '@inertialref/workers'
import { MemorySaveStore, type SaveStore } from '@inertialref/persistence'
import {
  type AuthorityPort,
  clientHello,
  LocalAuthority,
  partitionOfEntity,
} from '@inertialref/net'
import {
  GameHarness,
  type PresentationHost,
  type SimulationHost,
} from './harness.ts'

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
   * The star catalog. A host that has the packed asset passes it; a test that
   * does not gets `SOL_ONLY_CATALOG` and a galaxy that is entirely procedural
   * outside the Solar System.
   */
  readonly catalog?: StarCatalog
  /**
   * Where worker tasks run. `null` means no pool at all — generation falls back
   * to the main thread, which is a degraded but working game.
   */
  readonly workers?: WorkerFactory | null
  readonly poolSize?: number
  /** Injected so nothing here reaches for a host clock. */
  readonly now?: () => number
  readonly store?: SaveStore
  /**
   * The host's render side. Omitted headlessly, where there is none.
   *
   * One parameter because it is one thing: what the host can answer about a
   * frame, and what it needs to be told when the world underneath it changes.
   * They were two, and they always travelled together.
   */
  readonly host?: SessionHost
  /**
   * Who owns the part of the simulation this client does not.
   *
   * Defaults to a `LocalAuthority` over this session's own world, which is the
   * single-player case and not a placeholder for one. Passing something else is
   * how a remote authority arrives — there is deliberately no flag and no
   * branch, so the local path is the one every host exercises by default and
   * cannot rot unnoticed.
   */
  readonly authority?: AuthorityPort
}

/**
 * What a rendering host contributes to a session.
 *
 * **Named fields, not a spread**, and that is the whole reason this type
 * exists rather than `PresentationHost & { onWorldReplaced }`. The
 * `presentation` option used to be spread into the host object *last*, so a
 * stray `world` key in it would silently shadow the getter this module exists
 * to protect — the bug class recorded at the top of this file as having
 * happened once. Naming what may be supplied makes it unrepresentable rather
 * than commented against.
 */
export interface SessionHost {
  /** The frame's render description, for `ir.status().render`. */
  readonly scene?: PresentationHost['scene']
  /** Frames per second and frame time, for `ir.status().frame`. */
  readonly frameStats?: PresentationHost['frameStats']
  /** What the terrain streamer holds this frame, for `ir.terrain()`. */
  readonly terrain?: PresentationHost['terrain']
  /** The lens the frame is composed through, for `ir.lens()` and the panel. */
  readonly lensView?: PresentationHost['lensView']
  /** The flight lens alone, for the observatory's framing solver. */
  readonly framingLens?: PresentationHost['framingLens']
  /** Fit a lens — `ir.preset` and `ir.rise` each solve one. */
  readonly setFlightLens?: PresentationHost['setFlightLens']
  /** Put the interface in or out of the frame, for a plate capture. */
  readonly setChrome?: PresentationHost['setChrome']
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
}

export interface Session extends SimulationHost {
  readonly harness: GameHarness
  readonly store: SaveStore
  /** The system loaded at open, and the body the ship was placed above. */
  readonly system: StarSystem
  readonly target: Body
  /** Always present here, unlike on `SimulationHost` — a session always joins one. */
  authority(): AuthorityPort
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
  const catalog = options.catalog ?? SOL_ONLY_CATALOG
  let world = new World({ seed, catalog })
  const system = world.loadSystem(systemId(options.system ?? 'SOL'))
  const target = landingTarget(system)

  let player: EntityId | null = world.spawnShip(
    // Named here rather than through an option nothing ever passed. A session's
    // ship is the debug ship; a *second* ship is a world write, not a session
    // parameter, and `world.spawnShip` is already the verb for it.
    'Debug One',
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
      log.warn('worker pool unavailable, generating on the main thread', {
        cause: String(cause),
      })
      pool = null
    }
  }

  const store = options.store ?? new MemorySaveStore()

  /*
   * Joining the authority.
   *
   * Fire-and-forget on purpose. `join` resolves — it does not block the world,
   * the ship or the first frame — because a session that waited on an authority
   * would be a session that fails to start when there is no network, and
   * offline is the normal case rather than the error case. The result is logged
   * and reflected in `status().authority`; nothing downstream reads it
   * synchronously.
   */
  const authority =
    options.authority ??
    new LocalAuthority({ world: () => world, player: () => player })

  const host: SimulationHost & Partial<PresentationHost> = {
    get world() {
      return world
    },
    player: () => player,
    setPlayer: (id) => {
      player = id
    },
    pool: () => pool,
    // The host's clock, for the measuring verbs. Nothing below `apps/` may
    // reach for one itself, so a session that was given none reports "not
    // timed" rather than inventing a number.
    ...(options.now === undefined ? {} : { now: options.now }),
    replaceWorld: (next, nextPlayer) => {
      world = next
      player = nextPlayer
      options.host?.onWorldReplaced?.()
    },
    authority: () => authority,
    // Named, never spread. A spread landing after `world` above would shadow
    // the getter — see `SessionHost`.
    ...(options.host?.scene === undefined ? {} : { scene: options.host.scene }),
    ...(options.host?.frameStats === undefined
      ? {}
      : { frameStats: options.host.frameStats }),
    ...(options.host?.terrain === undefined
      ? {}
      : { terrain: options.host.terrain }),
    ...(options.host?.lensView === undefined
      ? {}
      : { lensView: options.host.lensView }),
    ...(options.host?.framingLens === undefined
      ? {}
      : { framingLens: options.host.framingLens }),
    ...(options.host?.setFlightLens === undefined
      ? {}
      : { setFlightLens: options.host.setFlightLens }),
    ...(options.host?.setChrome === undefined
      ? {}
      : { setChrome: options.host.setChrome }),
  }

  const harness = new GameHarness(host)

  const partition = partitionOfEntity(world, player)
  if (partition !== null) {
    void authority
      .join(partition, clientHello(world, player === null ? [] : [player]))
      .then((result) => {
        if (result.ok) {
          log.info('joined an authority', {
            partition: result.value.partition,
            peers: result.value.peers,
            streaming: result.value.streaming,
          })
        } else {
          // Refusal is an answer, not a crash. The world is already running.
          log.warn('authority refused this client', { reason: result.error })
        }
      })
      .catch((cause: unknown) => {
        log.warn('authority join failed', { cause: String(cause) })
      })
  }

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
    authority: () => authority,
    dispose: () => {
      authority.leave()
      pool?.terminate()
      pool = null
    },
  }
}
