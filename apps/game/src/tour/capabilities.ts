/*
 * What the Worker says about the guide, and the one reader of its answer.
 *
 * Its own module because two things read it and must not import each other:
 * the planetarium's access check, which runs on every mount and must not
 * bring the guide's runtime with it, and the runtime itself.
 */

/**
 * The Worker's answer at `/api/tour/capabilities`, for whoever asked.
 *
 * `authorized` is the Worker's verdict and the only one that counts: the grant
 * lives in the account's private metadata, which the browser cannot read.
 */
export interface GuideCapabilities {
  readonly available: boolean
  readonly signedIn: boolean
  readonly authorized: boolean
  readonly voices: readonly string[]
  readonly reason: string | null
}

/** The answer, if it is one; a proxy's error page or a stale shape is not. */
export function readCapabilities(value: unknown): GuideCapabilities | null {
  if (typeof value !== 'object' || value === null) return null
  const answer = value as Record<string, unknown>
  if (
    typeof answer.available !== 'boolean' ||
    typeof answer.signedIn !== 'boolean' ||
    typeof answer.authorized !== 'boolean' ||
    !Array.isArray(answer.voices) ||
    !answer.voices.every((voice) => typeof voice === 'string') ||
    (answer.reason !== null && typeof answer.reason !== 'string')
  )
    return null
  return {
    available: answer.available,
    signedIn: answer.signedIn,
    authorized: answer.authorized,
    voices: answer.voices as readonly string[],
    reason: answer.reason as string | null,
  }
}

/** Whether the answer grants the guide to whoever asked. */
export const grantsGuide = (answer: GuideCapabilities | null): boolean =>
  answer !== null && answer.available && answer.authorized
