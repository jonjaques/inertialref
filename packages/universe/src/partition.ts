import type { Brand } from '@inertialref/shared'
import type { FrameId } from '@inertialref/spatial'
import { UV, type UniverseVector } from '@inertialref/spatial'
import {
  type GalaxyId,
  systemAddress,
  type UniverseAddress,
} from './address.ts'
import { systemOfFrameId } from './frames.ts'
import { cellOf, cellKey } from './galaxy.ts'

/*
 * Partition keys (ADR-0008 — design seam only; multiplayer is a later phase).
 *
 * A partition is the unit of authority: the thing that would own a slice of the
 * simulation and the players inside it. A star system is the natural candidate,
 * because it is also the unit of gravitational coupling — two ships in
 * different systems cannot physically interact, so nothing has to be
 * reconciled across the boundary — and interstellar space partitions by
 * generation cell for the same reason.
 *
 * This file exists now, before any networking, for one reason: to make sure the
 * simulation never grows a hidden assumption that authority is global. It maps
 * addresses and positions to opaque string keys and imports nothing from any
 * infrastructure vendor. When the multiplayer phase lands, a Durable Object per
 * key is one plausible binding of this and Cloudflare stays on the far side of
 * an adapter.
 */

export type PartitionKey = Brand<string, 'partition'>

export function partitionForAddress(address: UniverseAddress): PartitionKey {
  return (
    address.kind === 'galaxy' ? `g:${address.galaxy}` : `s:${address.system}`
  ) as PartitionKey
}

/** Partition covering a point in interstellar space. */
export function partitionForPosition(position: UniverseVector): PartitionKey {
  return `c:${cellKey(cellOf(position))}` as PartitionKey
}

/**
 * The partition owning something standing in a chain of frames.
 *
 * Authority follows the *frame*, not the address: a ship has no address at all,
 * but a ship inside Sol belongs to Sol's partition, and falling back to the
 * galactic cell is only right out in interstellar space.
 *
 * It lives here, with the two grammars it spans, because it previously did not:
 * the debug overlay open-coded it by scanning the chain for an `s:` prefix and
 * returning the frame id, which matched `partitionForAddress` only by
 * coincidence (ADR-0008). Two callers now need the answer — the overlay and the
 * authority the client joins — and two open-codings of a coincidence is how the
 * router and the tool you would use to debug the router come to disagree.
 */
export function partitionForFrames(
  galaxy: GalaxyId,
  frameChain: readonly FrameId[],
  position: UniverseVector,
): PartitionKey {
  for (const frame of frameChain) {
    const system = systemOfFrameId(frame)
    if (system !== null) {
      return partitionForAddress(systemAddress(galaxy, system))
    }
  }
  return partitionForPosition(position)
}

/** Whether two partitions could ever need to exchange state this tick. */
export const partitionsAdjacent = (a: PartitionKey, b: PartitionKey): boolean =>
  a === b

export const formatPartition = (key: PartitionKey): string => key

/** Distance at which a system's partition is considered entered. */
export const PARTITION_ENTRY_RADIUS = 4e12

export function partitionForFlight(
  position: UniverseVector,
  systems: readonly {
    readonly key: PartitionKey
    readonly position: UniverseVector
  }[],
): PartitionKey {
  for (const system of systems) {
    if (UV.distance(system.position, position) <= PARTITION_ENTRY_RADIUS)
      return system.key
  }
  return partitionForPosition(position)
}
