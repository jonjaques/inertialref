import { describe, expect, it, vi } from 'vitest'
import type { GuideClientEvent } from '@inertialref/protocol'
import { LiveConnection } from './media.ts'

function audioFake() {
  const element = new EventTarget() as HTMLAudioElement
  element.play = vi.fn(async () => {})
  element.pause = vi.fn()
  return element
}

/** A microphone track: it can end on its own, as an unplugged headset's does. */
function captureTrack() {
  const track = new EventTarget() as EventTarget & {
    enabled: boolean
    stop: ReturnType<typeof vi.fn>
    end: () => void
  }
  track.enabled = true
  track.stop = vi.fn()
  track.end = () => track.dispatchEvent(new Event('ended'))
  return track
}

function channelFake() {
  const channel = new EventTarget() as EventTarget & {
    readyState: string
    send: ReturnType<typeof vi.fn>
  }
  channel.readyState = 'connecting'
  channel.send = vi.fn()
  return channel
}

function peerFake(channel: ReturnType<typeof channelFake>) {
  const sender = { replaceTrack: vi.fn(async () => {}) }
  const listeners = new Map<string, (event: unknown) => void>()
  const peer = {
    createDataChannel: () => channel,
    addTrack: vi.fn(() => sender),
    addEventListener: (name: string, listener: (event: unknown) => void) =>
      listeners.set(name, listener),
    removeEventListener: vi.fn(),
    createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
    connectionState: 'connected',
  }
  return { sender, peer, listeners }
}

/** An audio context that reads a steady level and remembers every source bound to it. */
function contextFake() {
  const sources: {
    connect: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[] = []
  const node = {
    fftSize: 0,
    getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.1),
  }
  const context = {
    state: 'suspended',
    // Resumes on a later tick, as a real context does; an async body would
    // run to its first await at once and the suspended state would never be
    // seen.
    resume: vi.fn(() =>
      Promise.resolve().then(() => {
        context.state = 'running'
      }),
    ),
    close: vi.fn(async () => {}),
    createAnalyser: () => node,
    createMediaStreamSource: () => {
      const source = { connect: vi.fn(), disconnect: vi.fn() }
      sources.push(source)
      return source
    },
  }
  return { context, node, sources }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** A remote stream with one audio track, as the peer's `track` event carries it. */
function remoteStream() {
  const track = { readyState: 'live' }
  return {
    track,
    stream: { getAudioTracks: () => [track], getTracks: () => [track] },
  }
}

function rig(context?: ReturnType<typeof contextFake>['context']) {
  const channel = channelFake()
  const { sender, peer, listeners } = peerFake(channel)
  const track = captureTrack()
  const captures: ReturnType<typeof captureTrack>[] = [track]
  let capture: () => Promise<MediaStream> = async () =>
    ({
      getTracks: () => [captures[captures.length - 1]],
    }) as unknown as MediaStream
  const events: Record<string, unknown>[] = []
  const failures: string[] = []
  const notices: string[] = []
  const audio = audioFake()
  const live = new LiveConnection(
    {
      peer: () => peer as unknown as RTCPeerConnection,
      capture: () => capture(),
      audio: () => audio,
      ...(context === undefined
        ? {}
        : { context: () => context as unknown as AudioContext }),
    },
    (event) => events.push(event),
    (message) => failures.push(message),
    (notice) => notices.push(notice),
  )
  const emit = (event: Record<string, unknown>) =>
    channel.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    )
  const arrive = (remote: ReturnType<typeof remoteStream>) =>
    listeners.get('track')?.({ streams: [remote.stream], track: remote.track })
  /** The next capture hands out a fresh track, or refuses. */
  const recapture = (outcome: 'track' | Error) => {
    capture = async () => {
      if (outcome instanceof Error) throw outcome
      captures.push(captureTrack())
      return {
        getTracks: () => [captures[captures.length - 1]],
      } as unknown as MediaStream
    }
  }
  /** The peer reports a connection state, as `connectionstatechange` would. */
  const connection = (state: string) => {
    peer.connectionState = state
    listeners.get('connectionstatechange')?.({})
  }
  return {
    live,
    channel,
    peer,
    sender,
    track,
    captures,
    recapture,
    connection,
    audio,
    events,
    failures,
    notices,
    emit,
    arrive,
  }
}

