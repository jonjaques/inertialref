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
    })
    await media.prepare()
    await media.muteMicrophone(true)
    expect(original.stop).toHaveBeenCalledOnce()
    expect(capture).toHaveBeenCalledTimes(1)
    await media.muteMicrophone(false)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(sender.replaceTrack).toHaveBeenLastCalledWith(replacement)
    await media.muteMicrophone(true)
    expect(replacement.stop).toHaveBeenCalledOnce()
    const pending = media.muteMicrophone(false)
    media.stop()
    finish({ getTracks: () => [late] } as unknown as MediaStream)
    await pending
    expect(late.stop).toHaveBeenCalledOnce()
    expect(sender.replaceTrack).not.toHaveBeenCalledWith(late)
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
