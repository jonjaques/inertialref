import { describe, expect, it, vi } from 'vitest'
import { groundedNarration, openSession } from '@inertialref/devtools'
import { tourMessageBytes, TOUR_LIMITS } from '@inertialref/protocol'
import type {
  TourClientMessage,
  TourContext,
  TourServerMessage,
} from '@inertialref/protocol'
import { GuideRuntime, type GuideHost } from './runtime.ts'
import { TourExecutor } from './executor.ts'
import { ControlledPlayback, type LiveConnection } from './media.ts'

class Socket extends EventTarget {
  readyState = 1
  sent: TourClientMessage[] = []
  respond: ((message: TourClientMessage) => void) | null = null
  send(text: string): void {
    const event = JSON.parse(text) as TourClientMessage
    this.sent.push(event)
    this.respond?.(event)
  }
  receive(event: TourServerMessage): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    )
  }
  close(): void {
    this.readyState = 3
  }
}

function rig() {
  const session = openSession()
  session.harness.look('s:SOL/b:2', { ease: false })
  const requests: { path: string; body: unknown }[] = []
  const sockets: Socket[] = []
  const clips: HTMLAudioElement[] = []
  const live = {
    prepare: vi.fn(async () => 'offer'),
    accept: vi.fn(async () => {}),
    stop: vi.fn(),
    muteGuide: vi.fn(),
    muteMicrophone: vi.fn(),
  }
  let sequence = 0
  let time = 1000
  let run: (() => void) | null = null
  let visibility: ((visible: boolean) => void) | null = null
  let createResponse: (() => Promise<Response>) | null = null
  const host: GuideHost = {
    now: () => time,
    presentationNow: () => time,
    id: () => `id-${++sequence}`,
    request: async (path, body) => {
      requests.push({ path, body })
      if (path.endsWith('/capabilities'))
        return Response.json({
          available: true,
          authenticated: true,
          voices: ['marin'],
          durationSeconds: 600,
          features: {
            text: true,
            live: true,
            controlledSpeech: true,
            images: false,
          },
          reason: null,
        })
      if (path === '/api/tour/sessions')
        return createResponse
          ? createResponse()
          : Response.json({
              sessionId: 'remote',
              expiresAt: 601000,
              transport: 'text',
              sdp: 'answer',
            })
      if (path.endsWith('/speech'))
        return new Response(new Blob(['voice'], { type: 'audio/mpeg' }))
      return Response.json({ closed: true })
    },
    socket: () => {
      const socket = new Socket()
      let context: TourContext | null = null
      socket.respond = (event) => {
        if (event.type === 'context') context = event.context
        if (event.type === 'narration-ready' && context !== null) {
          const brief = groundedNarration(
            context,
            null,
            event.requestRevision,
            `narration-${sequence++}`,
          )
          socket.receive({
            type: 'narration',
            brief: { ...brief, stopId: event.stopId },
          })
        }
      }
      sockets.push(socket)
      queueMicrotask(() =>
        socket.receive({
          type: 'ready',
          sessionId: 'remote',
          requestRevision: 0,
        }),
      )
      return socket as unknown as WebSocket
    },
    executor: (sessionId, onReceipt, onTakeover) =>
      new TourExecutor(session.harness, {
        sessionId,
        now: () => time,
        onReceipt,
        onTakeover,
      }),
    live: () => live as unknown as LiveConnection,
    playback: () =>
      new ControlledPlayback({
        audio: () => {
          const audio = new EventTarget() as HTMLAudioElement
          audio.play = vi.fn(async () => {})
          audio.pause = vi.fn()
          audio.load = vi.fn()
          audio.removeAttribute = vi.fn()
          clips.push(audio)
          return audio
        },
        url: () => 'blob:clip',
        revoke: vi.fn(),
      }),
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
  return {
    runtime,
    session,
    requests,
    sockets,
    clips,
    live,
    arrive: () => {
      for (let i = 0; i < 400; i++) session.harness.observatory.sample(1 / 60)
      run?.()
    },
    advance: (milliseconds: number) => {
      time += milliseconds
      run?.()
    },
    hide: () => visibility?.(false),
    pendingCreate: (create: () => Promise<Response>) => {
      createResponse = create
    },
    dispose: () => {
      runtime.end()
      session.dispose()
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

describe('the browser guide runtime', () => {
  it('is inert until requested and executes local object names without a model', async () => {
    const f = rig()
    expect(f.requests).toEqual([])
    await f.runtime.ask('Saturn')
    expect(f.requests).toEqual([])
    expect(f.session.harness.observatory.target?.name).toBe('Saturn')
    expect(f.runtime.getSnapshot().state).toBe('traveling')
    f.arrive()
    expect(f.runtime.getSnapshot().state).toBe('viewing')
    f.dispose()
  })

  it('requires playback end and minimum viewing time before advancing an automatic tour', async () => {
    const f = rig()
    await f.runtime.startTour('saturn', true)
    f.arrive()
    await settle()
    await vi.waitFor(() =>
      expect(
        f.clips,
        JSON.stringify({
          state: f.runtime.getSnapshot().state,
          message: f.runtime.getSnapshot().message,
          requests: f.requests.map((r) => r.path),
        }),
      ).toHaveLength(1),
    )
    f.advance(19000)
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    f.clips[0]!.dispatchEvent(new Event('ended'))
    f.advance(500)
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    f.advance(500)
    expect(f.runtime.getSnapshot().stopIndex).toBe(1)
    for (const event of f.sockets[0]!.sent)
      expect(
        tourMessageBytes(JSON.stringify(event)),
        event.type,
      ).toBeLessThanOrEqual(TOUR_LIMITS.messageBytes)
    f.dispose()
  })

  it('ignores stopped audio and resumes with fresh narration at the current view', async () => {
    const f = rig()
    await f.runtime.startTour('saturn', true)
    f.arrive()
    await settle()
    await vi.waitFor(() => expect(f.clips).toHaveLength(1))
    const first = f.clips[0]!
    f.runtime.command('pause')
    first.dispatchEvent(new Event('ended'))
    f.advance(25000)
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    f.runtime.command('resume')
    await settle()
    await vi.waitFor(() => expect(f.clips).toHaveLength(2))
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    f.dispose()
  })

  it('lets a manual view supersede pending speech and skips it when resuming', async () => {
    const f = rig()
    await f.runtime.startTour('saturn', true)
    f.arrive()
    await settle()
    await vi.waitFor(() => expect(f.clips).toHaveLength(1))
    f.session.harness.observatory.focus('s:SOL/b:3', { ease: false })
    f.advance(100)
    expect(f.runtime.getSnapshot().state).toBe('paused')
    f.clips[0]!.dispatchEvent(new Event('ended'))
    f.advance(30000)
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    f.runtime.command('resume')
    expect(f.runtime.getSnapshot().stopIndex).toBe(1)
    f.dispose()
  })

  it('pauses when hidden and Live never advances from output transcript timing', async () => {
    const f = rig()
    await f.runtime.startVoice('marin')
    await f.runtime.startTour('saturn')
    f.arrive()
    const socket = f.sockets[0]!
    socket.receive({
      type: 'transcript',
      eventId: 'output-one',
      text: 'Saturn.',
      speaker: 'guide',
      startMs: 1,
      endMs: 10,
    })
    socket.receive({
      type: 'transcript',
      eventId: 'output-one',
      text: 'Saturn.',
      speaker: 'guide',
      startMs: 1,
      endMs: 10,
    })
    f.advance(60000)
    expect(f.runtime.getSnapshot().stopIndex).toBe(0)
    expect(f.runtime.getSnapshot().transcripts).toHaveLength(1)
    f.hide()
    expect(f.runtime.getSnapshot().state).toBe('paused')
    expect(f.live.muteMicrophone).toHaveBeenLastCalledWith(true)
    f.dispose()
  })

  it('takes a fresh server revision before executing a spoken delegation', async () => {
    const f = rig()
    await f.runtime.startVoice('marin')
    await f.runtime.startTour('saturn')
    f.arrive()
    const socket = f.sockets[0]!
    const contexts = socket.sent.filter((event) => event.type === 'context')
    const context = contexts.at(-1)!.context
    const titan = context.candidates.find(
      (candidate) => candidate.name === 'Titan',
    )!
    const requestRevision = 10
    socket.receive({ type: 'status', state: 'paused', message: 'Listening.' })
    socket.receive({ type: 'ready', sessionId: 'remote', requestRevision })
    socket.receive({
      type: 'status',
      state: 'planning',
      message: 'Considering your request.',
    })
    socket.receive({
      type: 'tool',
      request: {
        sessionId: 'remote',
        requestRevision,
        expectedViewRevision: context.viewRevision,
        operationId: 'spoken-destination',
        expiresAt: 10000,
        action: { tool: 'show_subject', subjectId: titan.id },
      },
    })
    expect(f.session.harness.observatory.target?.name).toBe('Titan')
    f.arrive()
    const receiptIndex = socket.sent.findIndex(
      (event) =>
        event.type === 'receipt' &&
        event.receipt.operationId === 'spoken-destination' &&
        event.receipt.status === 'arrived',
    )
    expect(socket.sent[receiptIndex - 1]?.type).toBe('context')
    f.dispose()
  })

  it('keeps typed requests usable after microphone denial', async () => {
    const f = rig()
    f.live.prepare.mockRejectedValueOnce(
      new Error('Microphone permission was denied.'),
    )
    await f.runtime.startVoice('marin')
    expect(f.runtime.getSnapshot().connection).toBe('offline')
    expect(
      f.requests.some((request) => request.path === '/api/tour/sessions'),
    ).toBe(false)
    await f.runtime.ask('Why does Saturn have rings?')
    expect(f.sockets[0]!.sent.some((event) => event.type === 'ask')).toBe(true)
    expect(f.live.prepare).toHaveBeenCalledOnce()
    f.dispose()
  })

  it('keeps local Next usable after the online connection is lost', async () => {
    const f = rig()
    await f.runtime.startTour('saturn', true)
    f.arrive()
    await settle()
    f.sockets[0]!.dispatchEvent(new Event('close'))
    expect(f.runtime.getSnapshot().connection).toBe('offline')
    f.runtime.command('next')
    expect(f.runtime.getSnapshot().stopIndex).toBe(1)
    expect(
      f.requests.filter((request) => request.path === '/api/tour/sessions'),
    ).toHaveLength(1)
    f.dispose()
  })

  it('explains an uncertain admission conflict without issuing another create', async () => {
    const f = rig()
    f.pendingCreate(async () =>
      Response.json(
        { error: 'Creation belongs to another request.' },
        { status: 409 },
      ),
    )
    await f.runtime.startVoice('marin')
    expect(f.runtime.getSnapshot().message).toContain('30 seconds')
    expect(
      f.requests.filter((request) => request.path === '/api/tour/sessions'),
    ).toHaveLength(1)
    f.dispose()
  })

  it('closes an admitted session that resolves after End even when abort fails', async () => {
    const f = rig()
    let complete!: (response: Response) => void
    f.pendingCreate(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve
        }),
    )
    const starting = f.runtime.startVoice('marin')
    await settle()
    f.runtime.end()
    complete(
      Response.json({ sessionId: 'late', expiresAt: 601000, sdp: 'answer' }),
    )
    await starting
    expect(
      f.requests.some(
        (request) => request.path === '/api/tour/sessions/late/close',
      ),
    ).toBe(true)
    expect(f.sockets).toHaveLength(0)
    expect(f.live.stop).toHaveBeenCalled()
    f.dispose()
  })
})
