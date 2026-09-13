import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { openSession, subjectBrief } from '@inertialref/devtools'
import type {
  ToolReceipt,
  ToolRequest,
  TourWorldQuery,
} from '@inertialref/protocol'
import { TourExecutor } from './executor.ts'

function setup(ready?: () => boolean) {
  const session = openSession()
  session.harness.look('s:SOL/b:2', { ease: false })
  let now = 1000
  const receipts: ToolReceipt[] = []
  let takeovers = 0
  const executor = new TourExecutor(session.harness, {
    sessionId: 'session',
    now: () => now,
    onReceipt: (receipt) => receipts.push(receipt),
    onTakeover: () => {
      takeovers += 1
    },
    ready,
  })
  const context = executor.context('Saturn')
  const saturn = context.candidates.find(
    (candidate) => candidate.name === 'Saturn',
  )!
  const request: ToolRequest = {
    sessionId: 'session',
    requestRevision: 0,
    operationId: 'one',
    expectedViewRevision: executor.viewRevision,
    expiresAt: 5000,
    action: { tool: 'show_subject', subjectId: saturn.id },
  }
  return {
    session,
    executor,
    receipts,
    request,
    saturn,
    time: (value: number) => {
      now = value
    },
    takeovers: () => takeovers,
  }
}

