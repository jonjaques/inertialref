import { describe, expect, it, vi } from 'vitest'
import type { TourContext } from '@inertialref/protocol'
import {
  interpretTourRequest,
  prepareNarration,
  validateDirectorDecision,
} from './director.ts'
import { withAstronomyNotes } from './knowledge/astronomy.ts'

const context: TourContext = {
  protocolVersion: 1,
  manifest: {
    seed: 'seed',
    catalogVersion: 'catalog',
    generation: { system: 1 },
  },
  viewRevision: 2,
  pictureTime: 15,
  subjectId: 'saturn',
  traveling: false,
  candidates: [
    {
      id: 'saturn',
      address: 'saturn-address',
      name: 'Saturn',
      provenance: 'observed',
      kind: 'gas-giant',
      parentId: null,
      framings: ['rings'],
      sites: [],
      factIds: ['radius'],
    },
  ],
  brief: null,
  briefs: [
    {
      subjectId: 'saturn',
      address: 'saturn-address',
      name: 'Saturn',
      provenance: 'observed',
      classification: 'gas giant',
      summary: '',
      facts: [
        {
          id: 'radius',
          label: 'Radius',
          quantity: 10,
          unit: 'm',
          display: '10 meters',
          speech: 'Saturn has a test radius of ten meters.',
          reason: null,
          provenance: 'observed',
          sourceIds: ['app'],
        },
      ],
      sources: [
        {
          id: 'app',
          title: 'Application record',
          url: null,
          origin: 'application',
        },
      ],
      observer: {
        pictureTime: 15,
        altitudeMeters: null,
        fill: null,
        arrived: true,
      },
    },
  ],
}

const explanation = {
  kind: 'explanation',
  text: '',
  factIds: ['radius'],
  plan: null,
  actions: [],
}

describe('grounded director', () => {
  it('builds narration only from selected facts, never an unsupported exact model claim', () => {
    expect(validateDirectorDecision(explanation, context)).toMatchObject({
      text: 'Saturn has a test radius of ten meters.',
    })
    expect(() =>
      validateDirectorDecision(
        { ...explanation, text: 'Saturn is 999 kilometers wide.' },
        context,
      ),
    ).toThrow()
    expect(() =>
      validateDirectorDecision(
        { ...explanation, factIds: ['invented'] },
        context,
      ),
    ).toThrow()
    expect(prepareNarration(context, ['radius'])).toEqual({
      text: 'Saturn has a test radius of ten meters.',
      factIds: ['radius'],
      sourceIds: ['app'],
    })
  })

  it('rejects an unavailable subject, gas landing, unknown framing, and extra output fields', () => {
    const decision = {
      kind: 'actions',
      text: '',
      factIds: [],
      plan: null,
      actions: [],
    }
    for (const action of [
      { tool: 'show_subject', subjectId: 'invented' },
      { tool: 'stand_at_site', subjectId: 'saturn', siteId: 'surface' },
      { tool: 'compose_view', subjectId: 'saturn', framingId: 'javascript' },
    ])
      expect(() =>
        validateDirectorDecision({ ...decision, actions: [action] }, context),
      ).toThrow()
    expect(() =>
      validateDirectorDecision(
        { ...explanation, javascript: 'window.ir.world' },
        context,
      ),
    ).toThrow()
  })

  it('rejects plans with invented facts and normalizes stop objectives to registered subjects', () => {
    const plan = {
      id: 'tour',
      goal: 'rings',
      durationSeconds: 30,
      stops: [
        {
          id: 'stop',
          subjectId: 'saturn',
          framingId: 'rings',
          siteId: null,
          objective: 'Saturn is secretly made of cheese',
          factIds: ['radius'],
          minimumViewSeconds: 15,
        },
      ],
    }
    expect(
      validateDirectorDecision(
        { kind: 'plan', text: '', factIds: [], plan, actions: [] },
        context,
      ).plan?.stops[0]?.objective,
    ).toBe('Explore Saturn')
    expect(() =>
      validateDirectorDecision(
        {
          kind: 'plan',
          text: '',
          factIds: [],
          plan: { ...plan, stops: [{ ...plan.stops[0], factIds: ['false'] }] },
          actions: [],
        },
        context,
      ),
    ).toThrow()
  })

  it('adds cited historical facts only to observed subjects', () => {
    const observed = withAstronomyNotes(context)
    expect(
      observed.briefs[0]?.facts.some((fact) =>
        fact.id.endsWith('note:saturn-rings'),
      ),
    ).toBe(true)
    const projected = withAstronomyNotes({
      ...context,
      briefs: context.briefs.map((brief) => ({
        ...brief,
        provenance: 'projected',
      })),
    })
    expect(projected.briefs[0]?.facts).toEqual(context.briefs[0]?.facts)
  })

  it('holds current-news and ambiguous position requests without provider spending', async () => {
    const fetcher = vi.fn()
    const options = {
      apiKey: 'secret',
      context,
      fetch: fetcher as typeof fetch,
    }
    expect(
      await interpretTourRequest({
        ...options,
        text: 'What is the latest mission news?',
      }),
    ).toMatchObject({ kind: 'clarification', actions: [] })
    expect(
      await interpretTourRequest({
        ...options,
        text: 'Show me the one on the left',
      }),
    ).toMatchObject({ kind: 'clarification', actions: [] })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('lets Astra order a themed tour and carries a corrected goal explicitly', async () => {
    const response = { ...explanation, factIds: ['saturn:note:saturn-rings'] }
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(response) },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 2 },
        }),
    )
    const result = await interpretTourRequest({
      apiKey: 'secret',
      context: withAstronomyNotes(context),
      text: 'Actually focus on how rings form',
      priorGoal: 'Tour Saturn',
      fetch: fetcher as typeof fetch,
    })
    expect(result.kind).toBe('explanation')
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(JSON.parse(body.input)).toMatchObject({
      request: 'Actually focus on how rings form',
      priorGoal: 'Tour Saturn',
    })
  })
})
