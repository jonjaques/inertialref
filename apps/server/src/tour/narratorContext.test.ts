import { describe, expect, it } from 'vitest'
import type { TourContext, TourFact } from '@inertialref/protocol'
import {
  narratorContext,
  NARRATOR_CONTEXT_MAX_BYTES,
} from './narratorContext.ts'

const measured = (speech: string): TourFact => ({
  id: 'radius',
  label: 'Radius',
  quantity: 60268000,
  unit: 'm',
  display: '60,268 km',
  speech,
  reason: null,
  provenance: 'observed',
  sourceIds: ['application-record'],
})
const context = (facts: readonly TourFact[] = []): TourContext => ({
  protocolVersion: 2,
  manifest: {
    seed: 'private-seed',
    catalogVersion: 'test',
    generation: { terrain: 1 },
  },
  viewRevision: 7,
  pictureTime: 123,
  subjectId: 'saturn',
  traveling: false,
  candidates: [
    {
      id: 'titan',
      address: 'g:milky-way/s:SOL/b:5/m:0',
      name: 'Titan',
      provenance: 'observed',
      kind: 'moon',
      parentId: 'saturn',
      framings: ['portrait'],
      sites: [],
      factIds: [],
    },
  ],
  briefs: [],
  brief: {
    subjectId: 'saturn',
    address: 's:SOL/b:5',
    name: 'Saturn',
    provenance: 'observed',
    classification: 'gas giant',
    summary: 'COOKED SUMMARY',
    facts,
    sources: [
      {
        id: 'application-record',
        title: 'SOURCE PROSE',
        url: null,
        origin: 'application',
      },
    ],
    observer: {
      pictureTime: 123,
      altitudeMeters: null,
      fill: 0.5,
      arrived: true,
    },
  },
})

describe('Live context describes the scene and reads measurements on demand', () => {
  it('keeps current view, nearby names, and real guide capabilities without prepared stories', () => {
    const current = context([measured('COOKED RADIUS STORY')])
    const instructions = narratorContext({
      ...current,
      candidates: [
        ...current.candidates,
        {
          ...current.candidates[0]!,
          id: 'saturn',
          name: 'Saturn',
          framings: ['ring-profile'],
        },
      ],
    })
    for (const expected of [
      'Saturn',
      'Titan',
      'Provenance: observed',
      'Picture time: 123',
      'Arrival: verified',
      'Application measurements and current-view state are authoritative',
      'Use established Solar System knowledge',
      'read_subject',
      'find_worlds',
      'stand_at_site',
      'ring-profile',
    ])
      expect(instructions).toContain(expected)
    for (const excluded of [
      'COOKED',
      'SOURCE PROSE',
      '60268000',
      '60,268 km',
      'private-seed',
      's:SOL',
    ])
      expect(instructions).not.toContain(excluded)
  })

  it('includes only an asked raw measurement and excludes authored note speech even when asked', () => {
    const current = context([
      measured('COOKED RADIUS STORY'),
      {
        ...measured('COOKED RINGS STORY'),
        id: 'note',
        label: 'Rings',
        sourceIds: ['nasa'],
        quantity: null,
        unit: null,
        display: null,
      },
    ])
    const enriched = {
      ...current,
      brief: {
        ...current.brief!,
        sources: [
          ...current.brief!.sources,
          {
            id: 'nasa',
            title: 'SOURCE PROSE',
            url: 'https://example.invalid',
            origin: 'curated' as const,
          },
        ],
      },
    }
    const instructions = narratorContext(
      enriched,
      'What is Saturn’s radius and the history of its rings?',
    )
    expect(instructions).toContain('"quantity":60268000')
    expect(instructions).toContain('"unit":"m"')
    expect(instructions).toContain('60,268 km')
    for (const excluded of [
      'COOKED',
      'SOURCE PROSE',
      'https://',
      '"id":"note"',
    ])
      expect(instructions).not.toContain(excluded)
  })

  it('does not announce arrival during travel or with stale observer time', () => {
    expect(narratorContext({ ...context(), traveling: true })).toContain(
      'Arrival: traveling',
    )
    expect(narratorContext({ ...context(), pictureTime: 124 })).toContain(
      'Arrival: unverified',
    )
    expect(narratorContext(context())).toContain(
      'Do not announce arrival while traveling',
    )
  })

  it('separates projected-world properties from actual mission history', () => {
    const current = context()
    const instructions = narratorContext({
      ...current,
      brief: { ...current.brief!, provenance: 'projected' },
    })
    expect(instructions).toContain(
      'Projected worlds have no real mission or discovery history',
    )
    expect(instructions).not.toContain(
      'Use established Solar System knowledge for history',
    )
  })

  it('rejects a mismatched brief and never borrows its old subject', () => {
    const instructions = narratorContext({ ...context(), subjectId: 'titan' })
    expect(instructions).not.toContain('Saturn')
    expect(instructions).toContain('Current subject: unavailable')
    expect(instructions).toContain('Arrival: unverified')
  })

  it('bounds UTF-8 bytes without cutting an oversized record or name', () => {
    const current = context([
      {
        ...measured('COOKED'),
        quantity: null,
        display: null,
        reason: '遠'.repeat(1200),
      },
    ])
    for (const name of ['Saturn', '空'.repeat(160), '空'.repeat(2000)]) {
      const instructions = narratorContext(
        { ...current, brief: { ...current.brief!, name } },
        'What is the radius?',
      )
      expect(
        new TextEncoder().encode(instructions).byteLength,
      ).toBeLessThanOrEqual(NARRATOR_CONTEXT_MAX_BYTES)
      expect(instructions).not.toContain('遠')
      expect(instructions).not.toContain('\uFFFD')
    }
  })
})
