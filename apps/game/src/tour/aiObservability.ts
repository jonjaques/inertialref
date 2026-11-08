import type { GuideCall, GuideClientEvent, GuideToolOutput } from '@inertialref/protocol'
import { isPostHogStarted, posthog } from '../posthog.ts'
import type { LiveServerEvent } from './media.ts'

type Message = {
  readonly role: 'user' | 'system' | 'assistant'
  readonly content: unknown
}

type Raw = Readonly<Record<string, unknown>>

type Generation = {
  readonly traceId: string
  readonly startedAt: number
  readonly input: Message[]
  readonly output: Message[]
  transcript: string
  model: string | null
  captured: boolean
}

const record = (value: unknown): Raw | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Raw)
    : null

const allowedId = (value: string): boolean =>
  /^[A-Za-z0-9_~.@()!'|:-]+$/.test(value)

const generatedId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `${Date.now()}-${Math.random().toString(36).slice(2)}`

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined

/**
 * Mirrors the direct OpenAI Realtime data channel into AI Observability.
 * Captures are best effort: the guide continues even when PostHog is absent.
 */
export class GuideAiObservability {
  readonly #now: () => number
  #sessionId: string | null = null
  #queuedInput: Message[] = []
  #visitorTranscript = ''
  #requestedAt: number[] = []
  #generations = new Map<string, Generation>()
  #activeResponseId: string | null = null

  constructor(now: () => number) {
    this.#now = now
  }

  startSession(sessionId: string): void {
    this.#sessionId = allowedId(sessionId) ? sessionId : `guide-${generatedId()}`
    this.#queuedInput = []
    this.#visitorTranscript = ''
    this.#requestedAt = []
    this.#generations.clear()
    this.#activeResponseId = null
  }

  sent(event: GuideClientEvent): void {
    if (event.type === 'response.create') {
      this.#requestedAt.push(this.#now())
      return
    }
    if (event.type !== 'response.item.create') return

    const item = event.item
    if (item.type === 'message') {
      const content = item.content
        .filter((part) => part.type === 'input_text')
        .map((part) => part.text)
        .join('')
      if (!content) return
      this.#queuedInput.push({
        role: item.role === 'developer' ? 'system' : item.role,
        content,
      })
      return
    }
    if (item.type === 'function_call_output') {
      this.#queuedInput.push({
        role: 'assistant',
        content: [{ type: 'function_output', output: item.output }],
      })
    }
  }

  received(event: LiveServerEvent): void {
    if (event.type === 'session.input_transcript.delta') {
      if (typeof event.delta === 'string') this.#visitorTranscript += event.delta
      return
    }
    if (event.type === 'session.output_transcript.delta') {
      const active = this.#active()
      if (active !== null && typeof event.delta === 'string')
        active.transcript += event.delta
      return
    }
    if (event.type !== 'response.event') return

    const nested = record(event.event)
    if (nested === null || typeof nested.type !== 'string') return
    const response = record(nested.response)
    const responseId = typeof response?.id === 'string' ? response.id : null

    if (nested.type === 'response.created' && responseId !== null) {
      if (this.#visitorTranscript) {
        this.#queuedInput.push({
          role: 'user',
          content: this.#visitorTranscript,
        })
        this.#visitorTranscript = ''
      }
      this.#generations.set(responseId, {
        traceId: allowedId(responseId) ? responseId : generatedId(),
        startedAt: this.#requestedAt.shift() ?? this.#now(),
        input: this.#queuedInput.splice(0),
        output: [],
        transcript: '',
        model: typeof response.model === 'string' ? response.model : null,
        captured: false,
      })
      if (this.#generations.size > 64)
        for (const id of this.#generations.keys())
          if (id !== responseId) {
            this.#generations.delete(id)
            break
          }
      this.#activeResponseId = responseId
      return
    }

    if (nested.type === 'response.output_item.done') {
      const item = record(nested.item)
      const active = this.#active()
      if (active === null || item === null) return
      if (item.type === 'message') {
        const content = Array.isArray(item.content)
          ? item.content
              .map((part) => record(part))
              .filter((part) => part?.type === 'output_text')
              .map((part) => String(part?.text ?? ''))
              .join('')
          : ''
        if (content) active.output.push({ role: 'assistant', content })
      } else if (item.type === 'function_call' && typeof item.name === 'string') {
        active.output.push({
          role: 'assistant',
          content: [
            {
              type: 'function',
              function: {
                name: item.name,
                arguments:
                  typeof item.arguments === 'string' ? item.arguments : '{}',
              },
            },
          ],
        })
      }
      return
    }

    if (
      (nested.type === 'response.completed' ||
        nested.type === 'response.failed' ||
        nested.type === 'response.incomplete') &&
      responseId !== null
    )
      this.#captureGeneration(responseId, response, nested.type)
  }

  toolExecuted(
    call: GuideCall,
    output: GuideToolOutput,
    startedAt: number,
  ): void {
    const active = this.#active()
    if (active === null || this.#sessionId === null || !isPostHogStarted()) return
    this.#capture('$ai_span', {
      $ai_trace_id: active.traceId,
      $ai_session_id: this.#sessionId,
      $ai_span_id: generatedId(),
      $ai_span_name: `guide_${call.name}`,
      $ai_parent_id: active.traceId,
      $ai_input_state: call,
      $ai_output_state: output,
      $ai_latency: Math.max(0, (this.#now() - startedAt) / 1000),
      $ai_is_error: output.status === 'error',
    })
  }

  toolFailed(call: GuideCall, cause: unknown, startedAt: number): void {
    const active = this.#active()
    if (active === null || this.#sessionId === null || !isPostHogStarted()) return
    this.#capture('$ai_span', {
      $ai_trace_id: active.traceId,
      $ai_session_id: this.#sessionId,
      $ai_span_id: generatedId(),
      $ai_span_name: `guide_${call.name}`,
      $ai_parent_id: active.traceId,
      $ai_input_state: call,
      $ai_latency: Math.max(0, (this.#now() - startedAt) / 1000),
      $ai_is_error: true,
      $ai_error: cause instanceof Error ? cause.message : String(cause),
    })
  }

  #active(): Generation | null {
    if (this.#activeResponseId === null) return null
    return this.#generations.get(this.#activeResponseId) ?? null
  }

  #captureGeneration(
    responseId: string,
    response: Raw | null,
    status: 'response.completed' | 'response.failed' | 'response.incomplete',
  ): void {
    const generation = this.#generations.get(responseId)
    if (
      generation === undefined ||
      generation.captured ||
      this.#sessionId === null
    )
      return
    generation.captured = true
    if (typeof response?.model === 'string') generation.model = response.model
    if (!isPostHogStarted()) return

    const usage = record(response?.usage)
    const inputDetails = record(usage?.input_tokens_details)
    const output =
      generation.output.length > 0
        ? generation.output
        : generation.transcript
          ? [{ role: 'assistant' as const, content: generation.transcript }]
          : []
    this.#capture('$ai_generation', {
      $ai_trace_id: generation.traceId,
      $ai_session_id: this.#sessionId,
      $ai_span_id: generation.traceId,
      $ai_span_name: 'openai_realtime_response',
      $ai_provider: 'openai',
      ...(generation.model === null ? {} : { $ai_model: generation.model }),
      $ai_input: generation.input,
      $ai_output_choices: output,
      ...(finite(usage?.input_tokens) === undefined
        ? {}
        : { $ai_input_tokens: finite(usage?.input_tokens) }),
      ...(finite(usage?.output_tokens) === undefined
        ? {}
        : { $ai_output_tokens: finite(usage?.output_tokens) }),
      ...(finite(inputDetails?.cached_tokens) === undefined
        ? {}
        : { $ai_cache_read_input_tokens: finite(inputDetails?.cached_tokens) }),
      $ai_latency: Math.max(0, (this.#now() - generation.startedAt) / 1000),
      $ai_stream: true,
      $ai_is_error: status !== 'response.completed',
      ...(status === 'response.completed' ? {} : { $ai_stop_reason: status }),
    })
  }

  #capture(event: '$ai_generation' | '$ai_span', properties: Raw): void {
    try {
      posthog.capture(event, properties)
    } catch {
      // Observability must not affect a live guide session.
    }
  }
}
