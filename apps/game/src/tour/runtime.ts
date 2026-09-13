import {
  decodeTourMessage,
  decodeTourServerMessage,
  decodeTourTranscript,
  TOUR_PROTOCOL_VERSION,
  validateTourPlan,
  type NarrationBrief,
  type ToolReceipt,
  type ToolRequest,
  type TourClientMessage,
  type TourCommand,
  type TourContext,
  type TourPlan,
  type TourSource,
  type TourStop,
  type TourTranscript,
} from '@inertialref/protocol'
import { deterministicTour, TourRunner } from '@inertialref/devtools'
import { ControlledPlayback, LiveConnection, type LiveEvent } from './media.ts'

export interface GuideExecutor {
  readonly viewRevision: number
  readonly searchStatus?: {
    readonly systems: number
    readonly progress: number
    readonly total: number
    readonly running: boolean
  } | null
  context(query?: string): TourContext
  execute(request: ToolRequest): ToolReceipt
  poll(): void
  supersede(revision: number): void
  cancel(reason?: string): void
  dispose(): void
}

export interface GuideCapabilities {
  readonly available: boolean
  readonly authenticated: boolean
  readonly voices: readonly string[]
  readonly durationSeconds: number
  readonly features: {
    readonly text: boolean
    readonly live: boolean
    readonly controlledSpeech: boolean
    readonly images: boolean
  }
  readonly reason: string | null
}

export interface GuideHost {
  now(): number
  presentationNow(): number
  id(): string
  request(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    keepalive?: boolean,
  ): Promise<Response>
  socket(sessionId: string, tabId: string): WebSocket
  executor(
    sessionId: string,
    receipt: (value: ToolReceipt) => void,
    takeover: () => void,
  ): GuideExecutor
  live(
    event: (value: LiveEvent) => void,
    failure: (message: string) => void,
  ): LiveConnection
  playback(): ControlledPlayback
  poll(run: () => void): () => void
  visibility(changed: (visible: boolean) => void): () => void
}

export interface GuideSnapshot {
  readonly capabilities: GuideCapabilities | null
  readonly connection: 'offline' | 'connecting' | 'connected'
  readonly voice: boolean
  readonly microphoneMuted: boolean
  readonly guideMuted: boolean
  readonly automatic: boolean
  readonly state: string
  readonly plan: TourPlan | null
  readonly stopIndex: number
  readonly explanation: string | null
  readonly sources: readonly TourSource[]
  readonly transcripts: readonly TourTranscript[]
  readonly message: string | null
  readonly search: GuideExecutor['searchStatus']
}

