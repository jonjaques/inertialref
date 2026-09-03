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
  type Host,
  type RenderHost,
  renderHost,
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
 * save replaces both, and the reason `Host.world` is a getter is that a host
 * which captured the reference kept reporting on the discarded world. That is
 * written once, here, instead of being a rule each host remembers.
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
   * The host's render side, as much of it as it has.
   *
   * What is not supplied, `renderHost` answers headlessly — so a test names
   * the two members it is about and the harness sees a whole port. A nested
   * object rather than members beside `world`: nothing in it can shadow the
   * getter this module exists to protect.
   */
  readonly render?: Partial<RenderHost>
  /**
   * Called after the world is replaced, so a host can drop derived state.
   *
   * There is exactly one question here — "what becomes stale when the world
   * changes?" — and a host answers it in one place. Spread over three methods
   * and answered differently in each, the client reset the origin and the scene
   * and forgot the starfield and the terrain, so loading a save taken four light
   * years away kept the old stars: the re-survey is gated on having *moved*, and
   * from the cache's point of view nothing had.
   */
  readonly onWorldReplaced?: () => void
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

/** A running session: the host the harness is built over, and what came with it. */
export interface Session extends Host {
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

  const host: Host = {
    get world() {
      return world
    },
    player: () => player,
    pool: () => pool,
    // The host's clock, for the measuring verbs. Nothing below `apps/` may
    // reach for one itself, so a session that was given none reports "not
    // timed" rather than inventing a number.
    now: options.now ?? null,
    replaceWorld: (next, nextPlayer) => {
      world = next
      player = nextPlayer
      options.onWorldReplaced?.()
    },
    authority: () => authority,
    // Whole, whatever the caller supplied: the headless adapter answers the
    // rest, so no reader of the port asks whether a member is there.
    render: renderHost(options.render),
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

  // The session *is* the host, with the rest laid onto the same object — so
  // the `world` getter is written once and there is no second copy of the
  // simulation half to keep in step with it.
  return Object.assign(host, {
    harness,
    store,
    system,
    target,
    dispose: () => {
      authority.leave()
      pool?.terminate()
      pool = null
    },
  })
}
