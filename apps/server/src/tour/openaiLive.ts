import {
  GUIDE_CLIENT_EVENTS,
  GUIDE_TOOLS,
  isGuideVoice,
  type GuideVoice,
} from '@inertialref/protocol'
import { BACKEND_PROMPT, LIVE_PROMPT } from './prompts.ts'

/*
 * The one provider call the Worker makes: create a Live session from the
 * browser's SDP offer.
 *
 * Everything in the configuration is authored here except the voice, checked
 * against the allowed list, and the opening scene line, bounded and placed as
 * a developer message so the greeting can be specific. The browser cannot
 * change any of it afterward: `session.update` is not on the data-channel
 * allow list, and the provider refuses it from the frontend with
 * `event_not_allowed`, which the phase-0 probe confirmed.
 *
 * There is no sideband, no hangup and no timer. A closed peer connection ends
 * the session on the provider's side within seconds, measured by a sideband
 * attach returning 404 three seconds after a page dropped its connection
 * without `session.close`, and every session carries the provider's own
 * two-hour expiry.
 */

export const LIVE_MODEL = 'gpt-live-1'
export const BACKEND_MODEL = 'gpt-6-astra'

export class GuideProviderError extends Error {
  readonly code: 'unavailable' | 'invalid-output' | 'input-limit'
  constructor(code: GuideProviderError['code']) {
    super('The guide provider is unavailable.')
    this.name = 'GuideProviderError'
    this.code = code
  }
}

export function providerRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function readProviderJson(
  response: Response,
  limit = 128 * 1024,
): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new GuideProviderError('unavailable')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new GuideProviderError('invalid-output')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > limit) throw new GuideProviderError('invalid-output')
      chunks.push(chunk.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (error) {
    await reader.cancel().catch(() => {})
    if (error instanceof GuideProviderError) throw error
    throw new GuideProviderError('invalid-output')
  } finally {
    reader.releaseLock()
  }
}

/** The session configuration, as one value a test can read whole. */
export function liveSessionConfiguration(options: {
  voice: GuideVoice
  scene: string
}): Record<string, unknown> {
  return {
    model: LIVE_MODEL,
    instructions: LIVE_PROMPT,
    audio: { output: { voice: options.voice } },
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: options.scene }],
      },
    ],
    delegation: {
      type: 'responses',
      responses: {
        model: BACKEND_MODEL,
        instructions: BACKEND_PROMPT,
        tools: GUIDE_TOOLS,
        tool_choice: 'auto',
        // Two camera operations cannot be in flight at once, and the loop
        // serializes calls besides; this keeps the model from trying.
        parallel_tool_calls: false,
        reasoning: { effort: 'low' },
        service_tier: 'priority',
        text: { verbosity: 'low' },
        max_output_tokens: 1200,
      },
    },
    client: {
      data_channel: {
        allowed_client_events: [...GUIDE_CLIENT_EVENTS],
        // The browser is the only client and the data channel carries no
        // audio, so there is nothing to hide from it.
        allowed_server_events: 'all',
      },
    },
    store: false,
  }
}

export async function createLiveSession(options: {
  apiKey: string
  sdp: string
  voice: string
  /** Verified application text only: what is on screen, and the local time. */
  scene: string
  signal?: AbortSignal
  fetch?: typeof fetch
}): Promise<{ id: string; expiresAt: number; sdp: string }> {
  if (
    !options.sdp ||
    options.sdp.length > 64 * 1024 ||
    !isGuideVoice(options.voice) ||
    !options.scene ||
    new TextEncoder().encode(options.scene).byteLength > 1500
  )
    throw new GuideProviderError('input-limit')
  const timeout = AbortSignal.timeout(12_000)
  let response: Response
  try {
    response = await (options.fetch ?? fetch)(
      'https://api.openai.com/v1/live/sessions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal:
          options.signal === undefined
            ? timeout
            : AbortSignal.any([options.signal, timeout]),
        body: JSON.stringify({
          session: liveSessionConfiguration({
            voice: options.voice,
            scene: options.scene,
          }),
          transport: { type: 'webrtc', sdp: options.sdp },
        }),
      },
    )
  } catch {
    throw new GuideProviderError('unavailable')
  }
  const value = providerRecord(await readProviderJson(response))
  const session = providerRecord(value?.session)
  const id = session?.id
  const expiresAt = session?.expires_at
  const sdp = providerRecord(value?.transport)?.sdp
  if (
    typeof id !== 'string' ||
    !id ||
    id.length > 256 ||
    typeof sdp !== 'string' ||
    !sdp ||
    sdp.length > 64 * 1024
  )
    throw new GuideProviderError('invalid-output')
  return {
    id,
    // The provider states seconds since the epoch; the browser keeps
    // milliseconds like every other clock it holds.
    expiresAt:
      typeof expiresAt === 'number' && Number.isFinite(expiresAt)
        ? expiresAt * 1000
        : 0,
    sdp,
  }
}
