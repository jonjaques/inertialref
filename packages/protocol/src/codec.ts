import { err, ok, type Result } from '@inertialref/shared'

/*
 * Tiny validation combinators.
 *
 * Trust boundaries — save files, worker messages, and eventually the network —
 * need runtime validation, not a type assertion. This is deliberately not a
 * schema library: the whole surface is a dozen functions, it adds no dependency
 * to a package every other package sits on top of, and the error strings are
 * paths ("player.state.position[2]") rather than a stack of generic messages.
 *
 * If the protocol grows past what this comfortably expresses, that is the
 * moment to bring in a real library — not before.
 */

export type Decoder<T> = (value: unknown, path: string) => Result<T, string>

const fail = (path: string, expected: string, value: unknown): Result<never, string> =>
  err(`${path || 'value'}: expected ${expected}, got ${describe(value)}`)

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `array(${value.length})`
  return typeof value
}

export const decodeNumber: Decoder<number> = (value, path) =>
  typeof value === 'number' && Number.isFinite(value) ? ok(value) : fail(path, 'a finite number', value)

export const decodeInteger: Decoder<number> = (value, path) =>
  typeof value === 'number' && Number.isInteger(value) ? ok(value) : fail(path, 'an integer', value)

export const decodeString: Decoder<string> = (value, path) =>
  typeof value === 'string' ? ok(value) : fail(path, 'a string', value)

export const decodeBoolean: Decoder<boolean> = (value, path) =>
  typeof value === 'boolean' ? ok(value) : fail(path, 'a boolean', value)

export function decodeLiteral<const T extends string>(literal: T): Decoder<T> {
  return (value, path) => (value === literal ? ok(literal) : fail(path, `"${literal}"`, value))
}

export function decodeEnum<const T extends string>(...options: readonly T[]): Decoder<T> {
  return (value, path) =>
    typeof value === 'string' && (options as readonly string[]).includes(value)
      ? ok(value as T)
      : fail(path, `one of ${options.join(' | ')}`, value)
}

export function decodeArray<T>(item: Decoder<T>): Decoder<readonly T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, 'an array', value)
    const out: T[] = []
    for (let i = 0; i < value.length; i += 1) {
      const decoded = item(value[i], `${path}[${i}]`)
      if (!decoded.ok) return decoded
      out.push(decoded.value)
    }
    return ok(out)
  }
}

/** Fixed-length tuple of numbers — the wire form for vectors. */
export function decodeNumberTuple<N extends number>(length: N): Decoder<readonly number[]> {
  return (value, path) => {
    if (!Array.isArray(value) || value.length !== length) {
      return fail(path, `an array of ${length} numbers`, value)
    }
    return decodeArray(decodeNumber)(value, path)
  }
}

export function decodeNullable<T>(inner: Decoder<T>): Decoder<T | null> {
  return (value, path) => (value === null ? ok(null) : inner(value, path))
}

export function decodeOptional<T>(inner: Decoder<T>, fallback: T): Decoder<T> {
  return (value, path) => (value === undefined ? ok(fallback) : inner(value, path))
}

type Shape = Readonly<Record<string, Decoder<unknown>>>
type Decoded<S extends Shape> = { readonly [K in keyof S]: S[K] extends Decoder<infer T> ? T : never }

export function decodeObject<S extends Shape>(shape: S): Decoder<Decoded<S>> {
  return (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(path, 'an object', value)
    }
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(shape)) {
      const decoder = shape[key]
      if (decoder === undefined) continue
      const decoded = decoder(source[key], path ? `${path}.${key}` : key)
      if (!decoded.ok) return decoded
      out[key] = decoded.value
    }
    return ok(out as Decoded<S>)
  }
}

/** Run a decoder against a root value. */
export const decode = <T>(decoder: Decoder<T>, value: unknown): Result<T, string> =>
  decoder(value, '')

/** Parse JSON text and decode it, reporting both kinds of failure the same way. */
export function decodeJson<T>(decoder: Decoder<T>, text: string): Result<T, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return err(`malformed JSON: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  return decode(decoder, parsed)
}
