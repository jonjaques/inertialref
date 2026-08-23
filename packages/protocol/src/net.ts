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
  /**
   * The version of the star catalog this deployment ships, from
   * `data/catalog/manifest.json`. The *second* generation input, and exactly as
   * load-bearing as the first: a client on `hyg-4.5` finds stars in places a
   * server on `hyg-4.4` has nothing at all.
   *
   * Empty means the deployment did not state one, which `versionDrift` reports
   * as `absent` — a mismatch, never a pass.
   */
  readonly catalog: string
  /** Deployment identity, for "which build am I talking to". Never compared. */
  readonly revision: string
  /** Edge location that answered. Empty when the runtime does not report one. */
  readonly colo: string
}

export const decodeServerHealth: Decoder<ServerHealth> = decodeObject({
  status: decodeLiteral('ok'),
  protocol: decodeInteger,
  generation: decodeNumberRecord,
  /*
   * Optional in the decoder and compared as `absent` — not optional as a claim.
   *
   * A server too old to state a catalog version is a server whose universe this
   * client cannot verify, and that is the answer the drift reports. Making it
   * required in the decoder would say the same thing far less usefully: the
   * outcome would be "not a health record" rather than "the catalog is absent",
   * which is the difference between a diagnosis and a shrug.
   */
  catalog: decodeOptional(decodeString, ''),
  // Diagnostics, so a server that omits them is still a usable server. Refusing
  // a session over a missing debug field would be the tail wagging the dog.
  revision: decodeOptional(decodeString, 'unknown'),
  colo: decodeOptional(decodeString, ''),
})

/**
 * What a build claims about the universe it derives.
 *
 * Two manifests, not one, and they are different shapes for a reason that is
 * not going away: the generation versions are a map of algorithm names to
 * integers this repository controls, and the catalog version is an opaque
 * string naming somebody else's astronomy release. They are recorded together
 * in every save and every health record, and until `versionDrift` existed they
 * were compared in three places under three different disciplines — one
 * comparator that had never heard of the catalog, one string interpolation on a
 * failure path, and one caller that received both and discarded them.
 */
export interface UniverseVersions {
  /** `GENERATION_VERSIONS`: which algorithms, at which revision. */
  readonly generation: Readonly<Record<string, number>>
  /** The catalog manifest's version string, e.g. `hyg-4.4+nea-2b24daf0`. */
  readonly catalog: string
}

/**
 * What either side of the handshake claims about itself.
 *
 * Not `ClientVersions`: a `ServerHealth` satisfies this structurally, and the
 * comparison below is symmetric, so naming it after one participant made the
 * local authority — which is a server to its own client — read as if it were
 * borrowing the client's type.
 *
 * `protocol` is here and not in `UniverseVersions` because it answers a
 * different question. The protocol version says whether two peers can talk; the
 * universe versions say whether there is anything worth saying. A save file has
 * the second and not the first, which is why they are separate types rather
 * than one type with an optional field.
 */
export interface Versions extends UniverseVersions {
  readonly protocol: number
}

/** One key on which two manifests disagree. */
export interface VersionDrift {
  /** `catalog`, or the name of a generation algorithm. */
  readonly key: string
  /** `undefined` is absent — which is a mismatch, never a default. */
  readonly ours: string | number | undefined
  readonly theirs: string | number | undefined
}

/**
 * Every way two builds disagree about which universe they derive.
 *
 * An empty array is the same universe. This is the one verdict: the handshake
 * reads it, the save loader reads it, and the health panel displays it, so
 * "would this peer generate the same mountains" and "was this save written
 * against the sky I have" cannot be answered differently by two pieces of code
 * that both believe they are correct.
 *
 * The asymmetry is deliberate and it is the whole point. An algorithm present
 * on one side and absent on the other is a mismatch, not a default — a new
 * generator is a new universe whether or not the older peer has heard of it.
 * The tempting behavior, ignoring unknown keys, makes the comparison pass in
 * exactly the case it exists to catch. An empty catalog string is the same
 * claim in the other manifest's spelling: not stated, therefore not the same.
 *
 * Catalog first, then generation keys alphabetically, so a drift always reads
 * the same way whoever asked.
 */
export function versionDrift(
  ours: UniverseVersions,
  theirs: UniverseVersions,
): readonly VersionDrift[] {
  const drift: VersionDrift[] = []
  if (ours.catalog !== theirs.catalog) {
    drift.push({
      key: 'catalog',
      ours: stated(ours.catalog),
      theirs: stated(theirs.catalog),
    })
  }
  const names = new Set([
    ...Object.keys(ours.generation),
    ...Object.keys(theirs.generation),
  ])
  for (const name of [...names].sort()) {
    const a = ours.generation[name]
    const b = theirs.generation[name]
    if (a === b) continue
    drift.push({ key: name, ours: a, theirs: b })
  }
  return drift
}

/**
 * A drift as one sentence, reading in argument order.
 *
 * `terrain 1≠2` is ours 1, theirs 2 — which matters because `LocalAuthority` is
 * the server in its own handshake, so "the server" is not always the far end of
 * a wire.
 */
export function describeDrift(drift: readonly VersionDrift[]): string {
  return drift
    .map((one) => `${one.key} ${label(one.ours)}≠${label(one.theirs)}`)
    .join(', ')
}

/**
 * Whether two peers can talk, and if not, why in one sentence.
 *
 * Returns `null` when they agree. A reading of `versionDrift` with the protocol
 * check in front of it: the protocol has to match before a drift on anything
 * else is even meaningful, because a peer that cannot parse the message cannot
 * be told what it disagrees about.
 */
export function incompatibility(
  server: Versions,
  client: Versions,
): string | null {
  if (server.protocol !== client.protocol) {
    return `protocol ${server.protocol} on the server, ${client.protocol} here`
  }
  const drift = versionDrift(server, client)
  if (drift.length === 0) return null
  return `universe mismatch: ${describeDrift(drift)}`
}

const label = (version: string | number | undefined): string =>
  version === undefined ? 'absent' : String(version)

/** An unstated catalog version is absent, not a value two peers can share. */
const stated = (catalog: string): string | undefined =>
  catalog === '' ? undefined : catalog
