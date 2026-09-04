import { describe, expect, it } from 'vitest'
import type { DataTexture } from 'three/webgpu'
import { openSession } from '@inertialref/devtools'
import { formatAddress, parseAddress, walkBodies } from '@inertialref/universe'
import {
  PUBLISHED_RING_ADDRESSES,
  proceduralRingStrip,
} from './proceduralRings.ts'

/*
 * The seven Sol ring systems whose character is looked up rather than drawn
 * are keyed by address, and the small bodies among them by the issue-ordinal
 * address the catalog gives them — which is stable by ADR-0009 and still a
 * number nothing else in this file can see. So the table is held to the
 * catalog both ways: every key names a ringed Sol body with no photographed
 * strip, and every such body has a key. A Sol ring the seed got to draw would
 * be a coin toss on a published system, which is the defect the table exists
 * to prevent.
 */
describe('the published ring characters', () => {
  const session = openSession({ seed: 'inertialref', workers: null })
  const parsed = parseAddress('g:milky-way/s:SOL')
  if (parsed.kind !== 'system') throw new Error('Sol is a system')
  const sol = session.world.loadSystem(parsed.system)
  const mapless = new Set<string>()
  for (const body of walkBodies(sol)) {
    const rings = body.appearance.rings
    if (rings !== null && rings.texture === null) {
      mapless.add(formatAddress(body.address))
    }
  }
  session.dispose()

  it('names every mapless ringed body in Sol, and nothing else', () => {
    expect(new Set(PUBLISHED_RING_ADDRESSES)).toEqual(mapless)
  })

  it('draws Uranus as threads, however the seed falls', () => {
    // Thirteen hairlines over an empty annulus: most of the strip is clear.
    const strip = proceduralRingStrip(
      'ice-giant',
      'g:milky-way/s:SOL/b:6',
    ) as DataTexture
    const data = strip.image.data as Uint8Array
    let clear = 0
    for (let x = 0; x < strip.image.width; x += 1) {
      if ((data[x * 4 + 3] as number) < 8) clear += 1
    }
    expect(clear / strip.image.width).toBeGreaterThan(0.7)
  })
})
