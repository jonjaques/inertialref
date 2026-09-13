import { describe, expect, it, vi } from 'vitest'
import {
  attachLiveSession,
  createLiveSession,
  hangupLiveSession,
  LiveSideband,
  TranscriptAssembler,
  type LiveSocket,
} from './openaiLive.ts'
import { callResponsesDirector, synthesizeSpeech } from './openaiResponses.ts'

function socket() {
  const listeners = new Map<string, (event: { data: unknown }) => void>()
  return {
    send: vi.fn(),
    close: vi.fn(),
    accept: vi.fn(),
    addEventListener: (
      name: string,
      listener: (event: { data: unknown }) => void,
    ) => listeners.set(name, listener),
    emit: (data: unknown) =>
      listeners.get('message')?.({ data: JSON.stringify(data) }),
    finish: (code: number) =>
      listeners.get('close')?.({ code, wasClean: false } as unknown as {
        data: unknown
      }),
  }
}

describe('Live provider boundary', () => {
  it('authors a friendly astronomy enthusiast voice without permitting invented science', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'session-1' },
          transport: { sdp: 'answer' },
        }),
    )
    await createLiveSession({
      apiKey: 'fake',
      sdp: 'offer',
      fetch: fetcher as typeof fetch,
    })
    const instructions = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
      .session.instructions as string
    expect(instructions).toContain('friendly astronomy nerd')
    expect(instructions).toContain('natural contractions')
    expect(instructions).toContain(
      'specific curiosity hook from established astronomy or the supplied records',
    )
    expect(instructions).toContain('Vary your cadence')
    expect(instructions).toContain(
      'Application measurements and current-view state remain authoritative.',
    )
    expect(instructions).toContain(
      'Use your established knowledge of real Solar System history, discoveries, science, and fun facts without delegating every factual question.',
    )
    expect(instructions).toContain(
      'Projected worlds have no real mission or discovery history.',
    )
    expect(instructions).toContain(
      'When the application says a tour narration is playing, stay quiet and listen; do not repeat the clip or fill its looking pause.',
    )
    expect(instructions).toContain(
      'Delegate spoken pause, resume, next, back, and end controls immediately instead of only acknowledging them.',
    )
  })

  it('instructs the narrator to answer about Titan while Saturn remains in view', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'session-1' },
          transport: { sdp: 'answer' },
        }),
    )
    await createLiveSession({
      apiKey: 'fake',
      sdp: 'offer',
      context: 'Current view: Saturn. Verified brief: Saturn has rings.',
      fetch: fetcher as typeof fetch,
    })
    const instructions = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
      .session.instructions as string
    expect(instructions).toContain(
      'Application commentary is the prepared answer to the latest visitor request.',
    )
    expect(instructions).toContain(
      'Speak that answer faithfully, even when its subject differs from the current view.',
    )
    expect(instructions).toContain(
      'Never substitute an older brief for the new answer.',
    )
    expect(instructions).toContain(
      'Do not claim the view changed without application confirmation.',
    )
    expect(instructions).toContain(
      'Never speak stage directions such as Pause; apply them silently to your delivery.',
    )
  })

  it('supplies the verified initial brief and keeps a failed trace sink out of socket control', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'session-1' },
          transport: { sdp: 'answer' },
        }),
    )
    await createLiveSession({
      apiKey: 'fake',
      sdp: 'offer',
      context: 'Current verified brief: Saturn has rings.',
      fetch: fetcher as typeof fetch,
    })
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body.session.instructions).toContain(
      'Current verified brief: Saturn has rings.',
    )
    const wire = socket()
    const events = vi.fn()
    const live = new LiveSideband(wire as LiveSocket, events, () => {
      throw new Error('sink failed')
    })
    expect(live.append('commentary', 'Saturn has rings.')).toBe('guide-1')
    wire.finish(1006)
    expect(events).toHaveBeenCalledWith({
      type: 'error',
      code: 'connection-lost',
    })
  })

  it('traces Live messages and lifecycle without credentials, SDP, or reflected audio', async () => {
    const trace = vi.fn()
    await createLiveSession({
      apiKey: 'credential-canary',
      sdp: 'offer-canary',
      trace,
      fetch: (async () =>
        Response.json({
          session: { id: 'session-1' },
          transport: { sdp: 'answer-canary' },
        })) as typeof fetch,
    })
    const wire = socket()
    const live = new LiveSideband(wire as LiveSocket, () => {}, trace)
    live.append('commentary', 'Saturn has rings.', 'delegation-1')
    wire.emit({ type: 'session.output_audio.delta', audio: 'audio-canary' })
    wire.emit({
      type: 'session.input_transcript.delta',
      event_id: 'transcript-1',
      delta: 'Tell me about Saturn.',
      start_ms: 0,
      end_ms: 100,
      audio: 'extra-audio-canary',
    })
    wire.emit({
      type: 'error',
      code: 'invalid_request',
      message: 'credential-canary',
    })
    live.disconnect()
    const events = trace.mock.calls.map(([event]) => event)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'provider.request',
          model: 'gpt-live-1',
          data: expect.objectContaining({
            endpoint: '/v1/live/sessions',
            instructions: expect.any(String),
          }),
        }),
        expect.objectContaining({
          event: 'provider.response',
          model: 'gpt-live-1',
          data: expect.objectContaining({
            status: 200,
            sessionId: 'session-1',
          }),
        }),
        expect.objectContaining({
          event: 'live.send',
          model: 'gpt-live-1',
          data: expect.objectContaining({ content: 'Saturn has rings.' }),
        }),
        expect.objectContaining({
          event: 'live.receive',
          model: 'gpt-live-1',
          data: expect.objectContaining({ delta: 'Tell me about Saturn.' }),
        }),
        expect.objectContaining({
          event: 'provider.error',
          model: 'gpt-live-1',
          data: expect.objectContaining({ code: 'invalid_request' }),
        }),
        expect.objectContaining({
          event: 'live.close',
          model: 'gpt-live-1',
          data: expect.objectContaining({ origin: 'application' }),
        }),
      ]),
    )
    const logged = JSON.stringify(events)
    for (const secret of [
      'credential-canary',
      'offer-canary',
      'answer-canary',
      'audio-canary',
      'extra-audio-canary',
      'Authorization',
    ])
      expect(logged).not.toContain(secret)
  })

  it('releases the upgrade deadline after the sideband is accepted', async () => {
    vi.useFakeTimers()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), ms)
        return controller.signal
      })
    const wire = socket()
    let signal: AbortSignal | null | undefined
    let live: LiveSideband | undefined
    try {
      live = await attachLiveSession({
        apiKey: 'fake',
        id: 'live-session',
        onEvent: () => {},
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal
          return { status: 101, webSocket: wire } as unknown as Response
        }) as typeof fetch,
      })
      expect(wire.accept).toHaveBeenCalledOnce()
      expect(signal).toBeDefined()
      await vi.advanceTimersByTimeAsync(13_000)
      expect(signal?.aborted).toBe(false)
    } finally {
      live?.disconnect()
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it('still aborts a sideband handshake that does not complete by its deadline', async () => {
    vi.useFakeTimers()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockImplementation((ms) => {
        const controller = new AbortController()
        setTimeout(() => controller.abort(), ms)
        return controller.signal
      })
    let signal: AbortSignal | null | undefined
    try {
      const pending = attachLiveSession({
        apiKey: 'fake',
        id: 'live-session',
        onEvent: () => {},
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          signal = init?.signal
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          })
          return new Response()
        }) as typeof fetch,
      })
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'unavailable',
      })
      await vi.advanceTimersByTimeAsync(12_000)
      await rejected
      expect(signal?.aborted).toBe(true)
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps the startup deadline when the caller supplies its own cancellation signal', async () => {
    const deadline = new AbortController()
    const caller = new AbortController()
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(deadline.signal)
    try {
      const fetcher = vi.fn(
        async (_url: RequestInfo | URL, init?: RequestInit) => {
          await new Promise<void>((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => reject(new Error('aborted')),
              { once: true },
            ),
          )
          return new Response()
        },
      )
      const pending = createLiveSession({
        apiKey: 'fake',
        sdp: 'offer',
        signal: caller.signal,
        fetch: fetcher as typeof fetch,
      })
      expect(timeout).toHaveBeenCalledWith(12_000)
      deadline.abort()
      await expect(pending).rejects.toMatchObject({ code: 'unavailable' })
      expect(caller.signal.aborted).toBe(false)
    } finally {
      timeout.mockRestore()
    }
  })
  it('releases the socket when the provider closes before an application close request', async () => {
    const wire = socket()
    const live = new LiveSideband(wire as LiveSocket, () => {})
    wire.emit({
      type: 'session.closed',
      usage: { seconds: 17 },
      reason: 'expired',
    })
    expect(wire.close).toHaveBeenCalledTimes(1)
    await expect(live.close()).resolves.toEqual({
      finalized: true,
      seconds: 17,
    })
  })

  it('revokes a lost sideband through HTTP without inventing final usage', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    )
    await expect(
      hangupLiveSession({
        apiKey: 'secret',
        id: 'opaque/session',
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toBeUndefined()
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      'https://api.openai.com/v1/live/sessions/opaque%2Fsession/hangup',
    )
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST')
  })
  it('creates the Live WebRTC shape and denies client-side commands', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          session: { id: 'live-session' },
          transport: { sdp: 'answer' },
        }),
    )
    await expect(
      createLiveSession({
        apiKey: 'secret',
        sdp: 'offer',
        fetch: fetcher as typeof fetch,
      }),
    ).resolves.toEqual({ id: 'live-session', sdp: 'answer' })
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      session: {
        model: 'gpt-live-1',
        store: false,
        delegation: { type: 'client' },
        client: { data_channel: { allowed_client_events: [] } },
      },
      transport: { type: 'webrtc', sdp: 'offer' },
    })
    expect(body.session.audio.output.voice).toBe('marin')
    expect(body.session.instructions).toContain(
      'No current-view record is available.',
    )
  })

  it('does not retain reflected audio, treats usage as cumulative and waits for finalization', async () => {
    const wire = socket()
    const events: unknown[] = []
    const live = new LiveSideband(wire as LiveSocket, (event) =>
      events.push(event),
    )
    wire.emit({ type: 'session.input_audio.append', audio: 'private audio' })
    wire.emit({ type: 'session.usage.updated', usage: { seconds: 12 } })
    wire.emit({ type: 'session.usage.updated', usage: { seconds: 11 } })
    const closing = live.close(100)
    expect(wire.close).not.toHaveBeenCalled()
    wire.emit({
      type: 'session.closed',
      usage: { seconds: 14 },
      reason: 'client_request',
    })
    await expect(closing).resolves.toEqual({ finalized: true, seconds: 14 })
    expect(events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ audio: expect.anything() }),
      ]),
    )
    expect(JSON.parse(wire.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: 'session.close',
    })
  })

  it('distinguishes append acknowledgement and closure timeout from playback completion', async () => {
    const wire = socket()
    const events: unknown[] = []
    const live = new LiveSideband(wire as LiveSocket, (event) =>
      events.push(event),
    )
    live.append('commentary', 'Saturn has rings.', 'delegation-1')
    wire.emit({
      type: 'session.commentary.appended',
      client_event_id: 'guide-1',
      start_ms: 1,
      end_ms: 2,
    })
    expect(events).toEqual([{ type: 'appended', eventId: 'guide-1' }])
    await expect(live.close(1)).resolves.toEqual({
      finalized: false,
      seconds: 0,
    })
  })

  it('accepts the coordinator narration budget and measures its limit in UTF-8 bytes', () => {
    const wire = socket()
    const live = new LiveSideband(wire as LiveSocket, () => {})
    const content = 'é'.repeat(1000)

    expect(live.append('commentary', content, 'delegation-1')).toBe('guide-1')
    expect(JSON.parse(wire.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: 'session.commentary.append',
      content,
      delegation_id: 'delegation-1',
    })
    expect(() => live.append('commentary', `${content}a`)).toThrowError(
      expect.objectContaining({ code: 'input-limit' }),
    )
    expect(wire.send).toHaveBeenCalledTimes(1)
  })

  it('preserves raw transcript spacing and waits for late correction fragments', async () => {
    const transcript = new TranscriptAssembler(10)
    transcript.add({
      type: 'transcript',
      id: 'a',
      speaker: 'user',
      delta: 'Show me Titan',
      startMs: 0,
      endMs: 500,
    })
    const request = transcript.request({
      type: 'delegation',
      id: 'd',
      offsetMs: 1000,
    })
    transcript.add({
      type: 'transcript',
      id: 'c',
      speaker: 'user',
      delta: ', actually Enceladus',
      startMs: 500,
      endMs: 1000,
    })
    transcript.add({
      type: 'transcript',
      id: 'b',
      speaker: 'guide',
      delta: 'Okay.',
      startMs: 300,
      endMs: 900,
    })
    await expect(request).resolves.toEqual({
      id: 'd',
      offsetMs: 1000,
      text: 'Show me Titan, actually Enceladus',
    })
    await expect(
      transcript.request({ type: 'delegation', id: 'd', offsetMs: 1000 }),
    ).resolves.toBeNull()
  })

  it('includes the real Titan boundary fragment once without borrowing the next utterance', async () => {
    const transcript = new TranscriptAssembler(0)
    const fragments = [
      { id: 'a', delta: 'Please', startMs: 1000, endMs: 1200 },
      { id: 'b', delta: ' show', startMs: 1200, endMs: 1400 },
      { id: 'c', delta: ' me', startMs: 1400, endMs: 1600 },
      { id: 'd', delta: ' Titan.', startMs: 2000, endMs: 2200 },
      { id: 'e', delta: 'Actually, Enceladus.', startMs: 2200, endMs: 2800 },
    ]
    for (const fragment of fragments)
      transcript.add({ ...fragment, type: 'transcript', speaker: 'user' })

    await expect(
      transcript.request({ type: 'delegation', id: 'first', offsetMs: 2000 }),
    ).resolves.toEqual({
      id: 'first',
      offsetMs: 2000,
      text: 'Please show me Titan.',
    })
    await expect(
      transcript.request({ type: 'delegation', id: 'second', offsetMs: 2800 }),
    ).resolves.toEqual({
      id: 'second',
      offsetMs: 2800,
      text: 'Actually, Enceladus.',
    })
  })
})

