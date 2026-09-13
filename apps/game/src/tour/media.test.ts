import { describe, expect, it, vi } from 'vitest'
import { ControlledPlayback, LiveConnection } from './media.ts'

function audioFake() {
  const element = new EventTarget() as HTMLAudioElement
  element.play = vi.fn(async () => {})
  element.pause = vi.fn()
  element.load = vi.fn()
  element.removeAttribute = vi.fn()
  return element
}

function silenceFake() {
  const track = { enabled: true, stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const destination = { stream, channelCount: 2, disconnect: vi.fn() }
  const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }
  const source = {
    connect: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    disconnect: vi.fn(),
  }
  const context = {
    createMediaStreamDestination: vi.fn(() => destination),
    createGain: vi.fn(() => gain),
    createOscillator: vi.fn(() => source),
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    destination: {},
  }
  return { track, stream, destination, gain, source, context }
}

function peerFake() {
  const sender = { replaceTrack: vi.fn(async () => {}) }
  const peer = {
    createDataChannel: () => new EventTarget(),
    addTrack: vi.fn(() => sender),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
    setLocalDescription: vi.fn(async () => {}),
    close: vi.fn(),
  }
  return { sender, peer }
}

describe('controlled narration', () => {
  it('requires actual playback end and discards stale completion after stopping', async () => {
    const element = audioFake()
    const ended = vi.fn()
    const playback = new ControlledPlayback({
      audio: () => element,
      url: () => 'blob:clip',
      revoke: vi.fn(),
    })
    await playback.play(new Blob(['clip']), ended)
    expect(ended).not.toHaveBeenCalled()
    element.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(1)
    await playback.play(new Blob(['next']), ended)
    playback.stop()
    element.dispatchEvent(new Event('ended'))
    expect(ended).toHaveBeenCalledTimes(1)
  })

  it('reports a decoding failure after playback has started and removes its completion', async () => {
    const element = audioFake()
    const ended = vi.fn()
    const failed = vi.fn()
    const playback = new ControlledPlayback({
      audio: () => element,
      url: () => 'blob:clip',
      revoke: vi.fn(),
    })
    await playback.play(new Blob(['clip']), ended, failed)
    element.dispatchEvent(new Event('error'))
    element.dispatchEvent(new Event('ended'))
    expect(failed).toHaveBeenCalledOnce()
    expect(ended).not.toHaveBeenCalled()
  })

  it('keeps audio mute independent and stops rejected playback', async () => {
    const element = audioFake()
    const revoke = vi.fn()
    const playback = new ControlledPlayback({
      audio: () => element,
      url: () => 'blob:clip',
      revoke,
    })
    playback.mute(true)
    await playback.play(new Blob(['clip']), vi.fn())
    expect(element.muted).toBe(true)
    playback.stop()
    expect(revoke).toHaveBeenCalledWith('blob:clip')
  })
})

