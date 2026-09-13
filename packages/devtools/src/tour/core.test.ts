import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  decode,
  decodeTourContext,
  decodeTourClientMessage,
  decodeTourMessage,
  validateTourPlan,
} from '@inertialref/protocol'
import { openSession } from '../session.ts'
import { createTourContext, subjectBrief } from './brief.ts'
import { deterministicTour, groundedNarration } from './itinerary.ts'
import { TourRunner } from './runner.ts'

describe('the guide reads a bounded universe', () => {
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
  it('builds the Saturn, rings, Titan tour using only returned references', () => {
    const session = openSession()
    const context = createTourContext(session.harness, 'Saturn')
    const canonical = session.world.stateHash()
    const viewRevision = session.harness.observatory.mutationRevision
    const saturn = context.candidates.find(
      (subject) => subject.name === 'Saturn',
    )!
    const titan = context.candidates.find(
      (subject) => subject.name === 'Titan',
    )!
    const plan = deterministicTour(context, 'saturn')!
    expect(plan.stops).toHaveLength(3)
    expect(
      plan.stops.map(({ id, subjectId, framingId }) => ({
        id,
        subjectId,
        framingId,
      })),
    ).toEqual([
      { id: 'saturn-overview', subjectId: saturn.id, framingId: 'portrait' },
      {
        id: 'saturn-rings',
        subjectId: saturn.id,
        framingId: 'preset:the-rings',
      },
      { id: 'titan-weather', subjectId: titan.id, framingId: 'crescent' },
    ])
    expect(session.world.stateHash()).toBe(canonical)
    expect(session.harness.observatory.mutationRevision).toBe(viewRevision)
    expect(validateTourPlan(plan, context).ok).toBe(true)
    expect(
      context.candidates.find(
        (subject) => subject.id === plan.stops[2]!.subjectId,
      )?.name,
    ).toBe('Titan')
    expect(
      validateTourPlan(
        { ...plan, stops: [{ ...plan.stops[0]!, subjectId: 'invented' }] },
        context,
      ).ok,
    ).toBe(false)
    const narration = groundedNarration(
      context,
      {
        ...plan.stops[0]!,
        objective: 'An unverified teaching objective is never evidence.',
        factIds: [],
      },
      0,
      'narration',
    )
    expect(narration.text).not.toContain('unverified teaching objective')
    expect(narration.factIds).toEqual([])
    const system = deterministicTour(context, 'system')!
    expect(system.stops.map((stop) => stop.id)).toEqual(
      system.stops.map((_stop, index) => `stop-${index + 1}`),
    )
    session.dispose()
  })
  it('fits a focused Saturn context and its complete wire envelope', () => {
    const session = openSession()
    session.harness.look('s:SOL/b:5')
    const context = createTourContext(session.harness, 'Saturn')
    expect(new Set(context.briefs.map((brief) => brief.subjectId)).size).toBe(
      context.briefs.length,
    )
    expect(
      decodeTourMessage(
        decodeTourClientMessage,
        JSON.stringify({ type: 'context', context }),
      ).ok,
    ).toBe(true)
    expect(deterministicTour(context, 'saturn')?.stops).toHaveLength(3)
    session.dispose()
  })
})

describe('the guide runner waits for playback and the view independently', () => {
  it('does not infer playback completion from dwell or captions', () => {
    const session = openSession()
    const plan = deterministicTour(
      createTourContext(session.harness, 'Saturn'),
      'saturn',
    )!
    let now = 0
    const stops: string[] = []
    const runner = new TourRunner({
      now: () => now,
      automatic: true,
      onStop: (stop) => stops.push(stop.id),
    })
    runner.start(plan)
    const first = plan.stops[0]!
    runner.arrived(first.id, 5)
    now = 50000
    runner.tick()
    expect(stops).toHaveLength(1)
    runner.narrationEnded(first.id, 4)
    runner.tick()
    expect(stops).toHaveLength(1)
    runner.narrationEnded(first.id, 5)
    runner.tick()
    expect(stops).toHaveLength(2)
    runner.command('pause')
    runner.command('end')
    runner.command('resume')
    expect(runner.status().state).toBe('ended')
    session.dispose()
  })
  it('requires explicit Next when automatic playback is unavailable', () => {
    const session = openSession()
    const plan = deterministicTour(
      createTourContext(session.harness, 'Saturn'),
      'saturn',
    )!
    let now = 0
    const runner = new TourRunner({ now: () => now, onStop: () => {} })
    runner.start(plan)
    runner.arrived(plan.stops[0]!.id, 1)
    runner.narrationEnded(plan.stops[0]!.id, 1)
    now = 100000
    runner.tick()
    expect(runner.status().index).toBe(0)
    runner.command('next')
    expect(runner.status().index).toBe(1)
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
