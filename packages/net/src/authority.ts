import type { Result } from '@inertialref/shared'
import type { WireVec3, SaveEntity } from '@inertialref/protocol'
import { NET_PROTOCOL_VERSION } from '@inertialref/protocol'
import type { World } from '@inertialref/simulation'
import {
  type EntityId,
  GENERATION_VERSIONS,
  partitionForFrames,
  type PartitionKey,
} from '@inertialref/universe'

/*
 * The authority port (docs/hosting.md H-4).
 *
 * An *authority* is whatever owns the part of the simulation this client does
 * not: other players' ships, and mutations that have to outlive the session.
 * That is the entire job — the universe is a pure function of
 * (seed, catalog version, address), so nothing about the galaxy itself ever
 * crosses this boundary, and the set an authority replicates is the same set a
 * 696-byte save file holds.
 *
 * There are two implementations of that idea and they are peers, not a real one
 * and a fallback. `LocalAuthority` is what runs for a player who is alone,
 * which is most players most of the time and the only mode the project promises
 * unconditionally (docs/design/modes.md). A remote authority arrives at H4 and
 * gets to be the special case.
 *
 * This is the same shape `packages/workers/src/transport.ts` already uses for
 * Web Workers, deliberately: a port here, a host implementation there, and an
 * in-process double in Node tests. Nothing in this package knows what a Durable
 * Object is, and `pnpm graph` will keep it that way.
 */

/** What a client claims about itself when it asks to enter a partition. */
export interface ClientHello {
  readonly protocol: number
  /** Which universe this build derives. Compared, not logged. */
  readonly generation: Readonly<Record<string, number>>
  readonly seed: string
  readonly galaxy: string
  /**
   * Entities this client simulates itself and will never accept updates for.
   *
   * Sent rather than inferred because a client owning nothing is a legitimate
   * state — a spectator, or the headless runner joining to watch — and an
   * authority that guessed from the connection would have no way to express it.
   */
  readonly owns: readonly EntityId[]
}

export interface Joined {
  readonly partition: PartitionKey
  /** Other clients in this partition, not counting this one. */
  readonly peers: number
  /**
   * Whether the authority will send entity state at all.
   *
   * False when this client is alone, which is H-6 and the reason the wide
   * scenario in docs/hosting.md costs $96 rather than $2,166: a solo occupant
   * has nothing to be told, so the authority says so and goes quiet instead of
   * billing wall-clock time to relay nothing.
   */
  readonly streaming: boolean
}

/**
 * Control input, batched, addressed to whoever else needs to see it.
 *
 * The wire form of a control input rather than the physics one, so this package
 * does not depend on `physics` and a message needs no conversion to send. It is
 * the same shape `SaveEntity.control` already uses, and the same triple
 * (`tick`, `entity`, `control`) that the input log for replay would record —
 * which is why docs/roadmap.md lists replay as multiplayer work brought
 * forward rather than a separate feature.
 */
export interface Intent {
  readonly entity: EntityId
  readonly tick: number
  readonly control: {
    readonly translation: WireVec3
    readonly rotation: WireVec3
  }
  readonly flightAssist: boolean
}

/**
 * Everything an authority can tell a client, after it has accepted one.
 *
 * `entities` carries `SaveEntity` because the replication set and the save set
 * are the same set (ADR-0007), and saying so in a type is worth more than
 * saying so in a comment. It is a fuller record than a 10 Hz stream wants to
 * resend — H4 can split it into a spawn record plus a delta without any of this
 * changing shape.
 */
export type AuthorityUpdate =
  | {
      readonly kind: 'presence'
      readonly peers: number
      readonly streaming: boolean
    }
  | {
      readonly kind: 'entities'
      readonly tick: number
      readonly entities: readonly SaveEntity[]
    }
  | { readonly kind: 'departed'; readonly entities: readonly EntityId[] }
  | { readonly kind: 'closed'; readonly reason: string }

export type AuthorityState =
  'idle' | 'joining' | 'joined' | 'refused' | 'closed'

/** What the debug overlay shows, and what a test asserts on. The same record. */
export interface AuthorityStatus {
  readonly kind: 'local' | 'remote'
  readonly state: AuthorityState
  readonly partition: PartitionKey | null
  readonly peers: number
  readonly streaming: boolean
  /** Intents submitted since joining. Zero until the input log exists (H4). */
  readonly submitted: number
  /** Why, when the state is `refused` or `closed`. */
  readonly detail: string | null
}

export interface AuthorityPort {
  /**
   * Enter a partition. Resolves once the authority has accepted or refused.
   *
   * Refusal is a `Result`, not a rejection, because a version mismatch is an
   * answer rather than a failure — the save loader treats a newer schema the
   * same way (ADR-0007), and for the same reason: proceeding anyway loses data
   * that looks like it was preserved.
   */
  join(
    partition: PartitionKey,
    hello: ClientHello,
  ): Promise<Result<Joined, string>>
  leave(): void
  /** Fire-and-forget. Never awaited in the frame loop. */
  submit(intent: Intent): void
  /**
   * Authoritative state for entities this client does not own.
   *
   * Changes only — the current state is `status()`. A handler is never called
   * with the entities the client said it owns; an authority that echoed a
   * client's own ship back at it would be fighting the local simulation.
   */
  subscribe(handler: (update: AuthorityUpdate) => void): () => void
  status(): AuthorityStatus
}

/**
 * The claim this build makes about itself.
 *
 * Built from the same constants the handshake compares against, so a client
 * cannot describe a universe it does not actually generate. If a generator is
 * added and this is not the thing that changes, two peers agree on a handshake
 * and disagree about where the mountains are.
 */
export function clientHello(
  world: World,
  owns: readonly EntityId[],
): ClientHello {
  return {
    protocol: NET_PROTOCOL_VERSION,
    generation: GENERATION_VERSIONS,
    seed: world.seedText,
    galaxy: world.galaxy,
    owns,
  }
}

/**
 * The partition an entity is currently in, or null if it is not in the world.
 *
 * Goes through `partitionForFrames` rather than reading the address, because a
 * ship has no address at all — authority follows the frame it is standing in.
 */
export function partitionOfEntity(
  world: World,
  id: EntityId | null,
): PartitionKey | null {
  if (id === null) return null
  const entity = world.entities.get(id)
  if (entity === undefined) return null
  const frame = entity.state.frame
  const chain = world.frames.has(frame) ? world.frames.chain(frame) : [frame]
  return partitionForFrames(
    world.galaxy,
    chain,
    world.canonicalPositionOf(entity.id),
  )
}
