import { describe, expect, it, vi } from 'vitest'
import { openSession } from '@inertialref/devtools'
import { GuideExecutor } from './executor.ts'
import type { LiveServerEvent } from './media.ts'
import { GuideRuntime, type GuideHost } from './runtime.ts'

function rig() {
  const session = openSession()
  session.harness.look('s:SOL/b:2', { ease: false })
  const requests: { path: string; body: unknown }[] = []
  const sent: Record<string, unknown>[] = []
  let sequence = 0
  let time = 1000
  let run: (() => void) | null = null
  let visibility: ((visible: boolean) => void) | null = null
  let onEvent: ((event: LiveServerEvent) => void) | null = null
  let level = 0
  let executor: GuideExecutor | null = null
  const live = {
    prepare: vi.fn(async () => 'offer'),
    accept: vi.fn(async () => {
      onEvent?.({ type: 'session.started', session: { id: 'live_1' } })
    }),
    send: vi.fn((event: Record<string, unknown>) => {
      const id = `guide-${++sequence}`
      sent.push({ ...event, event_id: id })
      if (/\.append$/.test(String(event.type)))
        queueMicrotask(() =>
          onEvent?.({
            type: `${String(event.type)}ed`,
            client_event_id: id,
          }),
        )
      if (event.type === 'session.close')
        queueMicrotask(() =>
          onEvent?.({
            type: 'session.closed',
            reason: 'close_requested',
            usage: { seconds: 42 },
          }),
        )
      return id
    }),
    level: () => level,
    muteMicrophone: vi.fn(async () => {}),
    muteGuide: vi.fn(),
    close: vi.fn(async () => {
      live.send({ type: 'session.close' })
      await Promise.resolve()
      return { closed: true }
    }),
    stop: vi.fn(),
  }
  const host: GuideHost = {
    now: () => time,
    localTime: () => '21:04',
    request: async (path, body) => {
      requests.push({ path, body })
      if (path.endsWith('/capabilities'))
        return Response.json({
          available: true,
          authenticated: true,
          voices: ['marin', 'cedar'],
          reason: null,
        })
      if (path === '/api/tour/sessions')
        return Response.json({
          sessionId: 'live_1',
          expiresAt: time + 7_200_000,
          sdp: 'answer',
        })
      return Response.json({ authenticated: true })
    },
    executor: (events) => {
      executor = new GuideExecutor(session.harness, {
        now: () => time,
        ...events,
      })
      return executor
    },
    live: (event) => {
      onEvent = event
      return live
    },
    poll: (tick) => {
      run = tick
      return () => {
        run = null
      }
    },
    visibility: (changed) => {
      visibility = changed
      return () => {
        visibility = null
      }
    },
  }
  const runtime = new GuideRuntime(host)
  const receive = (event: LiveServerEvent) => onEvent?.(event)
  let responses = 0
  const delegated = (name: string, args: Record<string, unknown>) => {
    const id = `resp_${++responses}`
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: { type: 'response.created', response: { id } },
    })
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: `call_${responses}`,
          name,
          arguments: JSON.stringify(args),
        },
      },
    })
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: { type: 'response.completed', response: { id, usage: null } },
    })
    return `call_${responses}`
  }
  const terminal = (text: string) => {
    const id = `resp_${++responses}`
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: { type: 'response.created', response: { id } },
    })
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text }] },
      },
    })
    receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.completed',
        response: {
          id,
          usage: {
            input_tokens: 2000,
            input_tokens_details: { cached_tokens: 1900 },
            output_tokens: 30,
          },
        },
      },
    })
  }
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  return {
    runtime,
    session,
    requests,
    sent,
    live,
    receive,
    delegated,
    terminal,
    settle,
    executor: () => executor!,
    speak: (value: number) => {
      level = value
    },
    tick: () => run?.(),
    advance: (ms: number, ticks = 1) => {
      for (let i = 0; i < ticks; i++) {
        time += ms / ticks
        run?.()
      }
    },
    arrive: () => {
      for (let i = 0; i < 600; i++) session.harness.observatory.sample(1 / 60)
      run?.()
    },
    hide: () => visibility?.(false),
    developer: () =>
      sent
        .filter(
          (event) =>
            event.type === 'response.item.create' &&
            (event.item as { role?: string }).role === 'developer',
        )
        .map(
          (event) =>
            (event.item as { content: { text: string }[] }).content[0]!.text,
        ),
    outputs: () =>
      sent
        .filter(
          (event) =>
            event.type === 'response.item.create' &&
            (event.item as { type: string }).type === 'function_call_output',
        )
        .map((event) => {
          const item = event.item as { call_id: string; output: string }
          return { callId: item.call_id, output: JSON.parse(item.output) }
        }),
    creates: () => sent.filter((event) => event.type === 'response.create'),
    appends: (kind: string) =>
      sent
        .filter((event) => event.type === `session.${kind}.append`)
        .map((event) => String(event.content)),
    dispose: async () => {
      await runtime.end()
      session.dispose()
    },
  }
}

