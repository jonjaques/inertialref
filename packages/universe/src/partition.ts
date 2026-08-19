import type { Brand } from '@inertialref/shared'
import { UV, type UniverseVector } from '@inertialref/spatial'
import type { UniverseAddress } from './address.ts'
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
  return (address.kind === 'galaxy' ? `g:${address.galaxy}` : `s:${address.system}`) as PartitionKey
}

/** Partition covering a point in interstellar space. */
export function partitionForPosition(position: UniverseVector): PartitionKey {
  return `c:${cellKey(cellOf(position))}` as PartitionKey
}

/** Whether two partitions could ever need to exchange state this tick. */
export const partitionsAdjacent = (a: PartitionKey, b: PartitionKey): boolean => a === b

export const formatPartition = (key: PartitionKey): string => key

/** Distance at which a system's partition is considered entered. */
export const PARTITION_ENTRY_RADIUS = 4e12

export function partitionForFlight(
  position: UniverseVector,
  systems: readonly { readonly key: PartitionKey; readonly position: UniverseVector }[],
): PartitionKey {
  for (const system of systems) {
    if (UV.distance(system.position, position) <= PARTITION_ENTRY_RADIUS) return system.key
  }
  return partitionForPosition(position)
}
