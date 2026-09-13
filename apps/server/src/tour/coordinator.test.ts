import { describe, expect, it } from 'vitest'
import type {
  NarrationBrief,
  SubjectBrief,
  ToolRequest,
  TourAction,
  TourContext,
  TourPlan,
  TourServerMessage,
  TourWorldQuery,
} from '@inertialref/protocol'
import {
  TourCoordinator,
  newSessionRecord,
  type DirectorDecision,
  type CoordinatorPorts,
} from './coordinator.ts'
import { withAstronomyNotes } from './knowledge/astronomy.ts'

const context = (viewRevision = 0): TourContext => ({
  protocolVersion: 2,
  manifest: { seed: '1', catalogVersion: 'test', generation: { terrain: 1 } },
  viewRevision,
  pictureTime: 123,
  subjectId: 'saturn',
  traveling: false,
  candidates: [
    {
      id: 'saturn',
      address: 'b:allowed',
      name: 'Saturn',
      provenance: 'observed',
      kind: 'gas-giant',
      parentId: null,
      framings: ['overview'],
      sites: [],
      factIds: ['radius'],
    },
  ],
  brief: {
    subjectId: 'saturn',
    address: 'b:allowed',
    name: 'Saturn',
    provenance: 'observed',
    classification: 'gas giant',
    summary: 'Saturn',
    facts: [
      {
        id: 'radius',
        label: 'Radius',
        quantity: 58232000,
        unit: 'm',
        display: '58,232 km',
        speech: 'Its mean radius is 58,232 kilometers.',
        reason: null,
        provenance: 'observed',
        sourceIds: ['record'],
      },
    ],
    sources: [
      {
        id: 'record',
        title: 'Application record',
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
  briefs: [],
})

function setup(
  director: (
    text: string,
    context: TourContext,
    signal: AbortSignal,
    maxRounds: 1 | 2,
    priorGoal?: string,
  ) => Promise<DirectorDecision>,
  initial = context(),
  options: Partial<Pick<CoordinatorPorts, 'preset' | 'persist'>> = {},
) {
  const messages: TourServerMessage[] = []
  const saved: unknown[] = []
  const spoken: { brief: NarrationBrief; delegationId: string | null }[] = []
  const record = newSessionRecord({
    sessionId: 's1',
    user: 'alpha',
    tabId: 'tab',
    now: 100,
    transport: 'text',
    manifest: context().manifest,
    fingerprint: 'fp',
  })
  const coordinator = new TourCoordinator(record, initial, {
    now: () => 101,
    id: (() => {
      let id = 0
      return () => `op-${++id}`
    })(),
    send: (message) => messages.push(message),
    persist: async (value) => {
      saved.push(structuredClone(value))
    },
    director,
    narrate: async (brief, delegationId) => {
      spoken.push({ brief, delegationId })
    },
    close: async () => {},
    ...options,
  })
  return { coordinator, messages, saved, spoken }
}

describe('tour coordinator ordering', () => {
  it('returns a spoken clarification to the delegation that needs it', async () => {
    const { coordinator, spoken } = setup(async () => ({
      kind: 'clarification',
      text: 'Which object do you mean?',
      factIds: [],
      plan: null,
      actions: [],
    }))
    await coordinator.delegate('delegation-1', 'Show that object')
    expect(spoken).toHaveLength(1)
    expect(spoken[0]).toMatchObject({
      delegationId: 'delegation-1',
      brief: { text: 'Which object do you mean?', factIds: [], sources: [] },
    })
  })
  it('settles confirmed Live time once using cumulative provider usage', async () => {
    const messages: TourServerMessage[] = []
    const initial = newSessionRecord({
      sessionId: 'live',
      user: 'alpha',
      tabId: 'tab',
      now: 100,
      transport: 'live',
      manifest: context().manifest,
      fingerprint: 'fp',
    })
    const coordinator = new TourCoordinator(initial, context(), {
      now: () => 101,
      id: () => 'id',
      send: (event) => messages.push(event),
      persist: async () => {},
      director: async () => {
        throw new Error('unused')
      },
      narrate: async () => {},
      close: async () => {},
    })
    await coordinator.usage(60)
    await coordinator.usage(30)
    await coordinator.finalized(true, 60)
    await coordinator.finalized(true, 60)
    expect(coordinator.record.liveSeconds).toBe(60)
    expect(coordinator.record.budget).toMatchObject({
      spent: 50_000,
      reserved: 0,
    })
  })
  it('discards a slow director result after an explicit stop even when abort is ignored', async () => {
    let resolve!: (value: DirectorDecision) => void
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const { coordinator, messages } = setup(
      () =>
        new Promise((done) => {
          resolve = done
          markStarted()
        }),
    )
    const pending = coordinator.receive({
      type: 'ask',
      text: 'Show Saturn',
      requestRevision: 1,
      viewRevision: 0,
    })
    await started
    await coordinator.receive({
      type: 'command',
      command: 'pause',
      requestRevision: 2,
      viewRevision: 0,
    })
    resolve({
      kind: 'actions',
      text: '',
      factIds: [],
      plan: null,
      actions: [{ tool: 'show_subject', subjectId: 'saturn' }],
    })
    await pending
    expect(
      messages.filter(
        (message) => message.type === 'tool' || message.type === 'narration',
      ),
    ).toEqual([])
  })

  it('deduplicates requests and accepts no model invented addresses', async () => {
    let calls = 0
    const { coordinator, messages } = setup(async () => {
      calls++
      return {
        kind: 'actions',
        text: '',
        factIds: [],
        plan: null,
        actions: [{ tool: 'show_subject', subjectId: 'invented' }],
      }
    })
    await coordinator.receive({
      type: 'ask',
      text: 'Go',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'ask',
      text: 'Go',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(calls).toBe(1)
    expect(messages.some((message) => message.type === 'tool')).toBe(false)
  })

  it('requires actual matching arrival before narration and rejects repeated speech generation', async () => {
    const { coordinator, messages } = setup(async () => ({
      kind: 'explanation',
      text: '',
      factIds: ['radius'],
      plan: null,
      actions: [],
    }))
    await coordinator.receive({
      type: 'context',
      context: { ...context(1), traveling: true },
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'stop',
      requestRevision: 0,
      viewRevision: 1,
    })
    expect(messages.some((message) => message.type === 'narration')).toBe(false)
    await coordinator.receive({ type: 'context', context: context(2) })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'stop',
      requestRevision: 0,
      viewRevision: 2,
    })
    const narration = messages.find((message) => message.type === 'narration')
    expect(narration?.type).toBe('narration')
    if (narration?.type !== 'narration') throw new Error('No narration')
    expect(narration.brief.text).toContain('58,232 kilometers')
    expect(await coordinator.reserveSpeech(narration.brief.id)).not.toBeNull()
    expect(await coordinator.reserveSpeech(narration.brief.id)).toBeNull()
  })

  it('rejects stale contexts and incompatible universe manifests', async () => {
    const { coordinator } = setup(async () => {
      throw new Error('should not call')
    })
    await coordinator.receive({ type: 'context', context: context(2) })
    await coordinator.receive({ type: 'context', context: context(1) })
    expect(coordinator.context?.viewRevision).toBe(2)
    await coordinator.receive({
      type: 'context',
      context: {
        ...context(3),
        manifest: { ...context().manifest, seed: 'different' },
      },
    })
    expect(coordinator.context?.viewRevision).toBe(2)
  })
})

const worldQuery: TourWorldQuery = {
  kinds: ['moon'],
  starClasses: [],
  atmosphere: null,
  sea: null,
  rings: null,
  habitable: null,
  landable: true,
  moons: null,
  minRadius: null,
  maxRadius: null,
}

function returnedTitan(): TourContext {
  const current = context()
  const titan: SubjectBrief = {
    ...current.brief!,
    subjectId: 'titan',
    address: 'b:returned-titan',
    name: 'Titan',
    classification: 'moon',
    summary: 'A returned moon record.',
    facts: [
      {
        ...current.brief!.facts[0]!,
        id: 'titan-radius',
        quantity: 2574730,
        display: '2,574.73 km',
        speech:
          'Titan has a separately recorded radius of 2,574.73 kilometers.',
        sourceIds: ['titan-record'],
      },
    ],
    sources: [
      {
        id: 'titan-record',
        title: 'Titan application record',
        url: null,
        origin: 'application',
      },
    ],
    observer: {
      ...current.brief!.observer,
      fill: null,
      arrived: false,
    },
  }
  return {
    ...current,
    candidates: [
      ...current.candidates,
      {
        ...current.candidates[0]!,
        id: titan.subjectId,
        address: titan.address,
        name: titan.name,
        kind: 'moon',
        parentId: 'saturn',
        factIds: titan.facts.map((fact) => fact.id),
      },
    ],
    briefs: [current.brief!, titan],
  }
}

function toolMessages(
  messages: readonly TourServerMessage[],
): readonly ToolRequest[] {
  return messages.flatMap((message) =>
    message.type === 'tool' ? [message.request] : [],
  )
}

async function arrive(
  coordinator: TourCoordinator,
  request: ToolRequest,
  current: TourContext,
): Promise<void> {
  await coordinator.receive({ type: 'context', context: current })
  await coordinator.receive({
    type: 'receipt',
    receipt: {
      operationId: request.operationId,
      requestRevision: request.requestRevision,
      status: 'arrived',
      viewRevision: current.viewRevision,
      pictureTime: current.pictureTime,
      subjectId: current.subjectId,
      reason: null,
    },
  })
}

describe('tour read continuation and evidence', () => {
  it.each([
    { tool: 'resolve_subject', query: 'Titan' },
    { tool: 'find_worlds', query: worldQuery, radiusLightYears: 8, limit: 4 },
    { tool: 'read_subject', subjectId: 'saturn' },
  ] satisfies readonly TourAction[])(
    'continues $tool with the refreshed candidate context exactly once',
    async (action) => {
      const calls: TourContext[] = []
      const { coordinator, messages } = setup(async (_text, current) => {
        calls.push(current)
        return calls.length === 1
          ? {
              kind: 'actions',
              text: '',
              factIds: [],
              plan: null,
              actions: [action],
              rounds: 1,
            }
          : {
              kind: 'actions',
              text: '',
              factIds: ['titan-radius'],
              plan: null,
              actions: [{ tool: 'show_subject', subjectId: 'titan' }],
              rounds: 1,
            }
      })
      await coordinator.receive({
        type: 'ask',
        text: 'Find Titan and show it.',
        requestRevision: 1,
        viewRevision: 0,
      })
      const read = toolMessages(messages)[0]!
      expect(read.action).toEqual(action)
      expect(
        calls[0]?.candidates.some((candidate) => candidate.id === 'titan'),
      ).toBe(false)
      const refreshed = returnedTitan()
      await arrive(coordinator, read, refreshed)
      expect(calls).toHaveLength(2)
      expect(
        calls[1]?.candidates.find((candidate) => candidate.id === 'titan')
          ?.address,
      ).toBe('b:returned-titan')
      expect(toolMessages(messages)[1]?.action).toEqual({
        tool: 'show_subject',
        subjectId: 'titan',
      })
      await arrive(coordinator, read, refreshed)
      expect(calls).toHaveLength(2)
      expect(toolMessages(messages)).toHaveLength(2)
    },
  )

  it('shares the three-round allowance across completed reads', async () => {
    const allowances: number[] = []
    const { coordinator, messages } = setup(
      async (_text, _context, _signal, maxRounds) => {
        allowances.push(maxRounds)
        return {
          kind: 'actions',
          text: '',
          factIds: [],
          plan: null,
          actions: [{ tool: 'resolve_subject', query: 'Titan' }],
          rounds: 1,
        }
      },
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Find a moon.',
      requestRevision: 1,
      viewRevision: 0,
    })
    for (let index = 0; index < 3; index++) {
      const request = toolMessages(messages)[index]
      expect(request).toBeDefined()
      await arrive(coordinator, request!, returnedTitan())
    }
    expect(allowances).toEqual([2, 2, 1])
    expect(toolMessages(messages)).toHaveLength(3)
    expect(
      messages.some(
        (message) => message.type === 'error' && message.code === 'deadline',
      ),
    ).toBe(true)
  })

  it('returns a noncurrent subject record to the director while the camera stays put', async () => {
    let calls = 0
    const { coordinator, messages } = setup(async () => {
      calls++
      return calls === 1
        ? {
            kind: 'actions',
            text: '',
            factIds: [],
            plan: null,
            actions: [{ tool: 'read_subject', subjectId: 'titan' }],
          }
        : {
            kind: 'explanation',
            text: 'Titan has a recorded radius of 2,574.73 kilometers.',
            factIds: ['titan-radius'],
            plan: null,
            actions: [],
          }
    }, returnedTitan())
    await coordinator.receive({
      type: 'ask',
      text: 'How large is Titan?',
      requestRevision: 1,
      viewRevision: 0,
    })
    const read = toolMessages(messages)[0]!
    await arrive(coordinator, read, returnedTitan())
    expect(calls).toBe(2)
    expect(toolMessages(messages)).toHaveLength(1)
    expect(coordinator.context?.subjectId).toBe('saturn')
    expect(
      messages.find((message) => message.type === 'narration'),
    ).toMatchObject({
      brief: {
        text: 'Titan has a recorded radius of 2,574.73 kilometers.',
        factIds: ['titan-radius'],
      },
    })
  })

  it('shares six executed tools across director continuations', async () => {
    let calls = 0
    const { coordinator, messages } = setup(async () => {
      calls++
      const read: TourAction = {
        tool: 'set_picture_time',
        mode: 'hold',
        value: null,
      }
      return {
        kind: 'actions',
        text: '',
        factIds: [],
        plan: null,
        rounds: 1,
        actions:
          calls === 1
            ? [
                read,
                read,
                read,
                read,
                { tool: 'resolve_subject', query: 'Titan' },
              ]
            : [read, read, read, read, read, read],
      }
    })
    await coordinator.receive({
      type: 'ask',
      text: 'Compare these readings.',
      requestRevision: 1,
      viewRevision: 0,
    })
    for (let index = 0; index < 6; index++) {
      const request = toolMessages(messages)[index]
      expect(request).toBeDefined()
      await arrive(coordinator, request!, returnedTitan())
    }
    expect(calls).toBe(2)
    expect(toolMessages(messages)).toHaveLength(6)
    expect(
      messages.some(
        (message) => message.type === 'error' && message.code === 'operations',
      ),
    ).toBe(true)
  })

  it('keeps authored stop sources while returning a client-valid plan', async () => {
    const current = context()
    const note = {
      ...current.brief!.facts[0]!,
      id: 'saturn:note:rings',
      label: 'Ring material',
      quantity: null,
      unit: null,
      display: 'A curated astronomy note.',
      speech: 'This selected statement comes from the curated ring note.',
      sourceIds: ['nasa-saturn'],
    }
    const brief = {
      ...current.brief!,
      facts: [...current.brief!.facts, note],
      sources: [
        ...current.brief!.sources,
        {
          id: 'nasa-saturn',
          title: 'NASA Saturn',
          url: 'https://science.nasa.gov/saturn/',
          origin: 'curated' as const,
        },
      ],
    }
    const initial: TourContext = {
      ...current,
      candidates: [{ ...current.candidates[0]!, factIds: ['radius', note.id] }],
      brief,
      briefs: [brief],
    }
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'plan',
        text: '',
        factIds: [],
        actions: [],
        rounds: 1,
        plan: {
          id: 'rings-tour',
          goal: 'Read the ring note.',
          durationSeconds: 40,
          stops: [
            {
              id: 'rings-stop',
              subjectId: 'saturn',
              framingId: 'overview',
              siteId: null,
              objective: 'Explain the rings.',
              factIds: [note.id],
              minimumViewSeconds: 20,
              narration: note.speech,
              sources: [brief.sources[1]!],
            },
          ],
        },
      }),
      initial,
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Give me a ring tour.',
      requestRevision: 1,
      viewRevision: 0,
    })
    const plan = messages.find((message) => message.type === 'plan')
    expect(plan?.type).toBe('plan')
    if (plan?.type !== 'plan') throw new Error('No plan')
    expect(plan.plan.stops[0]?.factIds).toEqual([])
    await coordinator.receive({
      type: 'command',
      command: 'start',
      requestRevision: 2,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'rings-stop',
      requestRevision: 2,
      viewRevision: 0,
    })
    const narration = messages.find((message) => message.type === 'narration')
    expect(narration?.type).toBe('narration')
    if (narration?.type !== 'narration') throw new Error('No narration')
    expect(narration.brief.factIds).toEqual([note.id])
    expect(narration.brief.text).toContain(note.speech)
    expect(narration.brief.text).not.toContain('58,232 kilometers')
    expect(narration.brief.sources).toEqual([brief.sources[1]])
    expect(narration.brief.origin).toBe('authored')
  })

  it('uses raw numerical records when no authored or model prose is available', async () => {
    const { coordinator, messages } = setup(async () => {
      throw new Error('No director call is needed')
    }, withAstronomyNotes(context()))
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'saturn-rings',
      requestRevision: 0,
      viewRevision: 0,
    })
    const narration = messages.find((message) => message.type === 'narration')
    if (narration?.type !== 'narration') throw new Error('No narration')
    expect(narration.brief.factIds).toEqual(['radius'])
    expect(narration.brief.text).toContain('58,232')
    expect(narration.brief.origin).toBe('records')
    expect(narration.brief.sources.map((source) => source.id)).toEqual([
      'record',
    ])
  })

  it('names the answer subject when the visitor asks about another visible record', async () => {
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'explanation',
        text: '',
        factIds: ['titan-radius'],
        plan: null,
        actions: [],
        rounds: 1,
      }),
      returnedTitan(),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Tell me about Titan.',
      requestRevision: 1,
      viewRevision: 0,
    })
    const narration = messages.find((message) => message.type === 'narration')
    if (narration?.type !== 'narration') throw new Error('No narration')
    expect(narration.brief.text).toMatch(/^Titan\./)
    expect(narration.brief.text).not.toContain('Saturn.')
    expect(narration.brief.subjectId).toBe('saturn')
    expect(messages.some((message) => message.type === 'tool')).toBe(false)
  })

  it('retains selected cross-subject facts and each source in one explanation', async () => {
    const initial = returnedTitan()
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'explanation',
        text: '',
        factIds: ['radius', 'titan-radius'],
        plan: null,
        actions: [],
        rounds: 1,
      }),
      initial,
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Compare Saturn and Titan.',
      requestRevision: 1,
      viewRevision: 0,
    })
    const narration = messages.find((message) => message.type === 'narration')
    expect(narration?.type).toBe('narration')
    if (narration?.type !== 'narration') throw new Error('No narration')
    expect(narration.brief.factIds).toEqual(['radius', 'titan-radius'])
    expect(narration.brief.text).toContain('58,232 kilometers')
    expect(narration.brief.text).toContain('2,574.73 kilometers')
    expect(narration.brief.sources.map((source) => source.id)).toEqual([
      'record',
      'titan-record',
    ])
    expect(narration.brief.subjectId).toBe('saturn')
  })
})