/** All asynchronous work carries both the request and the actual view revision. */
export class GuideRuntime {
  readonly #host: GuideHost
  readonly #listeners = new Set<() => void>()
  #snapshot: GuideSnapshot = {
    capabilities: null,
    connection: 'offline',
    voice: false,
    microphoneMuted: false,
    guideMuted: false,
    automatic: false,
    state: 'idle',
    plan: null,
    stopIndex: 0,
    explanation: null,
    sources: [],
    transcripts: [],
    message: null,
    search: null,
  }
  #executor: GuideExecutor | null = null
  #runner: TourRunner | null = null
  #localId: string | null = null
  #sessionId: string | null = null
  #tabId: string | null = null
  #creationKey: string | null = null
  #expiresAt = Infinity
  #requestRevision = 0
  #generation = 0
  #operation: { id: string; stop: TourStop } | null = null
  #socket: WebSocket | null = null
  #live: LiveConnection | null = null
  #playback: ControlledPlayback | null = null
  #pollRelease: (() => void) | null = null
  #visibilityRelease: (() => void) | null = null
  #pending = new Set<AbortController>()
  #inspect: Promise<void> | null = null
  #connecting: Promise<void> | null = null
  #startup: TourTranscript[] = []
  #seenTranscripts = new Set<string>()
  #readyResolve: (() => void) | null = null
  #readyReject: ((error: Error) => void) | null = null
  #mutating = false
  #knownViewRevision = -1

  constructor(host: GuideHost) {
    this.#host = host
  }
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  getSnapshot = (): GuideSnapshot => this.#snapshot
  #update(next: Partial<GuideSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next }
    for (const listener of this.#listeners) listener()
  }

  inspect(): Promise<void> {
    if (this.#inspect !== null) return this.#inspect
    this.#inspect = this.#request('/api/tour/capabilities')
      .then(async (response) => {
        const value = (await response.json()) as GuideCapabilities
        if (
          !value ||
          typeof value.available !== 'boolean' ||
          typeof value.authenticated !== 'boolean' ||
          !Array.isArray(value.voices) ||
          !value.features
        )
          throw new Error('Guide availability could not be read.')
        this.#update({ capabilities: value })
      })
      .catch((cause: unknown) => {
        this.#update({ message: message(cause) })
      })
    return this.#inspect
  }

  async login(password: string): Promise<void> {
    try {
      await this.#request('/api/tour/login', { password })
      this.#inspect = null
      await this.inspect()
      this.#update({ message: null })
    } catch (cause) {
      this.#update({ message: message(cause) })
    }
  }

  async startVoice(voice: string): Promise<void> {
    this.command('pause')
    try {
      await this.#connect(true, voice)
      this.#update({ automatic: false })
    } catch (cause) {
      this.#disconnect()
      this.#update({ message: `${message(cause)} You can continue by typing.` })
    }
  }

  async startTour(
    kind: 'saturn' | 'system',
    audio = false,
    voice = 'marin',
  ): Promise<void> {
    try {
      if (audio) {
        await this.#connect(false, voice)
        if (!this.#snapshot.capabilities?.features.controlledSpeech)
          throw new Error('Spoken tours are unavailable.')
      }
      const context = this.#context(kind === 'saturn' ? 'Saturn' : undefined)
      const plan = deterministicTour(context, kind)
      if (plan === null)
        throw new Error('No tour subjects are available in this view.')
      this.#startPlan(plan, audio && !this.#snapshot.voice)
    } catch (cause) {
      this.#update({ message: message(cause) })
    }
  }

  async ask(text: string): Promise<void> {
    const query = text.trim().slice(0, 4000)
    if (!query) return
    const command = exactCommand(query)
    if (command !== null) {
      this.command(command)
      return
    }
    try {
      const context = this.#context(query)
      const choices = context.candidates.filter(
        (candidate) =>
          candidate.name.toLocaleLowerCase() === query.toLocaleLowerCase() ||
          candidate.address === query,
      )
      if (choices.length === 1) {
        const subject = choices[0]!
        this.#startPlan(
          {
            id: this.#host.id(),
            goal: `Look at ${subject.name}`,
            durationSeconds: 30,
            stops: [
              {
                id: this.#host.id(),
                subjectId: subject.id,
                framingId: null,
                siteId: null,
                objective: `Look at ${subject.name}`,
                factIds: subject.factIds.slice(0, 4),
                minimumViewSeconds: 5,
              },
            ],
          },
          false,
        )
        return
      }
      this.#invalidate()
      this.#runner?.command('pause')
      const generation = this.#generation
      await this.#connect(false, 'marin', true)
      if (generation !== this.#generation) return
      const current = this.#context(query)
      this.#requestRevision++
      this.#executor!.supersede(this.#requestRevision)
      this.#send({ type: 'context', context: current })
      this.#send({
        type: 'ask',
        text: query,
        requestRevision: this.#requestRevision,
        viewRevision: current.viewRevision,
      })
      this.#update({ state: 'planning', message: null })
    } catch (cause) {
      this.#update({ message: message(cause) })
    }
  }

  explain(): void {
    const context = this.#context()
    const brief = context.brief
    if (brief === null) {
      this.#update({ message: 'Choose an object to read its record.' })
      return
    }
    this.command('pause')
    this.#update({
      explanation: [
        brief.summary,
        ...brief.facts
          .slice(0, 5)
          .map((fact) => fact.speech ?? `${fact.label}: ${fact.reason}`),
      ].join(' '),
      sources: brief.sources,
      message: null,
    })
  }

  command(command: TourCommand): void {
    if (command === 'end') {
      this.end()
      return
    }
    if (command === 'start') {
      void this.startTour('system')
      return
    }
    if (this.#executor === null) return
    this.#invalidate()
    this.#requestRevision++
    this.#executor.supersede(this.#requestRevision)
    this.#sendContext()
    this.#send({
      type: 'command',
      command,
      requestRevision: this.#requestRevision,
      viewRevision: this.#executor.viewRevision,
    })
    this.#mutating = true
    if (command === 'resume' && this.#runner !== null) {
      const context = this.#context()
      const status = this.#runner.status()
      const stop = this.#snapshot.plan?.stops[status.index]
      if (stop && context.subjectId !== stop.subjectId)
        this.#runner.command('next')
      else {
        this.#runner.resumeAt(context.viewRevision)
        if (
          stop &&
          this.#runner.status().arrived &&
          this.#snapshot.connection === 'connected'
        ) {
          this.#send({ type: 'context', context })
          this.#send({
            type: 'narration-ready',
            stopId: stop.id,
            requestRevision: this.#requestRevision,
            viewRevision: context.viewRevision,
          })
        }
      }
    } else this.#runner?.command(command)
    this.#mutating = false
    if (command === 'pause') this.#live?.muteGuide(true)
    if (command === 'resume') {
      this.#live?.muteGuide(this.#snapshot.guideMuted)
      this.#live?.muteMicrophone(this.#snapshot.microphoneMuted)
      this.#update({ message: null })
    }
    this.#refreshRunner()
  }

  muteMicrophone(muted: boolean): void {
    this.#live?.muteMicrophone(muted)
    this.#update({ microphoneMuted: muted })
  }
  muteGuide(muted: boolean): void {
    this.#live?.muteGuide(muted)
    this.#playback?.mute(muted)
    this.#update({ guideMuted: muted })
  }

  end(): void {
    this.#invalidate()
    this.#runner?.command('end')
    this.#disconnect()
    this.#executor?.dispose()
    this.#executor = null
    this.#pollRelease?.()
    this.#pollRelease = null
    this.#visibilityRelease?.()
    this.#visibilityRelease = null
    this.#update({ state: 'ended', message: null, voice: false })
  }

  #activate(): GuideExecutor {
    if (this.#executor === null) {
      this.#localId ??= this.#host.id()
      this.#executor = this.#host.executor(
        this.#sessionId ?? this.#localId,
        (receipt) => this.#receipt(receipt),
        () => this.#takeover(),
      )
      this.#executor.supersede(this.#requestRevision)
      this.#knownViewRevision = this.#executor.viewRevision
    }
    this.#pollRelease ??= this.#host.poll(() => {
      if (this.#host.now() >= this.#expiresAt) {
        this.command('pause')
        this.#disconnect()
        this.#update({
          message:
            'The guide session has ended. The itinerary remains available.',
        })
        return
      }
      this.#executor?.poll()
      if (
        this.#executor &&
        this.#executor.viewRevision !== this.#knownViewRevision
      )
        this.#takeover()
      const search = this.#executor?.searchStatus
      if (JSON.stringify(search) !== JSON.stringify(this.#snapshot.search))
        this.#update({ search })
      this.#runner?.tick()
    })
    this.#visibilityRelease ??= this.#host.visibility((visible) => {
      if (!visible) {
        this.command('pause')
        this.#live?.muteMicrophone(true)
        this.#update({
          message:
            'Tour paused while this tab is hidden. Resume when you are ready.',
        })
      }
    })
    return this.#executor
  }

  #context(query?: string): TourContext {
    const context = this.#activate().context(query)
    return context
  }
  #sendContext(): TourContext {
    const context = this.#context()
    this.#send({ type: 'context', context })
    return context
  }
  #invalidate(cancel = true): void {
    this.#generation++
    this.#operation = null
    this.#playback?.stop()
    for (const controller of this.#pending) controller.abort()
    this.#pending.clear()
    if (cancel) this.#executor?.cancel('The visitor changed the request.')
  }
  #takeover(): void {
    if (this.#executor === null) return
    this.#knownViewRevision = this.#executor.viewRevision
    this.command('pause')
    this.#update({
      message: 'You have the camera. Resume to continue from this view.',
    })
  }

  #startPlan(plan: TourPlan, automatic: boolean): void {
    const checked = validateTourPlan(plan, this.#context())
    if (!checked.ok) throw new Error(checked.error)
    this.#invalidate(!this.#mutating)
    this.#runner?.command('end')
    this.#update({
      plan,
      automatic,
      explanation: null,
      sources: [],
      message: null,
    })
    const automaticEnabled = () =>
      this.#snapshot.automatic && !this.#snapshot.voice
    this.#runner = new TourRunner({
      now: this.#host.presentationNow,
      get automatic() {
        return automaticEnabled()
      },
      onStop: (stop: TourStop) => this.#move(stop),
      onChange: () => this.#refreshRunner(),
    })
    this.#runner.start(plan)
    this.#refreshRunner()
  }
  #refreshRunner(): void {
    const status = this.#runner?.status()
    if (status === undefined) return
    if (
      status.state !== this.#snapshot.state ||
      status.index !== this.#snapshot.stopIndex
    )
      this.#update({ state: status.state, stopIndex: status.index })
  }
  #move(stop: TourStop): void {
    this.#activate()
    if (!this.#mutating) {
      this.#invalidate()
      this.#requestRevision++
      this.#executor!.supersede(this.#requestRevision)
      this.#sendContext()
      this.#send({
        type: 'command',
        command: 'next',
        requestRevision: this.#requestRevision,
        viewRevision: this.#executor!.viewRevision,
      })
    }
    const operationId = this.#host.id()
    this.#operation = { id: operationId, stop }
    const request: ToolRequest = {
      sessionId: this.#sessionId ?? this.#localId!,
      requestRevision: this.#requestRevision,
      operationId,
      expectedViewRevision: this.#executor!.viewRevision,
      expiresAt: this.#host.now() + 20000,
      action:
        stop.siteId !== null
          ? {
              tool: 'stand_at_site',
              subjectId: stop.subjectId,
              siteId: stop.siteId,
            }
          : stop.framingId !== null
            ? {
                tool: 'compose_view',
                subjectId: stop.subjectId,
                framingId: stop.framingId,
              }
            : { tool: 'show_subject', subjectId: stop.subjectId },
    }
    this.#executor!.execute(request)
    this.#knownViewRevision = this.#executor!.viewRevision
  }
  #receipt(receipt: ToolReceipt): void {
    if (receipt.requestRevision !== this.#requestRevision) return
    this.#knownViewRevision = receipt.viewRevision
    if (receipt.status === 'arrived') this.#sendContext()
    this.#send({ type: 'receipt', receipt })
    const operation = this.#operation
    if (receipt.status === 'accepted') return
    if (operation === null || receipt.operationId !== operation.id) {
      if (receipt.status === 'arrived') this.#sendContext()
      return
    }
    if (receipt.status !== 'arrived') {
      this.#runner?.fail(receipt.reason ?? 'The view could not be reached.')
      this.#update({ message: receipt.reason })
      return
    }
    const context = this.#sendContext()
    this.#runner?.arrived(operation.stop.id, receipt.viewRevision)
    if (this.#snapshot.connection === 'connected') {
      this.#send({
        type: 'narration-ready',
        stopId: operation.stop.id,
        requestRevision: this.#requestRevision,
        viewRevision: receipt.viewRevision,
      })
    } else if (context.brief !== null) {
      this.#update({
        explanation: context.brief.summary,
        sources: context.brief.sources,
      })
    }
  }

  async #connect(
    voice: boolean,
    selectedVoice: string,
    preserveVoice = false,
  ): Promise<void> {
    if (
      this.#snapshot.connection === 'connected' &&
      (preserveVoice || this.#snapshot.voice === voice)
    )
      return
    if (this.#connecting !== null) return this.#connecting
    const pending = this.#open(voice, selectedVoice)
    this.#connecting = pending
    try {
      await pending
    } finally {
      if (this.#connecting === pending) this.#connecting = null
    }
  }
  async #open(voice: boolean, selectedVoice: string): Promise<void> {
    const generation = this.#generation
    await this.inspect()
    if (generation !== this.#generation)
      throw new Error('The guide request was canceled.')
    const capabilities = this.#snapshot.capabilities
    if (!capabilities?.available)
      throw new Error(
        capabilities?.reason ??
          'The online guide is unavailable. Local tours still work.',
      )
    if (!capabilities.authenticated)
      throw new Error(
        'Enter the private alpha password to ask the online guide.',
      )
    if (voice && !capabilities.features.live)
      throw new Error('Live voice is unavailable.')
    this.#disconnect()
    this.#update({ connection: 'connecting', message: null })
    this.#activate()
    let sdp: string | null = null
    if (voice) {
      const live = this.#host.live(
        (event) => this.#liveEvent(event),
        (reason) => {
          this.command('pause')
          this.#disconnect()
          this.#update({ message: reason })
        },
      )
      this.#live = live
      live.muteMicrophone(this.#snapshot.microphoneMuted)
      live.muteGuide(this.#snapshot.guideMuted)
      sdp = await live.prepare()
    }
    if (generation !== this.#generation)
      throw new Error('The guide request was canceled.')
    this.#creationKey ??= this.#host.id()
    this.#tabId ??= this.#host.id()
    const context = this.#context()
    let sessionId: string | null = null
    try {
      const response = await this.#request('/api/tour/sessions', {
        protocolVersion: TOUR_PROTOCOL_VERSION,
        manifest: context.manifest,
        context,
        transport: voice ? 'live' : 'text',
        voice: capabilities.voices.includes(selectedVoice)
          ? selectedVoice
          : (capabilities.voices[0] ?? 'marin'),
        sdp,
        idempotencyKey: this.#creationKey,
        tabId: this.#tabId,
      })
      const created = (await response.json()) as {
        sessionId: string
        expiresAt: number
        sdp: string | null
      }
      if (
        typeof created.sessionId !== 'string' ||
        !Number.isFinite(created.expiresAt)
      )
        throw new Error('The guide session response was invalid.')
      sessionId = created.sessionId
      if (generation !== this.#generation) {
        void this.#host
          .request(
            `/api/tour/sessions/${encodeURIComponent(sessionId)}/close`,
            {},
            undefined,
            true,
          )
          .catch(() => {})
        throw new Error('The guide request was canceled.')
      }
      this.#creationKey = null
      this.#sessionId = sessionId
      this.#expiresAt = created.expiresAt
      this.#executor?.dispose()
      this.#executor = null
      this.#activate()
      const socket = this.#host.socket(sessionId, this.#tabId)
      this.#socket = socket
      socket.addEventListener('message', (event) => {
        if (this.#socket !== socket || typeof event.data !== 'string') return
        const decoded = decodeTourMessage(decodeTourServerMessage, event.data)
        if (decoded.ok) this.#receive(decoded.value)
      })
      const lost = () => {
        if (this.#socket !== socket) return
        this.#readyReject?.(new Error('The guide connection was interrupted.'))
        this.command('pause')
        this.#disconnect()
        this.#update({
          message:
            'The guide connection was interrupted. Your itinerary is still available.',
        })
      }
      socket.addEventListener('close', lost)
      socket.addEventListener('error', lost)
      const coordinator = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            this.#readyReject?.(new Error('The guide did not become ready.')),
          15000,
        )
        this.#readyResolve = () => {
          clearTimeout(timer)
          this.#readyResolve = null
          this.#readyReject = null
          resolve()
        }
        this.#readyReject = (error) => {
          clearTimeout(timer)
          this.#readyResolve = null
          this.#readyReject = null
          reject(error)
        }
      })
      await Promise.all([
        coordinator,
        voice && created.sdp !== null
          ? this.#live!.accept(created.sdp)
          : Promise.resolve(),
      ])
      if (generation !== this.#generation)
        throw new Error('The guide request was canceled.')
      this.#update({
        connection: 'connected',
        voice,
        state: this.#runner?.status().state ?? 'idle',
      })
      this.#sendContext()
      if (this.#startup.length > 0)
        this.#send({ type: 'live-startup', events: this.#startup })
      this.#startup = []
    } catch (cause) {
      if (sessionId !== null && this.#sessionId === null)
        void this.#host
          .request(
            `/api/tour/sessions/${encodeURIComponent(sessionId)}/close`,
            {},
            undefined,
            true,
          )
          .catch(() => {})
      this.#disconnect()
      throw cause
    }
  }

  #receive(event: import('@inertialref/protocol').TourServerMessage): void {
    switch (event.type) {
      case 'ready':
        if (event.sessionId !== this.#sessionId) return
        if (event.requestRevision < this.#requestRevision) {
          this.#readyResolve?.()
          return
        }
        this.#requestRevision = event.requestRevision
        this.#executor?.supersede(this.#requestRevision)
        this.#readyResolve?.()
        return
      case 'plan':
        if (event.requestRevision !== this.#requestRevision) return
        try {
          this.#mutating = true
          this.#startPlan(
            event.plan,
            this.#snapshot.automatic && !this.#snapshot.voice,
          )
        } catch (cause) {
          this.#update({ message: message(cause) })
        } finally {
          this.#mutating = false
        }
        return
      case 'tool':
        if (
          this.#snapshot.connection !== 'connected' ||
          event.request.requestRevision !== this.#requestRevision
        )
          return
        this.#executor?.execute(event.request)
        this.#knownViewRevision = this.#executor?.viewRevision ?? -1
        return
      case 'narration':
        void this.#narrate(event.brief)
        return
      case 'transcript':
        this.#transcript(event)
        return
      case 'closed':
        this.command('pause')
        this.#disconnect()
        this.#update({ message: event.reason })
        return
      case 'error':
        this.#runner?.fail(event.message)
        this.#update({ message: event.message })
        return
      case 'status':
        if (event.state === 'paused') {
          this.#invalidate()
          this.#runner?.command('pause')
          this.#live?.muteGuide(true)
          this.#update({ state: 'paused' })
        }
        if (event.state === 'planning') this.#update({ state: 'planning' })
        this.#update({ message: event.message || null })
    }
  }
  #liveEvent(event: LiveEvent): void {
    if (
      event.type !== 'session.input_transcript.delta' &&
      event.type !== 'session.output_transcript.delta'
    )
      return
    const decoded = decodeTourTranscript(
      {
        eventId: event.event_id,
        text: event.delta,
        speaker:
          event.type === 'session.input_transcript.delta' ? 'visitor' : 'guide',
        startMs: event.start_ms,
        endMs: event.end_ms,
      },
      '',
    )
    if (!decoded.ok) return
    if (this.#snapshot.connection !== 'connected') {
      if (this.#startup.length < 64) this.#startup.push(decoded.value)
    }
    this.#transcript(decoded.value)
  }
  #transcript(event: TourTranscript): void {
    if (this.#seenTranscripts.has(event.eventId)) return
    this.#seenTranscripts.add(event.eventId)
    if (this.#seenTranscripts.size > 1024)
      this.#seenTranscripts.delete(this.#seenTranscripts.values().next().value!)
    this.#update({
      transcripts: [...this.#snapshot.transcripts, event].slice(-200),
    })
  }
  async #narrate(brief: NarrationBrief): Promise<void> {
    if (
      brief.requestRevision !== this.#requestRevision ||
      brief.viewRevision !== this.#executor?.viewRevision
    )
      return
    const generation = this.#generation
    const sources = brief.sources
    this.#update({ explanation: brief.text, sources })
    if (this.#snapshot.voice) {
      this.#live?.muteGuide(this.#snapshot.guideMuted)
      return
    }
    if (!this.#snapshot.automatic || this.#sessionId === null) return
    try {
      const response = await this.#request(
        `/api/tour/sessions/${encodeURIComponent(this.#sessionId)}/speech`,
        { narrationId: brief.id },
      )
      const blob = await response.blob()
      if (
        generation !== this.#generation ||
        brief.viewRevision !== this.#executor?.viewRevision
      )
        return
      this.#playback ??= this.#host.playback()
      this.#playback.mute(this.#snapshot.guideMuted)
      await this.#playback.play(
        blob,
        () => {
          if (
            generation !== this.#generation ||
            brief.stopId === null ||
            brief.viewRevision !== this.#executor?.viewRevision
          )
            return
          this.#runner?.narrationEnded(brief.stopId, brief.viewRevision)
          this.#send({
            type: 'narration-ended',
            stopId: brief.stopId,
            requestRevision: brief.requestRevision,
            viewRevision: brief.viewRevision,
          })
        },
        () => {
          if (generation !== this.#generation) return
          this.#runner?.fail('Audio playback stopped.')
          this.#update({
            message:
              'Audio playback stopped. Use Next to continue, or resume to retry this stop.',
          })
        },
      )
      if (generation === this.#generation)
        this.#transcript({
          eventId: `clip:${brief.id}`,
          text: brief.text,
          speaker: 'guide',
          startMs: this.#host.presentationNow(),
          endMs: this.#host.presentationNow(),
        })
    } catch (cause) {
      if (generation !== this.#generation) return
      this.#runner?.fail('Audio playback could not start.')
      this.#update({
        message: `${message(cause)} Use Next to continue, or resume to retry this stop.`,
      })
    }
  }
  #send(event: TourClientMessage): void {
    if (this.#socket?.readyState === 1) this.#socket.send(JSON.stringify(event))
  }
  #disconnect(): void {
    this.#readyReject?.(new Error('The guide connection closed.'))
    this.#live?.stop()
    this.#live = null
    this.#playback?.stop()
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    const sessionId = this.#sessionId
    this.#sessionId = null
    if (sessionId !== null) {
      this.#executor?.dispose()
      this.#executor = null
    }
    this.#expiresAt = Infinity
    this.#startup = []
    if (sessionId !== null)
      void this.#host
        .request(
          `/api/tour/sessions/${encodeURIComponent(sessionId)}/close`,
          {},
          undefined,
          true,
        )
        .catch(() => {})
    this.#update({ connection: 'offline', voice: false })
  }
  async #request(path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController()
    this.#pending.add(controller)
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const response = await this.#host.request(path, body, controller.signal)
      if (!response.ok) {
        let detail = 'The guide request could not be completed.'
        try {
          const error = (await response.json()) as {
            message?: string
            error?: string
          }
          detail = error.message ?? error.error ?? detail
        } catch {
          /* A proxy failure can return an HTML error page. */
        }
        throw new Error(detail)
      }
      return response
    } finally {
      clearTimeout(timer)
      this.#pending.delete(controller)
    }
  }
}

function message(cause: unknown): string {
  return cause instanceof Error && cause.name !== 'AbortError'
    ? cause.message
    : 'The guide request was canceled.'
}
function exactCommand(text: string): TourCommand | null {
  const commands: Readonly<Record<string, TourCommand>> = {
    next: 'next',
    back: 'back',
    pause: 'pause',
    'pause tour': 'pause',
    resume: 'resume',
    end: 'end',
    'end tour': 'end',
    stop: 'pause',
    'start tour': 'start',
  }
  return commands[text.toLowerCase()] ?? null
}
