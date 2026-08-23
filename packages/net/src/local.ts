import { err, getLogger, ok, type Result } from '@inertialref/shared'
import { incompatibility, NET_PROTOCOL_VERSION } from '@inertialref/protocol'
import type { World } from '@inertialref/simulation'
import {
  type EntityId,
  GENERATION_VERSIONS,
  type PartitionKey,
} from '@inertialref/universe'
import {
  type AuthorityPort,
  type AuthorityState,
  type AuthorityStatus,
  type AuthorityUpdate,
  type ClientHello,
  type Intent,
  type Joined,
  partitionOfEntity,
} from './authority.ts'

/*
 * The authority for a player who is alone.
 *
 * This is not a stub and not a mock, and the distinction is the point of the
 * file. Offline-first is the requirement rather than the fallback
 * (docs/design/modes.md), so this implementation runs in production for every
 * player who is not sharing a system with somebody — which, under H-6, is also
 * every player whose partition has gone quiet. It is the path that must never
 * be allowed to rot, and the surest way to keep it working is that it is the
 * only path `openSession` has: there is no `if (online)` anywhere.
 *
 * What it does is small because the honest answer is small. The client already
 * derives the entire universe and simulates its own ship at 64 Hz; an authority
 * exists to supply the two things a client cannot derive, and when you are
 * alone there are none of either. So it accepts the handshake, reports which
 * partition you are in, reports that nobody else is there, and never
 * replicates anything. Every one of those is a true statement rather than a
 * placeholder for one.
 */

const log = getLogger('net.local')

export interface LocalAuthorityOptions {
  /**
   * The running world — as an accessor, not a reference.
   *
   * Loading a save replaces the world wholesale, and a host that captured the
   * reference goes on reporting about the discarded one. That has already
   * happened here once (see `openSession`, which made `world` a getter for
   * exactly this reason), so this port takes the same shape rather than
   * relearning it.
   */
  readonly world: () => World
  readonly player: () => EntityId | null
}

export class LocalAuthority implements AuthorityPort {
  readonly #world: () => World
  readonly #player: () => EntityId | null
  readonly #listeners = new Set<(update: AuthorityUpdate) => void>()
  #state: AuthorityState = 'idle'
  #partition: PartitionKey | null = null
  #detail: string | null = null
  #submitted = 0

  constructor(options: LocalAuthorityOptions) {
    this.#world = options.world
    this.#player = options.player
  }

  join(
    partition: PartitionKey,
    hello: ClientHello,
  ): Promise<Result<Joined, string>> {
    const world = this.#world()
    /*
     * The same check a remote authority will run, against this build's own
     * constants and this session's own catalog.
     *
     * Locally it is very nearly a tautology, because `clientHello` is built
     * from the things it is compared against — and it is here anyway, for two
     * reasons. It means the local and remote paths cannot drift into applying
     * different rules to the same question. And "very nearly" is not "always":
     * a hello assembled from a *save file's* manifests is a real thing to want
     * (that is how you would ask "can this save still be played by this
     * build"), and this refuses it rather than pretending.
     */
    const mismatch = incompatibility(
      {
        protocol: NET_PROTOCOL_VERSION,
        generation: GENERATION_VERSIONS,
        catalog: world.catalog.version,
      },
      hello,
    )
    if (mismatch !== null) {
      this.#state = 'refused'
      this.#detail = mismatch
      log.warn('local authority refused a hello', { reason: mismatch })
      return Promise.resolve(err(mismatch))
    }

    if (hello.seed !== world.seedText || hello.galaxy !== world.galaxy) {
      // Not pedantry: the seed *is* the universe. A client joining with a
      // different one derives different planets, so a position means nothing.
      const reason = `this authority runs ${world.galaxy}/${world.seedText}, not ${hello.galaxy}/${hello.seed}`
      this.#state = 'refused'
      this.#detail = reason
      return Promise.resolve(err(reason))
    }

    this.#state = 'joined'
    this.#partition = partition
    this.#detail = null
    this.#submitted = 0
    const joined: Joined = { partition, peers: 0, streaming: false }
    // Emitted so a subscriber that joined before this resolves is told; the
    // current values are always available from `status()` regardless.
    this.#emit({ kind: 'presence', peers: 0, streaming: false })
    return Promise.resolve(ok(joined))
  }

  leave(): void {
    if (this.#state === 'closed') return
    this.#state = 'closed'
    this.#detail = null
    this.#emit({ kind: 'closed', reason: 'left' })
  }

  /**
   * Accepted and dropped, because there is nobody to relay it to.
   *
   * Intent is *outbound only* even when there is a server: the client applies
   * its own control input locally at 64 Hz and sends it on so that other
   * clients can see the ship move. With no other clients the send has no
   * recipient — it is not that the local case skips a step, it is that the step
   * has no content. Counting them is what makes that visible on the overlay
   * instead of merely true.
   */
  submit(_intent: Intent): void {
    this.#submitted += 1
  }

  subscribe(handler: (update: AuthorityUpdate) => void): () => void {
    this.#listeners.add(handler)
    return () => this.#listeners.delete(handler)
  }

  status(): AuthorityStatus {
    return {
      kind: 'local',
      state: this.#state,
      // Recomputed rather than remembered: the ship flies, and the partition it
      // is in is a fact about where it is now. A remembered one would be right
      // until the first frame transition and quietly wrong afterwards — which
      // is the H4 handoff question, visible here a milestone early.
      partition: this.#state === 'joined' ? this.#currentPartition() : null,
      peers: 0,
      streaming: false,
      submitted: this.#submitted,
      detail: this.#detail,
    }
  }

  /** Where the joined partition has drifted to, if the player has moved. */
  #currentPartition(): PartitionKey | null {
    return partitionOfEntity(this.#world(), this.#player()) ?? this.#partition
  }

  #emit(update: AuthorityUpdate): void {
    for (const listener of this.#listeners) listener(update)
  }
}
