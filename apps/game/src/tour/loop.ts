import type { GuideUsage } from '@inertialref/devtools'
import {
  decodeGuideCall,
  isGuideCameraTool,
  type GuideCall,
  type GuideToolOutput,
} from '@inertialref/protocol'
import type { GuideChannel } from './channel.ts'

/*
 * The tool loop over the data channel.
 *
 * A function call arrives as a `response.event` envelope whose nested event
 * is `response.output_item.done` with a `function_call` item. The loop
 * collects those from the item events — lifecycle snapshots such as
 * `response.completed` carry `output: []` on purpose — executes each call
 * once, answers with a `function_call_output`, and continues the response
 * with `response.create` once every call the response made has its output,
 * because appending a result does not continue it and a continuation with
 * an output missing is refused.
 *
 * Two facts about the provider shape everything else here. Live voices only
 * the terminal response of a delegation, so a chain is "in flight" until a
 * response ends without a tool call; and Live queues a new delegation behind
 * a chain still in flight. The browser therefore never starts backend work
 * while a chain is open or the visitor is speaking: `prompt` queues the
 * message as state and lets the next response read it instead.
 *
 * The backend may call several tools in one response. Queries run beside
 * each other; the camera tools run one at a time, and only the first camera
 * call of a response is executed — the second is answered as rejected,
 * because a move that replaces a move still starting is a camera that
 * thrashes. A call id seen twice executes once: the probe saw the provider
 * redeliver an item event, and a camera moved twice is a camera that arrived
 * at the wrong place.
 *
 * Every row here is bounded in time as well as in number, because "in
 * flight" is read from this object alone and nothing else can close a chain
 * the provider abandons. An item event carries no response id, only the
 * envelope's delegation id, so a call is keyed to the response open under
 * its own delegation and never to whichever response happens to be open; a
 * call that arrives before its `response.created` holds a provisional row
 * until the response is known. A response is pruned only once it is done —
 * completed, every call answered, continued or terminal — and the ids of
 * finished responses and seen calls are kept after the rows go, so a
 * redelivery of either does nothing.
 */

/** The verbs the loop speaks in; `GuideChannel` in `channel.ts` is the one implementation. */
export type GuideLoopChannel = Pick<
  GuideChannel,
  'note' | 'ask' | 'answer' | 'respond'
>

/** Where an answered call came from, and how long it ran on `now`. */
export interface GuideCallContext {
  /** The response that made the call, or null while its row is provisional. */
  readonly responseId: string | null
  readonly durationMs: number
}

/** A call one response made, as the provider sent it. */
export interface GuideResponseCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

/**
 * One backend response as the loop saw it. For observability: nothing reads
 * it to decide anything.
 */
export interface GuideResponseRecord {
  readonly id: string
  readonly model: string | null
  readonly outcome: 'completed' | 'failed' | 'incomplete'
  /** From the response's creation to its outcome, on `now`. */
  readonly durationMs: number
  /** The text it returned, which is what the voice is given to say. */
  readonly text: string
  readonly calls: readonly GuideResponseCall[]
  /** The provider's count for this one response; null when it sent none. */
  readonly usage: Omit<GuideUsage, 'voiceSeconds' | 'responses'> | null
}

export interface GuideLoopOptions {
  readonly now: () => number
  readonly execute: (call: GuideCall) => Promise<GuideToolOutput>
  /** After a call has been answered, whatever the outcome. */
  readonly onExecuted?: (
    call: GuideCall,
    output: GuideToolOutput,
    context: GuideCallContext,
  ) => void
  /** A response began: what the conversation queued so far is what it reads. */
  readonly onResponseStarted?: (id: string) => void
  /** A response ended — once, however many times the provider says so. */
  readonly onResponseEnded?: (response: GuideResponseRecord) => void
  /** A delegation the voice started, not one the browser prompted. */
  readonly onDelegation?: () => void
  /** Anything that went wrong and was recovered from, for the trace. */
  readonly onError?: (code: string, message: string) => void
  /**
   * A provider error the browser cannot repair — a configuration it may not
   * change, a budget that is spent — with the sentence for the visitor. The
   * runtime ends the session on it.
   */
  readonly onFatal?: (message: string) => void
  /** The provider ended the session, with its reason: `expired`, or why else. */
  readonly onClosed?: (reason: string) => void
  readonly onChange?: () => void
  /** Milliseconds since the last visitor fragment during which the visitor counts as speaking. */
  readonly visitorQuietMs?: number
}

