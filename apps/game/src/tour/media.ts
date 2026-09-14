import { GUIDE_CLIENT_EVENTS } from '@inertialref/protocol'

/*
 * The voice connection: one peer connection, one data channel, one speaker.
 *
 * The browser owns the session. It captures the microphone, offers, applies
 * the Worker's answer, plays the remote track, and sends every command the
 * guide needs over the data channel. There is no relay: the events the
 * provider sends arrive here and go straight to the loop, and the commands
 * the loop sends go straight out. `send` refuses anything not on the
 * data-channel allow list before the provider can, so a bug is a thrown
 * error in a test rather than an `event_not_allowed` in a session.
 *
 * The remote track is also the clock. Output audio streams whether or not
 * the guide is speaking, so `level()` reads an `AnalyserNode` on the track
 * and the runtime's clock decides what counts as speech.
 */

export interface LiveHost {
  peer(): RTCPeerConnection
  capture(): Promise<MediaStream>
  audio(): HTMLAudioElement
  context?(): AudioContext
}

interface SilentCarrier {
  readonly stream: MediaStream
  readonly track: MediaStreamTrack
  readonly ready: Promise<void>
  stop(): void
}

/** A live source keeps input RTP moving while the microphone is off.
 * It has no microphone input and is never connected to the speaker. */
function silentCarrier(context: AudioContext): SilentCarrier {
  const destination = context.createMediaStreamDestination()
  destination.channelCount = 1
  const gain = context.createGain()
  // A nonzero source avoids browser graph pruning while remaining inaudible.
  gain.gain.value = 1e-8
  const source = context.createOscillator()
  source.connect(gain)
  gain.connect(destination)
  source.start()
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    source.stop()
    source.disconnect()
    gain.disconnect()
    destination.disconnect()
    for (const track of destination.stream.getTracks()) track.stop()
    void context.close().catch(() => {})
  }
  const track = destination.stream.getTracks()[0]
  if (track === undefined) {
    stop()
    throw new Error('The browser could not keep muted voice audio connected.')
  }
  return { stream: destination.stream, track, ready: context.resume(), stop }
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
  context: () => new AudioContext({ sampleRate: 48000 }),
}

export type LiveServerEvent = Readonly<Record<string, unknown>> & {
  readonly type: string
}

