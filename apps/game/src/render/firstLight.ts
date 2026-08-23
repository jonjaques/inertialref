import { getLogger } from '@inertialref/shared'
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { RendererDescription } from './output.ts'
import { replayMeasurement, watchPresentation } from './presentationWatchdog.ts'
import type { BootProgress } from './warmup.ts'

/*
 * When the cover comes off.
 *
 * The contract is one sentence and it used to be spread across four `useState`s
 * and five effects in an eight-hundred-line component: **the cover lifts when
 * the warm-up has resolved and pixels are provably on screen, where "provably"
 * is backend-dependent.**
 *
 * That last clause is the reason this file exists rather than a boolean.
 * `presentationWatchdog.ts` documents that its pixel probe is trustworthy only
 * on a WebGPU canvas — `drawImage` of a WebGL canvas without
 * `preserveDrawingBuffer` may legally read back black between frames — and then
 * handed enforcement to its caller, which read `output.backend` and implemented
 * the WebGL alternative inline. A module that states an invariant it does not
 * own is a module whose invariant is one edit from being untrue somewhere else;
 * Firefox sat at "first light…" indefinitely for exactly that reason. So the
 * signal is a seam with two adapters, chosen here, by backend.
 *
 * What this owns, and what `App` therefore no longer does:
 *
 *   - the conjunction, and the **latch** on the warm-up half. The HDR toggle
 *     rebuilds the renderer and re-runs the warm-up mid-session; the cover must
 *     not come back for it.
 *   - the **exhausted-ladder release**. A watchdog that runs out of rungs has
 *     nothing left to say, and an overlay hiding a possibly-fine scene forever
 *     is strictly worse than revealing the black one the log already warned
 *     about.
 *   - the **canvas epoch**, because the only thing that consumes it is the
 *     canvas key and the only thing that bumps it is the watchdog's last rung.
 *   - one **measurement replay**, where there were three implementations in two
 *     files, each with a comment explaining why the other two were insufficient.
 *   - the status line.
 *
 * All of it is a plain state machine over injected signals, so the transitions,
 * the latch and the release are assertable in Node.
 */

const log = getLogger('game.firstlight')

export type FirstLightPhase = 'booting' | 'revealing' | 'done'

/** Everything the shell renders from. */
export interface FirstLightState {
  readonly phase: FirstLightPhase
  /** The cover's status line. */
  readonly status: string
  /**
   * How many times the canvas has been rebuilt. Part of the canvas key, and
   * bumped by the watchdog's last rung and by nothing else.
   */
  readonly epoch: number
}

/* ------------------------------------------------------------------------- */
/* The seam                                                                   */
/* ------------------------------------------------------------------------- */

/** Proof, for one backend, that pixels reached the screen. */
export interface PresentedSignal {
  /** Resolves when this backend can prove it. Never rejects. */
  wait(): Promise<void>
  /** Stop waiting; the canvas is going away. */
  cancel(): void
}

export interface PresentedOptions {
  /** Whether this watch may still ask for a fresh canvas. */
  readonly allowRemount: boolean
  /** Rebuild the canvas and renderer wholesale. The watchdog's last rung. */
  readonly remount: () => void
}

/**
 * WebGPU: read the canvas back and look for a lit pixel.
 *
 * The only signal that survives the blank-boot wedge — `renderer.info` reports
 * sixteen draw calls and eight hundred thousand triangles every frame on a
 * canvas that has never presented one, so it is useless as a detector. The
 * ladder inside `watchPresentation` is the recovery; `onPresented` fires when a
 * sample comes back lit *or* when the ladder is exhausted, and both release the
 * cover.
 */
export function webgpuPixelProbe(
  canvas: HTMLCanvasElement,
  options: PresentedOptions,
): PresentedSignal {
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const watch = watchPresentation(canvas, {
    allowRemount: options.allowRemount,
    remount: options.remount,
    onPresented: () => settle?.(),
  })
  return {
    wait: () => done,
    cancel: () => watch.cancel(),
  }
}

/**
 * WebGL: two visible animation frames.
 *
 * The probe legally lies on this backend, so it is not used at all. rAF only
 * runs while the document is visible, and by the second callback the first
 * frame has demonstrably been through the compositor — which is this backend's
 * honest signal and is *weaker* than the probe on purpose. The blank-boot wedge
 * the watchdog exists for has only ever been observed on the WebGPU path.
 */
export function webglTwoFrames(): PresentedSignal {
  let raf = 0
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(() => settle?.())
  })
  return {
    wait: () => done,
    cancel: () => cancelAnimationFrame(raf),
  }
}

/** Which adapter a backend gets. The whole backend split, in one function. */
export function signalFor(
  canvas: HTMLCanvasElement,
  backend: RendererDescription['backend'],
  options: PresentedOptions,
): PresentedSignal {
  return backend === 'webgpu'
    ? webgpuPixelProbe(canvas, options)
    : webglTwoFrames()
}

/* ------------------------------------------------------------------------- */
/* The status line                                                            */
/* ------------------------------------------------------------------------- */

