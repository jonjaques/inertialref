export class TourHttpError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function tourJson(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  const result = new Headers(headers)
  result.set('content-type', 'application/json; charset=utf-8')
  result.set('cache-control', 'no-store')
  result.set('x-content-type-options', 'nosniff')
  return new Response(JSON.stringify(body), { status, headers: result })
}

export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!body) throw new TourHttpError('A request body is required.')
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let count = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      count += next.value.byteLength
      if (count > limit) {
        await reader.cancel()
        throw new TourHttpError('The request is too large.', 413)
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(count)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

export async function readJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  if (
    request.headers.get('content-type')?.split(';')[0]?.trim() !==
    'application/json'
  )
    throw new TourHttpError('Send application/json.', 415)
  if (Number(request.headers.get('content-length') ?? 0) > limit)
    throw new TourHttpError('The request is too large.', 413)
  const bytes = await readBoundedBytes(request.body, limit)
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new TourHttpError('The request is not valid JSON.')
  }
}

export function record(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TourHttpError('An object is required.')
  const result = value as Record<string, unknown>
  if (
    Object.keys(result).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(result, field))
  )
    throw new TourHttpError('Unexpected or missing fields.')
  return result
}

export function boundedString(value: unknown, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max)
    throw new TourHttpError('A text field is outside its limits.')
  return value
}