describe('Live admission', () => {
  it('listens before offer creation and retains early session.started', async () => {
    const channel = new EventTarget()
    const track = { enabled: true, stop: vi.fn() }
    const audio = audioFake()
    const pc = {
      createDataChannel: vi.fn(() => channel),
      addTrack: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createOffer: vi.fn(async () => {
        channel.dispatchEvent(
          new MessageEvent('message', {
            data: JSON.stringify({ type: 'session.started' }),
          }),
        )
        return { type: 'offer', sdp: 'offer' }
      }),
      setLocalDescription: vi.fn(async () => {}),
      setRemoteDescription: vi.fn(async () => {}),
      close: vi.fn(),
    }
    const media = new LiveConnection(
      {
        peer: () => pc as unknown as RTCPeerConnection,
        capture: async () =>
          ({ getTracks: () => [track] }) as unknown as MediaStream,
        audio: () => audio,
      },
      vi.fn(),
    )
    expect(await media.prepare()).toBe('offer')
    await media.accept('answer')
    expect(pc.createDataChannel).toHaveBeenCalledWith('oai-events')
    await media.muteMicrophone(true)
    expect(track.enabled).toBe(false)
    expect(track.stop).toHaveBeenCalledOnce()
    expect(audio.muted).not.toBe(true)
    media.muteGuide(true)
    media.muteGuide(false)
    expect(audio.pause).not.toHaveBeenCalled()
    media.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(pc.close).toHaveBeenCalledTimes(1)
  })

  it('reacquires capture only on explicit unmute and discards it after End', async () => {
    const silent = silenceFake()
    const secondSilence = silenceFake()
    const createContext = vi
      .fn()
      .mockReturnValueOnce(silent.context)
      .mockReturnValueOnce(secondSilence.context)
    const original = { enabled: true, stop: vi.fn() }
    const replacement = { enabled: true, stop: vi.fn() }
    const late = { enabled: true, stop: vi.fn() }
    let finish!: (value: MediaStream) => void
    const sender = { replaceTrack: vi.fn(async () => {}) }
    const channel = new EventTarget()
    const peer = {
      createDataChannel: () => channel,
      addTrack: () => sender,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      createOffer: async () => ({ type: 'offer', sdp: 'offer' }),
      setLocalDescription: vi.fn(async () => {}),
      close: vi.fn(),
    }
    const capture = vi
      .fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce({
        getTracks: () => [original],
      } as unknown as MediaStream)
      .mockResolvedValueOnce({
        getTracks: () => [replacement],
      } as unknown as MediaStream)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
    const media = new LiveConnection({
      peer: () => peer as unknown as RTCPeerConnection,
      audio: audioFake,
      capture,
      context: createContext,
    })
    await media.prepare()
    expect(createContext).not.toHaveBeenCalled()
    await media.muteMicrophone(true)
    expect(original.stop).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledTimes(1)
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(silent.track)
    expect(silent.destination.channelCount).toBe(1)
    expect(silent.source.start).toHaveBeenCalledOnce()
    expect(silent.gain.gain.value).toBeGreaterThan(0)
    expect(silent.gain.gain.value).toBeLessThan(0.000001)
    expect(silent.source.connect).toHaveBeenCalledWith(silent.gain)
    expect(silent.gain.connect).toHaveBeenCalledWith(silent.destination)
    expect(silent.gain.connect).not.toHaveBeenCalledWith(
      silent.context.destination,
    )
    await media.muteMicrophone(false)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(replacement)
    expect(silent.source.stop).toHaveBeenCalledOnce()
    expect(silent.track.stop).toHaveBeenCalledOnce()
    expect(silent.context.close).toHaveBeenCalledOnce()
    await media.muteMicrophone(true)
    expect(replacement.stop).toHaveBeenCalledOnce()
    const pending = media.muteMicrophone(false)
    media.stop()
    finish({ getTracks: () => [late] } as unknown as MediaStream)
    await pending
    expect(late.stop).toHaveBeenCalledOnce()
    expect(sender.replaceTrack).not.toHaveBeenCalledWith(late)
    expect(secondSilence.track.stop).toHaveBeenCalledOnce()
    expect(secondSilence.context.close).toHaveBeenCalledOnce()
  })

  it('starts an already-muted connection without requesting microphone capture', async () => {
    const silent = silenceFake()
    const { peer, sender } = peerFake()
    const capture = vi.fn()
    const context = vi.fn(() => silent.context as unknown as AudioContext)
    const media = new LiveConnection({
      peer: () => peer as unknown as RTCPeerConnection,
      audio: audioFake,
      capture,
      context,
    })
    await media.muteMicrophone(true)
    expect(context).not.toHaveBeenCalled()
    expect(await media.prepare()).toBe('offer')
    expect(capture).not.toHaveBeenCalled()
    expect(peer.addTrack).toHaveBeenCalledWith(silent.track, silent.stream)
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(silent.track)
    media.stop()
    media.stop()
    expect(silent.source.stop).toHaveBeenCalledOnce()
    expect(silent.source.disconnect).toHaveBeenCalledOnce()
    expect(silent.gain.disconnect).toHaveBeenCalledOnce()
    expect(silent.destination.disconnect).toHaveBeenCalledOnce()
    expect(silent.track.stop).toHaveBeenCalledOnce()
    expect(silent.context.close).toHaveBeenCalledOnce()
  })

  it('releases silence immediately on End and cannot attach it after delayed startup', async () => {
    const silent = silenceFake()
    const { peer, sender } = peerFake()
    const real = { enabled: true, stop: vi.fn() }
    let finish!: () => void
    silent.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        }),
    )
    const capture = vi.fn(
      async () => ({ getTracks: () => [real] }) as unknown as MediaStream,
    )
    const media = new LiveConnection({
      peer: () => peer as unknown as RTCPeerConnection,
      audio: audioFake,
      capture,
      context: () => silent.context as unknown as AudioContext,
    })
    await media.prepare()
    const muting = media.muteMicrophone(true)
    expect(real.stop).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledOnce()
    media.stop()
    expect(silent.track.stop).toHaveBeenCalledOnce()
    expect(silent.context.close).toHaveBeenCalledOnce()
    finish()
    await muting
    expect(sender.replaceTrack).not.toHaveBeenCalled()
  })

  it('restores the silent carrier when explicit unmute fails during its startup', async () => {
    const silent = silenceFake()
    const { peer, sender } = peerFake()
    const real = { enabled: true, stop: vi.fn() }
    let resume!: () => void
    let deny!: (cause: Error) => void
    silent.context.resume.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resume = resolve
        }),
    )
    const capture = vi
      .fn<() => Promise<MediaStream>>()
      .mockResolvedValueOnce({
        getTracks: () => [real],
      } as unknown as MediaStream)
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            deny = reject
          }),
      )
    const media = new LiveConnection({
      peer: () => peer as unknown as RTCPeerConnection,
      audio: audioFake,
      capture,
      context: () => silent.context as unknown as AudioContext,
    })
    await media.prepare()
    const muting = media.muteMicrophone(true)
    const unmuting = media.muteMicrophone(false)
    resume()
    await muting
    expect(sender.replaceTrack).not.toHaveBeenCalled()
    deny(new Error('Microphone denied'))
    await expect(unmuting).rejects.toThrow('Microphone denied')
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(silent.track)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(real.stop).toHaveBeenCalledOnce()
    expect(silent.track.stop).not.toHaveBeenCalled()
    media.stop()
    expect(silent.context.close).toHaveBeenCalledOnce()
  })

  it('releases media acquired after the guide has ended', async () => {
    let capture!: (value: MediaStream) => void
    const track = { enabled: true, stop: vi.fn() }
    const peer = vi.fn()
    const media = new LiveConnection(
      {
        peer,
        capture: () =>
          new Promise((resolve) => {
            capture = resolve
          }),
        audio: audioFake,
      },
      vi.fn(),
    )
    const pending = media.prepare()
    media.stop()
    capture({ getTracks: () => [track] } as unknown as MediaStream)
    await expect(pending).rejects.toThrow('ended')
    expect(track.stop).toHaveBeenCalledOnce()
    expect(peer).not.toHaveBeenCalled()
  })
})