/**
 * How long a sent `response.create` may go unanswered before the chain reads
 * as closed. The recorded sessions answer a create in 168 to 972 ms; a
 * refusal the provider never spells out, or a create lost under a
 * redelivery, is the only way to reach this.
 */
const CONTINUATION_TIMEOUT_MS = 30_000
/**
 * How long a response may stay open. The recorded responses run 1.0 to
 * 2.0 s from created to completed, and 2,000 output tokens at low effort is
 * seconds, not a minute; a `response.completed` that never arrives is what
 * this closes.
 */
const RESPONSE_TIMEOUT_MS = 90_000
/** Rows kept once more than this many have accumulated, and the floor pruning stops at. */
const MAX_RESPONSES = 64
const KEPT_RESPONSES = 32
/** Calls held; answered ones go first, and unanswered ones are never evicted. */
const MAX_CALLS = 512
/** Ids remembered after their rows are gone, so a redelivery does nothing. */
const REMEMBERED_IDS = 1024

/**
 * Errors the browser cannot act on. The session's configuration is authored
 * by the Worker and the budget is the project's, so a code of this class ends
 * the session with the sentence rather than leaving a visitor talking to a
 * voice that cannot think.
 */
const FATAL_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  responses_validation_failed:
    "The guide's configuration was refused by the provider.",
  insufficient_quota: 'The guide has run out of budget.',
  session_expired: 'The guide session expired.',
}

/** The developer note that follows a terminal response cut off at the token cap. */
const CUT_OFF_NOTE =
  'Your last answer was cut off at the output limit. Give it again, briefly.'

interface OpenResponse {
  /** The provider's id, or null while the row is provisional. */
  id: string | null
  readonly delegationId: string | null
  readonly openedAt: number
  model: string | null
  completed: boolean
  /**
   * Open past the bound. No longer in flight and never continued, but not
   * completed either: the provider's late completion still counts once.
   */
  abandoned: boolean
  /** Every call this response made, answered or not. */
  readonly callIds: string[]
  /** The continuation has been sent, or never will be; a late redelivery must not send one. */
  continued: boolean
  text: string
}

interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly row: OpenResponse
  readonly camera: boolean
  answered: boolean
}

type Raw = Record<string, unknown>
const record = (value: unknown): Raw | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : null

const CANCELED: GuideToolOutput = {
  status: 'canceled',
  reason: 'The visitor took the camera.',
}

const provisionalKey = (delegationId: string | null): string =>
  `delegation:${delegationId ?? ''}`