describe('the guide local executor', () => {
  it('starts queued motion only on ready arrival and publishes its new revision', () => {
    let ready = false
    const { session, executor, request, receipts, takeovers } = setup(
      () => ready,
    )
    executor.queueMotion('orbit', 20)
    expect(executor.execute(request).status).toBe('accepted')
    const eye = session.harness.observatory
    for (let frame = 0; frame < 1000; frame++) eye.sample(1 / 60)
    executor.poll()
    expect(eye.status().motion).toBeNull()
    expect(receipts.at(-1)?.status).toBe('accepted')
    ready = true
    executor.poll()
    expect(receipts.at(-1)).toMatchObject({
      status: 'arrived',
      viewRevision: eye.mutationRevision,
    })
    expect(eye.status().motion?.durationSeconds).toBe(20)
    eye.sample(5)
    executor.poll()
    expect(takeovers()).toBe(0)
    executor.cancel()
    const held = eye.status().state
    expect(eye.status().motion).toBeNull()
    eye.sample(50)
    expect(eye.status().state).toEqual(held)
    executor.dispose()
    session.dispose()
  })

  it('starts and stops a ready-view gesture without canceling a visitor replacement', () => {
    const { session, executor, takeovers } = setup()
    const eye = session.harness.observatory
    const revision = executor.startMotion('push-in', 20)
    expect(revision).toBe(eye.mutationRevision)
    eye.sample(4)
    executor.poll()
    expect(takeovers()).toBe(0)
    executor.stopMotion()
    expect(executor.viewRevision).toBe(revision)
    const held = eye.status().state
    eye.sample(20)
    expect(eye.status().state).toEqual(held)
    executor.startMotion('reveal', 20)
    eye.sample(2)
    eye.startMotion({
      durationSeconds: 12,
      azimuthDelta: -0.2,
      elevationDelta: 0,
      distanceFactor: 1.1,
    })
    const visitor = eye.status().state
    executor.poll()
    executor.stopMotion()
    executor.cancel()
    expect(takeovers()).toBe(1)
    expect(eye.status().motion?.durationSeconds).toBe(12)
    eye.sample(6)
    expect(eye.status().state).not.toEqual(visitor)
    executor.dispose()
    expect(eye.status().motion?.durationSeconds).toBe(12)
    session.dispose()
  })

  it('discards queued motion when the request is superseded', () => {
    const { session, executor, request } = setup()
    executor.queueMotion('orbit', 20)
    executor.execute(request)
    executor.supersede(1)
    for (let frame = 0; frame < 1000; frame++)
      session.harness.observatory.sample(1 / 60)
    executor.poll()
    expect(session.harness.observatory.status().motion).toBeNull()
    executor.dispose()
    session.dispose()
  })

  const query: TourWorldQuery = {
    kinds: ['gas-giant'],
    starClasses: [],
    atmosphere: null,
    sea: null,
    rings: null,
    habitable: null,
    landable: null,
    moons: null,
    minRadius: null,
    maxRadius: null,
  }
  it('reads a compact inventory record fully without changing the camera', () => {
    const { session, executor, request } = setup()
    const before = executor.context()
    const candidate = before.candidates.find((item) => item.name === 'Neptune')!
    const full = subjectBrief(session.harness, candidate.address)!
    expect(
      before.briefs.find((brief) => brief.subjectId === candidate.id)!.facts
        .length,
    ).toBeLessThan(full.facts.length)
    const pose = session.harness.observatory.pose()
    const revision = executor.viewRevision
    expect(
      executor.execute({
        ...request,
        action: { tool: 'read_subject', subjectId: candidate.id },
      }).status,
    ).toBe('arrived')
    const after = executor.context()
    expect(
      after.briefs.find((brief) => brief.subjectId === candidate.id)?.facts,
    ).toEqual(full.facts)
    expect(
      after.candidates.find((item) => item.id === candidate.id)?.factIds,
    ).toEqual(full.facts.map((fact) => fact.id))
    expect(executor.viewRevision).toBe(revision)
    expect(session.harness.observatory.pose()).toEqual(pose)
    executor.dispose()
    session.dispose()
  })
  it('resolves a body name locally without changing the view', () => {
    const { session, executor, request } = setup()
    const before = session.harness.observatory.pose()
    expect(
      executor.execute({
        ...request,
        action: { tool: 'resolve_subject', query: 'Titan' },
      }).status,
    ).toBe('arrived')
    expect(
      executor
        .context()
        .candidates.some((candidate) => candidate.name === 'Titan'),
    ).toBe(true)
    expect(session.harness.observatory.pose()).toEqual(before)
    executor.dispose()
    session.dispose()
  })
  it('publishes capped search results and discards canceled completion', async () => {
    const { session, executor, request } = setup()
    const searchRequest: ToolRequest = {
      ...request,
      action: { tool: 'find_worlds', query, radiusLightYears: 0.01, limit: 1 },
    }
    expect(executor.execute(searchRequest).status).toBe('accepted')
    await executor.searchDone
    expect(executor.searchStatus.running).toBe(false)
    expect(executor.searchStatus.total).toBeGreaterThanOrEqual(2)
    expect(executor.execute(searchRequest).status).toBe('arrived')
    executor.supersede(1)
    const next = {
      ...searchRequest,
      operationId: 'two',
      requestRevision: 1,
      expectedViewRevision: executor.viewRevision,
    }
    executor.execute(next)
    executor.cancel()
    await executor.searchDone
    expect(executor.execute(next).status).toBe('canceled')
    executor.dispose()
    session.dispose()
  })
  it('executes once and replays the eventual arrival receipt', () => {
    const { session, executor, request } = setup()
    const accepted = executor.execute(request)
    expect(accepted.status).toBe('accepted')
    const revision = executor.viewRevision
    expect(executor.execute(request)).toEqual(accepted)
    expect(executor.viewRevision).toBe(revision)
    for (let i = 0; i < 1000; i += 1) session.harness.observatory.sample(1 / 60)
    executor.poll()
    expect(executor.execute(request).status).toBe('arrived')
    executor.dispose()
    session.dispose()
  })
  it('rejects superseded requests even when aborting failed', () => {
    const { session, executor, request } = setup()
    executor.supersede(1)
    const before = session.harness.observatory.pose()
    expect(executor.execute(request).status).toBe('rejected')
    expect(session.harness.observatory.pose()).toEqual(before)
    executor.dispose()
    session.dispose()
  })
  it('cancel revokes unseen operations from the same request', () => {
    const { session, executor, request } = setup()
    executor.cancel()
    expect(executor.execute(request).status).toBe('rejected')
    executor.supersede(1)
    expect(
      executor.execute({ ...request, operationId: 'fresh', requestRevision: 1 })
        .status,
    ).toBe('accepted')
    executor.dispose()
    session.dispose()
  })
  it('manual input cancels travel without applying a later receipt', () => {
    const { session, executor, request, receipts, takeovers } = setup()
    executor.execute(request)
    session.harness.observatory.drag(10, 0)
    executor.poll()
    expect(receipts.at(-1)?.status).toBe('canceled')
    expect(takeovers()).toBe(1)
    expect(executor.execute(request).status).toBe('canceled')
    executor.dispose()
    session.dispose()
  })
  it('rejects surface requests and unknown framing before changing the pose', () => {
    const { session, executor, request, saturn } = setup()
    const before = session.harness.observatory.pose()
    expect(
      executor.execute({
        ...request,
        action: {
          tool: 'stand_at_site',
          subjectId: saturn.id,
          siteId: 'invented',
        },
      }).status,
    ).toBe('rejected')
    expect(
      executor.execute({
        ...request,
        operationId: 'two',
        action: {
          tool: 'compose_view',
          subjectId: saturn.id,
          framingId: 'eval',
        },
      }).status,
    ).toBe('rejected')
    expect(session.harness.observatory.pose()).toEqual(before)
    executor.dispose()
    session.dispose()
  })
  it('picture playback holds render time without changing the simulation', () => {
    const { session, executor, request } = setup()
    const before = session.world.stateHash()
    const time = session.harness.observatory.time
    expect(
      executor.execute({
        ...request,
        action: { tool: 'set_picture_time', mode: 'resume', value: null },
      }).status,
    ).toBe('arrived')
    expect(session.harness.observatory.heldTime).toBe(time)
    expect(session.world.stateHash()).toBe(before)
    executor.dispose()
    session.dispose()
  })
  it('cancellation wins at every arrival ordering', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (frames) => {
        const { session, executor, request } = setup()
        executor.execute(request)
        for (let i = 0; i < frames; i += 1)
          session.harness.observatory.sample(1 / 60)
        executor.cancel('Stopped')
        const pose = session.harness.observatory.pose()
        for (let i = 0; i < 100; i += 1)
          session.harness.observatory.sample(1 / 60)
        executor.poll()
        expect(session.harness.observatory.pose()).toEqual(pose)
        expect(executor.execute(request).status).toBe('canceled')
        executor.dispose()
        session.dispose()
      }),
      { numRuns: 10 },
    )
  })
})
