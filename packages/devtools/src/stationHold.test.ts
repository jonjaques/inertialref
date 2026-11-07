import { describe, expect, it } from 'vitest'
import {
  bodyFrameId,
  entityIdForAddress,
  parseAddress,
  stationFrameId,
} from '@inertialref/universe'
import { holdOn, holdReading } from './stationHold.ts'

/*
 * What a hold is, apart from the camera that applies it: which subjects take
 * one, and what the status says about it. The observatory's hand-offs are in
 * `observatory.test.ts`.
 */

const station = {
  frame: stationFrameId(
    entityIdForAddress(parseAddress('g:milky-way/s:SOL/b:2/a:0')),
  ),
}
const earth = { frame: bodyFrameId(parseAddress('g:milky-way/s:SOL/b:2')) }

describe('a station hold', () => {
  it('is taken on a station’s anchor and refused on anything else', () => {
    expect(holdOn(station, 12).referenceTime).toBe(12)
    expect(() => holdOn(earth, 12)).toThrow(/Choose a station/)
    expect(() => holdOn(null, 12)).toThrow(/Choose a station/)
  })

  it('reads as a switch only where taking it would work', () => {
    const hold = holdOn(station, 0)
    expect(holdReading(station, null, false)).toBe('space')
    expect(holdReading(station, hold, false)).toBe('station')
    expect(holdReading(earth, null, false)).toBeNull()
    expect(holdReading(null, null, false)).toBeNull()
    // A galaxy instrument owns the pose and refuses a hold, so it offers none:
    // a switch drawn there would throw from the panel that drew it.
    expect(holdReading(station, null, true)).toBeNull()
  })
})
