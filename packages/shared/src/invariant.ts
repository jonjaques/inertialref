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
export function invariant(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new InvariantError(message)
}
