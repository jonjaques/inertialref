import { describe, expect, it, vi } from 'vitest'
import { GuideAiObservability } from './aiObservability.ts'
import type { GuideResponseRecord } from './loop.ts'

const response = (
  overrides: Partial<GuideResponseRecord> = {},
): GuideResponseRecord => ({
  id: 'resp_1',
  model: 'gpt-live',
  outcome: 'completed',
  durationMs: 250,
  text: 'Titan, behind the rings.',
  calls: [],
  usage: { inputTokens: 1875, cachedTokens: 1619, outputTokens: 28 },
  ...overrides,
})

function rig(transcripts = true) {
  const capture = vi.fn()
  let consent = transcripts
  const ai = new GuideAiObservability(capture, () => consent)
  ai.startSession('sess_1')
  return {
    ai,
    capture,
    consent: (on: boolean) => {
      consent = on
    },
  }
}

describe('the guide as AI traces', () => {
  it('gives a generation the conversation it read and what it returned', () => {
    const { ai, capture } = rig()
    ai.sent({ kind: 'message', role: 'developer', text: 'Scene: Saturn.' })
    ai.heard('Show me ')
    ai.heard('Titan.')
    ai.responseStarted('resp_1')
    // Queued after the start: the next response reads it, not this one.
    ai.sent({ kind: 'message', role: 'developer', text: 'Arrived: Titan.' })
    ai.responseEnded(
      response({
        calls: [{ callId: 'call_1', name: 'go_to', arguments: '{}' }],
      }),
    )

    expect(capture).toHaveBeenCalledExactlyOnceWith('$ai_generation', {
      $ai_trace_id: 'resp_1',
      $ai_session_id: 'sess_1',
      $ai_span_id: 'resp_1',
      $ai_span_name: 'openai_realtime_response',
      $ai_provider: 'openai',
      $ai_service_tier: 'priority',
      $ai_model: 'gpt-live',
      $ai_input: [
        { role: 'system', content: 'Scene: Saturn.' },
        { role: 'user', content: 'Show me Titan.' },
      ],
      $ai_output_choices: [
        { role: 'assistant', content: 'Titan, behind the rings.' },
        {
          role: 'assistant',
          content: [
            {
              type: 'function',
              id: 'call_1',
              function: { name: 'go_to', arguments: '{}' },
            },
          ],
        },
      ],
      guide_content: 'full',
      $ai_tools_called: 'go_to',
      $ai_tool_call_count: 1,
      $ai_input_tokens: 1875,
      $ai_output_tokens: 28,
      $ai_cache_read_input_tokens: 1619,
      $ai_latency: 0.25,
      $ai_stream: true,
      $ai_is_error: false,
    })

    ai.responseStarted('resp_2')
    ai.responseEnded(response({ id: 'resp_2', outcome: 'failed', usage: null }))
    expect(capture).toHaveBeenLastCalledWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_input: [{ role: 'system', content: 'Arrived: Titan.' }],
        $ai_is_error: true,
        $ai_stop_reason: 'failed',
      }),
    )
  })

  it('records a tool answer as the tool, under its call', () => {
    const { ai, capture } = rig()
    ai.sent({ kind: 'output', callId: 'call_1', output: '{"status":"ok"}' })
    ai.responseStarted('resp_1')
    ai.responseEnded(response())
    expect(capture.mock.calls[0]![1].$ai_input).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: '{"status":"ok"}' },
    ])
  })

  it('parents a tool span to the response that made the call, even after it ended', () => {
    const { ai, capture } = rig()
    ai.responseStarted('resp/1')
    ai.responseEnded(response({ id: 'resp/1' }))
    const traceId = capture.mock.calls[0]![1].$ai_trace_id
    // A slash is outside PostHog's id characters; the trace gets its own id.
    expect(traceId).not.toBe('resp/1')

    ai.toolSettled(
      { name: 'describe_view' },
      { status: 'error', reason: 'No scene.' },
      { responseId: 'resp/1', durationMs: 40 },
    )
    expect(capture).toHaveBeenLastCalledWith(
      '$ai_span',
      expect.objectContaining({
        $ai_trace_id: traceId,
        $ai_parent_id: traceId,
        $ai_span_name: 'guide_describe_view',
        $ai_latency: 0.04,
        $ai_is_error: true,
        $ai_error: 'No scene.',
      }),
    )

    ai.toolSettled(
      { name: 'describe_view' },
      { status: 'ok' },
      { responseId: null, durationMs: 1 },
    )
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('sends no sentence without the visitor’s consent, and says which it sent', () => {
    const { ai, capture, consent } = rig(false)
    ai.sent({ kind: 'message', role: 'developer', text: 'Scene: Saturn.' })
    ai.heard('Show me Titan.')
    ai.responseStarted('resp_1')
    ai.responseEnded(
      response({
        calls: [{ callId: 'call_1', name: 'go_to', arguments: '{"to":"Titan"}' }],
      }),
    )
    ai.toolSettled(
      { name: 'go_to', to: 'Titan' } as never,
      { status: 'error', reason: 'Titan is behind Saturn.' },
      { responseId: 'resp_1', durationMs: 12 },
    )
    const [generation, span] = capture.mock.calls.map((call) => call[1])
    const sent = JSON.stringify([generation, span])
    for (const words of ['Saturn', 'Titan', 'rings'])
      expect(sent).not.toContain(words)
    expect(generation).toMatchObject({
      guide_content: 'metadata',
      $ai_tools_called: 'go_to',
      $ai_input_tokens: 1875,
    })
    expect(span).toMatchObject({
      guide_content: 'metadata',
      $ai_is_error: true,
      tool_status: 'error',
    })

    // A switch turned on mid-tour applies from the next event.
    consent(true)
    ai.responseStarted('resp_2')
    ai.responseEnded(response({ id: 'resp_2' }))
    expect(capture.mock.calls.at(-1)![1]).toMatchObject({
      guide_content: 'full',
      $ai_output_choices: [{ content: 'Titan, behind the rings.' }],
    })
  })

  it('prices the voice once, at the end of the session', () => {
    const { ai, capture } = rig(false)
    const usage = {
      voiceSeconds: 90,
      responses: 4,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
    }
    ai.endSession(usage, 'ended')
    ai.endSession(usage, 'ended')
    expect(capture).toHaveBeenCalledExactlyOnceWith(
      '$ai_generation',
      expect.objectContaining({
        $ai_model: 'gpt-live-1',
        $ai_session_id: 'sess_1',
        // A minute and a half at $0.05 a minute.
        $ai_request_cost_usd: 0.075,
        $ai_stop_reason: 'ended',
      }),
    )
  })
})
