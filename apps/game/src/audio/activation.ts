/*
 * The user's gestures, as one subscription, for whatever needs one to make a
 * sound.
 *
 * Browsers hold audio until the page has been touched, and Safari holds it
 * harder than the others: a `play()` or an `AudioContext.resume()` made
 * anywhere but inside the task a gesture arrived in is refused, where
 * Chrome's sticky activation carries a page-wide permission far enough that
 * the same code works there. So the work that unlocks audio has to run
 * synchronously inside a real gesture, whatever that gesture was for — the
 * click on the Planetarium door, the first drag across the sky.
 *
 * The cutscene's track and the soundtrack both need that, and two sets of
 * document listeners racing for one gesture is two primers that can each
 * believe the other one handled it. Here there is one set, installed while
 * anything is subscribed and removed when nothing is.
 *
 * **Broader than it looks like it needs to be, and deliberately.** The spec's
 * list of activation-triggering events and WebKit's are not the same list,
 * and this is the one place where guessing wrong costs a whole feature rather
 * than a frame. `pointerdown` covers mouse and touch where Pointer Events are
 * the primary input path; `touchend` and `mousedown` cover the engines that
 * set their gesture flag on the legacy event instead. All of them are
 * harmless duplicates — a subscriber is idempotent. Capture phase, so a
 * handler that stops propagation cannot take the activation with it.
 *
 * `keydown` is listened for here only as an activation, never as a key: what
 * a key *does* is the keymap's, and its single listener is the rule.
 */

const GESTURES = [
  'pointerdown',
  'mousedown',
  'touchend',
  'keydown',
  'click',
] as const

const subscribers = new Set<() => void>()
let installed = false

function dispatch(): void {
  // A copy, because a subscriber that unlocked removes itself mid-loop.
  for (const subscriber of [...subscribers]) subscriber()
}

/**
 * Call `subscriber` synchronously inside every user gesture until the
 * returned function is called. A subscriber that has done what it needed
 * unsubscribes itself.
 */
export function onActivation(subscriber: () => void): () => void {
  subscribers.add(subscriber)
  if (!installed && typeof document !== 'undefined') {
    for (const type of GESTURES) document.addEventListener(type, dispatch, true)
    installed = true
  }
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size > 0 || !installed) return
    for (const type of GESTURES)
      document.removeEventListener(type, dispatch, true)
    installed = false
  }
}