describe('the guide runtime', () => {
  it('starts a session from the offer, greets by the documented recipe, and listens', async () => {
    const f = rig()
    await f.runtime.start('cedar')
    const creation = f.requests.find(
      (request) => request.path === '/api/tour/sessions',
    )!
    expect(creation.body).toMatchObject({ voice: 'cedar', sdp: 'offer' })
    expect(String((creation.body as { scene: string }).scene)).toContain(
      'local time is 21:04',
    )
    expect(f.live.accept).toHaveBeenCalledWith('answer')
    expect(f.appends('instructions')[0]).toMatch(/^Greet the visitor/)
    expect(f.appends('commentary')[0]).toMatch(/^Begin the conversation now/)
    expect(
      f.sent.findIndex((e) => e.type === 'session.commentary.append'),
    ).toBeGreaterThan(
      f.sent.findIndex((e) => e.type === 'session.instructions.append'),
    )
    const snapshot = f.runtime.getSnapshot()
    expect(snapshot.connection).toBe('connected')
    expect(snapshot.voice).toBe('cedar')
    expect(snapshot.status).toBe('Listening')
    expect(f.runtime.diagnostics().sessionId).toBe('live_1')
    await f.dispose()
  })

  it('runs a delegated move at once and prompts the backend with the arrival', async () => {
    const f = rig()
    await f.runtime.start('marin')
    const call = f.delegated('go_to', {
      subject: 'Saturn',
      framing: 'portrait',
      motion: null,
    })
    await f.settle()
    expect(f.outputs()).toEqual([
      {
        callId: call,
        output: expect.objectContaining({
          status: 'moving',
          subject: 'Saturn',
        }),
      },
    ])
    expect(f.creates()).toHaveLength(1)
    f.tick()
    expect(f.runtime.getSnapshot().status).toBe('Moving to Saturn')
    // The continuation ends the chain with words; only then may an arrival prompt.
    f.terminal('Heading over to Saturn.')
    f.arrive()
    const arrival = f
      .developer()
      .find((text) => text.startsWith('Arrived: Saturn'))
    expect(arrival).toContain('Narrate this stop now.')
    expect(f.creates()).toHaveLength(2)
    expect(f.appends('thinking').at(-1)).toMatch(/looking at Saturn/)
    expect(f.runtime.getSnapshot().usage.responses).toBe(1)
    expect(f.runtime.getSnapshot().usage.cachedTokens).toBe(1900)
    await f.dispose()
  })

  it('lets a correction during travel replace the pending arrival without waiting', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Off to Titan.')
    f.tick()
    const correction = f.delegated('go_to', {
      subject: 'Enceladus',
      framing: null,
      motion: null,
    })
    await f.settle()
    expect(f.outputs().at(-1)).toEqual({
      callId: correction,
      output: expect.objectContaining({
        status: 'moving',
        subject: 'Enceladus',
      }),
    })
    f.terminal('Pivoting to Enceladus.')
    f.arrive()
    const arrivals = f.developer().filter((text) => text.startsWith('Arrived:'))
    expect(arrivals).toHaveLength(1)
    expect(arrivals[0]).toMatch(/^Arrived: Enceladus/)
    await f.dispose()
  })

  it('prompts an arrival that landed inside an open chain once the chain closes and the visitor is quiet', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('stand_at', { subject: 'Earth', site: 'summit' })
    await f.settle()
    const before = f.creates().length
    // The stand completes before the backend has written its travel line.
    f.arrive()
    const arrivals = f.developer().filter((text) => text.startsWith('Arrived:'))
    expect(arrivals).toHaveLength(1)
    expect(f.creates()).toHaveLength(before)
    f.terminal('Down to the summit.')
    f.receive({ type: 'session.input_transcript.delta', delta: 'wait' })
    f.tick()
    expect(f.creates()).toHaveLength(before)
    f.advance(1100, 2)
    expect(f.creates()).toHaveLength(before + 1)
    expect(
      f.developer().filter((text) => text.startsWith('Arrived:')),
    ).toHaveLength(1)
    f.advance(1000, 5)
    expect(f.creates()).toHaveLength(before + 1)
    await f.dispose()
  })

  it('tells the models about a drag once per gesture, not once per frame', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Titan.')
    const takeovers = () =>
      f.developer().filter((text) => text.startsWith('The visitor has taken'))
    for (let frame = 0; frame < 30; frame++) {
      f.session.harness.observatory.zoom(1.02)
      f.advance(16)
    }
    expect(takeovers()).toHaveLength(1)
    expect(
      f.appends('thinking').filter((text) => /taken the camera/.test(text)),
    ).toHaveLength(1)
    f.delegated('describe_view', {})
    await f.settle()
    f.session.harness.observatory.zoom(1.5)
    f.tick()
    expect(takeovers()).toHaveLength(2)
    await f.dispose()
  })

  it('executes a redelivered function call once', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('describe_view', {})
    f.receive({
      type: 'response.event',
      delegation_id: 'item_1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'call_1',
          name: 'describe_view',
          arguments: '{}',
        },
      },
    })
    await f.settle()
    expect(f.outputs()).toHaveLength(1)
    expect(f.creates()).toHaveLength(1)
    await f.dispose()
  })

  it('treats a takeover as the visitor choosing the view, and tells both models', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Titan', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Titan.')
    f.session.harness.observatory.zoom(2)
    f.tick()
    expect(f.runtime.getSnapshot().status).toBe('You have the camera')
    expect(f.appends('thinking').at(-1)).toMatch(
      /^The visitor has taken the camera/,
    )
    const note = f.developer().at(-1)!
    expect(note).toMatch(/^The visitor has taken the camera/)
    expect(note).toContain('Current view:')
    f.arrive()
    expect(f.developer().some((text) => text.startsWith('Arrived:'))).toBe(
      false,
    )
    await f.dispose()
  })

  it('waits for the spoken beat and the declared quiet before continuing a tour', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.delegated('go_to', { subject: 'Saturn', framing: null, motion: null })
    await f.settle()
    f.terminal('Heading to Saturn.')
    f.arrive()
    f.delegated('linger', { seconds: 5, reason: 'the rings' })
    await f.settle()
    expect(f.outputs().at(-1)?.output).toEqual({
      status: 'scheduled',
      seconds: 5,
    })
    f.terminal('Those rings are countless pieces of ice.')
    const before = f.creates().length
    f.tick()
    f.speak(0.05)
    f.advance(2000, 20)
    f.speak(0)
    f.advance(2600, 26)
    await f.settle()
    f.advance(4000, 40)
    expect(f.creates()).toHaveLength(before)
    f.advance(1200, 12)
    expect(f.developer().at(-1)).toMatch(
      /^The visitor has looked quietly for 5 seconds/,
    )
    expect(f.creates()).toHaveLength(before + 1)
    await f.dispose()
  })

  it('pauses both directions and holds the camera, then resumes, then ends cleanly', async () => {
    const f = rig()
    await f.runtime.start('marin')
    f.runtime.pause()
    expect(f.runtime.getSnapshot()).toMatchObject({
      paused: true,
      status: 'Paused',
    })
    expect(f.live.muteMicrophone).toHaveBeenLastCalledWith(true)
    expect(f.live.muteGuide).toHaveBeenLastCalledWith(true)
    expect(
      f.sent.some((event) => event.type === 'session.input_audio.mute'),
    ).toBe(true)
    expect(f.appends('instructions').at(-1)).toMatch(/^The visitor paused/)
    f.runtime.resume()
    expect(f.runtime.getSnapshot().paused).toBe(false)
    expect(
      f.sent.some((event) => event.type === 'session.input_audio.unmute'),
    ).toBe(true)
    f.hide()
    expect(f.runtime.getSnapshot().paused).toBe(true)
    f.runtime.resume()
    f.runtime.pause()
    f.advance(180_000, 2)
    await f.settle()
    expect(f.runtime.getSnapshot().connection).toBe('offline')
    expect(f.runtime.getSnapshot().message).toMatch(/three minutes paused/)
    expect(f.live.close).toHaveBeenCalledOnce()
    f.session.dispose()
  })

  it('records an opt-in trace of the channel without the password, bounded and detached', async () => {
    const f = rig()
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    try {
      await f.runtime.login('password-never-recorded')
      expect(f.runtime.trace()).toEqual([])
      f.runtime.trace(true)
      await f.runtime.start('marin')
      for (let i = 0; i < 210; i++)
        f.receive({ type: 'session.usage.updated', usage: { seconds: i } })
      const entries = f.runtime.trace()
      expect(entries).toHaveLength(200)
      expect(JSON.stringify(entries)).not.toContain('password-never-recorded')
      ;(entries[0] as unknown as { message: { type: string } }).message.type =
        'changed'
      expect(JSON.stringify(f.runtime.trace())).not.toContain('changed')
      expect(debug).toHaveBeenCalledWith('[guide]', expect.any(Object))
      f.runtime.trace(false)
      debug.mockClear()
      f.receive({ type: 'session.usage.updated', usage: { seconds: 999 } })
      expect(debug).not.toHaveBeenCalled()
    } finally {
      debug.mockRestore()
      await f.dispose()
    }
  })
})
