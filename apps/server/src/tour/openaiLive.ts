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

/**
 * What the provider said, for the log and the trace. The browser never sees
 * it: the route answers every provider failure with the same 503, and this is
 * what makes that answer diagnosable from Workers Logs rather than from a
 * probe run with the deployment's key. `providerCode` is OpenAI's own
 * `error.code` — `token_invalidated` for a revoked key, `insufficient_quota`
 * for a spent project — and `requestId` is the id to quote at their support.
 */
export interface GuideProviderDetail {
  readonly status?: number
  readonly providerType?: string
  readonly providerCode?: string
  readonly providerMessage?: string
  readonly requestId?: string
  readonly cause?: string
}

export class GuideProviderError extends Error {
  readonly code: 'unavailable' | 'invalid-output' | 'input-limit'
  readonly detail: GuideProviderDetail
  constructor(
    code: GuideProviderError['code'],
    detail: GuideProviderDetail = {},
  ) {
    super('The guide provider is unavailable.')
    this.name = 'GuideProviderError'
    this.code = code
    this.detail = detail
  }
}

/** How much of a refusal body is read for its error record. */
const REFUSAL_LIMIT = 4096

/**
 * The provider's refusal, reduced to its error record. The record is bounded
 * and the body is never stored: a 401 for a revoked key is forty bytes of
 * JSON, and a proxy's HTML error page is not worth the log line it would
 * fill. The body is read whole rather than through the chunked reader above
 * because the host is known and its error pages are kilobytes, not the
 * megabytes the success path guards against.
 */
async function providerRefusal(
  response: Response,
): Promise<GuideProviderDetail> {
  const detail: {
    -readonly [K in keyof GuideProviderDetail]: GuideProviderDetail[K]
  } = { status: response.status }
  const requestId = response.headers.get('x-request-id')
  if (requestId) detail.requestId = requestId.slice(0, 64)
  try {
    const text = (await response.text()).slice(0, REFUSAL_LIMIT)
    const error = providerRecord(providerRecord(JSON.parse(text))?.error)
    if (typeof error?.type === 'string')
      detail.providerType = error.type.slice(0, 64)
    if (typeof error?.code === 'string')
      detail.providerCode = error.code.slice(0, 64)
    if (typeof error?.message === 'string')
      detail.providerMessage = error.message.slice(0, 256)
  } catch {
    /* Not JSON, or not readable: the status and request id are the record. */
  }
  return detail
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
  if (!response.ok)
    throw new GuideProviderError('unavailable', await providerRefusal(response))
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
        // Queries run beside each other in the browser; the loop runs camera
        // tools one at a time and executes only the first move of a response,
        // so the model may ask for several records at once without a chain of
        // round trips, and cannot thrash the camera by asking for two moves.
        parallel_tool_calls: true,
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
  } catch (error) {
    // A thrown fetch is the network, the twelve-second timeout, or a header
    // the runtime refuses — a secret pasted with a trailing newline arrives
    // here as a TypeError, not as a provider status.
    throw new GuideProviderError('unavailable', {
      cause:
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 256)
          : String(error).slice(0, 256),
    })
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
