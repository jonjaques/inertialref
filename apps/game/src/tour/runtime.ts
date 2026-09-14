import type {
  GuideStatus,
  GuideTraceEntry,
  GuideUsage,
  ViewDescription,
} from '@inertialref/devtools'
import { NO_GUIDE_USAGE } from '@inertialref/devtools'
import type { GuideCall, GuideToolOutput } from '@inertialref/protocol'
import { SpeechClock } from './clock.ts'
import type { GuideArrival, SceneFacts } from './executor.ts'
import { GuideLoop } from './loop.ts'
import type { LiveServerEvent } from './media.ts'
import {
  arrivalBlock,
  BEGIN_CONVERSATION,
  GREETING_INSTRUCTION,
  openingLine,
  PAUSE_INSTRUCTION,
  quietBlock,
  RESUME_INSTRUCTION,
  sceneBlock,
  takeoverBlock,
  takeoverContext,
  uiContext,
} from './scene.ts'

/*
 * The guide runtime: connect, loop, pause, end, and the snapshot the panel
 * reads.
 *
 * One conversation, three parties. Live listens and speaks; the backend
 * thinks and calls tools; this object moves the camera through the executor
 * and keeps the clock. It owns nothing the model could ask for directly: the
 * executor validates every argument, the loop answers every call exactly
 * once, and everything this file sends to either model is prose it wrote
 * itself about the state of the application.
 *
 * The beat is a chain with the browser as metronome. An arrival is prompted
 * to the backend only while no chain is in flight and the visitor is quiet;
 * a `linger` the backend declares becomes a wait for the words to be spoken
 * and then for the declared seconds, and only then a prompt to continue. A
 * takeover, a pause, a new delegation or a new move ends the wait.
 */

export interface GuideCapabilities {
  readonly available: boolean
  readonly authenticated: boolean
  readonly voices: readonly string[]
  readonly reason: string | null
}

export interface GuideSnapshot {
  readonly capabilities: GuideCapabilities | null
  readonly connection: GuideStatus['connection']
  readonly voice: string | null
  readonly paused: boolean
  /** One line under the controls: Listening, Speaking, Moving to Titan. */
  readonly status: string
  readonly message: string | null
  readonly usage: GuideUsage
  readonly expiresAt: number | null
}

/** What the runtime needs from the executor; `executor.ts` is the one implementation. */
export interface GuideExecutorPort {
  readonly viewRevision: number
  readonly pending: GuideArrival['tool'] | null
  readonly pendingSubject: string | null
  readonly searching: boolean
  view(): ViewDescription
  facts(): SceneFacts
  execute(call: GuideCall): Promise<GuideToolOutput>
  poll(): void
  cancel(): void
  dispose(): void
}

/** What the runtime needs from the connection; `media.ts` is the one implementation. */
export interface LiveConnectionPort {
  prepare(): Promise<string>
  accept(sdp: string): Promise<void>
  send(event: Record<string, unknown>): string
  level(): number
  muteMicrophone(muted: boolean): Promise<void>
  muteGuide(muted: boolean): void
  close(timeoutMs?: number): Promise<{ closed: boolean }>
  stop(): void
}

export interface GuideHost {
  now(): number
  request(path: string, body?: unknown, signal?: AbortSignal): Promise<Response>
  executor(events: {
    onArrival: (arrival: GuideArrival) => void
    onTakeover: () => void
  }): GuideExecutorPort
  live(
    onEvent: (event: LiveServerEvent) => void,
    onFailure: (message: string) => void,
  ): LiveConnectionPort
  poll(run: () => void): () => void
  visibility(changed: (visible: boolean) => void): () => void
  /** The page is going away; a best-effort close. */
  leaving?(handler: () => void): () => void
  /** The visitor's clock, for the greeting. */
  localTime(): string
}

/** Milliseconds a view must stay put before the scene block is queued. */
const SCENE_DEBOUNCE_MS = 500
/** A pause longer than this ends the session; the clock bills throughout. */
const PAUSE_LIMIT_MS = 180_000
/** How long the greeting waits for its acknowledgment before sending the cue. */
const ACK_TIMEOUT_MS = 3000

