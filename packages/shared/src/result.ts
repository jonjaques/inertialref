/**
 * Result type for trust boundaries (protocol decode, save-file load, worker
 * responses). Throwing is fine for programmer error; data arriving from storage,
 * a worker, or eventually the network is not programmer error and callers must
 * be forced to consider the failure.
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

/** Unwrap, throwing on failure. For tests and for call sites that have already checked. */
export function expect<T, E>(result: Result<T, E>, message: string): T {
  if (result.ok) return result.value
  throw new Error(`${message}: ${String(result.error)}`)
}
