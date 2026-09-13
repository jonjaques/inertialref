import { describe, expect, it } from 'vitest'
import type { TourContext, TourServerMessage } from '@inertialref/protocol'
import {
  TourCoordinator,
  newSessionRecord,
  type DirectorDecision,
} from './coordinator.ts'

const context = (viewRevision = 0): TourContext => ({
  protocolVersion: 1,
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
  ) => Promise<DirectorDecision>,
) {
  const messages: TourServerMessage[] = []
  const saved: unknown[] = []
  const record = newSessionRecord({
    sessionId: 's1',
    user: 'alpha',
    tabId: 'tab',
    now: 100,
    transport: 'text',
    manifest: context().manifest,
    fingerprint: 'fp',
  })
  const coordinator = new TourCoordinator(record, context(), {
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
    narrate: async () => {},
    close: async () => {},
  })
  return { coordinator, messages, saved }
}

describe('tour coordinator ordering', () => {
  it('discards a slow director result after an explicit stop even when abort is ignored', async () => {
    let resolve!: (value: DirectorDecision) => void
    const started = Promise.withResolvers<void>()
    const { coordinator, messages } = setup(
      () =>
        new Promise((done) => {
          resolve = done
          started.resolve()
        }),
    )
    const pending = coordinator.receive({
      type: 'ask',
      text: 'Show Saturn',
      requestRevision: 1,
      viewRevision: 0,
    })
    await started.promise
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
