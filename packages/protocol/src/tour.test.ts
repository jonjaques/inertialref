import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decode } from './codec.ts'
import {
  decodeSubjectBrief,
  decodeTourFact,
  TOUR_PROTOCOL_VERSION,
  tourMessageBytes,
  withinTourBytes,
} from './tour.ts'

const fact = {
  id: 'subject-1.radius',
  label: 'Equatorial radius',
  quantity: 60_268_000,
  unit: 'm',
  display: '60268000 m',
  speech: "Saturn's equatorial radius is about sixty thousand kilometers.",
  reason: null,
  provenance: 'observed',
  sourceIds: ['record-subject-1'],
}

describe('the guide record boundary', () => {
  it('names the current protocol', () => {
    expect(TOUR_PROTOCOL_VERSION).toBe(3)
  })
  it('requires a reason for a missing fact and wording for a quantity', () => {
    expect(decode(decodeTourFact, fact)).toEqual({ ok: true, value: fact })
    expect(
      decode(decodeTourFact, {
        ...fact,
        quantity: null,
        unit: null,
        display: null,
        speech: null,
        reason: null,
      }).ok,
    ).toBe(false)
    expect(decode(decodeTourFact, { ...fact, unit: null }).ok).toBe(false)
  })
  it('rejects extra fields on a record', () => {
    expect(decode(decodeTourFact, { ...fact, address: 's:SOL/b:5' }).ok).toBe(
      false,
    )
    expect(
      decode(decodeSubjectBrief, {
        subjectId: 'subject-1',
        address: 's:SOL/b:5',
        name: 'Saturn',
        provenance: 'observed',
        classification: 'Gas giant',
        summary: 'Ringed.',
        facts: [fact],
        sources: [
          {
            id: 'record-subject-1',
            title: 'Saturn: application observed record',
            url: null,
            origin: 'application',
          },
        ],
        observer: {
          pictureTime: 0,
          altitudeMeters: null,
          fill: null,
          arrived: false,
        },
      }).ok,
    ).toBe(true)
  })
  it('counts UTF-8 bytes rather than code units', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme' }), (text) => {
        // A percent-escape is one UTF-8 byte; anything unescaped is ASCII.
        expect(tourMessageBytes(text)).toBe(
          encodeURIComponent(text).replace(/%[0-9A-F]{2}/g, 'x').length,
        )
      }),
    )
    expect(withinTourBytes({ text: 'x'.repeat(70_000) }).ok).toBe(false)
  })
})
