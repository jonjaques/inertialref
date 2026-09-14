import type { GuideUsage } from '@inertialref/devtools'
import {
  decodeGuideCall,
  type GuideCall,
  type GuideToolOutput,
} from '@inertialref/protocol'

/*
 * The tool loop over the data channel.
 *
 * A function call arrives as a `response.event` envelope whose nested event
 * is `response.output_item.done` with a `function_call` item. The loop
 * collects those from the item events — lifecycle snapshots such as
 * `response.completed` carry `output: []` on purpose — executes each call
 * once, answers with a `function_call_output`, and continues the response
 * with `response.create`, because appending a result does not continue it.
 *
 * Two facts about the provider shape everything else here. Live voices only
 * the terminal response of a delegation, so a chain is "in flight" until a
 * response ends without a tool call; and Live queues a new delegation behind
 * a chain still in flight. The browser therefore never starts backend work
 * while a chain is open or the visitor is speaking: `prompt` queues the
 * message as state and lets the next response read it instead.
 *
 * Calls are executed one at a time whatever `parallel_tool_calls` says, and
 * a call id seen twice executes once: the probe saw the provider redeliver
 * an item event, and a camera moved twice is a camera that arrived at the
 * wrong place.
 */

export interface GuideChannel {
  /** Send one client event; returns its event id. */
  send(event: Record<string, unknown>): string
}

export interface GuideLoopOptions {
  readonly now: () => number
  readonly execute: (call: GuideCall) => Promise<GuideToolOutput>
  /** After a call has been answered, whatever the outcome. */
  readonly onExecuted?: (call: GuideCall, output: GuideToolOutput) => void
  /** A delegation the voice started, not one the browser prompted. */
  readonly onDelegation?: () => void
  readonly onError?: (code: string, message: string) => void
  readonly onChange?: () => void
  /** Milliseconds since the last visitor fragment during which the visitor counts as speaking. */
  readonly visitorQuietMs?: number
}

interface OpenResponse {
  readonly id: string
  readonly delegationId: string | null
  completed: boolean
  calls: number
  text: string
}

interface PendingCall {
  readonly callId: string
  readonly name: string
  readonly arguments: string
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

export class GuideLoop {
  readonly #channel: GuideChannel
  readonly #options: GuideLoopOptions
  readonly #responses = new Map<string, OpenResponse>()
  readonly #calls = new Map<string, PendingCall>()
  readonly #counted = new Set<string>()
  readonly #acks = new Map<
    string,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >()
  #queue: Promise<void> = Promise.resolve()
  #continuing = false
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

  constructor(channel: GuideChannel, options: GuideLoopOptions) {
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
    return [...this.#calls.values()].filter((call) => !call.answered).length
  }
  /** A chain that has not ended without a tool call. */
  get inFlight(): boolean {
    if (this.#continuing || this.pendingCalls > 0) return true
    for (const response of this.#responses.values())
      if (!response.completed) return true
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
    this.#item({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text }],
    })
  }

  /** The visitor's own words, typed: the documented text-input path. */
  ask(text: string): void {
    this.#item({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })
    this.#create()
  }

  /**
   * Queue a developer message and run the backend on it — but only while no
   * chain is in flight and the visitor is quiet. Otherwise the message is
   * queued alone and the next response reads it as state. Returns whether
   * the backend was started.
   */
  prompt(text: string): boolean {
    this.queue(text)
    if (this.inFlight || this.visitorSpeaking) return false
    this.#create()
    return true
  }

  /** Answer every unanswered call as canceled and let the chain continue. */
  cancelPending(reason = CANCELED.reason): void {
    for (const call of this.#calls.values()) {
      if (call.answered) continue
      call.answered = true
      this.#output(call.callId, { ...CANCELED, reason })
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
      if (type === 'session.closed')
        this.#closed = {
          reason: typeof event.reason === 'string' ? event.reason : 'unknown',
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
      this.#options.onError?.(
        typeof error?.code === 'string' ? error.code : 'provider-error',
        typeof error?.message === 'string' ? error.message : '',
      )
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
        this.#continuing = false
        if (id !== null && !this.#responses.has(id))
          this.#responses.set(id, {
            id,
            delegationId,
            completed: false,
            calls: 0,
            text: '',
          })
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
          if (this.#calls.has(callId)) return
          const call: PendingCall = {
            callId,
            name,
            arguments:
              typeof item.arguments === 'string' ? item.arguments : '{}',
            answered: false,
          }
          this.#calls.set(callId, call)
          if (this.#calls.size > 512)
            this.#calls.delete(this.#calls.keys().next().value!)
          const open = this.#open(delegationId)
          if (open !== undefined) open.calls += 1
          this.#queue = this.#queue.then(() => this.#run(call))
          this.#options.onChange?.()
        } else if (item.type === 'message') {
          const text = (Array.isArray(item.content) ? item.content : [])
            .map((part) => record(part))
            .filter((part) => part?.type === 'output_text')
            .map((part) => String(part!.text ?? ''))
            .join('')
          const open = this.#open(delegationId)
          if (open !== undefined) open.text += text
          if (text) this.#lastText = text
          this.#options.onChange?.()
        }
        return
      }
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete': {
        if (id === null) return
        const open = this.#responses.get(id)
        if (open !== undefined) open.completed = true
        const usage = record(response?.usage)
        if (usage !== null && !this.#counted.has(id)) {
          this.#counted.add(id)
          const details = record(usage.input_tokens_details)
          this.#usage = {
            ...this.#usage,
            responses: this.#usage.responses + 1,
            inputTokens: this.#usage.inputTokens + count(usage.input_tokens),
            cachedTokens:
              this.#usage.cachedTokens + count(details?.cached_tokens),
            outputTokens: this.#usage.outputTokens + count(usage.output_tokens),
          }
        }
        // Finished responses are kept only long enough to answer "is a chain
        // open?"; the map is bounded so a long session cannot grow it.
        if (this.#responses.size > 64)
          for (const [key, row] of this.#responses)
            if (row.completed && this.#responses.size > 32)
              this.#responses.delete(key)
        this.#options.onChange?.()
        return
      }
      default:
        return
    }
  }

  #open(delegationId: string | null): OpenResponse | undefined {
    const rows = [...this.#responses.values()].filter((row) => !row.completed)
    return rows.find((row) => row.delegationId === delegationId) ?? rows.at(-1)
  }

  async #run(call: PendingCall): Promise<void> {
    if (this.#stopped || call.answered) return
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
    this.#output(call.callId, output)
    if (decodedCall !== null) this.#options.onExecuted?.(decodedCall, output)
  }

  #output(callId: string, output: GuideToolOutput): void {
    this.#item({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(output),
    })
    this.#create()
  }

  #item(item: Record<string, unknown>): void {
    if (this.#stopped) return
    this.#channel.send({ type: 'response.item.create', item })
  }

  #create(): void {
    if (this.#stopped) return
    // Between this send and the provider's `response.created` the chain is
    // open and nothing has said so yet; the flag covers that gap so an
    // arrival cannot start a second response into it.
    this.#continuing = true
    this.#channel.send({ type: 'response.create' })
    this.#options.onChange?.()
  }
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