interface Linger {
  readonly seconds: number
  phase: 'chain' | 'speech' | 'quiet'
  quietFrom: number
}

export class GuideRuntime {
  readonly #host: GuideHost
  readonly #listeners = new Set<() => void>()
  readonly #clock: SpeechClock
  #snapshot: GuideSnapshot = {
    capabilities: null,
    connection: 'offline',
    voice: null,
    paused: false,
    status: '',
    message: null,
    usage: NO_GUIDE_USAGE,
    expiresAt: null,
  }
  #executor: GuideExecutorPort | null = null
  #live: LiveConnectionPort | null = null
  #loop: GuideLoop | null = null
  #sessionId: string | null = null
  #generation = 0
  #inspect: Promise<void> | null = null
  #pending = new Set<AbortController>()
  #pollRelease: (() => void) | null = null
  #visibilityRelease: (() => void) | null = null
  #leavingRelease: (() => void) | null = null
  #sceneRevision = -1
  #sceneChangedAt: number | null = null
  #sceneText = ''
  #linger: Linger | null = null
  #pausedAt: number | null = null
  #ending = false
  #traceEnabled = false
  #traceSequence = 0
  #traceEntries: GuideTraceEntry[] = []

  constructor(host: GuideHost) {
    this.#host = host
    this.#clock = new SpeechClock({ now: () => host.now() })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  getSnapshot = (): GuideSnapshot => this.#snapshot

  trace(enabled?: boolean): readonly GuideTraceEntry[] {
    if (enabled !== undefined) this.#traceEnabled = enabled
    return structuredClone(this.#traceEntries)
  }
  #record(
    direction: GuideTraceEntry['direction'],
    message: Readonly<Record<string, unknown>>,
  ): void {
    if (!this.#traceEnabled) return
    const entry: GuideTraceEntry = {
      sequence: ++this.#traceSequence,
      at: this.#host.now(),
      direction,
      message: structuredClone(message),
    }
    this.#traceEntries.push(entry)
    if (this.#traceEntries.length > 200) this.#traceEntries.shift()
    console.debug('[guide]', structuredClone(entry))
  }

  diagnostics(): GuideStatus {
    const state = this.#snapshot
    return {
      available: true,
      loaded: true,
      state: state.status.toLowerCase() || 'idle',
      connection: state.connection,
      sessionId: this.#sessionId,
      viewRevision: this.#executor?.viewRevision ?? null,
      microphone:
        state.connection === 'connected'
          ? state.paused
            ? 'muted'
            : 'active'
          : 'off',
      paused: state.paused,
      pendingCalls: this.#loop?.pendingCalls ?? 0,
      inFlight: this.#loop?.inFlight ?? false,
      usage: state.usage,
    }
  }

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
          !Array.isArray(value.voices)
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

  /** Request the microphone, post the offer, greet. */
  async start(voice: string): Promise<void> {
    if (this.#snapshot.connection !== 'offline') return
    const generation = ++this.#generation
    this.#ending = false
    try {
      await this.inspect()
      const capabilities = this.#snapshot.capabilities
      if (!capabilities?.available)
        throw new Error(capabilities?.reason ?? 'The guide is unavailable.')
      if (!capabilities.authenticated)
        throw new Error('Enter the private alpha password first.')
      const chosen = capabilities.voices.includes(voice)
        ? voice
        : (capabilities.voices[0] ?? 'marin')
      this.#update({
        connection: 'connecting',
        voice: chosen,
        paused: false,
        status: 'Connecting',
        message: null,
        usage: NO_GUIDE_USAGE,
        expiresAt: null,
      })
      const live = this.#host.live(
        (event) => this.#event(live, event),
        (reason) => this.#failure(live, reason),
      )
      this.#live = live
      const loop = new GuideLoop(
        { send: (event) => this.#send(event) },
        {
          now: () => this.#host.now(),
          execute: (call) => this.#execute(call),
          onExecuted: (call, output) => this.#executed(call, output),
          onDelegation: () => this.#cancelLinger(),
          onError: (code, detail) => {
            this.#record('note', { error: code, detail })
            if (code === 'session_expired')
              this.#update({ message: 'The guide session expired.' })
          },
          onChange: () => this.#refresh(),
        },
      )
      this.#loop = loop
      const sdp = await live.prepare()
      this.#guard(generation)
      const executor = this.#host.executor({
        onArrival: (arrival) => this.#arrival(arrival),
        onTakeover: () => this.#takeover(),
      })
      this.#executor = executor
      const view = executor.view()
      const facts = executor.facts()
      const response = await this.#request('/api/tour/sessions', {
        voice: chosen,
        sdp,
        scene: openingLine(view, facts, this.#host.localTime()),
      })
      const created = (await response.json()) as {
        sessionId?: unknown
        expiresAt?: unknown
        sdp?: unknown
      }
      if (
        typeof created.sessionId !== 'string' ||
        typeof created.sdp !== 'string' ||
        typeof created.expiresAt !== 'number'
      )
        throw new Error('The guide session response was invalid.')
      this.#guard(generation)
      this.#sessionId = created.sessionId
      this.#update({
        expiresAt: created.expiresAt > 0 ? created.expiresAt : null,
      })
      await live.accept(created.sdp)
      this.#guard(generation)
      this.#sceneRevision = executor.viewRevision
      this.#sceneChangedAt = null
      this.#sceneText = sceneBlock(view, facts)
      this.#update({ connection: 'connected', status: 'Listening' })
      this.#pollRelease ??= this.#host.poll(() => this.#tick())
      this.#visibilityRelease ??= this.#host.visibility((visible) => {
        if (!visible) this.pause()
      })
      this.#leavingRelease ??=
        this.#host.leaving?.(() => {
          try {
            this.#send({ type: 'session.close' })
          } catch {
            /* The peer connection closing is the fallback the provider honors. */
          }
          this.#live?.stop()
        }) ?? null
      // The documented recipe: the instruction alone greeted in one of two
      // probe runs; with the commentary cue after it, every time.
      const greeting = this.#send({
        type: 'session.instructions.append',
        delegation_id: null,
        content: GREETING_INSTRUCTION,
      })
      await loop.waitForAck(greeting, ACK_TIMEOUT_MS)
      if (generation !== this.#generation) return
      this.#send({
        type: 'session.commentary.append',
        delegation_id: null,
        content: BEGIN_CONVERSATION,
      })
    } catch (cause) {
      if (generation !== this.#generation) return
      this.#teardown()
      this.#update({
        connection: 'offline',
        status: '',
        message: message(cause),
      })
    }
  }

  pause(): void {
    if (this.#snapshot.connection !== 'connected' || this.#snapshot.paused)
      return
    this.#pausedAt = this.#host.now()
    this.#cancelLinger()
    this.#executor?.cancel()
    void this.#live?.muteMicrophone(true).catch(() => {})
    this.#live?.muteGuide(true)
    try {
      this.#send({ type: 'session.input_audio.mute' })
      this.#send({
        type: 'session.instructions.append',
        delegation_id: null,
        content: PAUSE_INSTRUCTION,
      })
    } catch {
      /* A connection that cannot carry the mute is one the failure handler is about to report. */
    }
    this.#update({ paused: true, status: 'Paused' })
  }

  resume(): void {
    if (this.#snapshot.connection !== 'connected' || !this.#snapshot.paused)
      return
    this.#pausedAt = null
    void this.#live?.muteMicrophone(false).catch((cause: unknown) => {
      this.#update({ message: message(cause) })
    })
    this.#live?.muteGuide(false)
    try {
      this.#send({ type: 'session.input_audio.unmute' })
      this.#send({
        type: 'session.instructions.append',
        delegation_id: null,
        content: RESUME_INSTRUCTION,
      })
    } catch {
      /* As above. */
    }
    this.#update({ paused: false, status: 'Listening', message: null })
  }

  /** Close the session, wait for its final usage, release everything. */
  async end(): Promise<void> {
    if (this.#snapshot.connection === 'offline' || this.#ending) return
    this.#ending = true
    this.#generation++
    this.#cancelLinger()
    this.#executor?.cancel()
    this.#update({ connection: 'closing', status: 'Ending' })
    const live = this.#live
    if (live !== null) await live.close()
    this.#teardown()
    this.#update({
      connection: 'offline',
      paused: false,
      status: '',
      voice: null,
      expiresAt: null,
    })
  }

  /** A typed request, as the visitor's own words. */
  async ask(text: string): Promise<void> {
    const query = text.trim().slice(0, 4000)
    if (
      !query ||
      this.#loop === null ||
      this.#snapshot.connection !== 'connected'
    )
      return
    this.#loop.ask(query)
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                   */
  /* ---------------------------------------------------------------------- */

  #event(live: LiveConnectionPort, event: LiveServerEvent): void {
    if (live !== this.#live) return
    if (event.type !== 'session.output_transcript.delta')
      this.#record('receive', event)
    this.#loop?.receive(event)
    if (event.type === 'session.closed' && !this.#ending) {
      const reason = typeof event.reason === 'string' ? event.reason : 'closed'
      this.#teardown()
      this.#update({
        connection: 'offline',
        paused: false,
        status: '',
        voice: null,
        message:
          reason === 'expired'
            ? 'The guide session reached its time limit.'
            : 'The guide session ended.',
      })
    }
  }

  #failure(live: LiveConnectionPort, reason: string): void {
    if (live !== this.#live || this.#ending) return
    this.#teardown()
    this.#update({
      connection: 'offline',
      paused: false,
      status: '',
      voice: null,
      message: reason,
    })
  }

  #send(event: Record<string, unknown>): string {
    const live = this.#live
    if (live === null) throw new Error('The voice connection is not open.')
    const id = live.send(event)
    this.#record('send', { ...event, event_id: id })
    return id
  }

  async #execute(call: GuideCall): Promise<GuideToolOutput> {
    const executor = this.#executor
    if (executor === null) return { status: 'rejected', reason: 'No scene.' }
    if (this.#snapshot.paused)
      return { status: 'rejected', reason: 'The visitor has paused the guide.' }
    const output = await executor.execute(call)
    this.#record('note', { call: call.name, output })
    return output
  }

  #executed(call: GuideCall, output: GuideToolOutput): void {
    if (call.name === 'linger' && output.status === 'scheduled') {
      this.#linger = { seconds: call.seconds, phase: 'chain', quietFrom: 0 }
      return
    }
    if (
      call.name === 'go_to' ||
      call.name === 'frame_pair' ||
      call.name === 'stand_at' ||
      call.name === 'leave_surface' ||
      call.name === 'hold_view'
    )
      this.#cancelLinger()
    this.#refresh()
  }

  #arrival(arrival: GuideArrival): void {
    const executor = this.#executor
    const loop = this.#loop
    if (executor === null || loop === null) return
    const view = executor.view()
    const facts = executor.facts()
    this.#sceneText = sceneBlock(view, facts)
    this.#sceneRevision = executor.viewRevision
    this.#sceneChangedAt = null
    const prompted = loop.prompt(arrivalBlock(arrival, view, facts))
    this.#record('note', { arrival: arrival.subject, prompted })
    this.#think(uiContext(view))
    this.#refresh()
  }

  #takeover(): void {
    const executor = this.#executor
    const loop = this.#loop
    this.#cancelLinger()
    if (executor === null || loop === null) return
    loop.cancelPending()
    const view = executor.view()
    const facts = executor.facts()
    this.#sceneText = sceneBlock(view, facts)
    this.#sceneRevision = executor.viewRevision
    this.#sceneChangedAt = null
    loop.queue(takeoverBlock(view, facts))
    this.#think(takeoverContext(view))
    this.#update({ status: 'You have the camera' })
  }

  #think(content: string): void {
    try {
      this.#send({
        type: 'session.thinking.append',
        delegation_id: null,
        content,
      })
    } catch {
      /* Reported by the failure handler if the connection is gone. */
    }
  }

  /* ---------------------------------------------------------------------- */
  /* The clock                                                                */
  /* ---------------------------------------------------------------------- */

  #tick(): void {
    if (this.#snapshot.connection !== 'connected') return
    const executor = this.#executor
    const loop = this.#loop
    const live = this.#live
    if (executor === null || loop === null || live === null) return
    const now = this.#host.now()
    executor.poll()
    this.#clock.sample(live.level())
    const revision = executor.viewRevision
    if (revision !== this.#sceneRevision) {
      this.#sceneRevision = revision
      this.#sceneChangedAt = now
    }
    if (
      this.#sceneChangedAt !== null &&
      now - this.#sceneChangedAt >= SCENE_DEBOUNCE_MS &&
      executor.pending === null
    ) {
      const view = executor.view()
      if (
        !view.traveling ||
        now - this.#sceneChangedAt >= 10 * SCENE_DEBOUNCE_MS
      ) {
        this.#sceneChangedAt = null
        const text = sceneBlock(view, executor.facts())
        if (text !== this.#sceneText) {
          this.#sceneText = text
          loop.queue(text)
          this.#think(uiContext(view))
        }
      }
    }
    const expiresAt = this.#snapshot.expiresAt
    if (expiresAt !== null && now >= expiresAt) {
      void this.end().then(() =>
        this.#update({ message: 'The guide session reached its time limit.' }),
      )
      return
    }
    if (this.#pausedAt !== null && now - this.#pausedAt >= PAUSE_LIMIT_MS) {
      void this.end().then(() =>
        this.#update({
          message: 'The guide ended after three minutes paused.',
        }),
      )
      return
    }
    this.#tickLinger(now)
    this.#refresh()
  }

  #tickLinger(now: number): void {
    const linger = this.#linger
    const loop = this.#loop
    if (linger === null || loop === null) return
    if (linger.phase === 'chain') {
      if (loop.inFlight) return
      linger.phase = 'speech'
      void this.#clock.waitForBeat({ since: now }).then((outcome) => {
        if (this.#linger !== linger || outcome === 'canceled') return
        linger.phase = 'quiet'
        linger.quietFrom = this.#host.now()
        this.#record('note', { beat: outcome, quietSeconds: linger.seconds })
      })
      return
    }
    if (
      linger.phase === 'quiet' &&
      now - linger.quietFrom >= linger.seconds * 1000
    ) {
      this.#linger = null
      loop.prompt(quietBlock(linger.seconds))
    }
  }

  #cancelLinger(): void {
    this.#linger = null
    this.#clock.cancel()
  }

  #refresh(): void {
    const snapshot = this.#snapshot
    if (snapshot.connection !== 'connected') return
    const loop = this.#loop
    const executor = this.#executor
    const usage = loop?.usage ?? snapshot.usage
    const status = snapshot.paused
      ? 'Paused'
      : executor?.searching
        ? 'Searching the sky'
        : executor?.pending !== null && executor?.pendingSubject
          ? `Moving to ${executor.pendingSubject}`
          : this.#clock.speaking
            ? 'Speaking'
            : loop?.inFlight
              ? 'Thinking'
              : snapshot.status === 'You have the camera'
                ? snapshot.status
                : 'Listening'
    if (status !== snapshot.status || usage !== snapshot.usage)
      this.#update({ status, usage })
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                                */
  /* ---------------------------------------------------------------------- */

  #guard(generation: number): void {
    if (generation !== this.#generation)
      throw new Error('The guide request was canceled.')
  }

  #teardown(): void {
    this.#cancelLinger()
    this.#pollRelease?.()
    this.#pollRelease = null
    this.#visibilityRelease?.()
    this.#visibilityRelease = null
    this.#leavingRelease?.()
    this.#leavingRelease = null
    this.#loop?.stop()
    this.#loop = null
    this.#live?.stop()
    this.#live = null
    this.#executor?.dispose()
    this.#executor = null
    this.#sessionId = null
    this.#pausedAt = null
    this.#sceneChangedAt = null
    this.#ending = false
    for (const controller of this.#pending) controller.abort()
    this.#pending.clear()
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
          const error = (await response.json()) as { error?: string }
          detail = error.error ?? detail
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
