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
    media.muteMicrophone(true)
    expect(track.enabled).toBe(false)
    expect(audio.muted).not.toBe(true)
    media.stop()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(pc.close).toHaveBeenCalledTimes(1)
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
