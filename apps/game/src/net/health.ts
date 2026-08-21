import { getLogger } from '@inertialref/shared'
import {
  decode,
  decodeServerHealth,
  HEALTH_PATH,
  incompatibility,
  NET_PROTOCOL_VERSION,
  type ServerHealth,
} from '@inertialref/protocol'
import { GENERATION_VERSIONS } from '@inertialref/universe'

/*
 * The client's half of the healthcheck (docs/hosting.md H1/H2).
 *
 * This is the only file in the client that talks to `/api`, for the same reason
 * `engine/browserWorker.ts` is the only one that constructs a `Worker`: the
 * host capability is named once, so the rest of the code cannot quietly acquire
 * a second, differently-behaved copy of it. When `AuthorityPort` lands
 * (`packages/net`, H3), this becomes one implementation behind that port rather
 * than something new.
 *
 * It lives in `apps/game` rather than in a package because `packages/*` type-
 * checks with no DOM lib at all — `fetch` and `Response` are not declared there
 * — which is exactly the rule that keeps the simulation core runnable in Node,
 * a worker and a browser without conditionals.
 *
 * **Nothing here may ever block the game.** Offline-first is the requirement,
 * not a fallback: a single-player universe needs no server, so a probe that
 * fails is a fact to display, never an error to handle. Every failure below
 * ends up as a state and a sentence.
 */

const log = getLogger('game.net')

/**
 * Four answers to "can I reach the universe's authority", which are genuinely
 * different situations and want different words in the HUD:
 *
 *   offline       the browser says there is no network. Nothing was attempted.
 *   online        a server answered and derives the same universe we do.
 *   unreachable   the request did not complete, or came back an error status.
 *   incompatible  something answered, but not with a health record this client
 *                 can use — a version mismatch, or a captive portal's login
 *                 page, which is a cheerful 200 and not a server at all.
 */
export type ConnectionState =
  'checking' | 'online' | 'offline' | 'unreachable' | 'incompatible'

export interface Connection {
  readonly state: ConnectionState
  /** One sentence, when the state is not `online`. */
  readonly detail: string | null
  readonly health: ServerHealth | null
  /** `performance.now()` of the last completed probe; null before the first. */
  readonly checkedAt: number | null
  /** Consecutive failed probes, so the HUD can distinguish a blip from an outage. */
  readonly failures: number
}

export const DISCONNECTED: Connection = {
  state: 'checking',
  detail: null,
  health: null,
  checkedAt: null,
  failures: 0,
}

/** What this build derives, and therefore what it can be talked to about. */
export const CLIENT_VERSIONS = {
  protocol: NET_PROTOCOL_VERSION,
  generation: GENERATION_VERSIONS,
} as const

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface ProbeOutcome {
  readonly state: Extract<
    ConnectionState,
    'online' | 'unreachable' | 'incompatible'
  >
  readonly detail: string | null
  readonly health: ServerHealth | null
}

/**
 * One probe, classified.
 *
 * Split out from the monitor because this is the half with judgement in it and
 * the half a Node test can drive: hand it a `fetch` that returns whatever a
 * misbehaving network returns and check the sentence that comes back. The
 * monitor around it is timers and event listeners.
 */
export async function probeHealth(
  fetchImpl: FetchLike,
  options: { readonly path?: string; readonly timeoutMs?: number } = {},
): Promise<ProbeOutcome> {
  const path = options.path ?? HEALTH_PATH
  let response: Response
  try {
    response = await fetchImpl(path, {
      // Third and last line of defence against a cached health record. The
      // service worker skips /api and the Worker sends `no-store`; this covers
      // the HTTP cache in a browser whose service worker never installed.
      cache: 'no-store',
      // A request that never settles would pin the state at `checking`
      // forever, which reads as "working on it" and is the one answer that is
      // never true.
      signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
    })
  } catch (cause) {
    return {
      state: 'unreachable',
      detail: cause instanceof Error ? cause.message : String(cause),
      health: null,
    }
  }

  if (!response.ok) {
    return {
      state: 'unreachable',
      detail: `server answered ${response.status}`,
      health: null,
    }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    return {
      state: 'incompatible',
      detail: `not a health record: ${cause instanceof Error ? cause.message : String(cause)}`,
      health: null,
    }
  }

  const decoded = decode(decodeServerHealth, body)
  if (!decoded.ok) {
    return { state: 'incompatible', detail: decoded.error, health: null }
  }

  const mismatch = incompatibility(decoded.value, CLIENT_VERSIONS)
  return mismatch === null
    ? { state: 'online', detail: null, health: decoded.value }
    : { state: 'incompatible', detail: mismatch, health: decoded.value }
}

