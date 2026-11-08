import type { GuideCall, GuideToolOutput } from '@inertialref/protocol'
import type { GuideConversationEntry } from './channel.ts'
import type { GuideCallContext, GuideResponseRecord } from './loop.ts'

/*
 * The guide's backend responses as PostHog AI traces: one `$ai_generation`
 * per response and one `$ai_span` per answered tool call, grouped under the
 * guide session.
 *
 * It reads what the adapter has already parsed — the conversation entries
 * `channel.ts` names and the responses `loop.ts` tracks — and never a
 * provider event. The loop is what matches an item to its response across
 * overlapping delegations and counts a redelivered outcome once; a second
 * parser here would be a second place to get either wrong, and
 * `channel.test.ts` refuses one.
 *
 * A generation's input is what the conversation gained between the previous
 * response's start and its own: notes, the visitor's words, tool answers.
 * Overlapping delegations make that boundary approximate. Content is captured
 * — the notes, the visitor's transcribed speech, the replies and the tool
 * state — so whatever the guide hears and says is in PostHog.
 */

type Capture = (event: string, properties: Record<string, unknown>) => void

interface Message {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: unknown
  readonly tool_call_id?: string
}

interface Trace {
  readonly traceId: string
  /** Held from the response's start to its end, then dropped. */
  input: readonly Message[]
}

/** Traces kept for spans that settle after their response ended. */
const MAX_TRACES = 64

/** The characters PostHog accepts in a trace or session id. */
const safeId = (value: string): string | null =>
  /^[A-Za-z0-9_~.@()!'|:-]+$/.test(value) ? value : null

export class GuideAiObservability {
  readonly #capture: Capture
  #sessionId: string | null = null
  #pending: Message[] = []
  #heard = ''
  readonly #traces = new Map<string, Trace>()

  constructor(capture: Capture) {
    this.#capture = capture
  }

  startSession(sessionId: string): void {
    this.#sessionId = safeId(sessionId) ?? `guide-${crypto.randomUUID()}`
    this.#pending = []
    this.#heard = ''
    this.#traces.clear()
  }

  /** An entry the browser added to the conversation. */
  sent(entry: GuideConversationEntry | null): void {
    if (entry === null) return
    if (entry.kind === 'output')
      this.#pending.push({
        role: 'tool',
        tool_call_id: entry.callId,
        content: entry.output,
      })
    else if (entry.text)
      this.#pending.push({
        role: entry.role === 'developer' ? 'system' : 'user',
        content: entry.text,
      })
  }

  /** A fragment of the visitor's transcribed speech. */
  heard(fragment: string): void {
    this.#heard += fragment
  }

  responseStarted(id: string): void {
    if (this.#heard) {
      this.#pending.push({ role: 'user', content: this.#heard })
      this.#heard = ''
    }
    this.#traces.set(id, {
      traceId: safeId(id) ?? crypto.randomUUID(),
      input: this.#pending,
    })
    this.#pending = []
    if (this.#traces.size > MAX_TRACES)
      this.#traces.delete(this.#traces.keys().next().value!)
  }

  responseEnded(response: GuideResponseRecord): void {
    const trace = this.#traces.get(response.id)
    if (trace === undefined || this.#sessionId === null) return
    const input = trace.input
    trace.input = []
    const output: Message[] = [
      ...(response.text
        ? [{ role: 'assistant' as const, content: response.text }]
        : []),
      ...response.calls.map((call) => ({
        role: 'assistant' as const,
        content: [
          {
            type: 'function',
            id: call.callId,
            function: { name: call.name, arguments: call.arguments },
          },
        ],
      })),
    ]
    this.#capture('$ai_generation', {
      $ai_trace_id: trace.traceId,
      $ai_session_id: this.#sessionId,
      $ai_span_id: trace.traceId,
      $ai_span_name: 'openai_realtime_response',
      $ai_provider: 'openai',
      ...(response.model === null ? {} : { $ai_model: response.model }),
      $ai_input: input,
      $ai_output_choices: output,
      ...(response.usage === null
        ? {}
        : {
            $ai_input_tokens: response.usage.inputTokens,
            $ai_output_tokens: response.usage.outputTokens,
            $ai_cache_read_input_tokens: response.usage.cachedTokens,
          }),
      $ai_latency: response.durationMs / 1000,
      $ai_stream: true,
      $ai_is_error: response.outcome !== 'completed',
      ...(response.outcome === 'completed'
        ? {}
        : { $ai_stop_reason: response.outcome }),
    })
  }

  /** A tool call the loop answered, under the response that made it. */
  toolSettled(
    call: GuideCall,
    output: GuideToolOutput,
    context: GuideCallContext,
  ): void {
    const traceId =
      context.responseId === null
        ? undefined
        : this.#traces.get(context.responseId)?.traceId
    if (traceId === undefined || this.#sessionId === null) return
    const failed = output.status === 'error'
    this.#capture('$ai_span', {
      $ai_trace_id: traceId,
      $ai_session_id: this.#sessionId,
      $ai_span_id: crypto.randomUUID(),
      $ai_span_name: `guide_${call.name}`,
      $ai_parent_id: traceId,
      $ai_input_state: call,
      $ai_output_state: output,
      $ai_latency: context.durationMs / 1000,
      $ai_is_error: failed,
      ...(failed && typeof output.reason === 'string'
        ? { $ai_error: output.reason }
        : {}),
    })
  }
}
