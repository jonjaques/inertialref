import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { decode } from './codec.ts'
import {
  decodeToolRequest,
  decodeTourClientMessage,
  decodeTourPlan,
  TOUR_PROTOCOL_VERSION,
} from './tour.ts'

const request = {
  sessionId: 'session-1',
  requestRevision: 1,
  operationId: 'op-1',
  expectedViewRevision: 0,
  expiresAt: 12345,
  action: { tool: 'show_subject', subjectId: 'subject-1' },
}

describe('tour wire boundary', () => {
  it('carries bounded narration and a named camera motion in an automatic plan', () => {
    const plan = {
      id: 'solar-family',
      goal: 'Five minutes around the Solar System',
      durationSeconds: 300,
      automatic: true,
      rationale: 'A relaxed tour with time to look.',
      stops: [
        {
          id: 'saturn',
          subjectId: 'subject-1',
          framingId: 'portrait',
          siteId: null,
          objective: 'The rings that puzzled Galileo',
          factIds: [],
          minimumViewSeconds: 38,
          narration: 'Saturn gave early telescope observers quite a puzzle.',
          motion: 'reveal',
          sources: [],
        },
      ],
    }
    expect(decode(decodeTourPlan, plan)).toEqual({ ok: true, value: plan })
    expect(
      decode(decodeTourPlan, {
        ...plan,
        stops: [{ ...plan.stops[0], motion: 'execute-javascript' }],
      }).ok,
    ).toBe(false)
    expect(
      decode(decodeTourPlan, {
        ...plan,
        stops: [{ ...plan.stops[0], narration: 'x'.repeat(2001) }],
      }).ok,
    ).toBe(false)
  })
  it('decodes the current protocol and bounded scene operation', () => {
    expect(TOUR_PROTOCOL_VERSION).toBe(2)
    expect(decode(decodeToolRequest, request)).toEqual({
      ok: true,
      value: request,
    })
  })
  it('rejects extra fields at every operation boundary', () => {
    expect(decode(decodeToolRequest, { ...request, arbitrary: true }).ok).toBe(
      false,
    )
    expect(
      decode(decodeToolRequest, {
        ...request,
        action: { ...request.action, address: 's:SOL/b:5' },
      }).ok,
    ).toBe(false)
  })
  it('rejects nonfinite and outside photographic instants', () => {
    for (const value of [NaN, Infinity, -Infinity, 3.15576e12 + 1]) {
      expect(
        decode(decodeToolRequest, {
          ...request,
          action: { tool: 'set_picture_time', mode: 'set', value },
        }).ok,
      ).toBe(false)
    }
  })
  it('never accepts arbitrary tool names', () => {
    fc.assert(
      fc.property(fc.string(), (tool) => {
        if (tool === 'show_subject') return
        expect(
          decode(decodeToolRequest, {
            ...request,
            action: { tool, subjectId: 'subject-1' },
          }).ok,
        ).toBe(false)
      }),
    )
  })
  it('bounds requests and requires every plan stop', () => {
    expect(
      decode(decodeTourClientMessage, {
        type: 'ask',
        text: 'x'.repeat(4001),
        requestRevision: 1,
        viewRevision: 0,
      }).ok,
    ).toBe(false)
    expect(
      decode(decodeTourPlan, {
        id: 'p',
        goal: 'Saturn',
        durationSeconds: 120,
        stops: [],
      }).ok,
    ).toBe(false)
  })
})
