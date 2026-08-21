import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { frameId, UV } from '@inertialref/spatial'
import {
  bodyAddress,
  galaxyAddress,
  galaxyId,
  systemAddress,
  systemId,
} from './address.ts'
import {
  bodyFixedFrameId,
  bodyFrameId,
  surfaceFrameId,
  systemFrameId,
  systemOfFrameId,
} from './frames.ts'
import {
  PARTITION_ENTRY_RADIUS,
  partitionForAddress,
  partitionForFlight,
  partitionForPosition,
} from './partition.ts'

const GALAXY = galaxyId('milky-way')
const SOL = systemId('SOL')

/*
 * Partition keys, and the one place they are derived from a frame.
 *
 * The interesting property is not what the strings look like — it is that
 * everything claiming to know which authority owns a ship arrives at the same
 * answer. ADR-0008 records that the debug overlay used to reach it by scanning
 * a frame chain for an `s:` prefix, which produced the right string only
 * because the two grammars happen to spell a system the same way. These tests
 * fail if either grammar moves without the other, which is the failure that
 * coincidence was hiding.
 */

describe('system frame ids', () => {
  it('round-trips every well-formed system id', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,16}$/),
        (text) => {
          const system = systemId(text)
          expect(systemOfFrameId(systemFrameId(system))).toBe(system)
        },
      ),
    )
  })

  it('rejects every other kind of frame', () => {
    const planet = bodyAddress(GALAXY, SOL, [2])
    // `sf:` also begins with an s, which is exactly what a prefix scan gets
    // wrong; the trailing-segment case is what an id grammar grows next.
    for (const frame of [
      bodyFrameId(planet),
      bodyFixedFrameId(planet),
      surfaceFrameId(planet, 0.35, -1.1),
      frameId('universe'),
      frameId('s:SOL/extra'),
      frameId('s:'),
    ]) {
      expect(systemOfFrameId(frame)).toBe(null)
    }
  })
})

describe('partition keys', () => {
  it('routes a frame and an address to the same authority', () => {
    const parsed = systemOfFrameId(systemFrameId(SOL))
    if (parsed === null) throw new Error('a system frame id must parse back')
    expect(partitionForAddress(systemAddress(GALAXY, parsed))).toBe(
      partitionForAddress(systemAddress(GALAXY, SOL)),
    )
  })

  it('puts everything inside a system under that system', () => {
    const system = partitionForAddress(systemAddress(GALAXY, SOL))
    expect(partitionForAddress(bodyAddress(GALAXY, SOL, [2]))).toBe(system)
    expect(partitionForAddress(bodyAddress(GALAXY, SOL, [2, 0]))).toBe(system)
    expect(partitionForAddress(galaxyAddress(GALAXY))).not.toBe(system)
  })

  it('hands a ship to the system it is near, and to the cell otherwise', () => {
    const sol = {
      key: partitionForAddress(systemAddress(GALAXY, SOL)),
      position: UV.fromMeters(0, 0, 0),
    }
    const inside = UV.fromMeters(PARTITION_ENTRY_RADIUS * 0.5, 0, 0)
    const outside = UV.fromMeters(PARTITION_ENTRY_RADIUS * 2, 0, 0)
    expect(partitionForFlight(inside, [sol])).toBe(sol.key)
    expect(partitionForFlight(outside, [sol])).toBe(
      partitionForPosition(outside),
    )
    // A deep-space key is never a system key, or a ship out between the stars
    // would be routed to an authority for a star it is nowhere near.
    expect(partitionForPosition(outside).startsWith('s:')).toBe(false)
  })
})
