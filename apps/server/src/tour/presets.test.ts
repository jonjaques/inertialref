import { describe, expect, it } from 'vitest'
import { openSession } from '../../../../packages/devtools/src/session.ts'
import { createTourContext } from '../../../../packages/devtools/src/tour/brief.ts'
import { validateTourPlan, type TourContext } from '@inertialref/protocol'
import solar from '../../../../design/narration/solar-system-tour.json'
import saturn from '../../../../design/narration/saturn-tour.json'
import demo from '../../../../design/narration/developer-demo.json'
import { authoredTour } from './presets.ts'

const solarRequest =
  'Hi, sitting with my grandparents, can you give us a 5 minute tour of the Solar system?'
const demoRequest =
  'Hi, I’m the developer. Can you give me a quick demo of all your capabilities?'

describe('authored tours use the supplied observed Solar System', () => {
  it('builds the grandparents’ complete five-minute Solar System visit in a real session', () => {
    const session = openSession()
    const context = createTourContext(session.harness)
    const hash = session.world.stateHash()
    const revision = session.harness.observatory.mutationRevision
    const plan = authoredTour(solarRequest, context)!
    expect(plan).not.toBeNull()
    expect(plan.stops).toHaveLength(8)
    expect(
      plan.stops.map(
        (stop) =>
          context.candidates.find(
            (candidate) => candidate.id === stop.subjectId,
          )?.name,
      ),
    ).toEqual([
      'Sol',
      'Venus',
      'Luna',
      'Mars',
      'Jupiter',
      'Saturn',
      'Neptune',
      'Earth',
    ])
    expect(plan.stops[0]?.narration).toBe(
      `${solar.introduction} ${solar.stops[0]!.narration}`,
    )
    expect(plan.stops.at(-1)?.narration).toBe(
      `${solar.stops.at(-1)!.narration} ${solar.closing}`,
    )
    expect(plan.durationSeconds).toBeGreaterThanOrEqual(295)
    expect(plan.durationSeconds).toBeLessThanOrEqual(305)
    const speechSeconds = plan.stops.reduce(
      (sum, stop) => sum + stop.narration!.split(/\s+/).length / 2.5,
      0,
    )
    const quietSeconds = plan.stops.reduce(
      (sum, stop) => sum + stop.lookSeconds!,
      0,
    )
    expect(speechSeconds + quietSeconds + plan.stops.length * 4).toBeCloseTo(
      plan.durationSeconds,
      0,
    )
    expect(
      plan.stops.every(
        (stop) => stop.minimumViewSeconds === 2 && stop.lookSeconds! > 0,
      ),
    ).toBe(true)
    expect(
      plan.stops.every((stop) =>
        stop.sources!.every(
          (source) =>
            source.origin === 'curated' && source.url?.startsWith('https://'),
        ),
      ),
    ).toBe(true)
    expect(validateTourPlan(plan, context).ok).toBe(true)
    expect(session.world.stateHash()).toBe(hash)
    expect(session.harness.observatory.mutationRevision).toBe(revision)
    session.dispose()
  })

  it('builds the developer’s capability demonstration with a returned lunar site', () => {
    const session = openSession()
    const context = createTourContext(session.harness)
    const plan = authoredTour(demoRequest, context)!
    expect(plan).not.toBeNull()
    expect(plan.stops).toHaveLength(3)
    expect(new Set(plan.stops.map((stop) => stop.motion)).size).toBe(3)
    expect(new Set(plan.stops.map((stop) => stop.framingId)).size).toBe(3)
    expect(
      plan.stops.map(
        (stop) =>
          context.candidates.find(
            (candidate) => candidate.id === stop.subjectId,
          )?.name,
      ),
    ).toEqual(['Saturn', 'Titan', 'Luna'])
    expect(plan.stops[0]?.narration).toContain(demo.stops[0]!.narration)
    expect(plan.stops[2]?.siteId).toBe(
      context.candidates.find((candidate) => candidate.name === 'Luna')!
        .sites[0]?.id,
    )
    expect(plan.stops[2]?.motion).toBe('hold')
    expect(plan.durationSeconds).toBeGreaterThanOrEqual(100)
    expect(plan.durationSeconds).toBeLessThanOrEqual(120)
    expect(validateTourPlan(plan, context).ok).toBe(true)
    session.dispose()
  })

  it('falls back to a returned lunar composition when no standing site is supplied', () => {
    const session = openSession()
    const original = createTourContext(session.harness)
    const context = {
      ...original,
      candidates: original.candidates.map((candidate) => ({
        ...candidate,
        sites: [],
      })),
    }
    const plan = authoredTour(demoRequest, context)!
    expect(plan.stops[2]?.siteId).toBeNull()
    expect(plan.stops[2]?.framingId).toBe('wide')
    expect(validateTourPlan(plan, context).ok).toBe(true)
    session.dispose()
  })

  it('keeps all four Saturn stories with returned compositions and stable curated sources', () => {
    const session = openSession()
    session.harness.look('s:SOL/b:5', { ease: false })
    const context = createTourContext(session.harness, 'Saturn')
    const plan = authoredTour('Please give us a tour of Saturn.', context)!
    expect(plan).not.toBeNull()
    expect(plan.stops).toHaveLength(4)
    expect(plan.stops.map((stop) => stop.id)).toEqual(
      saturn.stops.map((stop) => stop.id),
    )
    expect(plan.stops[0]?.framingId).not.toBe(plan.stops[1]?.framingId)
    expect(plan.stops[1]?.narration).toBe(saturn.stops[1]!.narration)
    const solarPlan = authoredTour(solarRequest, context)!
    expect(plan.stops[1]?.sources?.[0]?.id).toBe(
      solarPlan.stops[5]?.sources?.[0]?.id,
    )
    expect(validateTourPlan(plan, context).ok).toBe(true)
    session.dispose()
  })

  it('leaves conversational edits and unsupported requests to the director', () => {
    const session = openSession()
    const context = createTourContext(session.harness)
    for (const request of [
      'Add Mars to our Solar system tour.',
      'Skip Venus on the Solar System tour.',
      'Reorder our tour of Saturn.',
      'Give me a tour of Saturn instead of the Solar System.',
      'Tell me about Saturn.',
      'Do not give me a tour of Saturn.',
      'Give me a tour of the Solar System with only the gas giants.',
    ])
      expect(authoredTour(request, context)).toBeNull()
    session.dispose()
  })

  it('rejects missing, projected, renamed, or mismatched Solar identities', () => {
    const session = openSession()
    const context = createTourContext(session.harness)
    const original = context.candidates.find(
      (candidate) => candidate.name === 'Saturn',
    )!
    const changed = (patch: Partial<typeof original>): TourContext => ({
      ...context,
      candidates: context.candidates.map((candidate) =>
        candidate.id === original.id ? { ...candidate, ...patch } : candidate,
      ),
    })
    expect(
      authoredTour('A tour of Saturn', {
        ...context,
        candidates: context.candidates.filter(
          (candidate) => candidate.id !== original.id,
        ),
      }),
    ).toBeNull()
    expect(
      authoredTour('A tour of Saturn', changed({ provenance: 'projected' })),
    ).toBeNull()
    expect(
      authoredTour(
        'A tour of Saturn',
        changed({ address: 'g:milky-way/s:SOL/b:2' }),
      ),
    ).toBeNull()
    expect(
      authoredTour(
        'A tour of Saturn',
        changed({ address: 'g:milky-way/s:HIP71683/b:5' }),
      ),
    ).toBeNull()
    expect(
      authoredTour('A tour of Saturn', changed({ id: 'not-a-returned-brief' })),
    ).toBeNull()
    session.dispose()
  })
})
