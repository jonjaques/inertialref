/**
 * Nominal typing helper.
 *
 * Used sparingly. A brand that has to be cast away at every call site costs more
 * than it catches, so only values that are *actually* confused in practice get
 * one (see units.ts for which, and why).
 */
export type Brand<T, B extends string> = T & { readonly __brand: B }
