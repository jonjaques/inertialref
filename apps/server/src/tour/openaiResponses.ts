/** HTTP only: the Worker owns credentials, deadlines, and provider retention. */
export const DIRECTOR_MODEL = 'gpt-6-astra'
export const DIRECTOR_MODELS = [
  DIRECTOR_MODEL,
  'gpt-5.6-sol',
  'gpt-5.6-terra',
] as const
export type DirectorModel = (typeof DIRECTOR_MODELS)[number]

export type ProviderTrace = (entry: {
  event: string
  model: string
  data: unknown
}) => void

/** Diagnostics never participate in provider control flow. The host bounds its sink. */
export function emitProviderTrace(
  trace: ProviderTrace | undefined,
  entry: Parameters<ProviderTrace>[0],
): void {
  try {
    trace?.(entry)
  } catch {
    // A disabled or failed diagnostic sink must not interrupt the guide.
  }
}

export class GuideProviderError extends Error {
  readonly code:
    | 'unavailable'
    | 'timeout'
    | 'invalid-output'
    | 'incomplete'
    | 'refusal'
    | 'input-limit'

  constructor(code: GuideProviderError['code']) {
    super(
      code === 'timeout'
        ? 'The guide took too long. Please try again.'
        : 'The guide provider is unavailable.',
    )
    this.name = 'GuideProviderError'
    this.code = code
  }
}

export interface DirectorUsage {
  inputTokens: number
  outputTokens: number
}

export interface ResponsesRequest {
  apiKey: string
  input: string
  instructions: string
  schema: Record<string, unknown>
  signal?: AbortSignal
  fetch?: typeof fetch
  /** Only the explicit evaluation runner selects a comparison model. */
  model?: DirectorModel
  trace?: ProviderTrace
}

