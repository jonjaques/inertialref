import { describe, expect, it } from 'vitest'
import type { TourContext, TourFact } from '@inertialref/protocol'
import {
  narratorContext,
  NARRATOR_CONTEXT_MAX_BYTES,
  requestedRecords,
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
  it('resolves day, year, rotation and spin questions to their distinct recorded periods', () => {
    const brief = {
      ...context().brief!,
      name: 'Venus',
      facts: [
        {
          ...measured('COOKED ROTATION'),
          id: 'rotation',
          label: 'Sidereal rotation period',
          quantity: 5832.5,
          unit: 'h',
        },
        {
          ...measured('COOKED ORBIT'),
          id: 'orbit',
          label: 'Orbital period',
          quantity: 224.7,
          unit: 'd',
        },
      ],
    }
    for (const question of [
      'How long is Venus’s day?',
      'What is Venus’s rotation period?',
      'How fast does Venus spin?',
      'How fast is Venus spinning?',
    ])
      expect(requestedRecords(brief, question).map((fact) => fact.id)).toEqual([
        'rotation',
      ])
    for (const question of [
      'How long is Venus’s year?',
      'What is its orbital period?',
      'How long does Venus take to revolve around the Sun?',
    ])
      expect(requestedRecords(brief, question).map((fact) => fact.id)).toEqual([
        'orbit',
      ])
    expect(
      requestedRecords(
        brief,
        'Compare the length of Venus’s day and year.',
      ).map((fact) => fact.id),
    ).toEqual(['rotation', 'orbit'])
    expect(
      requestedRecords(
        brief,
        'Tell me the history of Venus exploration over the years.',
      ),
    ).toEqual([])
  })

  it('returns a bounded raw-record overview only when measurements are explicitly requested', () => {
    const base = context().brief!
    const brief = {
      ...base,
      facts: [
        { ...measured('COOKED NOTE'), id: 'note', sourceIds: ['curated'] },
        ...[
          'Radius',
          'Mass',
          'Temperature',
          'Orbital period',
          'Sidereal rotation period',
        ].map((label, index) => ({
          ...measured('COOKED MEASUREMENT'),
          id: `record-${index}`,
          label,
        })),
      ],
      sources: [
        ...base.sources,
        {
          id: 'curated',
          title: 'COOKED SOURCE',
          origin: 'curated' as const,
          url: 'https://example.invalid',
        },
      ],
    }
    for (const question of [
      'Show me its measurements.',
      'What properties are recorded?',
      'Show the app record.',
      'Give me the numbers.',
    ])
      expect(requestedRecords(brief, question).map((fact) => fact.id)).toEqual([
        'record-0',
        'record-1',
        'record-2',
        'record-3',
      ])
    expect(
      requestedRecords(brief, 'Show the radius record.').map((fact) => fact.id),
    ).toEqual(['record-0'])
    expect(requestedRecords(brief, 'Tell me its history.')).toEqual([])
    const instructions = narratorContext(
      { ...context(), brief },
      'Show its measurements.',
    )
    expect(instructions).toContain('"quantity":60268000')
    expect(instructions).not.toContain('COOKED')
    expect(instructions).not.toContain('https://')
  })

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
