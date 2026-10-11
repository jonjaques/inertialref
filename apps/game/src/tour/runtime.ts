import type {
  GuideState,
  GuideStatus,
  GuideTraceEntry,
  GuideUsage,
  ViewDescription,
} from '@inertialref/devtools'
import { NO_GUIDE_USAGE } from '@inertialref/devtools'
import {
  decode,
  decodeGuideError,
  decodeGuideSessionCreated,
  endsStop,
  GUIDE_SESSIONS_PATH,
  type GuideCall,
  type GuideSessionRequest,
  type GuideToolOutput,
} from '@inertialref/protocol'
import {
  GuideChannel,
  isOutputTranscript,
  type LiveTransport,
} from './channel.ts'
import { SpeechClock } from './clock.ts'
import { accessState, type GuideAccess } from './verdict.ts'
import type { GuideArrival, SceneFacts } from './executor.ts'
import { GuideLoop } from './loop.ts'
import type { LiveServerEvent } from './media.ts'
import {
  arrivalBlock,
  BEGIN_CONVERSATION,
  greetingInstruction,
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

/**
 * Where the session is, and while it is connected, what the guide is doing.
 *
 * Held as a code, never as the words under the controls: the status line and
 * `ir.guideStatus` are both derived from it, so a change to one sentence does
 * not change what a script reads.
 */
export type GuideActivity =
  | { readonly state: 'offline' }
  | { readonly state: 'connecting' }
  | { readonly state: 'listening' }
  | { readonly state: 'speaking' }
  | { readonly state: 'thinking' }
  | { readonly state: 'searching' }
  | { readonly state: 'moving'; readonly subject: string }
  /** The visitor took the camera and the guide has not acted since. */
  | { readonly state: 'visitor-camera' }
  | { readonly state: 'paused' }
  | { readonly state: 'ending' }

const OFFLINE: GuideActivity = { state: 'offline' }
const LISTENING: GuideActivity = { state: 'listening' }

/** The one line under the controls. */
export function statusLine(activity: GuideActivity): string {
  switch (activity.state) {
    case 'offline':
      return 'Ready'
    case 'connecting':
      return 'Connecting'
    case 'listening':
      return 'Listening'
    case 'speaking':
      return 'Speaking'
    case 'thinking':
      return 'Thinking'
    case 'searching':
      return 'Searching the sky'
    case 'moving':
      return `Moving to ${activity.subject}`
    case 'visitor-camera':
      return 'You have the camera'
    case 'paused':
      return 'Paused'
    case 'ending':
      return 'Ending'
  }
}

/** The connection an activity implies: the peer connection's own phases. */
export function connectionOf(
  activity: GuideActivity,
): GuideStatus['connection'] {
  switch (activity.state) {
    case 'offline':
      return 'offline'
    case 'connecting':
      return 'connecting'
    case 'ending':
      return 'closing'
    default:
      return 'connected'
  }
}

const sameActivity = (a: GuideActivity, b: GuideActivity): boolean =>
  a.state === b.state &&
  (a.state !== 'moving' || (b.state === 'moving' && a.subject === b.subject))

export interface GuideSnapshot {
  readonly activity: GuideActivity
  readonly voice: string | null
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

/**
 * What the runtime needs from the connection: the transport the channel's
 * verbs speak over, and the lifecycle around it. `media.ts` is the one
 * implementation; `liveFake.ts` is the tests'.
 */
export interface LiveConnectionPort extends LiveTransport {
  prepare(): Promise<string>
  accept(sdp: string): Promise<void>
  level(): number
  close(timeoutMs?: number): Promise<{ closed: boolean }>
  stop(): void
}

export interface GuideHost {
  /** The mode's verdict on whoever is signed in (`verdict.ts`). */
  access(): GuideAccess
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
    activity: OFFLINE,
    voice: null,
    message: null,
    usage: NO_GUIDE_USAGE,
    expiresAt: null,
  }
  #executor: GuideExecutorPort | null = null
  #live: LiveConnectionPort | null = null
  #channel: GuideChannel | null = null
  #loop: GuideLoop | null = null
  #sessionId: string | null = null
  #generation = 0
  #pending = new Set<AbortController>()
  #pollRelease: (() => void) | null = null
  #visibilityRelease: (() => void) | null = null
  #leavingRelease: (() => void) | null = null
  #sceneRevision = -1
  #sceneChangedAt: number | null = null
  #sceneText = ''
  #linger: Linger | null = null
  /** The view revision of an arrival queued while a chain was open, until it is prompted. */
  #deferredArrival: number | null = null
  /** A drag reports a takeover on every frame; the models hear about it once per gesture. */
  #takenOver = false
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
    const { activity, usage } = this.#snapshot
    const access = this.#host.access()
    const connection = connectionOf(activity)
    const paused = activity.state === 'paused'
    return {
      available: access.state === 'granted',
      loaded: true,
      // An offline runtime is as available as the verdict says, so a refused
      // visitor reads as refused, not as an idle guide, once it has loaded.
      state:
        activity.state === 'offline'
          ? accessState(access)
          : (activity.state satisfies GuideState),
      connection,
      sessionId: this.#sessionId,
      viewRevision: this.#executor?.viewRevision ?? null,
      microphone:
        connection === 'connected' ? (paused ? 'muted' : 'active') : 'off',
      paused,
      pendingCalls: this.#loop?.pendingCalls ?? 0,
      inFlight: this.#loop?.inFlight ?? false,
      usage,
    }
  }

  #connected(): boolean {
    return connectionOf(this.#snapshot.activity) === 'connected'
  }
  #paused(): boolean {
    return this.#snapshot.activity.state === 'paused'
  }

  #update(next: Partial<GuideSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...next }
    for (const listener of this.#listeners) listener()
  }

  /** Request the microphone, post the offer, greet. */
  async start(voice: string): Promise<void> {
    if (this.#snapshot.activity.state !== 'offline') return
    /*
     * The mode's verdict, read rather than kept: there is one per mode, keyed
     * on the user, and the runtime holds no copy to fall out of step with it.
     * Nothing is written for a refusal: the panel is only offered under a
     * grant, and `ir.guideStatus` reports the verdict's reason.
     */
    const verdict = this.#host.access()
    if (verdict.state !== 'granted') return
    const generation = ++this.#generation
    this.#ending = false
    try {
      const chosen =
        verdict.voices.find((offered) => offered === voice) ??
        verdict.voices[0] ??
        'marin'
      this.#update({
        activity: { state: 'connecting' },
        voice: chosen,
        message: null,
        usage: NO_GUIDE_USAGE,
        expiresAt: null,
      })
      const live = this.#host.live(
        (event) => this.#event(live, event),
        (reason) => this.#failure(live, reason),
      )
      this.#live = live
      const channel = new GuideChannel(live, (event, id) =>
        this.#record('send', { ...event, event_id: id }),
      )
      this.#channel = channel
      const loop = new GuideLoop(channel, {
        now: () => this.#host.now(),
        execute: (call) => this.#execute(call),
        onExecuted: (call, output) => this.#executed(call, output),
        onDelegation: () => {
          this.#cancelLinger()
          this.#takenOver = false
        },
        onError: (code, detail) => {
          this.#record('note', { error: code, detail })
          if (code === 'session_expired')
            this.#update({ message: 'The guide session expired.' })
        },
        onClosed: (reason) => this.#closed(reason),
        onChange: () => this.#refresh(),
      })
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
      const response = await this.#request(GUIDE_SESSIONS_PATH, {
        voice: chosen,
        sdp,
        scene: openingLine(view, facts, this.#host.localTime()),
      } satisfies GuideSessionRequest)
      const decoded = decode(decodeGuideSessionCreated, await response.json())
      if (!decoded.ok)
        throw new Error('The guide session response was invalid.')
      const created = decoded.value
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
      this.#update({ activity: LISTENING })
      this.#pollRelease ??= this.#host.poll(() => this.#tick())
      this.#visibilityRelease ??= this.#host.visibility((visible) => {
        if (!visible) this.pause()
      })
      this.#leavingRelease ??=
        this.#host.leaving?.(() => {
          this.#channel?.close()
          this.#live?.stop()
        }) ?? null
      // The documented recipe: the instruction alone greeted in one of two
      // probe runs; with the commentary cue after it, every time.
      const greeting = channel.instruct(greetingInstruction(chosen))
      await loop.waitForAck(greeting, ACK_TIMEOUT_MS)
      if (generation !== this.#generation) return
      channel.comment(BEGIN_CONVERSATION)
    } catch (cause) {
      if (generation !== this.#generation) return
      this.#teardown()
      this.#update({ activity: OFFLINE, message: message(cause) })
    }
  }

  pause(): void {
    const channel = this.#channel
    if (!this.#connected() || this.#paused() || channel === null) return
    this.#pausedAt = this.#host.now()
    this.#cancelLinger()
    this.#deferredArrival = null
    this.#executor?.cancel()
    void channel.mute(true).catch(() => {})
    this.#instruct(channel, PAUSE_INSTRUCTION)
    this.#update({ activity: { state: 'paused' } })
  }

  resume(): void {
    const channel = this.#channel
    if (!this.#connected() || !this.#paused() || channel === null) return
    this.#pausedAt = null
    void channel.mute(false).catch((cause: unknown) => {
      this.#update({ message: message(cause) })
    })
    this.#instruct(channel, RESUME_INSTRUCTION)
    this.#update({ activity: LISTENING, message: null })
  }

  /** An instruction a closing connection may refuse; its failure handler reports that. */
  #instruct(channel: GuideChannel, content: string): void {
    try {
      channel.instruct(content)
    } catch {
      /* A connection that cannot carry it is one the failure handler is about to report. */
    }
  }

  /** Close the session, wait for its final usage, release everything. */
  async end(): Promise<void> {
    if (this.#snapshot.activity.state === 'offline' || this.#ending) return
    this.#ending = true
    this.#generation++
    this.#cancelLinger()
    this.#executor?.cancel()
    this.#update({ activity: { state: 'ending' } })
    const live = this.#live
    if (live !== null) await live.close()
    this.#teardown()
    this.#update({ activity: OFFLINE, voice: null, expiresAt: null })
  }

  /** Drop the message: it was written for an account that is not this one. */
  forgetMessage(): void {
    if (this.#snapshot.message !== null) this.#update({ message: null })
  }

  /** A typed request, as the visitor's own words. */
  async ask(text: string): Promise<void> {
    const query = text.trim().slice(0, 4000)
    if (!query || this.#loop === null || !this.#connected()) return
    this.#loop.ask(query)
  }

  /* ---------------------------------------------------------------------- */
  /* Events                                                                   */
  /* ---------------------------------------------------------------------- */

  #event(live: LiveConnectionPort, event: LiveServerEvent): void {
    if (live !== this.#live) return
    if (!isOutputTranscript(event)) this.#record('receive', event)
    this.#loop?.receive(event)
  }

  /** The provider ended the session; an end the visitor asked for is `end`'s. */
  #closed(reason: string): void {
    if (this.#ending) return
    this.#teardown()
    this.#update({
      activity: OFFLINE,
      voice: null,
      message:
        reason === 'expired'
          ? 'The guide session reached its time limit.'
          : 'The guide session ended.',
    })
  }

  #failure(live: LiveConnectionPort, reason: string): void {
    if (live !== this.#live || this.#ending) return
    this.#teardown()
    this.#update({ activity: OFFLINE, voice: null, message: reason })
  }

  async #execute(call: GuideCall): Promise<GuideToolOutput> {
    const executor = this.#executor
    if (executor === null) return { status: 'rejected', reason: 'No scene.' }
    if (this.#paused())
      return { status: 'rejected', reason: 'The visitor has paused the guide.' }
    const output = await executor.execute(call)
    this.#record('note', { call: call.name, output })
    return output
  }

  #executed(call: GuideCall, output: GuideToolOutput): void {
    this.#takenOver = false
    if (call.name === 'linger' && output.status === 'scheduled') {
      this.#linger = { seconds: call.seconds, phase: 'chain', quietFrom: 0 }
      return
    }
    if (endsStop(output)) {
      this.#cancelLinger()
      // A new stop supersedes any arrival still waiting to be narrated.
      this.#deferredArrival = null
    }
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
    // Not prompted means a chain is open or the visitor is talking. The
    // message is queued as state either way; the tick starts the response
    // once the chain closes, at this view, or drops it if the view moves on.
    this.#deferredArrival = prompted ? null : arrival.viewRevision
    this.#takenOver = false
    this.#record('note', { arrival: arrival.subject, prompted })
    this.#think(uiContext(view))
    this.#refresh()
  }

  #takeover(): void {
    const executor = this.#executor
    const loop = this.#loop
    this.#cancelLinger()
    this.#deferredArrival = null
    if (executor === null || loop === null) return
    loop.cancelPending()
    // The observatory advances its revision on every frame of a drag, and a
    // three-second drag queued twenty-five takeover messages to the backend
    // and as many thinking appends to the voice. One per gesture: the flag
    // clears when the guide next acts or the visitor next speaks, and the
    // settled view reaches the backend through the scene block regardless.
    if (this.#takenOver) return
    this.#takenOver = true
    const view = executor.view()
    const facts = executor.facts()
    this.#sceneText = sceneBlock(view, facts)
    this.#sceneRevision = executor.viewRevision
    this.#sceneChangedAt = null
    loop.queue(takeoverBlock(view, facts))
    this.#think(takeoverContext(view))
    this.#update({ activity: { state: 'visitor-camera' } })
  }

  #think(content: string): void {
    this.#channel?.think(content)
  }

  /* ---------------------------------------------------------------------- */
  /* The clock                                                                */
  /* ---------------------------------------------------------------------- */

  #tick(): void {
    if (!this.#connected()) return
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
      // Written before the session closes rather than after, so a verdict
      // that drops the message while it closes is not followed by one.
      this.#update({ message: 'The guide session reached its time limit.' })
      void this.end()
      return
    }
    if (this.#pausedAt !== null && now - this.#pausedAt >= PAUSE_LIMIT_MS) {
      this.#update({ message: 'The guide ended after three minutes paused.' })
      void this.end()
      return
    }
    this.#tickLinger(now)
    const deferred = this.#deferredArrival
    if (deferred !== null) {
      if (deferred !== executor.viewRevision || executor.pending !== null)
        this.#deferredArrival = null
      else if (loop.start()) {
        this.#deferredArrival = null
        this.#record('note', { arrival: 'deferred', prompted: true })
      }
    }
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
        // The quiet began at the last word, not when the clock was sure of
        // it: the 2.5 s it takes to be sure is already looking time, and
        // counting it twice made every gap between stops that much longer.
        linger.quietFrom =
          outcome === 'spoken' ? this.#clock.lastLoudAt : this.#host.now()
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
    if (!this.#connected()) return
    const loop = this.#loop
    const executor = this.#executor
    const usage = loop?.usage ?? snapshot.usage
    const current = snapshot.activity
    // A takeover holds until the guide does something else; listening is
    // the one thing that does not count.
    const activity: GuideActivity =
      current.state === 'paused'
        ? current
        : executor?.searching
          ? { state: 'searching' }
          : executor?.pending !== null && executor?.pendingSubject
            ? { state: 'moving', subject: executor.pendingSubject }
            : this.#clock.speaking
              ? { state: 'speaking' }
              : loop?.inFlight
                ? { state: 'thinking' }
                : current.state === 'visitor-camera'
                  ? current
                  : LISTENING
    if (!sameActivity(activity, current) || usage !== snapshot.usage)
      this.#update({ activity, usage })
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
    this.#channel = null
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
          const error = decode(decodeGuideError, await response.json())
          if (error.ok) detail = error.value.error
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
