import { describe, expect, it } from 'vitest'
import type { TourContext, TourFact } from '@inertialref/protocol'
import {
  narratorContext,
  NARRATOR_CONTEXT_MAX_BYTES,
} from './narratorContext.ts'

const measured = (speech: string): TourFact => ({
  id: speech,
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
  protocolVersion: 1,
  manifest: { seed: '1', catalogVersion: 'test', generation: { terrain: 1 } },
  viewRevision: 7,
  pictureTime: 123,
  subjectId: 'saturn',
  traveling: false,
  candidates: [],
  briefs: [],
  brief: {
    subjectId: 'saturn',
    address: 's:SOL/b:5',
    name: 'Saturn',
    provenance: 'observed',
    classification: 'gas giant',
    summary: 'Unselected summary must not be narrated.',
    facts,
    sources: [],
    observer: {
      pictureTime: 123,
      altitudeMeters: null,
      fill: 0.5,
      arrived: true,
    },
  },
})

describe('Live narration receives only the current verified view', () => {
  it('includes current subject, time, arrival and at most three complete evidence entries', () => {
    const facts = [
      measured('Saturn has rings.'),
      {
        ...measured('unused'),
        label: 'Core composition',
        speech: null,
        quantity: null,
        unit: null,
        display: null,
        provenance: 'unknown' as const,
        reason: 'No direct sample has measured the core.',
      },
      measured('Saturn has a recorded radius.'),
      measured('This fourth fact is outside the allowance.'),
    ]
    const instructions = narratorContext(context(facts))
    expect(instructions).toContain('Saturn')
    expect(instructions).toContain('Provenance: observed')
    expect(instructions).toContain('Picture time: 123')
    expect(instructions).toContain('Arrival: verified')
    expect(instructions).toContain(facts[0]!.speech)
    expect(instructions).toContain(
      'Unknown Core composition: No direct sample has measured the core.',
    )
    expect(instructions).toContain(facts[2]!.speech)
    expect(instructions).not.toContain(facts[3]!.speech)
    expect(instructions).not.toContain('application-record')
    expect(instructions).not.toContain('Unselected summary')
    expect(instructions).toContain('Use only these verified facts')
    expect(instructions).toContain('Delegate other factual requests')
    expect(instructions).toContain('Do not recite this context unsolicited')
  })

  it('never announces arrival during travel even when the brief reports an arrived observer', () => {
    const instructions = narratorContext({ ...context(), traveling: true })
    expect(instructions).toContain('Arrival: traveling')
    expect(instructions).not.toContain('Arrival: verified')
    expect(instructions).toContain('Do not announce arrival while traveling')
  })

  it('replaces the previous subject evidence and rejects a stale current brief', () => {
    const previous = context([measured('Saturn has rings.')])
    const current: TourContext = {
      ...previous,
      subjectId: 'titan',
      brief: {
        ...previous.brief!,
        subjectId: 'titan',
        name: 'Titan',
        provenance: 'projected',
        facts: [measured('Titan has an atmosphere.')],
      },
      briefs: [previous.brief!],
    }
    const instructions = narratorContext(current)
    expect(instructions).toContain('Titan has an atmosphere.')
    expect(instructions).toContain('Provenance: projected')
    expect(instructions).not.toContain('Saturn')
    const mismatched = narratorContext({ ...current, brief: previous.brief })
    expect(mismatched).not.toContain('Saturn')
    expect(mismatched).toContain('Arrival: unverified')
  })

  it('counts UTF-8 bytes and skips a whole oversized sentence while retaining later complete evidence', () => {
    const oversized = `${'遠'.repeat(400)}.`
    const complete = `${'🌌'.repeat(100)}.`
    const short = 'This complete fact still fits.'
    const instructions = narratorContext(
      context([measured(oversized), measured(complete), measured(short)]),
    )
    expect(instructions).not.toContain('遠')
    expect(instructions).toContain(complete)
    expect(instructions).toContain(short)
    expect(
      new TextEncoder().encode(instructions).byteLength,
    ).toBeLessThanOrEqual(NARRATOR_CONTEXT_MAX_BYTES)
    expect(instructions).not.toContain('\uFFFD')
    expect(instructions.endsWith('.')).toBe(true)
  })

  it('keeps its byte limit even when the subject name consumes the evidence budget', () => {
    const current = context([measured(`${'🌌'.repeat(300)}.`)])
    const instructions = narratorContext({
      ...current,
      brief: { ...current.brief!, name: '空'.repeat(160) },
    })
    expect(instructions).toContain('空'.repeat(160))
    expect(instructions).not.toContain('🌌')
    expect(
      new TextEncoder().encode(instructions).byteLength,
    ).toBeLessThanOrEqual(1500)
  })

  it('omits unfinished speech and completes a whole unknown reason without inventing a value', () => {
    const unknown: TourFact = {
      ...measured('unused'),
      label: 'Interior',
      speech: null,
      quantity: null,
      unit: null,
      display: null,
      provenance: 'unknown',
      reason: 'no sample has reached the interior',
    }
    const instructions = narratorContext(
      context([measured('A cut off claim that says'), unknown]),
    )
    expect(instructions).not.toContain('A cut off claim')
    expect(instructions).toContain(
      'Unknown Interior: no sample has reached the interior.',
    )
    expect(instructions).not.toContain('60,268')
  })
})