export function providerRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export async function readProviderJson(
  response: Response,
  limit = 64 * 1024,
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

/** UTF-8 bytes bound text tokens conservatively, including non-Latin input. */
export function withinTextBudget(text: string, tokens: number): boolean {
  return new TextEncoder().encode(text).byteLength <= tokens
}

export async function callResponsesDirector(
  request: ResponsesRequest,
): Promise<{
  value: unknown
  usage: DirectorUsage
  model: DirectorModel
}> {
  const model = request.model ?? DIRECTOR_MODEL
  const endpoint = '/v1/responses'
  const started = Date.now()
  let status: number | null = null
  const body = {
    model,
    reasoning: { effort: 'low' },
    max_output_tokens: 2000,
    store: false,
    instructions: request.instructions,
    input: request.input,
    text: {
      format: {
        type: 'json_schema',
        name: 'planetarium_guide',
        strict: true,
        schema: request.schema,
      },
    },
  }
  if (!withinTextBudget(JSON.stringify(body), 8000))
    throw new GuideProviderError('input-limit')
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (request.signal?.aborted) controller.abort()
  else request.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 12_000)
  emitProviderTrace(request.trace, {
    event: 'provider.request',
    model,
    data: { endpoint, ...body },
  })
  try {
    const response = await (request.fetch ?? fetch)(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${request.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    )
    status = response.status
    const value = providerRecord(await readProviderJson(response))
    if (controller.signal.aborted) throw new GuideProviderError('timeout')
    if (value?.status !== 'completed')
      throw new GuideProviderError('incomplete')
    if (!Array.isArray(value.output))
      throw new GuideProviderError('invalid-output')
    let output = ''
    for (const entry of value.output) {
      const item = providerRecord(entry)
      if (item?.type !== 'message' || !Array.isArray(item.content)) continue
      for (const entry of item.content) {
        const part = providerRecord(entry)
        if (part?.type === 'refusal') throw new GuideProviderError('refusal')
        if (part?.type === 'output_text' && typeof part.text === 'string')
          output += part.text
      }
    }
    const usage = providerRecord(value.usage)
    const inputTokens = usage?.input_tokens
    const outputTokens = usage?.output_tokens
    if (
      typeof inputTokens !== 'number' ||
      !Number.isSafeInteger(inputTokens) ||
      inputTokens < 0 ||
      typeof outputTokens !== 'number' ||
      !Number.isSafeInteger(outputTokens) ||
      outputTokens < 0
    )
      throw new GuideProviderError('invalid-output')
    try {
      const result = {
        value: JSON.parse(output) as unknown,
        usage: { inputTokens, outputTokens },
        model,
      }
      emitProviderTrace(request.trace, {
        event: 'provider.response',
        model,
        data: {
          endpoint,
          status,
          latencyMs: Date.now() - started,
          output: result.value,
          usage: result.usage,
        },
      })
      return result
    } catch {
      throw new GuideProviderError('invalid-output')
    }
  } catch (error) {
    const failure = controller.signal.aborted
      ? new GuideProviderError('timeout')
      : error instanceof GuideProviderError
        ? error
        : new GuideProviderError('unavailable')
    emitProviderTrace(request.trace, {
      event: 'provider.error',
      model,
      data: {
        endpoint,
        status,
        latencyMs: Date.now() - started,
        code: failure.code,
      },
    })
    throw failure
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', abort)
  }
}

/** Controlled clips provide the audio-ended evidence absent from Live transcripts. */
export async function synthesizeSpeech(options: {
  apiKey: string
  text: string
  signal?: AbortSignal
  fetch?: typeof fetch
  trace?: ProviderTrace
}): Promise<Uint8Array> {
  if (!options.text || !withinTextBudget(options.text, 2000))
    throw new GuideProviderError('input-limit')
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  else options.signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, 20_000)
  const model = 'gpt-4o-mini-tts'
  const endpoint = '/v1/audio/speech'
  const started = Date.now()
  let status: number | null = null
  const body = {
    model,
    voice: 'marin',
    input: options.text,
    response_format: 'mp3',
    instructions:
      'Sound like a friendly astronomy nerd sharing a fascinating detail with one curious visitor: warm, congenial, lightly playful, and easy to talk to. Let the specific curiosity hook already in the script brighten your voice. Vary your cadence with a little lift on the surprising detail and a softer beat to let it land. Let contractions in the script sound natural. Share delight without relentless hype, stock cheerleading, a formal fact-list voice, or a robotic rhythm. Take one idea, then leave a little room to look. Read the supplied text exactly; do not add words, facts, jokes, or personal experiences. Express personality through emphasis, timing, and warmth while preserving the scientific meaning and uncertainty. Io is EYE-oh; Enceladus is en-SELL-uh-dus; Iapetus is eye-APP-eh-tus.',
  }
  emitProviderTrace(options.trace, {
    event: 'provider.request',
    model,
    data: { endpoint, ...body },
  })
  try {
    const response = await (options.fetch ?? fetch)(
      'https://api.openai.com/v1/audio/speech',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify(body),
      },
    )
    status = response.status
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new GuideProviderError('unavailable')
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > 2 * 1024 * 1024)
          throw new GuideProviderError('invalid-output')
        chunks.push(chunk.value)
      }
      if (size === 0 || controller.signal.aborted)
        throw new GuideProviderError('invalid-output')
      const audio = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        audio.set(chunk, offset)
        offset += chunk.byteLength
      }
      emitProviderTrace(options.trace, {
        event: 'provider.response',
        model,
        data: {
          endpoint,
          status,
          latencyMs: Date.now() - started,
          audioBytes: size,
          format: 'mp3',
        },
      })
      return audio
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  } catch (error) {
    const failure = controller.signal.aborted
      ? new GuideProviderError('timeout')
      : error instanceof GuideProviderError
        ? error
        : new GuideProviderError('unavailable')
    emitProviderTrace(options.trace, {
      event: 'provider.error',
      model,
      data: {
        endpoint,
        status,
        latencyMs: Date.now() - started,
        code: failure.code,
      },
    })
    throw failure
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}
