import type { GuideUsage } from '@inertialref/devtools'
import type { GuideCall, GuideToolOutput } from '@inertialref/protocol'
import type { GuideConversationEntry } from './channel.ts'
import type { GuideCallContext, GuideResponseRecord } from './loop.ts'

/*
 * The guide's tours as PostHog AI traces: one `$ai_generation` per backend
 * response and one `$ai_span` per answered tool call, grouped under the guide
 * session, and one generation for the voice when the session ends.
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
 * Overlapping delegations make that boundary approximate.
 *
 * **What was said goes only with the visitor's consent.** PostHog strips
 * nothing; privacy is the client's to decide. Without `TELEMETRY_TRANSCRIPTS`
 * a tour reports its shape — models, tokens, cost, latency, which tools ran
 * and whether they failed — and no sentence: no input, no output, no tool
 * arguments (model text made from speech) and no tool state. The names of the
 * tools called are sent explicitly then, because PostHog extracts them from
 * the output it no longer gets. `guide_content` says which a trace is, so an
 * evaluation can filter to the traces that carry words.
 *
 * **The voice is priced here.** `gpt-live-1` is not in PostHog's price table
 * and an unmatched model gets no cost at all, so the session's voice seconds
 * are priced at OpenAI's rate and sent as a precalculated request cost.
 */

/** OpenAI's price for a minute of `gpt-live-1` audio, in USD. */
export const VOICE_USD_PER_MINUTE = 0.05

/** The two models a tour runs on, as the Worker configures them (`apps/server/src/tour/openaiLive.ts`). */
export const LIVE_MODEL = 'gpt-live-1'

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
  readonly #transcripts: () => boolean
  #sessionId: string | null = null
  #pending: Message[] = []
  #heard = ''
  readonly #traces = new Map<string, Trace>()

  /**
   * @param transcripts Whether the visitor allows what was said to be sent,
   *   asked per event so a switch flipped mid-tour applies from then on.
   */
  constructor(capture: Capture, transcripts: () => boolean) {
    this.#capture = capture
    this.#transcripts = transcripts
  }

  /** The content half of an event, or nothing, by the visitor's choice. */
  #content(properties: Record<string, unknown>): Record<string, unknown> {
    return this.#transcripts()
      ? { ...properties, guide_content: 'full' }
      : { guide_content: 'metadata' }
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
      // The Worker asks for the priority tier (`openaiLive.ts`), which
      // PostHog prices at twice the default.
      $ai_service_tier: 'priority',
      ...(response.model === null ? {} : { $ai_model: response.model }),
      ...this.#content({ $ai_input: input, $ai_output_choices: output }),
      ...(response.calls.length === 0
        ? {}
        : {
            $ai_tools_called: response.calls.map((call) => call.name).join(','),
            $ai_tool_call_count: response.calls.length,
          }),
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
      ...this.#content({
        $ai_input_state: call,
        $ai_output_state: output,
        ...(failed && typeof output.reason === 'string'
          ? { $ai_error: output.reason }
          : {}),
      }),
      $ai_latency: context.durationMs / 1000,
      $ai_is_error: failed,
      tool_status: output.status,
    })
  }

  /**
   * The voice, priced, once per session. Sent at the end because the voice's
   * seconds are cumulative on the session and only the closing count is the
   * bill; a generation per turn would need the provider to say where a turn
   * ends, which it does not.
   */
  endSession(usage: GuideUsage, cause: string): void {
    const sessionId = this.#sessionId
    this.#sessionId = null
    if (sessionId === null) return
    this.#capture('$ai_generation', {
      $ai_trace_id: `${sessionId}:voice`,
      $ai_session_id: sessionId,
      $ai_span_id: `${sessionId}:voice`,
      $ai_span_name: 'openai_realtime_voice',
      $ai_provider: 'openai',
      $ai_model: LIVE_MODEL,
      $ai_request_cost_usd:
        Math.round(((usage.voiceSeconds / 60) * VOICE_USD_PER_MINUTE) * 1e6) /
        1e6,
      $ai_stop_reason: cause,
      voice_seconds: usage.voiceSeconds,
      guide_responses: usage.responses,
      guide_content: this.#transcripts() ? 'full' : 'metadata',
    })
  }
}
