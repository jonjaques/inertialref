export interface ClipHost {
  audio(): HTMLAudioElement
  url(blob: Blob): string
  revoke(url: string): void
}

const clipHost: ClipHost = {
  audio: () => new Audio(),
  url: (blob) => URL.createObjectURL(blob),
  revoke: (url) => URL.revokeObjectURL(url),
}

/** Completion comes from the playing element, never a model acknowledgment. */
export class ControlledPlayback {
  #audio: HTMLAudioElement | null = null
  #release: (() => void) | null = null
  #muted = false
  constructor(private readonly host: ClipHost = clipHost) {}

  async play(blob: Blob, ended: () => void): Promise<void> {
    this.stop()
    const audio = this.host.audio()
    const url = this.host.url(blob)
    this.#audio = audio
    audio.src = url
    audio.muted = this.#muted
    const onEnd = () => {
      if (this.#audio !== audio) return
      this.stop()
      ended()
    }
    audio.addEventListener('ended', onEnd, { once: true })
    this.#release = () => {
      audio.removeEventListener('ended', onEnd)
      this.host.revoke(url)
    }
    try {
      await audio.play()
    } catch (cause) {
      if (this.#audio === audio) this.stop()
      throw cause
    }
  }

  mute(muted: boolean): void {
    this.#muted = muted
    if (this.#audio !== null) this.#audio.muted = muted
  }

  stop(): void {
    this.#release?.()
    this.#release = null
    this.#audio?.pause()
    this.#audio?.removeAttribute('src')
    this.#audio?.load()
    this.#audio = null
  }
}

export interface LiveEvent {
  readonly type: string
  readonly event_id?: string
  readonly delta?: string
  readonly start_ms?: number
  readonly end_ms?: number
}

interface LiveHost {
  peer(): RTCPeerConnection
  capture(): Promise<MediaStream>
  audio(): HTMLAudioElement
}

const liveHost: LiveHost = {
  peer: () => new RTCPeerConnection(),
  capture: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    }),
  audio: () => new Audio(),
}

/** The data channel is receive-only. The coordinator owns all provider commands. */
export class LiveConnection {
  #peer: RTCPeerConnection | null = null
  #stream: MediaStream | null = null
  #audio: HTMLAudioElement | null = null
  #stopped = false
  #started = false
  #release: (() => void) | null = null
  #resolve: (() => void) | null = null
  #reject: ((cause: Error) => void) | null = null
  #micMuted = false
  #guideMuted = false

  constructor(
    private readonly host: LiveHost = liveHost,
    private readonly onEvent: (event: LiveEvent) => void = () => {},
    private readonly onFailure: (message: string) => void = () => {},
  ) {}

  async prepare(): Promise<string> {
    const stream = await this.host.capture()
    if (this.#stopped) {
      for (const track of stream.getTracks()) track.stop()
      throw new Error('The guide has ended.')
    }
    this.#stream = stream
    const peer = this.host.peer()
    this.#peer = peer
    const audio = this.host.audio()
    this.#audio = audio
    audio.autoplay = true
    audio.muted = this.#guideMuted
    const channel = peer.createDataChannel('oai-events')
    const message = (event: MessageEvent) => {
      if (
        this.#stopped ||
        typeof event.data !== 'string' ||
        event.data.length > 65536
      )
        return
      let value: LiveEvent
      try {
        value = JSON.parse(event.data) as LiveEvent
      } catch {
        return
      }
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof value.type !== 'string'
      )
        return
      if (value.type === 'session.started') {
        this.#started = true
        this.#resolve?.()
      }
      this.onEvent(value)
    }
    const track = (event: RTCTrackEvent) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void audio
        .play()
        .catch(() =>
          this.onFailure(
            'Audio playback is blocked. Captions remain available.',
          ),
        )
    }
    const connection = () => {
      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected'
      )
        this.onFailure(
          'The voice connection was interrupted. Resume with text or start voice again.',
        )
    }
    channel.addEventListener('message', message)
    peer.addEventListener('track', track)
    peer.addEventListener('connectionstatechange', connection)
    this.#release = () => {
      channel.removeEventListener('message', message)
      peer.removeEventListener('track', track)
      peer.removeEventListener('connectionstatechange', connection)
    }
    for (const input of stream.getTracks()) {
      input.enabled = !this.#micMuted
      peer.addTrack(input, stream)
    }
    const offer = await peer.createOffer()
    if (this.#stopped) throw new Error('The guide has ended.')
    await peer.setLocalDescription(offer)
    if (this.#stopped) throw new Error('The guide has ended.')
    if (!offer.sdp)
      throw new Error('The browser could not prepare a voice connection.')
    return offer.sdp
  }

  async accept(sdp: string): Promise<void> {
    if (this.#stopped || this.#peer === null)
      throw new Error('The guide has ended.')
    await this.#peer.setRemoteDescription({ type: 'answer', sdp })
    if (this.#stopped) throw new Error('The guide has ended.')
    if (this.#started) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#reject?.(new Error('The voice connection did not become ready.'))
      }, 15000)
      const clear = () => {
        clearTimeout(timer)
        this.#resolve = null
        this.#reject = null
      }
      this.#resolve = () => {
        clear()
        resolve()
      }
      this.#reject = (cause) => {
        clear()
        reject(cause)
      }
    })
  }

  muteMicrophone(muted: boolean): void {
    this.#micMuted = muted
    for (const track of this.#stream?.getTracks() ?? []) track.enabled = !muted
  }

  muteGuide(muted: boolean): void {
    this.#guideMuted = muted
    if (this.#audio !== null) this.#audio.muted = muted
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#reject?.(new Error('The guide has ended.'))
    this.#release?.()
    this.#release = null
    for (const track of this.#stream?.getTracks() ?? []) track.stop()
    this.#stream = null
    this.#audio?.pause()
    if (this.#audio !== null) this.#audio.srcObject = null
    this.#audio = null
    this.#peer?.close()
    this.#peer = null
  }
}
