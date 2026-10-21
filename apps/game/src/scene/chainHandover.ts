/**
 * Which sensor chain draws the frame while a new one prepares.
 *
 * A new picture is a new chain, and the upscaler compiles its pipelines off
 * the frame and refuses to dispatch until they exist. Swapping on the effect
 * that built the chain puts a frame of zero-initialized output on screen for
 * a path already compiled this session, and as long as the compile takes for
 * one that is not. So the chain on screen stays there, drawing under its own
 * layout, until its successor is ready; then the successor takes the frame and
 * the old chain is disposed.
 *
 * The first chain has nothing to wait behind and shows at once: at boot the
 * cover is up and its warm-up awaits the compile. A successor whose compile
 * fails is shown anyway, because the old chain cannot draw the picture that
 * was asked for and holding it forever would hide the failure.
 *
 * React runs a changed effect's cleanup before the new setup, in one commit,
 * so a released chain that is on screen is kept for a microtask. An offer in
 * that commit claims it as the chain to draw until the successor is ready; no
 * offer means the component unmounted, and it is disposed.
 */
export interface Handover<C> {
  /** The chain frames are drawn through; null before the first and after unmount. */
  readonly shown: C | null
  /** The newest chain, on screen or preparing: what a warm-up compiles. */
  readonly latest: C | null
  /** Hand a built chain over; the returned release is the effect's cleanup. */
  offer(chain: C): () => void
}

export function createHandover<C>(hooks: {
  /** Settles once `chain` can draw; a rejection still shows it. */
  ready(chain: C): Promise<void>
  dispose(chain: C): void
  /** The chain that now draws the frame, or null when none does. */
  show(chain: C | null): void
}): Handover<C> {
  let shown: C | null = null
  let latest: C | null = null
  const released = new Set<C>()

  const show = (chain: C | null) => {
    shown = chain
    hooks.show(chain)
  }
  const dispose = (chain: C) => {
    released.delete(chain)
    hooks.dispose(chain)
  }
  // A released chain on screen with no successor behind it is an unmount.
  const settle = () => {
    if (shown === null || !released.has(shown) || latest !== shown) return
    const gone = shown
    latest = null
    show(null)
    dispose(gone)
  }

  return {
    get shown() {
      return shown
    },
    get latest() {
      return latest
    },
    offer(chain) {
      latest = chain
      if (shown === null) show(chain)
      else {
        const take = () => {
          if (latest !== chain || released.has(chain)) return
          const old = shown
          show(chain)
          if (old !== null && old !== chain) dispose(old)
        }
        void hooks.ready(chain).then(take, take)
      }
      return () => {
        released.add(chain)
        if (chain !== shown) {
          if (latest === chain) latest = shown
          dispose(chain)
        }
        queueMicrotask(settle)
      }
    },
  }
}