export interface ConnectionMonitorOptions {
  /** How often to re-probe while the tab is visible and the probe is succeeding. */
  readonly intervalMs?: number
  readonly timeoutMs?: number
  readonly fetchImpl?: FetchLike
}

/**
 * Keeps a `Connection` current, cheaply.
 *
 * Three things drive a probe, and the third is the one that is easy to forget:
 * a timer, the browser's own `online` event, and the tab becoming visible
 * again. A tab left in the background for an hour has a `Connection` an hour
 * old, and the moment a human looks at it is precisely when it must be true.
 *
 * While hidden it does not probe at all. That is not only politeness to the
 * battery — inbound requests are the billed axis of this design, and a thousand
 * backgrounded tabs polling a healthcheck is a self-inflicted load pattern.
 */
export class ConnectionMonitor {
  #connection: Connection = DISCONNECTED
  readonly #listeners = new Set<(connection: Connection) => void>()
  readonly #intervalMs: number
  readonly #timeoutMs: number
  readonly #fetch: FetchLike
  #timer: number | null = null
  /** Guards against overlapping probes when several triggers coincide. */
  #inFlight = false
  #started = false

  constructor(options: ConnectionMonitorOptions = {}) {
    this.#intervalMs = options.intervalMs ?? 30_000
    this.#timeoutMs = options.timeoutMs ?? 5_000
    this.#fetch =
      options.fetchImpl ??
      ((input, init) => globalThis.fetch(input, init as RequestInit))
  }

  get connection(): Connection {
    return this.#connection
  }

  subscribe(listener: (connection: Connection) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#connection)
    return () => this.#listeners.delete(listener)
  }

  start(): void {
    if (this.#started) return
    this.#started = true
    window.addEventListener('online', this.#onOnline)
    window.addEventListener('offline', this.#onOffline)
    document.addEventListener('visibilitychange', this.#onVisibility)
    this.#timer = window.setInterval(() => this.#tick(), this.#intervalMs)
    this.#tick()
  }

  stop(): void {
    if (!this.#started) return
    this.#started = false
    window.removeEventListener('online', this.#onOnline)
    window.removeEventListener('offline', this.#onOffline)
    document.removeEventListener('visibilitychange', this.#onVisibility)
    if (this.#timer !== null) window.clearInterval(this.#timer)
    this.#timer = null
  }

  /** Probe now, whatever the schedule says. Bound so a button can pass it. */
  readonly refresh = (): void => {
    void this.#probe()
  }

  #tick(): void {
    if (document.visibilityState === 'hidden') return
    void this.#probe()
  }

  async #probe(): Promise<void> {
    if (this.#inFlight) return
    // `navigator.onLine` is famously optimistic — true means "there is an
    // interface", not "the internet is reachable". It is trustworthy in exactly
    // one direction, so it is used only to skip a probe that cannot succeed.
    if (!navigator.onLine) {
      this.#publish({
        state: 'offline',
        detail: 'the browser reports no network',
        health: null,
        checkedAt: performance.now(),
        failures: this.#connection.failures,
      })
      return
    }
    this.#inFlight = true
    try {
      const outcome = await probeHealth(this.#fetch, {
        timeoutMs: this.#timeoutMs,
      })
      const failures =
        outcome.state === 'online' ? 0 : this.#connection.failures + 1
      if (outcome.state !== this.#connection.state) {
        log.info('connection changed', {
          from: this.#connection.state,
          to: outcome.state,
          detail: outcome.detail,
        })
      }
      this.#publish({
        ...outcome,
        checkedAt: performance.now(),
        failures,
      })
    } finally {
      this.#inFlight = false
    }
  }

  readonly #onOnline = (): void => {
    void this.#probe()
  }

  readonly #onOffline = (): void => {
    this.#publish({
      state: 'offline',
      detail: 'the browser reports no network',
      health: null,
      checkedAt: performance.now(),
      failures: this.#connection.failures,
    })
  }

  readonly #onVisibility = (): void => {
    if (document.visibilityState !== 'visible') return
    const { checkedAt } = this.#connection
    if (checkedAt === null || performance.now() - checkedAt >= this.#intervalMs)
      void this.#probe()
  }

  #publish(connection: Connection): void {
    this.#connection = connection
    for (const listener of this.#listeners) listener(connection)
  }
}
