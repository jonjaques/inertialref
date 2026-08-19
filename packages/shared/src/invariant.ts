/** Thrown when an invariant is violated. Distinct type so tests can assert on it. */
export class InvariantError extends Error {
  override readonly name = 'InvariantError'
}

/**
 * Assert a condition that must hold for the program to be correct.
 *
 * Kept in production builds on purpose: the failure modes this guards against
 * (NaN positions, corrupt frame graphs, out-of-range sector indices) silently
 * poison a whole universe and are far more expensive to diagnose later than an
 * immediate throw.
 */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}

/**
 * Exhaustiveness check for discriminated unions. `erasableSyntaxOnly` forbids
 * enums, so unions plus this helper are how we get switch exhaustiveness.
 */
export function assertNever(value: never, message = 'Unexpected variant'): never {
  throw new InvariantError(`${message}: ${JSON.stringify(value)}`)
}

/** Guard for values that must be finite numbers (catches NaN propagation early). */
export function assertFinite(value: number, what: string): asserts value is number {
  if (!Number.isFinite(value)) throw new InvariantError(`${what} must be finite, got ${value}`)
}