function storyPlan(overrides: Partial<TourPlan> = {}): TourPlan {
  return {
    id: 'story-tour',
    goal: 'Meet the worlds as places with stories.',
    durationSeconds: 60,
    automatic: true,
    stops: [
      {
        id: 'saturn-story',
        subjectId: 'saturn',
        framingId: 'overview',
        siteId: null,
        objective: 'The first telescopes meet a very strange planet.',
        factIds: [],
        minimumViewSeconds: 20,
        narration: 'Imagine seeing those rings through a tiny early telescope.',
        motion: 'orbit',
      },
    ],
    ...overrides,
  }
}

function planContext(): TourContext {
  const current = context()
  return { ...current, briefs: [current.brief!] }
}

describe('tour stories and conversation controls', () => {
  it('speaks model-written historical flavor without substituting unrelated records', async () => {
    const text =
      'Galileo saw something so puzzling that he drew Saturn with companions on either side.'
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'explanation',
        text,
        factIds: [],
        plan: null,
        actions: [],
      }),
      withAstronomyNotes(context()),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Tell me a story about Saturn.',
      requestRevision: 1,
      viewRevision: 0,
    })
    const narration = messages.find((message) => message.type === 'narration')
    expect(narration).toMatchObject({
      type: 'narration',
      brief: { text, origin: 'model', factIds: [], sourceIds: [], sources: [] },
    })
  })

  it('holds action narration until the matching destination has arrived', async () => {
    const text =
      'Welcome to Titan, where familiar-looking rivers have a rather unfamiliar ingredient. Its recorded radius is 2,574.73 kilometers.'
    const initial = returnedTitan()
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'actions',
        text,
        factIds: ['titan-radius'],
        plan: null,
        actions: [{ tool: 'show_subject', subjectId: 'titan' }],
      }),
      initial,
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Show me Titan.',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(messages.some((message) => message.type === 'narration')).toBe(false)
    const request = toolMessages(messages)[0]!
    await coordinator.receive({
      type: 'receipt',
      receipt: {
        operationId: request.operationId,
        requestRevision: 1,
        status: 'accepted',
        viewRevision: 0,
        pictureTime: 123,
        subjectId: 'titan',
        reason: null,
      },
    })
    expect(messages.some((message) => message.type === 'narration')).toBe(false)
    const titan = initial.briefs[1]!
    await arrive(coordinator, request, {
      ...initial,
      viewRevision: 1,
      subjectId: 'titan',
      brief: { ...titan, observer: { ...titan.observer, arrived: true } },
    })
    expect(
      messages.find((message) => message.type === 'narration'),
    ).toMatchObject({
      type: 'narration',
      brief: {
        text,
        origin: 'model',
        factIds: ['titan-radius'],
        sourceIds: ['titan-record'],
        sources: titan.sources,
      },
    })
  })

  it('speaks an automatic stop with no selected facts using controlled playback', async () => {
    const plan = storyPlan()
    const { coordinator, messages, spoken } = setup(
      async () => ({ kind: 'plan', text: '', factIds: [], plan, actions: [] }),
      planContext(),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'A short tour, please.',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(spoken).toEqual([])
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'saturn-story',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(
      messages.find((message) => message.type === 'narration'),
    ).toMatchObject({
      type: 'narration',
      brief: {
        text: plan.stops[0]!.narration,
        origin: 'model',
        playback: 'controlled',
        factIds: [],
        sources: [],
      },
    })
  })

  it('rejects an accepted stop when a different subject is currently in view', async () => {
    const initial = returnedTitan()
    const plan = storyPlan({
      stops: [
        { ...storyPlan().stops[0]!, subjectId: 'titan', id: 'titan-story' },
      ],
    })
    const { coordinator, messages } = setup(
      async () => ({ kind: 'plan', text: '', factIds: [], plan, actions: [] }),
      initial,
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Tour Titan.',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'titan-story',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(messages.some((message) => message.type === 'narration')).toBe(false)
  })

  it('cites only the authored stop sources when its story uses no record facts', async () => {
    const source = {
      id: 'galileo-source',
      title: 'The early telescopes',
      url: 'https://example.com/galileo',
      origin: 'curated' as const,
    }
    const plan = storyPlan({
      stops: [{ ...storyPlan().stops[0]!, sources: [source] }],
    })
    const { coordinator, messages } = setup(
      async () => ({ kind: 'plan', text: '', factIds: [], plan, actions: [] }),
      planContext(),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'Tell that first telescope story.',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'saturn-story',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(
      messages.find((message) => message.type === 'narration'),
    ).toMatchObject({
      brief: {
        text: plan.stops[0]!.narration,
        factIds: [],
        sourceIds: [source.id],
        sources: [source],
        origin: 'authored',
        playback: 'controlled',
      },
    })
  })

  it('rejects invented stop IDs once a plan has been accepted', async () => {
    const { coordinator, messages } = setup(
      async () => ({
        kind: 'plan',
        text: '',
        factIds: [],
        plan: storyPlan(),
        actions: [],
      }),
      planContext(),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'A tour.',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'not-a-stop',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(messages.some((message) => message.type === 'narration')).toBe(false)
  })

  it('returns a validated authored preset before reserving any provider budget', async () => {
    let calls = 0
    const plan = storyPlan()
    const { coordinator, messages } = setup(
      async () => {
        calls++
        throw new Error('No inference needed')
      },
      planContext(),
      { preset: () => plan },
    )
    await coordinator.receive({
      type: 'ask',
      text: 'A five-minute Solar System tour.',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(calls).toBe(0)
    expect(coordinator.record.budget).toMatchObject({
      spent: 0,
      reserved: 0,
      calls: 0,
    })
    expect(messages.find((message) => message.type === 'plan')).toMatchObject({
      plan,
      requestRevision: 1,
    })
  })

  it('does not publish a preset with an unavailable subject', async () => {
    const plan = storyPlan({
      stops: [{ ...storyPlan().stops[0]!, subjectId: 'invented' }],
    })
    const { coordinator, messages } = setup(
      async () => {
        throw new Error('No inference needed')
      },
      planContext(),
      { preset: () => plan },
    )
    await coordinator.receive({
      type: 'ask',
      text: 'A tour.',
      requestRevision: 1,
      viewRevision: 0,
    })
    expect(messages.some((message) => message.type === 'plan')).toBe(false)
    expect(coordinator.record.budget.calls).toBe(0)
    expect(messages).toContainEqual(
      expect.objectContaining({ type: 'error', code: 'plan' }),
    )
  })

  it('passes the ordered prior plan into a conversational revision', async () => {
    const prior: (string | undefined)[] = []
    const plan = storyPlan()
    const { coordinator } = setup(
      async (_text, _context, _signal, _rounds, priorGoal) => {
        prior.push(priorGoal)
        return { kind: 'plan', text: '', factIds: [], plan, actions: [] }
      },
      planContext(),
    )
    await coordinator.receive({
      type: 'ask',
      text: 'A short tour.',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'narration-ready',
      stopId: 'saturn-story',
      requestRevision: 1,
      viewRevision: 0,
    })
    await coordinator.receive({
      type: 'ask',
      text: 'Spend longer on the history.',
      requestRevision: 2,
      viewRevision: 0,
    })
    expect(prior[0]).toBeUndefined()
    expect(prior[1]).toContain(plan.goal)
    expect(prior[1]).toContain('Saturn')
    expect(prior[1]).toContain('orbit')
    expect(prior[1]).toContain('telescopes')
    expect(prior[1]).toContain('"subjectId":"saturn"')
    expect(prior[1]).toContain('"currentStopId":"saturn-story"')
  })

  it.each(['pause', 'resume', 'next', 'back', 'end'] as const)(
    'executes spoken %s without inference or an early server close',
    async (command) => {
      let calls = 0
      const { coordinator, messages } = setup(async () => {
        calls++
        throw new Error('No inference needed')
      })
      await coordinator.delegate('spoken-control', `${command.toUpperCase()}.`)
      expect(calls).toBe(0)
      expect(messages).toContainEqual({
        type: 'control',
        command,
        requestRevision: 1,
      })
      expect(coordinator.record.state).toBe('open')
      expect(coordinator.record.budget.calls).toBe(0)
      expect(messages.some((message) => message.type === 'closed')).toBe(false)
      await coordinator.delegate('spoken-control', command)
      expect(
        messages.filter((message) => message.type === 'control'),
      ).toHaveLength(1)
    },
  )

  it('does not deliver a stale spoken control after a newer one supersedes its write', async () => {
    let release!: () => void
    let started!: () => void
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let writes = 0
    const { coordinator, messages } = setup(
      async () => {
        throw new Error('No inference needed')
      },
      context(),
      {
        persist: async () => {
          if (++writes === 1) {
            started()
            await blocked
          }
        },
      },
    )
    const pause = coordinator.delegate('pause-first', 'Pause.')
    await waiting
    const resume = coordinator.delegate('resume-second', 'Resume.')
    release()
    await Promise.all([pause, resume])
    expect(messages.filter((message) => message.type === 'control')).toEqual([
      { type: 'control', command: 'resume', requestRevision: 2 },
    ])
  })
})
