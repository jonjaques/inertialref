import type { GuideState } from '@inertialref/devtools'
import type {
  GuideRefusal,
  GuideVerdict,
  GuideVoice,
} from '@inertialref/protocol'

/*
 * Whether the guide is offered, held in one place for one mode.
 *
 * The planetarium's menu, the panel's controls, the end-on-loss rule, the
 * runtime's `start` and `ir.guideStatus` all read this, and none of them
 * holds a copy to fall out of step with it.
 *
 * Keyed on the user. An answer is about whoever was signed in when it was
 * asked, so an answer that lands after a sign-out or an account switch is
 * discarded rather than read as one about the next account.
 */

export type GuideAccess =
  | { readonly state: 'checking' }
  | { readonly state: 'granted'; readonly voices: readonly GuideVoice[] }
  | { readonly state: 'refused'; readonly reason: GuideRefusal }

export interface GuideAccessOwner {
  current(): GuideAccess
  subscribe(listener: () => void): () => void
  /**
   * Ask for this user, or settle a signed-out visitor without asking. The same
   * user again is a no-op, so this reconciles rather than latches.
   */
  forUser(userId: string | null): void
}

/**
 * The verdict as `ir.guideStatus` names an idle guide's state: `idle` when
 * granted, otherwise `checking` or the refusal's reason.
 */
export const accessState = (access: GuideAccess): GuideState =>
  access.state === 'granted'
    ? 'idle'
    : access.state === 'checking'
      ? 'checking'
      : access.reason

const SIGNED_OUT: GuideAccess = { state: 'refused', reason: 'signed-out' }
const CHECKING: GuideAccess = { state: 'checking' }

/**
 * `ask` is the Worker's verdict for whoever the session token names, or null
 * for no answer — which is not offered rather than an error on screen: the
 * Worker refuses a session to an account without the grant whatever this
 * said.
 */
export function createGuideAccess(
  ask: () => Promise<GuideVerdict | null>,
): GuideAccessOwner {
  const listeners = new Set<() => void>()
  let access: GuideAccess = CHECKING
  // `undefined` until the first `forUser`, so a signed-out first call settles.
  let user: string | null | undefined = undefined
  let asking = 0

  const publish = (next: GuideAccess): void => {
    access = next
    for (const listener of listeners) listener()
  }

  return {
    current: () => access,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    forUser(userId) {
      if (userId === user) return
      user = userId
      const ticket = ++asking
      if (userId === null) {
        publish(SIGNED_OUT)
        return
      }
      publish(CHECKING)
      void ask().then(
        (verdict) => {
          if (ticket !== asking) return
          publish(
            verdict === null
              ? { state: 'refused', reason: 'unavailable' }
              : verdict.granted
                ? { state: 'granted', voices: verdict.voices }
                : { state: 'refused', reason: verdict.reason },
          )
        },
        () => {
          if (ticket === asking)
            publish({ state: 'refused', reason: 'unavailable' })
        },
      )
    },
  }
}
