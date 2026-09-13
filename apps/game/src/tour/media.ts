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
  readonly #host: ClipHost
  constructor(host: ClipHost = clipHost) {
    this.#host = host
  }

  async play(
    blob: Blob,
    ended: () => void,
    failed: () => void = () => {},
  ): Promise<void> {
    this.stop()
    const audio = this.#host.audio()
    const url = this.#host.url(blob)
    this.#audio = audio
    audio.src = url
    audio.muted = this.#muted
    const onEnd = () => {
      if (this.#audio !== audio) return
      this.stop()
      ended()
    }
    const onError = () => {
      if (this.#audio !== audio) return
      this.stop()
      failed()
    }
    audio.addEventListener('error', onError, { once: true })
    audio.addEventListener('ended', onEnd, { once: true })
    this.#release = () => {
      audio.removeEventListener('ended', onEnd)
      audio.removeEventListener('error', onError)
      this.#host.revoke(url)
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
  #captureRevision = 0
  #resuming: Promise<void> | null = null
  readonly #senders: RTCRtpSender[] = []
  readonly #retired = new WeakSet<MediaStreamTrack>()
  #guideMuted = false

  readonly #host: LiveHost
  readonly #onEvent: (event: LiveEvent) => void
  readonly #onFailure: (message: string) => void
  constructor(
    host: LiveHost = liveHost,
    onEvent: (event: LiveEvent) => void = () => {},
    onFailure: (message: string) => void = () => {},
  ) {
    this.#host = host
    this.#onEvent = onEvent
    this.#onFailure = onFailure
  }

  async prepare(): Promise<string> {
    const stream = await this.#host.capture()
    if (this.#stopped) {
      this.#stopCapture(stream)
      throw new Error('The guide has ended.')
    }
    this.#stream = stream
    const peer = this.#host.peer()
    this.#peer = peer
    const audio = this.#host.audio()
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
      this.#onEvent(value)
    }
    const track = (event: RTCTrackEvent) => {
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
      void audio
        .play()
        .catch(() =>
          this.#onFailure(
            'Audio playback is blocked. Captions remain available.',
          ),
        )
    }
    const connection = () => {
      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected'
      )
        this.#onFailure(
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
      const sender = peer.addTrack(input, stream)
      if (sender !== undefined) this.#senders.push(sender)
    }
    if (this.#micMuted) await this.muteMicrophone(true)
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

  muteMicrophone(muted: boolean): Promise<void> {
    this.#micMuted = muted
    if (muted) {
      this.#captureRevision++
      this.#stopCapture(this.#stream)
      this.#stream = null
      return Promise.all(
        this.#senders.map((sender) => sender.replaceTrack(null)),
      ).then(() => {})
    }
    if (this.#stopped || this.#peer === null || this.#stream !== null)
      return Promise.resolve()
    if (this.#resuming !== null) return this.#resuming
    const pending = this.#resumeCapture(this.#captureRevision)
    this.#resuming = pending
    void pending
      .finally(() => {
        if (this.#resuming === pending) this.#resuming = null
      })
      .catch(() => {})
    return pending
  }

  #stopCapture(stream: MediaStream | null): void {
    for (const track of stream?.getTracks() ?? []) {
      if (this.#retired.has(track)) continue
      this.#retired.add(track)
      track.enabled = false
      track.stop()
    }
  }

  async #resumeCapture(revision: number): Promise<void> {
    const stream = await this.#host.capture()
    if (this.#stopped || this.#micMuted || revision !== this.#captureRevision) {
      this.#stopCapture(stream)
      if (!this.#stopped && !this.#micMuted)
        throw new Error(
          'Microphone capture was canceled. Unmute the microphone to try again.',
        )
      return
    }
    this.#stream = stream
    try {
      const tracks = stream.getTracks()
      for (const [index, sender] of this.#senders.entries()) {
        const track = tracks[index] ?? null
        if (track !== null) track.enabled = true
        await sender.replaceTrack(track)
      }
      if (this.#stopped || this.#micMuted || revision !== this.#captureRevision)
        this.#stopCapture(stream)
    } catch (cause) {
      this.#stopCapture(stream)
      if (this.#stream === stream) this.#stream = null
      this.#micMuted = true
      throw cause
    }
  }

  muteGuide(muted: boolean): void {
    this.#guideMuted = muted
    if (this.#audio !== null) this.#audio.muted = muted
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#captureRevision++
    this.#reject?.(new Error('The guide has ended.'))
    this.#release?.()
    this.#release = null
    this.#stopCapture(this.#stream)
    this.#stream = null
    this.#audio?.pause()
    if (this.#audio !== null) this.#audio.srcObject = null
    this.#audio = null
    this.#peer?.close()
    this.#peer = null
  }
}