describe('the voice connection', () => {
  it('sends only the allow list, only once the channel is open, with its own ids', async () => {
    const f = rig()
    expect(await f.live.prepare()).toBe('offer')
    expect(() => f.live.send({ type: 'response.create' })).toThrow(/not open/)
    f.channel.readyState = 'open'
    // The type refuses it; a cast does not, and the wire is where a cast lands.
    expect(() =>
      f.live.send({
        type: 'session.update',
        session: {},
      } as unknown as GuideClientEvent),
    ).toThrow(/may not send/)
    expect(f.live.send({ type: 'response.create' })).toBe('guide-1')
    expect(
      f.live.send({
        type: 'session.thinking.append',
        delegation_id: null,
        content: 'x',
      }),
    ).toBe('guide-2')
    expect(JSON.parse(String(f.channel.send.mock.calls[0]![0]))).toEqual({
      type: 'response.create',
      event_id: 'guide-1',
    })
    expect(f.channel.send).toHaveBeenCalledTimes(2)
  })

  it('resolves accept on session.started and delivers every event', async () => {
    const f = rig()
    await f.live.prepare()
    const accepted = f.live.accept('answer')
    f.emit({ type: 'session.started', session: { id: 'live_1' } })
    await accepted
    expect(f.peer.setRemoteDescription).toHaveBeenCalledWith({
      type: 'answer',
      sdp: 'answer',
    })
    f.emit({ type: 'session.usage.updated', usage: { seconds: 3 } })
    expect(f.events.map((event) => event.type)).toEqual([
      'session.started',
      'session.usage.updated',
    ])
  })

  it('closes the documented way: session.close, then session.closed, then the peer', async () => {
    const f = rig()
    await f.live.prepare()
    f.channel.readyState = 'open'
    const closing = f.live.close(1000)
    expect(JSON.parse(String(f.channel.send.mock.calls.at(-1)![0])).type).toBe(
      'session.close',
    )
    expect(f.peer.close).not.toHaveBeenCalled()
    f.emit({ type: 'session.closed', reason: 'close_requested' })
    expect(await closing).toEqual({ closed: true })
    expect(f.peer.close).toHaveBeenCalledOnce()
    expect(f.track.stop).toHaveBeenCalledOnce()
    expect(f.live.level()).toBe(0)
  })

  it('meters every remote track it is given, over the whole read interval, and says when it cannot', async () => {
    const audio = contextFake()
    const f = rig(audio.context)
    await f.live.prepare()
    expect(f.live.meter()).toBe('unmeasured')
    expect(f.live.level()).toBe(0)
    const first = remoteStream()
    f.arrive(first)
    // 100 ms between reads; 8,192 samples at 48 kHz is 171 ms, so no audio
    // falls between two reads. At 2,048 the clock heard 43 % of it.
    expect(audio.node.fftSize).toBe(8192)
    expect(f.live.meter()).toBe('suspended')
    await settle()
    expect(f.live.meter()).toBe('ok')
    expect(f.live.level()).toBeCloseTo(0.1, 6)
    // The provider replaces the track: the old one ends, and the next one is
    // bound in its place rather than left reading zero behind it.
    first.track.readyState = 'ended'
    expect(f.live.meter()).toBe('ended')
    const second = remoteStream()
    f.arrive(second)
    expect(audio.sources).toHaveLength(2)
    expect(audio.sources[0]!.disconnect).toHaveBeenCalledOnce()
    expect(audio.sources[1]!.connect).toHaveBeenCalledWith(audio.node)
    expect(f.live.meter()).toBe('ok')
    await settle()
    // A context the browser suspends is asked to resume each time it is seen.
    audio.context.state = 'suspended'
    const resumes = audio.context.resume.mock.calls.length
    expect(f.live.meter()).toBe('suspended')
    expect(audio.context.resume.mock.calls.length).toBe(resumes + 1)
    await settle()
    expect(f.live.meter()).toBe('ok')
  })

  it('gives up on a close the provider never acknowledges', async () => {
    vi.useFakeTimers()
    try {
      const f = rig()
      await f.live.prepare()
      f.channel.readyState = 'open'
      const closing = f.live.close(500)
      await vi.advanceTimersByTimeAsync(600)
      expect(await closing).toEqual({ closed: false })
      expect(f.peer.close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives a disconnected peer a grace, and fails it only when the grace runs out', async () => {
    vi.useFakeTimers()
    try {
      const f = rig()
      await f.live.prepare()
      f.connection('disconnected')
      expect(f.notices).toEqual(['reconnecting'])
      expect(f.failures).toEqual([])
      await vi.advanceTimersByTimeAsync(5000)
      f.connection('connected')
      expect(f.notices).toEqual(['reconnecting', 'connected'])
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.failures).toEqual([])
      f.connection('disconnected')
      await vi.advanceTimersByTimeAsync(10_100)
      expect(f.failures).toEqual(['The voice connection was lost.'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails at once on a peer that failed, and on a channel the provider drops', async () => {
    const f = rig()
    await f.live.prepare()
    f.connection('failed')
    expect(f.failures).toEqual(['The voice connection was interrupted.'])
    const g = rig()
    await g.live.prepare()
    g.channel.dispatchEvent(new Event('close'))
    expect(g.failures).toEqual(['The voice connection was interrupted.'])
    // A channel closing after `session.closed` is the provider's ordinary end.
    const h = rig()
    await h.live.prepare()
    h.emit({ type: 'session.closed', reason: 'close_requested' })
    h.channel.dispatchEvent(new Event('close'))
    expect(h.failures).toEqual([])
  })

  it('replaces a microphone track that ends on its own, and reports when none answers', async () => {
    const f = rig()
    await f.live.prepare()
    f.recapture('track')
    f.track.end()
    await settle()
    expect(f.captures).toHaveLength(2)
    expect(f.sender.replaceTrack).toHaveBeenLastCalledWith(f.captures[1])
    expect(f.notices).toEqual([])
    f.recapture(new Error('Requested device not found'))
    f.captures[1]!.end()
    await settle()
    await settle()
    expect(f.notices).toEqual(['microphone-lost'])
    expect(f.failures).toEqual([])
    // A track this connection stopped itself says nothing.
    f.live.stop()
    expect(f.notices).toEqual(['microphone-lost'])
  })

  it('keeps the session when playback is refused, and retries on the next unmute', async () => {
    const f = rig()
    await f.live.prepare()
    f.audio.play = vi.fn(async () => {
      throw new Error('NotAllowedError')
    })
    f.arrive(remoteStream())
    await settle()
    expect(f.notices).toEqual(['playback-blocked'])
    expect(f.failures).toEqual([])
    f.audio.play = vi.fn(async () => {})
    f.live.muteGuide(false)
    expect(f.audio.play).toHaveBeenCalledOnce()
    await settle()
    expect(f.notices).toEqual(['playback-blocked'])
    // One retry per refusal, not one per unmute.
    f.live.muteGuide(false)
    expect(f.audio.play).toHaveBeenCalledOnce()
  })

  it('refuses a frame it cannot read, and says so', async () => {
    const f = rig()
    await f.live.prepare()
    f.channel.dispatchEvent(
      new MessageEvent('message', { data: 'x'.repeat(65_537) }),
    )
    expect(f.failures).toEqual([
      'The voice connection sent more than the guide can read.',
    ])
    expect(f.events).toEqual([])
  })
})