export class GuideLoop {
  readonly #channel: GuideLoopChannel
  readonly #options: GuideLoopOptions
  /** Keyed by response id, or by `provisionalKey` until the id is known. */
  readonly #responses = new Map<string, OpenResponse>()
  readonly #calls = new Map<string, PendingCall>()
  /** Response ids that have completed, kept past their rows. */
  readonly #finished = new Set<string>()
  /** Call ids ever received, kept past their rows. */
  readonly #seen = new Set<string>()
  readonly #acks = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  #queue: Promise<void> = Promise.resolve()
  #continuing: { readonly eventId: string | null; readonly at: number } | null =
    null
  /** A re-prompt after a cut-off answer has been sent and not yet answered whole. */
  #reprompted = false
  #lastVisitorAt = -Infinity
  #lastGuideTextAt = -Infinity
  #lastText = ''
  #usage: GuideUsage = {
    voiceSeconds: 0,
    responses: 0,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
  }
  #closed: { reason: string } | null = null
  #stopped = false

  constructor(channel: GuideLoopChannel, options: GuideLoopOptions) {
    this.#channel = channel
    this.#options = options
  }

  get usage(): GuideUsage {
    return this.#usage
  }
  get closed(): { reason: string } | null {
    return this.#closed
  }
  /** The last words the backend returned, for the status line. */
  get lastText(): string {
    return this.#lastText
  }
  get pendingCalls(): number {
    let count = 0
    for (const call of this.#calls.values()) if (!call.answered) count++
    return count
  }
  /** A chain that has not ended without a tool call. */
  get inFlight(): boolean {
    this.#expire()
    if (this.#continuing !== null || this.pendingCalls > 0) return true
    for (const response of this.#responses.values())
      if (!response.completed && !response.abandoned) return true
    return false
  }
  get visitorSpeaking(): boolean {
    return (
      this.#options.now() - this.#lastVisitorAt <
      (this.#options.visitorQuietMs ?? 1000)
    )
  }
  get guideTextAt(): number {
    return this.#lastGuideTextAt
  }

  /** Queue a developer message as state the next response will read. */
  queue(text: string): void {
    if (this.#stopped) return
    this.#try(() => this.#channel.note(text))
  }

  /** The visitor's own words, typed: the documented text-input path. */
  ask(text: string): void {
    if (this.#stopped) return
    if (this.#try(() => this.#channel.ask(text))) this.#create()
  }

  /**
   * Queue a developer message and run the backend on it — but only while no
   * chain is in flight and the visitor is quiet. Otherwise the message is
   * queued alone and the next response reads it as state. Returns whether
   * the backend was started.
   */
  prompt(text: string): boolean {
    this.queue(text)
    return this.start()
  }

  /**
   * Run the backend on the state already queued, under the same rule. A
   * prompt refused while a chain was open is not read by that chain's
   * continuation as an instruction: the recorded sessions show a move that
   * arrives before its chain ends — a stand, a hold, a reframe — answered
   * with the travel line and never narrated. The runtime calls this once the
   * chain has closed.
   */
  start(): boolean {
    if (this.inFlight || this.visitorSpeaking) return false
    this.#create()
    return true
  }

  /** Answer every unanswered call as canceled and let the chain continue. */
  cancelPending(reason = CANCELED.reason): void {
    for (const call of this.#calls.values()) {
      if (call.answered) continue
      call.answered = true
      this.#output(call, { ...CANCELED, reason })
    }
  }

  /** Resolve when the provider acknowledges the client event, or on timeout. */
  waitForAck(eventId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#acks.delete(eventId)
        resolve(false)
      }, timeoutMs)
      this.#acks.set(eventId, { resolve, timer })
    })
  }

  stop(): void {
    this.#stopped = true
    for (const [id, ack] of this.#acks) {
      clearTimeout(ack.timer)
      ack.resolve(false)
      this.#acks.delete(id)
    }
  }

  /** Every server event the data channel delivers. */
  receive(event: Raw): void {
    if (this.#stopped) return
    const type = event.type
    if (typeof type !== 'string') return
    if (type === 'response.event') {
      this.#responseEvent(event)
      return
    }
    if (type === 'session.input_transcript.delta') {
      this.#lastVisitorAt = this.#options.now()
      return
    }
    if (type === 'session.output_transcript.delta') {
      this.#lastGuideTextAt = this.#options.now()
      return
    }
    if (type === 'session.delegation.created') {
      this.#options.onDelegation?.()
      return
    }
    if (type === 'session.usage.updated' || type === 'session.closed') {
      const seconds = record(event.usage)?.seconds
      if (typeof seconds === 'number' && Number.isFinite(seconds))
        this.#usage = {
          ...this.#usage,
          voiceSeconds: Math.max(this.#usage.voiceSeconds, seconds),
        }
      if (type === 'session.closed') {
        const reason =
          typeof event.reason === 'string' ? event.reason : 'unknown'
        this.#closed = { reason }
        this.#options.onClosed?.(reason)
      }
      this.#options.onChange?.()
      return
    }
    if (/\.(appended|muted|unmuted)$/.test(type)) {
      const id = event.client_event_id
      if (typeof id !== 'string') return
      const ack = this.#acks.get(id)
      if (ack === undefined) return
      clearTimeout(ack.timer)
      this.#acks.delete(id)
      ack.resolve(true)
      return
    }
    if (type === 'error') {
      const error = record(event.error)
      const code =
        typeof error?.code === 'string' ? error.code : 'provider-error'
      const message = typeof error?.message === 'string' ? error.message : ''
      // The Live spelling is `client_event_id` on the event; the legacy one
      // is `event_id` inside the error. A refused create is a closed chain.
      const named = event.client_event_id ?? error?.event_id
      if (
        this.#continuing !== null &&
        typeof named === 'string' &&
        named === this.#continuing.eventId
      ) {
        this.#continuing = null
        this.#options.onChange?.()
      }
      this.#options.onError?.(code, message)
      const fatal = FATAL_ERROR_MESSAGES[code]
      if (fatal !== undefined) this.#options.onFatal?.(fatal)
    }
  }

  #responseEvent(event: Raw): void {
    const nested = record(event.event)
    if (nested === null || typeof nested.type !== 'string') return
    const delegationId =
      typeof event.delegation_id === 'string' ? event.delegation_id : null
    const response = record(nested.response)
    const id = typeof response?.id === 'string' ? response.id : null
    switch (nested.type) {
      case 'response.created': {
        this.#continuing = null
        if (
          id !== null &&
          !this.#finished.has(id) &&
          !this.#responses.has(id)
        ) {
          const model =
            typeof response?.model === 'string' ? response.model : null
          const provisional = this.#responses.get(provisionalKey(delegationId))
          if (provisional !== undefined) {
            this.#responses.delete(provisionalKey(delegationId))
            provisional.id = id
            provisional.model = model
            this.#responses.set(id, provisional)
          } else this.#responses.set(id, this.#row(id, delegationId, model))
          this.#options.onResponseStarted?.(id)
        }
        this.#options.onChange?.()
        return
      }
      case 'response.output_item.done': {
        const item = record(nested.item)
        if (item === null) return
        if (item.type === 'function_call') {
          const callId = item.call_id
          const name = item.name
          if (typeof callId !== 'string' || typeof name !== 'string') return
          if (this.#seen.has(callId)) return
          remember(this.#seen, callId)
          const row = this.#rowFor(delegationId)
          const camera = isGuideCameraTool(name)
          const call: PendingCall = {
            callId,
            name,
            arguments:
              typeof item.arguments === 'string' ? item.arguments : '{}',
            row,
            camera,
            answered: false,
          }
          this.#calls.set(callId, call)
          row.callIds.push(callId)
          const secondMove =
            camera &&
            row.callIds.some(
              (other) =>
                other !== callId && this.#calls.get(other)?.camera === true,
            )
          if (!this.#pruneCalls()) {
            call.answered = true
            this.#output(call, {
              status: 'rejected',
              reason: 'Too much work is pending. This call was not executed.',
            })
          } else if (secondMove) {
            call.answered = true
            this.#output(call, {
              status: 'rejected',
              reason:
                'One camera move per turn. This call was not executed; move again after the arrival.',
            })
          } else if (camera)
            this.#queue = this.#queue.then(() => this.#run(call))
          else void this.#run(call)
          this.#options.onChange?.()
        } else if (item.type === 'message') {
          const text = (Array.isArray(item.content) ? item.content : [])
            .map((part) => record(part))
            .filter((part) => part?.type === 'output_text')
            .map((part) => String(part!.text ?? ''))
            .join('')
          const row = this.#find(delegationId)
          if (row !== undefined) row.text += text
          if (text) this.#lastText = text
          this.#options.onChange?.()
        }
        return
      }
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete': {
        if (id === null) return
        this.#completion(id, delegationId, nested.type, response)
        this.#options.onChange?.()
        return
      }
      default:
        return
    }
  }

  #completion(
    id: string,
    delegationId: string | null,
    kind: 'response.completed' | 'response.failed' | 'response.incomplete',
    response: Raw | null,
  ): void {
    let row = this.#responses.get(id)
    if (row === undefined) {
      // A redelivery for a pruned row must not adopt the calls of the next
      // response, which is what a provisional row under this delegation is.
      if (this.#finished.has(id)) return
      // A completion for a response whose `response.created` was lost: the
      // calls that arrived under its delegation hold a provisional row.
      const provisional = this.#responses.get(provisionalKey(delegationId))
      if (provisional === undefined) return
      this.#responses.delete(provisionalKey(delegationId))
      provisional.id = id
      this.#responses.set(id, provisional)
      row = provisional
      this.#options.onResponseStarted?.(id)
    }
    // A duplicate completion counts nothing twice and continues nothing.
    if (row.completed) return
    row.completed = true
    remember(this.#finished, id)
    const usage = record(response?.usage)
    if (usage !== null) {
      const details = record(usage.input_tokens_details)
      this.#usage = {
        ...this.#usage,
        responses: this.#usage.responses + 1,
        inputTokens: this.#usage.inputTokens + count(usage.input_tokens),
        cachedTokens: this.#usage.cachedTokens + count(details?.cached_tokens),
        outputTokens: this.#usage.outputTokens + count(usage.output_tokens),
      }
    }
    this.#ended(row, id, kind, response, usage)
    if (kind === 'response.failed') {
      // Never continued: a continuation of a failed response is refused,
      // and its calls are dropped rather than run for a response that is
      // not waiting for them.
      row.continued = true
      for (const callId of row.callIds) {
        const call = this.#calls.get(callId)
        if (call !== undefined) call.answered = true
      }
      const error = record(response?.error)
      this.#options.onError?.(
        typeof error?.code === 'string' ? error.code : 'response_failed',
        typeof error?.message === 'string' ? error.message : '',
      )
    } else if (
      kind === 'response.incomplete' &&
      row.callIds.length === 0 &&
      !row.abandoned
    ) {
      // A terminal response truncated before its words leaves the voice
      // silent and the stop never narrated. `max_output_tokens` counts
      // reasoning tokens, so one re-prompt is given; a second cut-off ends
      // the chain rather than loop on a question the cap cannot hold.
      const reason = record(response?.incomplete_details)?.reason
      row.continued = true
      if (reason === 'max_output_tokens' && !this.#reprompted) {
        this.#reprompted = true
        this.queue(CUT_OFF_NOTE)
        this.#create()
      } else
        this.#options.onError?.(
          typeof reason === 'string' ? reason : 'response_incomplete',
          'The response ended incomplete.',
        )
    } else {
      // A whole terminal answer restores the one re-prompt; a tool round does
      // not, or a retry that calls a tool before hitting the cap again would
      // be retried without end.
      if (kind === 'response.completed' && row.callIds.length === 0)
        this.#reprompted = false
      this.#continueIfAnswered(row)
    }
    this.#pruneResponses()
  }

  /** The response, reported once, with what its own delegation said and called. */
  #ended(
    row: OpenResponse,
    id: string,
    kind: 'response.completed' | 'response.failed' | 'response.incomplete',
    response: Raw | null,
    usage: Raw | null,
  ): void {
    const report = this.#options.onResponseEnded
    if (report === undefined) return
    const details = record(usage?.input_tokens_details)
    report({
      id,
      model: typeof response?.model === 'string' ? response.model : row.model,
      outcome:
        kind === 'response.completed'
          ? 'completed'
          : kind === 'response.failed'
            ? 'failed'
            : 'incomplete',
      durationMs: Math.max(0, this.#options.now() - row.openedAt),
      text: row.text,
      calls: row.callIds.flatMap((callId) => {
        const call = this.#calls.get(callId)
        return call === undefined
          ? []
          : [{ callId, name: call.name, arguments: call.arguments }]
      }),
      usage:
        usage === null
          ? null
          : {
              inputTokens: count(usage.input_tokens),
              cachedTokens: count(details?.cached_tokens),
              outputTokens: count(usage.output_tokens),
            },
    })
  }

  #row(
    id: string | null,
    delegationId: string | null,
    model: string | null = null,
  ): OpenResponse {
    return {
      id,
      delegationId,
      openedAt: this.#options.now(),
      model,
      completed: false,
      abandoned: false,
      callIds: [],
      continued: false,
      text: '',
    }
  }

  /**
   * The row a delegation's item belongs to: the newest open under it, else
   * its latest. Newest, because a response whose completion was lost stays
   * open until the bound closes it, and the item is the live response's.
   *
   * For a call, a row already continued is never the one: its continuation
   * is the response the call belongs to, and attaching the call to the row
   * behind it would answer it without ever continuing it.
   */
  #find(
    delegationId: string | null,
    forCall = false,
  ): OpenResponse | undefined {
    let open: OpenResponse | undefined
    let latest: OpenResponse | undefined
    for (const row of this.#responses.values()) {
      if (row.delegationId !== delegationId) continue
      if (!forCall || !row.continued) latest = row
      if (!row.completed && !row.abandoned) open = row
    }
    return open ?? latest
  }

  /** As `#find` for a call, holding a provisional row when no response can take it yet. */
  #rowFor(delegationId: string | null): OpenResponse {
    const found = this.#find(delegationId, true)
    if (found !== undefined) return found
    const row = this.#row(null, delegationId)
    this.#responses.set(provisionalKey(delegationId), row)
    return row
  }

  /** Close what the provider has abandoned, so "in flight" can become false without it. */
  #expire(): void {
    const now = this.#options.now()
    const continuing = this.#continuing
    if (continuing !== null && now - continuing.at >= CONTINUATION_TIMEOUT_MS) {
      this.#continuing = null
      this.#options.onError?.(
        'continuation-timeout',
        'No response was created for the continuation.',
      )
    }
    for (const row of this.#responses.values()) {
      if (
        row.completed ||
        row.abandoned ||
        now - row.openedAt < RESPONSE_TIMEOUT_MS
      )
        continue
      // Abandoned, not completed: nothing is in flight for it and it is
      // never continued, but a late completion still counts its usage and
      // reports the response once. Its calls are retired with it, or a tool
      // that never returns would hold "in flight" past the bound; an answer
      // that arrives later finds the call answered and sends nothing.
      row.abandoned = true
      row.continued = true
      for (const callId of row.callIds) {
        const call = this.#calls.get(callId)
        if (call !== undefined) call.answered = true
      }
      this.#options.onError?.(
        'response-timeout',
        'The response never completed.',
      )
    }
  }

  /** Done: completed or abandoned, every call answered, and continued or terminal. */
  #done(row: OpenResponse): boolean {
    return (
      (row.completed || row.abandoned) &&
      (row.continued || row.callIds.length === 0) &&
      row.callIds.every((id) => this.#calls.get(id)?.answered !== false)
    )
  }

  #pruneResponses(): void {
    if (this.#responses.size <= MAX_RESPONSES) return
    for (const [key, row] of this.#responses) {
      if (this.#responses.size <= KEPT_RESPONSES) return
      if (!this.#done(row)) continue
      this.#responses.delete(key)
      // An abandoned row's completion may still come; past the row it is a
      // redelivery, and remembered so it adopts nothing.
      if (row.id !== null) remember(this.#finished, row.id)
      for (const callId of row.callIds) this.#calls.delete(callId)
    }
  }

  /** Evict answered calls past the bound; false when nothing can go, so the new call is refused instead. */
  #pruneCalls(): boolean {
    if (this.#calls.size <= MAX_CALLS) return true
    for (const [id, call] of this.#calls) {
      if (this.#calls.size <= MAX_CALLS) break
      if (call.answered) this.#calls.delete(id)
    }
    return this.#calls.size <= MAX_CALLS
  }

  async #run(call: PendingCall): Promise<void> {
    if (this.#stopped || call.answered) return
    const startedAt = this.#options.now()
    const decoded = decodeGuideCall(call.name, call.arguments)
    let output: GuideToolOutput
    let decodedCall: GuideCall | null = null
    if (!decoded.ok) output = { status: 'error', reason: decoded.error }
    else {
      decodedCall = decoded.value
      try {
        output = await this.#options.execute(decoded.value)
      } catch (cause) {
        output = {
          status: 'error',
          reason: cause instanceof Error ? cause.message : 'The tool failed.',
        }
      }
    }
    if (this.#stopped || call.answered) return
    call.answered = true
    // Nothing past the execution may throw: this promise is the camera queue
    // for every later move, and a rejection here would stop them all.
    try {
      this.#output(call, output)
      if (decodedCall !== null)
        this.#options.onExecuted?.(decodedCall, output, {
          responseId: call.row.id,
          durationMs: Math.max(0, this.#options.now() - startedAt),
        })
    } catch (cause) {
      this.#options.onError?.('executed-hook', describe(cause))
    }
  }

  #output(call: PendingCall, output: GuideToolOutput): void {
    if (this.#stopped) return
    if (!this.#try(() => this.#channel.answer(call.callId, output))) return
    this.#continueIfAnswered(call.row)
  }

  /**
   * Continue a response once it has finished emitting and every call it made
   * has its output. Before `response.completed` more calls may still arrive;
   * after it, the last output is what continues the chain. A provisional
   * row is never continued: its response is not known to have completed.
   */
  #continueIfAnswered(row: OpenResponse): void {
    if (row.continued || !row.completed || row.callIds.length === 0) return
    if (!row.callIds.every((id) => this.#calls.get(id)?.answered === true))
      return
    row.continued = true
    this.#create()
  }

  #create(): void {
    if (this.#stopped) return
    // Between this send and the provider's `response.created` the chain is
    // open and nothing has said so yet; the flag covers that gap so an
    // arrival cannot start a second response into it. It is cleared by the
    // created event, by an error naming this event id, or by the bound.
    let eventId: string
    try {
      eventId = this.#channel.respond()
    } catch (cause) {
      this.#options.onError?.('send-failed', describe(cause))
      return
    }
    this.#continuing = { eventId, at: this.#options.now() }
    this.#options.onChange?.()
  }

  /** A send the transport may refuse once the connection is gone; reported, never thrown. */
  #try(send: () => void): boolean {
    try {
      send()
      return true
    } catch (cause) {
      this.#options.onError?.('send-failed', describe(cause))
      return false
    }
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/** Add to a set that forgets its oldest member past the bound. */
function remember(set: Set<string>, id: string): void {
  set.add(id)
  if (set.size > REMEMBERED_IDS) set.delete(set.values().next().value!)
}