describe('Responses provider boundary', () => {
  it('gives controlled speech warmth and varied cadence while keeping its exact script', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('audio'),
    )
    const text =
      'Titan has a dense atmosphere and a weather cycle involving methane.'
    await synthesizeSpeech({
      apiKey: 'fake',
      text,
      fetch: fetcher as typeof fetch,
    })
    const body = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: text,
    })
    expect(body.instructions).toContain('friendly astronomy nerd')
    expect(body.instructions).toContain('Vary your cadence')
    expect(body.instructions).toContain(
      'Read the supplied text exactly; do not add words, facts, jokes, or personal experiences.',
    )
    expect(body.instructions).toContain(
      'one idea, then leave a little room to look',
    )
  })

  it('traces Astra text, structured output and usage while sanitizing failures', async () => {
    const trace = vi.fn()
    await callResponsesDirector({
      apiKey: 'credential-canary',
      input: 'Tell me about Saturn.',
      instructions: 'Use the supplied facts.',
      schema: { type: 'object' },
      trace,
      fetch: (async () =>
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [
                { type: 'output_text', text: '{"kind":"explanation"}' },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 3 },
        })) as typeof fetch,
    })
    await expect(
      callResponsesDirector({
        apiKey: 'credential-canary',
        input: 'request',
        instructions: 'instructions',
        schema: {},
        trace,
        fetch: (async () =>
          new Response('credential-canary', { status: 401 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'unavailable' })
    const events = trace.mock.calls.map(([event]) => event)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'provider.request',
          model: 'gpt-6-astra',
          data: expect.objectContaining({
            endpoint: '/v1/responses',
            input: 'Tell me about Saturn.',
            instructions: 'Use the supplied facts.',
          }),
        }),
        expect.objectContaining({
          event: 'provider.response',
          model: 'gpt-6-astra',
          data: expect.objectContaining({
            status: 200,
            output: { kind: 'explanation' },
            usage: { inputTokens: 12, outputTokens: 3 },
            latencyMs: expect.any(Number),
          }),
        }),
        expect.objectContaining({
          event: 'provider.error',
          model: 'gpt-6-astra',
          data: expect.objectContaining({ status: 401, code: 'unavailable' }),
        }),
      ]),
    )
    expect(JSON.stringify(events)).not.toContain('credential-canary')
    expect(JSON.stringify(events)).not.toContain('Authorization')
  })

  it('traces controlled speech text and byte counts without logging audio', async () => {
    const trace = vi.fn()
    await synthesizeSpeech({
      apiKey: 'credential-canary',
      text: 'Saturn has rings.',
      trace,
      fetch: (async () => new Response('audio-canary')) as typeof fetch,
    })
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider.request',
        model: 'gpt-4o-mini-tts',
        data: expect.objectContaining({
          input: 'Saturn has rings.',
          voice: 'marin',
        }),
      }),
    )
    expect(trace).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'provider.response',
        model: 'gpt-4o-mini-tts',
        data: expect.objectContaining({ audioBytes: 12 }),
      }),
    )
    expect(JSON.stringify(trace.mock.calls)).not.toContain('audio-canary')
    expect(JSON.stringify(trace.mock.calls)).not.toContain('credential-canary')
  })

  it('bounds Astra reasoning/output and never stores input', async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({
          status: 'completed',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: '{"value":1}' }],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 9 },
        }),
    )
    const result = await callResponsesDirector({
      apiKey: 'secret',
      input: 'request',
      instructions: 'director',
      schema: { type: 'object' },
      fetch: fetcher as typeof fetch,
    })
    expect(result).toEqual({
      value: { value: 1 },
      usage: { inputTokens: 12, outputTokens: 9 },
      model: 'gpt-6-astra',
    })
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: 'gpt-6-astra',
      reasoning: { effort: 'low' },
      max_output_tokens: 2000,
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    })
  })

  it('sanitizes provider errors and refuses incomplete output', async () => {
    const rejected = vi.fn(
      async () => new Response('secret sk-do-not-print', { status: 401 }),
    )
    await expect(
      callResponsesDirector({
        apiKey: 'secret',
        input: '',
        instructions: '',
        schema: {},
        fetch: rejected as typeof fetch,
      }),
    ).rejects.toThrow('The guide provider is unavailable.')
    const incomplete = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ status: 'incomplete', output: [] }),
    )
    await expect(
      callResponsesDirector({
        apiKey: 'secret',
        input: '',
        instructions: '',
        schema: {},
        fetch: incomplete as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'incomplete' })
  })
})
