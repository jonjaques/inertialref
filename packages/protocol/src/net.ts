import {
  decodeInteger,
  decodeLiteral,
  decodeNumberRecord,
  decodeObject,
  decodeOptional,
  decodeString,
  type Decoder,
} from './codec.ts'

/*
 * The network's front door (docs/hosting.md, H-5).
 *
 * Two things live here and nothing else does: the paths the client and the
 * server both have to spell the same way, and the handshake that decides
 * whether they are allowed to talk at all.
 *
 * The handshake is not a formality. The universe is a pure function of
 * (seed, catalog version, address), so a client whose `GENERATION_VERSIONS`
 * differ from the server's derives a *different universe* — different planets,
 * different terrain — and replicating a position into it means nothing. A
 * mismatch is therefore refused with a reason, exactly as the save loader
 * refuses a newer schema (ADR-0007): proceeding on a best-effort basis loses
 * data that looks like it was preserved.
 *
 * The network is a trust boundary, so everything inbound is decoded rather than
 * cast. That includes the health record, and it earns its keep on day one — a
 * captive portal answers every request with a cheerful 200 and an HTML login
 * page, which is indistinguishable from a healthy server until something tries
 * to read the body.
 */

/**
 * Bumped when the shape of anything on the wire changes incompatibly.
 *
 * Separate from `SAVE_SCHEMA_VERSION` because they version different things and
 * move for different reasons: a save is read by a later build of the same
 * client, a message is read by a peer running concurrently.
 */
export const NET_PROTOCOL_VERSION = 1

/**
 * Paths, in one place, because four things have to agree on them: the client,
 * the Worker's router, `run_worker_first` in `wrangler.jsonc`, and the service
 * worker's cache bypass. The last of those is plain JavaScript in
 * `apps/game/public/` and cannot import this file — it repeats the prefix with
 * a comment pointing here, which is the one duplicate that could not be
 * removed.
 */
export const API_PREFIX = '/api/'
export const HEALTH_PATH = '/api/health'
export const SOCKET_PATH = '/ws'

/**
 * Files the site serves but does not carry — object storage, not the bundle.
 *
 * The *prefix* is here because it is a path the client, the router and
 * `run_worker_first` all have to spell the same way. **What is under it is
 * not**: the mapping from a name to a storage key is a fact about a bucket, and
 * a package that knew a bucket layout would be the same layering break as one
 * that knew what a Durable Object is. `apps/server/src/media.ts` holds the
 * manifest, and it is the adapter layer's business.
 */
export const MEDIA_PREFIX = '/media/'

/** The URL a named media object is served at. */
export const mediaPath = (name: string): string => `${MEDIA_PREFIX}${name}`

/**
 * What a server says about itself.
 *
 * Deliberately not a timestamp. `Date.now()` in a Worker returns the time of
 * the last I/O and does not advance during execution — a Spectre mitigation,
 * not a bug — so a clock read here would be authoritative-looking and wrong.
 * Nothing in this project needs wall clock anyway; simulation is driven by the
 * integer tick (ADR-0006).
 */
export interface ServerHealth {
  readonly status: 'ok'
  /** The server's `NET_PROTOCOL_VERSION`. */
  readonly protocol: number
  /** The server's `GENERATION_VERSIONS` — which universe it believes in. */
  readonly generation: Readonly<Record<string, number>>
  /** Deployment identity, for "which build am I talking to". Never compared. */
  readonly revision: string
  /** Edge location that answered. Empty when the runtime does not report one. */
  readonly colo: string
}

export const decodeServerHealth: Decoder<ServerHealth> = decodeObject({
  status: decodeLiteral('ok'),
  protocol: decodeInteger,
  generation: decodeNumberRecord,
  // Diagnostics, so a server that omits them is still a usable server. Refusing
  // a session over a missing debug field would be the tail wagging the dog.
  revision: decodeOptional(decodeString, 'unknown'),
  colo: decodeOptional(decodeString, ''),
})

/**
 * What either side of the handshake claims about itself.
 *
 * Not `ClientVersions`: a `ServerHealth` satisfies this structurally, and the
 * comparison below is symmetric, so naming it after one participant made the
 * local authority — which is a server to its own client — read as if it were
 * borrowing the client's type.
 */
export interface Versions {
  readonly protocol: number
  readonly generation: Readonly<Record<string, number>>
}

/**
 * Whether two peers can talk, and if not, why in one sentence.
 *
 * Returns `null` when they agree. The asymmetry is deliberate: an algorithm
 * present on one side and absent on the other is a mismatch, not a default —
 * a new generator is a new universe whether or not the older peer has heard of
 * it. The tempting behavior, ignoring unknown keys, makes the handshake pass
 * in exactly the case it exists to catch.
 *
 * The sentence reads in argument order — `terrain 1≠2` is server 1, client 2 —
 * which matters because `LocalAuthority` is the server in its own handshake,
 * so "the server" is not always the far end of a wire.
 */
export function incompatibility(
  server: Versions,
  client: Versions,
): string | null {
  if (server.protocol !== client.protocol) {
    return `protocol ${server.protocol} on the server, ${client.protocol} here`
  }
  const names = new Set([
    ...Object.keys(server.generation),
    ...Object.keys(client.generation),
  ])
  const differing = [...names]
    .filter((name) => server.generation[name] !== client.generation[name])
    .sort()
  if (differing.length === 0) return null
  return `generation mismatch: ${differing
    .map(
      (name) =>
        `${name} ${label(server.generation[name])}≠${label(client.generation[name])}`,
    )
    .join(', ')}`
}

const label = (version: number | undefined): string =>
  version === undefined ? 'absent' : String(version)