/**
 * What boot is doing right now, in the cover's own voice.
 *
 * Lowercase like the boot placeholder in `index.html` — these two speak in one
 * voice, because the placeholder's last line and this module's first are on
 * screen within a commit of each other and a case change at that seam reads as
 * a glitch.
 *
 * The verb phrase comes from the producer that is running; the count comes from
 * the whole census. It used to be the running step's own count, so "compiling
 * the sky…" appeared with nothing left to say while the per-body build-ahead —
 * the expensive part — had not started. A single running total cannot tell that
 * lie.
 */
export function bootStatusLine(
  progress: BootProgress | null,
  warmed: boolean,
): string {
  if (warmed) return 'first light…'
  if (progress === null) return 'waking the renderer…'
  // Before the first unit lands there is no fraction worth showing, and "0/19"
  // reads as stuck where an ellipsis reads as starting.
  if (progress.done === 0) return `${progress.label}…`
  return `${progress.label} ${progress.done}/${progress.total}`
}

/* ------------------------------------------------------------------------- */
/* The state machine                                                          */
/* ------------------------------------------------------------------------- */

export interface FirstLight {
  readonly store: StoreApi<FirstLightState>
  /** The warm-up published progress. Status line only. */
  progress(progress: BootProgress): void
  /** The warm-up resolved. **Latches** — see the header. */
  warmed(): void
  /** Verify that this canvas actually presented. Replaces any previous watch. */
  watch(
    canvas: HTMLCanvasElement,
    backend: RendererDescription['backend'],
  ): void
  /** The cover's fade-out finished; it may unmount for the rest of the session. */
  revealed(): void
  /**
   * Begin watching the document, and return the teardown.
   *
   * Separate from the factory so that building one has no side effects: this is
   * constructed in a `useState` initializer, which StrictMode double-invokes.
   * Returning the teardown rather than exposing a `dispose` is what stops the
   * two from being called in different places.
   */
  start(): () => void
}

export function createFirstLight(
  deps: {
    /** Injected so a test can supply either adapter, or neither. */
    readonly signal?: typeof signalFor
    /** Injected so a test needs no `window`. */
    readonly replay?: () => void
  } = {},
): FirstLight {
  const signal = deps.signal ?? signalFor
  const replay = deps.replay ?? replayMeasurement
  const store = createStore<FirstLightState>(() => ({
    phase: 'booting',
    status: bootStatusLine(null, false),
    epoch: 0,
  }))

  let isWarmed = false
  let isPresented = false
  let progress: BootProgress | null = null
  let watching: PresentedSignal | null = null
  let epoch = 0

  const publish = (): void => {
    const phase = store.getState().phase
    store.setState({
      phase,
      status: bootStatusLine(progress, isWarmed),
      epoch,
    })
  }

  const settle = (): void => {
    if (store.getState().phase !== 'booting') return
    if (!isWarmed || !isPresented) return
    log.info('first light')
    store.setState({ ...store.getState(), phase: 'revealing' })
  }

  const onVisibility = (): void => replay()

  return {
    store,

    /*
     * The measurement replay, on the two occasions that are not a watchdog rung.
     *
     * Mount, because a page that loaded hidden never got its initial
     * ResizeObserver observation; and every return to visibility, because
     * becoming visible does not replay it either. The third occasion — a
     * renderer has just been built — is in `watch` below, at the one moment a
     * measurement provably cannot be too early.
     *
     * A method rather than something the factory does on its way out, because
     * the factory is called from a `useState` initializer and **StrictMode
     * double-invokes those**. Two instances were built, both registered a
     * listener, and only the one React kept could ever remove its own — so
     * every mount cycle leaked a listener that dispatched a resize on every
     * visibility change for the rest of the session. The same class of bug the
     * boot census hit; there the answer was idempotence, and here it is that a
     * factory returns an object and does nothing else.
     */
    start() {
      replay()
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        watching?.cancel()
        watching = null
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },

    progress(next) {
      progress = next
      publish()
    },

    warmed() {
      // The latch. A renderer rebuild re-runs the warm-up mid-session and this
      // must not be able to un-set, or the cover would come back over a running
      // game the moment somebody toggled HDR.
      if (isWarmed) return
      isWarmed = true
      publish()
      settle()
    },

    watch(canvas, backend) {
      watching?.cancel()
      /*
       * The remount lever is withheld after the first rebuild, or a genuinely
       * black scene would rebuild the renderer forever. The epoch is what the
       * canvas key reads, so bumping it *is* the remount.
       */
      const allowRemount = epoch === 0
      const watcher = signal(canvas, backend, {
        allowRemount,
        remount: () => {
          epoch += 1
          log.warn('rebuilding the canvas', { epoch })
          publish()
        },
      })
      watching = watcher
      void watcher.wait().then(() => {
        // A watch that was replaced has nothing to say about the canvas that
        // replaced it.
        if (watching !== watcher) return
        isPresented = true
        settle()
      })
      // The backend now exists, so a re-measure cannot be lost. A macrotask
      // rather than an animation frame, because rAF does not fire in a hidden
      // tab and a background load must still size its canvas for the frame that
      // draws the moment it is focused.
      setTimeout(replay, 0)
    },

    revealed() {
      if (store.getState().phase !== 'revealing') return
      store.setState({ ...store.getState(), phase: 'done' })
    },
  }
}
