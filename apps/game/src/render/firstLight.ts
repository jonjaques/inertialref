import { getLogger, getTimer } from '@inertialref/shared'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { BOOT_MARKER, BOOT_PHASE } from '../engine/frameTiming.ts'
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
 *   - the status line, and the ledger of every line the cover has shown.
 *
 * All of it is a plain state machine over injected signals, so the transitions,
 * the latch and the release are assertable in Node.
 */

const log = getLogger('game.firstlight')
const timer = getTimer('game.firstlight')

export type FirstLightPhase = 'booting' | 'revealing' | 'done'

/** One line of the cover's ledger. */
export interface BootStage {
  readonly label: string
  /**
   * The census as this stage last reported it — `done/total` across every
   * producer — or `null` while there was no fraction worth showing. A finished
   * stage keeps the count it ended on, so the ledger reads as a running total
   * rather than as one number that moves from line to line.
   */
  readonly count: string | null
}

/** Everything the shell renders from. */
export interface FirstLightState {
  readonly phase: FirstLightPhase
  /** The cover's status line: the running stage, with its count. */
  readonly status: string
  /**
   * Every stage the cover has shown, oldest first. The last one is running
   * and `status` is its line; every earlier one is finished. Append-only, so
   * the cover can stream them down rather than replace one with the next.
   */
  readonly stages: readonly BootStage[]
  /** Units finished over units expected, 0 to 1, for the progress rule. */
  readonly fraction: number
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
 * Lowercase, because the cover keeps every one of these as a line of a ledger
 * and a capitalised sentence per stage would read as a column of headings.
 * The two lines this module owns — before the first producer reports, and
 * after the last one has — are in the same register as the producers' own.
 */
export function bootStageLabel(
  progress: BootProgress | null,
  warmed: boolean,
): string {
  if (warmed) return 'first light'
  if (progress === null) return 'waking the renderer'
  return progress.label
}

/**
 * The count beside the running stage, or `null` when there is none to show.
 *
 * The count comes from the whole census, not the running producer's own. It
 * used to be the running step's count, so "compiling the sky…" appeared with
 * nothing left to say while the per-body build-ahead — the expensive part —
 * had not started. A single running total cannot tell that lie.
 */
export function bootStatusCount(
  progress: BootProgress | null,
  warmed: boolean,
): string | null {
  // Once the warm-up is done the wait is for pixels, and there is nothing
  // left to count.
  if (warmed || progress === null) return null
  // Before the first unit lands there is no fraction worth showing, and "0/19"
  // reads as stuck where an ellipsis reads as starting.
  if (progress.done === 0) return null
  return `${progress.done}/${progress.total}`
}

/** The running stage and its count as the one line a log would print. */
export function bootStatusLine(
  progress: BootProgress | null,
  warmed: boolean,
): string {
  const label = bootStageLabel(progress, warmed)
  const count = bootStatusCount(progress, warmed)
  return count === null ? `${label}…` : `${label} ${count}`
}

/**
 * How far through the census boot is, for the rule under the wordmark.
 *
 * Warmed is 1 whatever the census says: a producer that gave up early has
 * been credited its shortfall by then, and a rule that stops short of its end
 * while the line beneath it says "first light" reads as stuck.
 */
export function bootFraction(
  progress: BootProgress | null,
  warmed: boolean,
): number {
  if (warmed) return 1
  if (progress === null) return 0
  return Math.min(1, Math.max(0, progress.done / Math.max(1, progress.total)))
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
    stages: [{ label: bootStageLabel(null, false), count: null }],
    fraction: 0,
    epoch: 0,
  }))

  let isWarmed = false
  let isPresented = false
  let progress: BootProgress | null = null
  let watching: PresentedSignal | null = null
  let epoch = 0

  /*
   * The ledger grows by one line each time the running stage changes name,
   * and never shrinks. A producer reports many times under one label — every
   * unit is a publish — so a report under the running label updates that
   * line's count in place, and only a new label appends. A producer reporting
   * again after the warm-up settled (a renderer rebuild re-runs it) lands on
   * "first light", which the label function already answers for a warmed
   * boot, so the ledger is closed by the same rule that closes the line.
   */
  const publish = (): void => {
    const { phase, stages } = store.getState()
    const label = bootStageLabel(progress, isWarmed)
    const count = bootStatusCount(progress, isWarmed)
    const last = stages[stages.length - 1]
    let next = stages
    // A census that has registered producers but not yet started one reports
    // an empty label. Not a stage; the running line keeps its name.
    if (label !== '' && last !== undefined) {
      if (last.label !== label) next = [...stages, { label, count }]
      else if (last.count !== count)
        next = [...stages.slice(0, -1), { label, count }]
    }
    store.setState({
      phase,
      status: bootStatusLine(progress, isWarmed),
      stages: next,
      fraction: bootFraction(progress, isWarmed),
      epoch,
    })
  }

  const settle = (): void => {
    if (store.getState().phase !== 'booting') return
    if (!isWarmed || !isPresented) return
    log.info('first light')
    /*
     * **The measurement this project cares about most and stated nowhere.**
     *
     * Boot is measured everywhere else as `performance.now()` deltas that are
     * never related to the navigation, so "how long from opening the link to
     * first light" — the one duration a player actually experiences — was a
     * number nothing here could produce. `0` in this clock *is*
     * `performance.timeOrigin`, so one measure from it to now is the whole
     * answer, and every boot entry above lands inside it.
     *
     * A marker beside it rather than instead of it. A marker draws as a
     * vertical line across every track at once, so "first light" cuts through
     * the frame track, the worker tracks and the boot track together — which is
     * what makes a heightfield still landing after the cover came off visible
     * as a fact rather than an inference.
     */
    if (timer.on) {
      timer.measure('navigation to first light', 0, performance.now(), {
        ...BOOT_PHASE,
        tooltip: 'from performance.timeOrigin — what a player waits',
      })
      timer.mark('first light', BOOT_MARKER)
    }
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
      // The end of the reveal transition, which is when the interface is
      // genuinely in the player's hands. The gap between this marker and
      // `first light` is the cover's own fade, and it is the one part of boot
      // that is a deliberate cost rather than a measured one.
      timer.mark('revealed', BOOT_MARKER)
      store.setState({ ...store.getState(), phase: 'done' })
    },
  }
}
