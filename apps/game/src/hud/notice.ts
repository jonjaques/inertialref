/*
 * Running a harness verb from a control, and saying what happened either way.
 *
 * The harness throws by design — `compose` on a star has no terminator to swing
 * round, `stand` on a gas giant has no ground, `preset` on a picture whose
 * address a build no longer ships has nowhere to go — and a `throw` out of an
 * `onClick` is not caught by anything React draws. It reaches
 * `window.onerror`, so the press does nothing, says nothing, and leaves a
 * console line nobody looking at the panel can see.
 *
 * Its own module because four panels want it and a component file that exports
 * a plain function alongside components is a file Fast Refresh gives up on —
 * the same reason `focus.ts` exists.
 */

/** An unknown throw, as a sentence. */
export const describeCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause)

/**
 * Do it, and report either the label or the refusal.
 *
 * The refusal is the interesting half. A verb that cannot be done here is a
 * fact about the subject rather than about the control — "Jupiter has no
 * surface to stand on" is the answer somebody wants, and it is better than a
 * disabled button, which says only that something is impossible without saying
 * which of the sixteen things it was.
 */
export function attempt(
  onNotice: (message: string) => void,
  label: string,
  action: () => void,
): void {
  try {
    action()
    onNotice(label)
  } catch (cause) {
    onNotice(describeCause(cause))
  }
}
