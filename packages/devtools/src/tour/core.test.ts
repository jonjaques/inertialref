import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  decode,
  decodeTourContext,
  withinTourBytes,
} from '@inertialref/protocol'
import { openSession } from '../session.ts'
import { subjectBrief } from './brief.ts'
import { createTourContext } from './inventory.ts'
import { withNotes } from './notes.ts'

describe('the guide reads a bounded universe', () => {
  it('keeps a full newest read while bounding a large retained search inventory', () => {
    const session = openSession()
    const addresses = [
      ...new Set(session.harness.searchEntries().map((item) => item.address)),
    ].slice(0, 16)
    const context = createTourContext(session.harness, '', addresses)
    expect(withinTourBytes(context).ok).toBe(true)
    const newest = context.briefs.find(
      (brief) => brief.address === addresses[0],
    )!
    expect(newest.facts).toEqual(
      subjectBrief(session.harness, addresses[0]!)?.facts,
    )
    expect(context.candidates).toHaveLength(16)
    session.dispose()
  })
  it('keeps authored Solar subjects in the bounded inventory and full explicit records', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.focus('s:SOL/b:5', { ease: false })
    const context = createTourContext(session.harness, 'Neptune')
    expect(context.candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining([
        'Sol',
        'Venus',
        'Luna',
        'Mars',
        'Jupiter',
        'Saturn',
        'Neptune',
        'Earth',
        'Titan',
        'Enceladus',
      ]),
    )
    for (const name of ['Saturn', 'Neptune']) {
      const candidate = context.candidates.find((item) => item.name === name)!
      expect(
        context.briefs.find((brief) => brief.subjectId === candidate.id)?.facts,
      ).toEqual(subjectBrief(session.harness, candidate.address)?.facts)
    }
    expect(withinTourBytes(context).ok).toBe(true)
    session.dispose()
  })
  it('provides numeric quantities, unknown reasons, and separate observer facts', () => {
    const session = openSession()
    const ir = session.harness
    ir.look('s:SOL/b:5', { ease: false })
    ir.observatory.setTime(12345)
    const brief = subjectBrief(ir, ir.observatory.target!.address)!
    expect(
      brief.facts.find((fact) => fact.id.endsWith('.radius'))?.quantity,
    ).toBeGreaterThan(60_000_000)
    expect(
      brief.facts.some((fact) => fact.display === null && fact.reason !== null),
    ).toBe(true)
    expect(brief.observer.pictureTime).toBe(12345)
    expect(brief.facts.every((fact) => !fact.label.includes('Altitude'))).toBe(
      true,
    )
    expect(decode(decodeTourContext, createTourContext(ir)).ok).toBe(true)
    session.dispose()
  })
  it('adds curated notes to an observed record and never to a projected one', () => {
    const session = openSession()
    const ir = session.harness
    const saturn = withNotes(subjectBrief(ir, 's:SOL/b:5')!)
    expect(saturn.facts.some((fact) => fact.id.includes(':note:'))).toBe(true)
    expect(saturn.sources.some((source) => source.origin === 'curated')).toBe(
      true,
    )
    expect(withinTourBytes(saturn).ok).toBe(true)
    const projected = withNotes({
      ...subjectBrief(ir, 's:SOL/b:5')!,
      provenance: 'projected',
    })
    expect(projected.facts.some((fact) => fact.id.includes(':note:'))).toBe(
      false,
    )
    session.dispose()
  })
  it('fits a focused Saturn context inside the record bound', () => {
    const session = openSession()
    session.harness.look('s:SOL/b:5')
    const context = createTourContext(session.harness, 'Saturn')
    expect(new Set(context.briefs.map((brief) => brief.subjectId)).size).toBe(
      context.briefs.length,
    )
    expect(withinTourBytes(context).ok).toBe(true)
    session.dispose()
  })
})

describe('the observatory revokes pending guide movement', () => {
  it('holds exactly the current pose and does not count ease as manual input', () => {
    const session = openSession()
    const eye = session.harness.observatory
    eye.focus('s:SOL/b:5', { ease: false })
    eye.compose('wide')
    const revision = eye.mutationRevision
    eye.sample(0.1)
    expect(eye.mutationRevision).toBe(revision)
    const pose = eye.pose()
    eye.hold()
    expect(eye.mutationRevision).toBeGreaterThan(revision)
    for (let frame = 0; frame < 120; frame += 1) eye.sample(1 / 60)
    expect(eye.pose()).toEqual(pose)
    expect(eye.status().traveling).toBe(false)
    session.dispose()
  })
  it('preserves equal canonical inputs in paused and running worlds', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.boolean(),
        (frames, paused) => {
          const guide = openSession()
          const control = openSession()
          guide.world.clock.setPaused(paused)
          control.world.clock.setPaused(paused)
          const eye = guide.harness.observatory
          eye.focus('s:SOL/b:5')
          eye.setTime(eye.time)
          eye.setTimeScale(100)
          eye.setTimePaused(false)
          for (let frame = 0; frame < frames; frame += 1) {
            guide.world.advance(1 / 60)
            control.world.advance(1 / 60)
            eye.advanceTime(1 / 60)
            eye.sample(1 / 60)
          }
          eye.hold()
          expect(guide.world.stateHash()).toBe(control.world.stateHash())
          guide.dispose()
          control.dispose()
        },
      ),
      { numRuns: 10 },
    )
  })
})