export class LiveConnection {
  #peer: RTCPeerConnection | null = null
  #channel: RTCDataChannel | null = null
  #stream: MediaStream | null = null
  #audio: HTMLAudioElement | null = null
  #stopped = false
  #started = false
  #closed = false
  #release: (() => void) | null = null
  #resolve: (() => void) | null = null
  #reject: ((cause: Error) => void) | null = null
  #closing: ((closed: boolean) => void) | null = null
  #micMuted = false
  #captureRevision = 0
  #resuming: Promise<void> | null = null
  #silence: SilentCarrier | null = null
  #meter: {
    node: AnalyserNode
    buffer: Float32Array<ArrayBuffer>
    context: AudioContext
  } | null = null
  #sequence = 0
  readonly #senders: RTCRtpSender[] = []
  readonly #retired = new WeakSet<MediaStreamTrack>()
  #guideMuted = false

  readonly #host: LiveHost
  readonly #onEvent: (event: LiveServerEvent) => void
  readonly #onFailure: (message: string) => void
  constructor(
    host: LiveHost = liveHost,
    onEvent: (event: LiveServerEvent) => void = () => {},
    onFailure: (message: string) => void = () => {},
  ) {
    this.#host = host
    this.#onEvent = onEvent
    this.#onFailure = onFailure
  }

  async prepare(): Promise<string> {
    if (this.#stopped) throw new Error('The guide has ended.')
    const carrier = this.#micMuted ? this.#silentCarrier() : null
    const stream = carrier?.stream ?? (await this.#host.capture())
    if (this.#stopped) {
      if (carrier === null) this.#stopCapture(stream)
      else carrier.stop()
      throw new Error('The guide has ended.')
    }
    this.#stream = carrier === null ? stream : null
    const peer = this.#host.peer()
    this.#peer = peer
    const audio = this.#host.audio()
    this.#audio = audio
    audio.autoplay = true
    audio.muted = this.#guideMuted
    const channel = peer.createDataChannel('oai-events')
    this.#channel = channel
    const message = (event: MessageEvent) => {
      if (
        this.#stopped ||
        typeof event.data !== 'string' ||
        event.data.length > 65536
      )
        return
      let value: unknown
      try {
        value = JSON.parse(event.data)
      } catch {
        return
      }
      if (
        value === null ||
        typeof value !== 'object' ||
        typeof (value as { type?: unknown }).type !== 'string'
      )
        return
      const parsed = value as LiveServerEvent
      if (parsed.type === 'session.started') {
        this.#started = true
        this.#resolve?.()
      }
      if (parsed.type === 'session.closed') {
        this.#closed = true
        this.#closing?.(true)
      }
      this.#onEvent(parsed)
    }
    const track = (event: RTCTrackEvent) => {
      const stream = event.streams[0] ?? new MediaStream([event.track])
      audio.srcObject = stream
      void audio
        .play()
        .catch(() => this.#onFailure('Audio playback is blocked.'))
      this.#listen(stream)
    }
    const connection = () => {
      if (
        peer.connectionState === 'failed' ||
        peer.connectionState === 'disconnected'
      )
        this.#onFailure('The voice connection was interrupted.')
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
      input.enabled = carrier !== null || !this.#micMuted
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

  /** Apply the answer and resolve once the provider says the session started. */
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

  /**
   * Send one client event. Only the allow list, only while open.
   *
   * The event id is the browser's, so an acknowledgment can be matched to the
   * append that asked for it.
   */
  send(event: Record<string, unknown>): string {
    const type = event.type
    if (
      typeof type !== 'string' ||
      !(GUIDE_CLIENT_EVENTS as readonly string[]).includes(type)
    )
      throw new Error(`The guide may not send ${String(type)}.`)
    const channel = this.#channel
    if (this.#stopped || channel === null || channel.readyState !== 'open')
      throw new Error('The voice connection is not open.')
    const id = `guide-${++this.#sequence}`
    channel.send(JSON.stringify({ ...event, event_id: id }))
    return id
  }

  /** RMS of the remote track's last window, 0 to 1. Zero without a track. */
  level(): number {
    const meter = this.#meter
    if (meter === null) return 0
    meter.node.getFloatTimeDomainData(meter.buffer)
    let sum = 0
    for (const value of meter.buffer) sum += value * value
    return Math.sqrt(sum / meter.buffer.length)
  }

  #listen(stream: MediaStream): void {
    const make = this.#host.context
    if (make === undefined || this.#meter !== null) return
    try {
      const context = make()
      const node = context.createAnalyser()
      node.fftSize = 2048
      context.createMediaStreamSource(stream).connect(node)
      this.#meter = {
        node,
        buffer: new Float32Array(node.fftSize),
        context,
      }
      void context.resume().catch(() => {})
    } catch {
      // Without an meter the clock reads silence and beats end on their
      // start timeout; the conversation still works.
      this.#meter = null
    }
  }

  muteMicrophone(muted: boolean): Promise<void> {
    this.#micMuted = muted
    if (muted) {
      this.#captureRevision++
      this.#stopCapture(this.#stream)
      this.#stream = null
      if (this.#stopped || this.#peer === null || this.#senders.length === 0)
        return Promise.resolve()
      return this.#sendSilence(this.#captureRevision)
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

  #silentCarrier(): SilentCarrier {
    this.#silence ??= silentCarrier(
      this.#host.context?.() ?? new AudioContext({ sampleRate: 48000 }),
    )
    return this.#silence
  }

  async #sendSilence(revision: number): Promise<void> {
    const carrier = this.#silentCarrier()
    try {
      await carrier.ready
      if (
        this.#stopped ||
        !this.#micMuted ||
        revision !== this.#captureRevision
      )
        return
      await Promise.all(
        this.#senders.map((sender) => sender.replaceTrack(carrier.track)),
      )
    } catch (cause) {
      if (this.#silence === carrier) this.#stopSilence()
      throw cause
    }
  }

  #stopSilence(): void {
    this.#silence?.stop()
    this.#silence = null
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
    let stream: MediaStream
    try {
      stream = await this.#host.capture()
    } catch (cause) {
      if (!this.#stopped && revision === this.#captureRevision) {
        this.#micMuted = true
        await this.#sendSilence(revision).catch(() => {})
      }
      throw cause
    }
    if (this.#stopped || this.#micMuted || revision !== this.#captureRevision) {
      this.#stopCapture(stream)
      if (!this.#stopped && !this.#micMuted)
        throw new Error('Microphone capture was canceled. Resume to try again.')
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
      else this.#stopSilence()
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

  /**
   * End the session the documented way: `session.close`, wait for
   * `session.closed` under a bound, then drop the peer connection.
   */
  async close(timeoutMs = 5000): Promise<{ closed: boolean }> {
    if (this.#stopped) return { closed: this.#closed }
    if (!this.#closed) {
      let sent = false
      try {
        this.send({ type: 'session.close' })
        sent = true
      } catch {
        sent = false
      }
      if (sent)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            this.#closing = null
            resolve()
          }, timeoutMs)
          this.#closing = () => {
            clearTimeout(timer)
            this.#closing = null
            resolve()
          }
        })
    }
    const closed = this.#closed
    this.stop()
    return { closed }
  }

  stop(): void {
    if (this.#stopped) return
    this.#stopped = true
    this.#captureRevision++
    this.#reject?.(new Error('The guide has ended.'))
    this.#closing?.(false)
    this.#release?.()
    this.#release = null
    this.#stopCapture(this.#stream)
    this.#stream = null
    this.#stopSilence()
    if (this.#meter !== null) {
      void this.#meter.context.close().catch(() => {})
      this.#meter = null
    }
    this.#audio?.pause()
    if (this.#audio !== null) this.#audio.srcObject = null
    this.#audio = null
    this.#channel = null
    this.#peer?.close()
    this.#peer = null
  }
}
