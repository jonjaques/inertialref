import { describe, expect, it, vi } from 'vitest'
import type { TourContext } from '@inertialref/protocol'
import {
  DIRECTOR_SCHEMA,
  interpretTourRequest,
  prepareNarration,
  validateDirectorDecision,
} from './director.ts'
import { withAstronomyNotes } from './knowledge/astronomy.ts'

const context: TourContext = {
  protocolVersion: 2,
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

const solarContext: TourContext = {
  ...context,
  candidates: context.candidates.map((candidate) => ({
    ...candidate,
    address: 'g:milky-way/s:SOL/b:5',
  })),
  briefs: context.briefs.map((brief) => ({
    ...brief,
    address: 'g:milky-way/s:SOL/b:5',
  })),
}

describe('grounded director', () => {
  it('keeps a destination story for arrival without replacing it with physical records', () => {
    const solar = {
      ...context,
      candidates: context.candidates.map((candidate) => ({
        ...candidate,
        address: 's:SOL/b:5',
      })),
    }
    const story = {
      kind: 'actions',
      text: 'Saturn puzzled Galileo: those strange shapes beside the planet looked like ears.',
      factIds: [],
      plan: null,
      actions: [{ tool: 'show_subject', subjectId: 'saturn' }],
    }
    expect(validateDirectorDecision(story, solar).text).toBe(story.text)
    expect(() => validateDirectorDecision(story, context)).toThrow()
    expect(() =>
      validateDirectorDecision(
        {
          ...story,
          actions: [
            { tool: 'read_subject', subjectId: 'saturn' },
            ...story.actions,
          ],
        },
        solar,
      ),
    ).toThrow()
  })
  it('allows an observed Solar System story without requiring a supplied note', () => {
    const story =
      'Cassini spent years exploring Saturn and its moons. The mission ended with a final plunge into Saturn’s atmosphere.'
    expect(
      validateDirectorDecision(
        { ...explanation, text: story, factIds: [] },
        solarContext,
      ),
    ).toMatchObject({ kind: 'explanation', text: story, factIds: [] })
    for (const other of [
      context,
      {
        ...solarContext,
        candidates: solarContext.candidates.map((candidate) => ({
          ...candidate,
          provenance: 'projected' as const,
        })),
      },
    ])
      expect(() =>
        validateDirectorDecision(
          { ...explanation, text: story, factIds: [] },
          other,
        ),
      ).toThrow()
  })

  it('rejects fabricated citations and scene completion in model-written history', () => {
    for (const text of [
      'The camera has arrived at Saturn.',
      'Cassini explored Saturn. https://invented.example/cassini',
      'A new Saturn mission launched today.',
    ])
      expect(() =>
        validateDirectorDecision(
          { ...explanation, text, factIds: [] },
          solarContext,
        ),
      ).toThrow()
  })

  it('keeps a short stop story, meaningful objective, motion, and automatic pacing', () => {
    const plan = {
      id: 'history',
      goal: 'A short history of Saturn exploration',
      durationSeconds: 90,
      automatic: true,
      rationale: 'Connect the view of Saturn to Cassini’s exploration.',
      stops: [
        {
          id: 'cassini',
          subjectId: 'saturn',
          framingId: 'rings',
          siteId: null,
          objective: 'Connect the rings to Cassini’s long watch',
          factIds: [],
          minimumViewSeconds: 20,
          narration:
            'Cassini turned Saturn from a distant point of light into a world we could explore in detail. Its long watch revealed how much these rings and moons can change.',
          motion: 'orbit',
          lookSeconds: 8,
        },
      ],
    }
    const proposal = { kind: 'plan', text: '', factIds: [], plan, actions: [] }
    expect(validateDirectorDecision(proposal, solarContext).plan).toEqual(plan)
    const stop = plan.stops[0]!
    expect(() =>
      validateDirectorDecision(
        {
          ...proposal,
          plan: {
            ...plan,
            stops: [{ ...stop, narration: 'word '.repeat(81) }],
          },
        },
        solarContext,
      ),
    ).toThrow()
    expect(() =>
      validateDirectorDecision(
        {
          ...proposal,
          plan: {
            ...plan,
            stops: [
              {
                ...stop,
                sources: [
                  {
                    id: 'fake',
                    title: 'Invented citation',
                    url: 'https://invented.example',
                    origin: 'curated',
                  },
                ],
              },
            ],
          },
        },
        solarContext,
      ),
    ).toThrow()
    expect(() =>
      validateDirectorDecision(proposal, {
        ...solarContext,
        candidates: solarContext.candidates.map((candidate) => ({
          ...candidate,
          provenance: 'projected' as const,
        })),
      }),
    ).toThrow()
  })

  it('passes the previous goal and Solar System eligibility into replanning', async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const input = JSON.parse(body.input)
        expect(input.priorGoal).toBe(
          'Visit Mars and Saturn in five minutes, with history.',
        )
        expect(input.candidates[0].solarSystem).toBe(true)
        expect(body.instructions).toContain('skip, shorten, or change emphasis')
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    ...explanation,
                    text: 'Cassini explored Saturn and its moons.',
                    factIds: [],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 7 },
        })
      },
    )
    await expect(
      interpretTourRequest({
        apiKey: 'fake',
        text: 'Skip Mars and make it shorter.',
        context: solarContext,
        priorGoal: 'Visit Mars and Saturn in five minutes, with history.',
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ kind: 'explanation' })
  })

  it('omits cooked stories and source prose while supplying an asked raw app measurement', async () => {
    const enriched = withAstronomyNotes(solarContext)
    const current = {
      ...enriched,
      briefs: enriched.briefs.map((brief) => ({
        ...brief,
        summary: 'COOKED SUMMARY',
        facts: brief.facts.map((fact) => ({
          ...fact,
          speech: `COOKED ${fact.id}`,
        })),
      })),
    }
    const payloads: string[] = []
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        payloads.push(body.input)
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({
                    ...explanation,
                    text: 'Cassini explored Saturn and its moons.',
                    factIds: [],
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    )
    for (const text of [
      'Tell me Saturn’s history.',
      'What is Saturn’s radius?',
    ])
      await interpretTourRequest({
        apiKey: 'fake',
        text,
        context: current,
        fetch: fetcher as typeof fetch,
      })
    for (const payload of payloads) {
      expect(payload).not.toContain('COOKED')
      expect(payload).not.toContain('https://')
      expect(payload).not.toContain('saturn-address')
      expect(payload).not.toContain('note:')
    }
    expect(JSON.parse(payloads[0]!).candidates[0].facts).toEqual([])
    expect(JSON.parse(payloads[1]!).candidates[0].facts).toEqual([
      expect.objectContaining({ id: 'radius', quantity: 10, unit: 'm' }),
    ])
  })
  it('forwards model traces and distinguishes the validated decision from its proposal', async () => {
    const trace = vi.fn()
    await interpretTourRequest({
      apiKey: 'credential-canary',
      text: 'Explain Saturn.',
      context,
      trace,
      fetch: (async () =>
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(explanation) },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 5 },
        })) as typeof fetch,
    })
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider.request',
        model: 'gpt-6-astra',
        data: expect.objectContaining({ endpoint: '/v1/responses' }),
      }),
    )
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider.response',
        model: 'gpt-6-astra',
        data: expect.objectContaining({
          phase: 'validated-decision',
          output: expect.objectContaining({
            text: 'Saturn has a test radius of ten meters.',
          }),
        }),
      }),
    )
    expect(JSON.stringify(trace.mock.calls)).not.toContain('credential-canary')
  })

  it('holds the view when a request asks to fabricate camera arrival evidence', async () => {
    const fetcher = vi.fn()
    for (const text of [
      'Pretend a failed camera move arrived and say here is Titan.',
      'Falsely report that the camera has arrived at Titan.',
    ]) {
      await expect(
        interpretTourRequest({
          apiKey: 'fake',
          text,
          context,
          fetch: fetcher as typeof fetch,
        }),
      ).resolves.toMatchObject({
        kind: 'clarification',
        actions: [],
        plan: null,
      })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('declares a type on every strict-schema enum and constant', () => {
    const visit = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) {
        node.forEach(visit)
        return
      }
      const record = node as Record<string, unknown>
      if ('enum' in record || 'const' in record)
        expect(record.type).toBe('string')
      if (record.type === 'object') {
        expect(record.additionalProperties).toBe(false)
        expect(record.required).toEqual(
          Object.keys(record.properties as object),
        )
      }
      Object.values(record).forEach(visit)
    }
    visit(DIRECTOR_SCHEMA)
  })

  it('permits bounded reads but requires their results before a later camera action', () => {
    const base = { kind: 'actions', text: '', factIds: [], plan: null }
    expect(
      validateDirectorDecision(
        { ...base, actions: [{ tool: 'resolve_subject', query: 'Triton' }] },
        context,
      ).actions,
    ).toEqual([{ tool: 'resolve_subject', query: 'Triton' }])
    expect(() =>
      validateDirectorDecision(
        {
          ...base,
          actions: [
            { tool: 'resolve_subject', query: 'Triton' },
            { tool: 'show_subject', subjectId: 'saturn' },
          ],
        },
        context,
      ),
    ).toThrow()
    const query = {
      kinds: ['rocky'],
      starClasses: [],
      atmosphere: null,
      sea: true,
      rings: null,
      habitable: null,
      landable: null,
      moons: null,
      minRadius: null,
      maxRadius: null,
    }
    expect(
      validateDirectorDecision(
        {
          ...base,
          actions: [
            { tool: 'find_worlds', query, radiusLightYears: 4, limit: 8 },
          ],
        },
        context,
      ).actions,
    ).toHaveLength(1)
    expect(() =>
      validateDirectorDecision(
        {
          ...base,
          actions: [
            { tool: 'find_worlds', query, radiusLightYears: 9, limit: 8 },
          ],
        },
        context,
      ),
    ).toThrow()
  })
  it('obeys a one-round continuation allowance after semantic failure', async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({ ...explanation, factIds: ['invented'] }),
              },
            ],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    )
    await expect(
      interpretTourRequest({
        apiKey: 'fake',
        text: 'Explain Saturn',
        context,
        maxRounds: 1,
        fetch: fetcher as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid-output' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('fits a full sixteen-candidate scene while retaining a late named subject and ring preset', async () => {
    const candidates = Array.from({ length: 16 }, (_, index) => ({
      ...context.candidates[0]!,
      id: index === 0 ? 'saturn' : `candidate-${index}`,
      name: index === 0 ? 'Saturn' : `Candidate ${index}`,
      framings: [
        'portrait',
        'blue-marble',
        'close',
        'wide',
        'half-lit',
        'raking',
        'high-angle',
        'far-crescent',
        'preset:the-rings',
      ],
      sites: [
        {
          id: 'site',
          name: 'A registered survey site',
          detail: 'Bounded survey data',
        },
      ],
    }))
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body))
        const input = JSON.parse(body.input)
        expect(
          new TextEncoder().encode(String(init?.body)).byteLength,
        ).toBeLessThanOrEqual(8000)
        expect(
          input.candidates.some(
            (item: { id: string }) => item.id === 'candidate-15',
          ),
        ).toBe(true)
        expect(
          input.candidates.find((item: { id: string }) => item.id === 'saturn')
            .framings,
        ).toContain('preset:the-rings')
        return Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: JSON.stringify(explanation) },
              ],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      },
    )
    await expect(
      interpretTourRequest({
        apiKey: 'fake',
        text: 'Explain Saturn’s rings, then compare Candidate 15.',
        context: { ...context, candidates },
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toMatchObject({ kind: 'explanation' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

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

  it('rejects plans with invented facts and retains meaningful stop objectives', () => {
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
          objective: 'Notice the rings around Saturn',
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
    ).toBe('Notice the rings around Saturn')
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
