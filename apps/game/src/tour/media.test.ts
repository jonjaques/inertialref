import { describe, expect, it, vi } from 'vitest'
import { LiveConnection } from './media.ts'

function audioFake() {
  const element = new EventTarget() as HTMLAudioElement
  element.play = vi.fn(async () => {})
  element.pause = vi.fn()
  return element
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

function rig() {
  const channel = channelFake()
  const { peer } = peerFake(channel)
  const track = { enabled: true, stop: vi.fn() }
  const events: Record<string, unknown>[] = []
  const failures: string[] = []
  const live = new LiveConnection(
    {
      peer: () => peer as unknown as RTCPeerConnection,
      capture: async () =>
        ({ getTracks: () => [track] }) as unknown as MediaStream,
      audio: audioFake,
    },
    (event) => events.push(event),
    (message) => failures.push(message),
  )
  const emit = (event: Record<string, unknown>) =>
    channel.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) }),
    )
  return { live, channel, peer, track, events, failures, emit }
}

describe('the voice connection', () => {
  it('sends only the allow list, only once the channel is open, with its own ids', async () => {
    const f = rig()
    expect(await f.live.prepare()).toBe('offer')
    expect(() => f.live.send({ type: 'response.create' })).toThrow(/not open/)
    f.channel.readyState = 'open'
    expect(() => f.live.send({ type: 'session.update', session: {} })).toThrow(
      /may not send/,
    )
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
})
