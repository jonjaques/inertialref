import type { ProviderTrace } from './openaiResponses.ts'

const encoder = new TextEncoder()
const SECRET_FIELD =
  /^(authorization|cookie|set-cookie|password|api[_-]?key|sdp|audio_data|image_data)$/i

interface TraceEnvironment {
  readonly TOUR_GUIDE_TRACE?: string
  readonly OPENAI_API_KEY?: string
  readonly TOUR_GUIDE_PASSWORD?: string
}

/** Explicit diagnostic mode may contain conversation text, never credentials/media. */
export function createTourTrace(
  env: TraceEnvironment,
  identity: () => Readonly<Record<string, unknown>> = () => ({}),
  write: (line: string) => void = (line) => console.log(line),
): ProviderTrace {
  if (env.TOUR_GUIDE_TRACE !== 'true') return () => {}
  const secrets = [env.OPENAI_API_KEY, env.TOUR_GUIDE_PASSWORD].filter(
    (value): value is string => Boolean(value),
  )
  let sequence = 0
  const clean = (value: unknown, depth = 0): unknown => {
    if (depth > 12) return '[depth limit]'
    if (typeof value === 'string') {
      if (value.startsWith('v=0\r\n') || value.startsWith('v=0\n'))
        return '[SDP omitted]'
      let text = value
      for (const secret of secrets) text = text.replaceAll(secret, '[redacted]')
      text = text.replace(/sk-[A-Za-z0-9_-]{12,}/g, '[redacted]')
      return text.length > 8192 ? `${text.slice(0, 8192)} [truncated]` : text
    }
    if (value instanceof Error)
      return clean({ name: value.name, message: value.message }, depth + 1)
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
      return '[binary omitted]'
    if (Array.isArray(value))
      return value.slice(0, 64).map((item) => clean(item, depth + 1))
    if (value !== null && typeof value === 'object') {
      const data = value as Record<string, unknown>
      if (
        typeof data.type === 'string' &&
        /(?:input_audio\.append|output_audio\.delta)/.test(data.type)
      )
        return { type: data.type, payload: '[audio omitted]' }
      return Object.fromEntries(
        Object.entries(data)
          .slice(0, 96)
          .map(([key, item]) => [
            key,
            SECRET_FIELD.test(key) ? '[redacted]' : clean(item, depth + 1),
          ]),
      )
    }
    return value
  }
  return (event) => {
    try {
      const entry = {
        scope: 'tour',
        sequence: ++sequence,
        at: new Date().toISOString(),
        ...(clean(identity()) as Record<string, unknown>),
        ...event,
        data: clean(event.data),
      }
      const serialized = JSON.stringify(entry)
      write(
        encoder.encode(serialized).byteLength <= 65536
          ? serialized
          : JSON.stringify({
              ...entry,
              data: {
                truncated: true,
                bytes: encoder.encode(serialized).byteLength,
              },
            }),
      )
    } catch {
      // Diagnostic failures cannot interrupt admission, playback, or cleanup.
    }
  }
}
