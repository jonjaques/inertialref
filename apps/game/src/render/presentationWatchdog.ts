import { getLogger } from '@inertialref/shared'

/*
 * The presentation watchdog: the fix for the blank-scene boot.
 *
 * The failure it exists for was measured, not guessed. A freshly loaded page
 * sometimes comes up black with everything else healthy: the sim ticks, the
 * harness answers, and `renderer.info` reports the full scene — 16 draw
 * calls, 800k triangles, every frame — while the canvas never presents a
 * pixel. `renderer.info` is therefore *useless* as a detector, which is why
 * this watchdog reads the actual canvas bitmap: `drawImage` of a WebGPU
 * canvas yields its last presented frame, and a canvas that has never
 * presented samples as pure transparent black.
 *
 * Recovery is a ladder, because the wedge has layers and each earlier rung is
 * cheaper than the next:
 *
 *  1. Replay the measurement (synthetic `resize`). Covers the lost initial
 *     ResizeObserver observation — the canvas stuck at 300×150 in a document
 *     that loaded hidden.
 *  2. A *real* element nudge — shrink the canvas's wrapper one pixel for two
 *     frames and restore — plus a swap-chain reset (`canvas.width`
 *     reassigned). A synthetic `resize` event never fires a ResizeObserver;
 *     only a genuine layout change walks R3F's whole `setSize` path, which is
 *     why a human dragging the window edge always revived the page while the
 *     old event-dispatch fix sometimes did not.
 *  3. The same again, because Chrome has been observed to need two.
 *  4. Remount the canvas. In the deepest state — draws submitted every frame,
 *     presentation stuck, immune even to real resizes — nothing short of a
 *     fresh renderer recovers, so the host hands us a remount lever and we
 *     pull it. At most once per page load: a genuinely all-black scene must
 *     not remount the canvas forever.
 *
 * Checks only run while the document is visible — an occluded window
 * legitimately never presents (Chrome suspends rAF entirely), and burning the
 * ladder there would remount a healthy renderer. The watchdog retires the
 * moment one sample comes back lit; a black frame later in play is a scene,
 * not a symptom.
 */

const log = getLogger('game.presentation')

/** How long after renderer-ready the first sample waits. */
const FIRST_CHECK_MS = 1_200
/** Spacing between samples while the ladder climbs. */
const RETRY_MS = 800

/**
 * Native-resolution strips, spread over the frame. Native rather than a
 * downscale of the whole canvas: a star is one or two device pixels, and a
 * 16×16 thumbnail of a starfield averages every one of them to black — the
 * detector would then "fix" a perfectly healthy sky. Four 512×16 strips keep
 * individual stars while reading back a few kilobytes instead of the
 * hundred-megabyte full frame.
 */
const STRIPS: readonly { x: number; y: number }[] = [
  { x: 0.2, y: 0.2 },
  { x: 0.4, y: 0.45 },
  { x: 0.1, y: 0.6 },
  { x: 0.55, y: 0.8 },
]

/**
 * Whether the canvas has ever put a lit pixel on screen.
 *
 * Exported so it can be tested directly. It is pure arithmetic over an
 * `ImageData` buffer and was reachable only by loading the application — which
 * matters because the thing its own comment warns about, a starfield averaging
 * to black, is a false positive that would make the watchdog "fix" a perfectly
 * healthy sky by rebuilding the renderer under it.
 *
 * `probe` is a 2D context to sample through: `drawImage` of a WebGPU canvas
 * yields its last presented frame, and one that has never presented reads back
 * pure transparent black.
 */
export function hasLitPixels(
  canvas: { readonly width: number; readonly height: number },
  probe: CanvasRenderingContext2D,
): boolean {
  const stripW = Math.min(512, canvas.width)
  const stripH = Math.min(16, canvas.height)
  for (const strip of STRIPS) {
    const sx = Math.min(
      canvas.width - stripW,
      Math.floor(canvas.width * strip.x),
    )
    const sy = Math.min(
      canvas.height - stripH,
      Math.floor(canvas.height * strip.y),
    )
    probe.clearRect(0, 0, stripW, stripH)
    probe.drawImage(
      canvas as CanvasImageSource,
      sx,
      sy,
      stripW,
      stripH,
      0,
      0,
      stripW,
      stripH,
    )
    const data = probe.getImageData(0, 0, stripW, stripH).data
    for (let i = 0; i < data.length; i += 4) {
      // > 2, not > 0: leave room for dither noise without letting a real
      // star (which lands far above it even antialiased) slip through.
      const r = data[i] as number
      const g = data[i + 1] as number
      const b = data[i + 2] as number
      if (r > 2 || g > 2 || b > 2) return true
    }
  }
  return false
}

/**
 * Replay the canvas measurement. One definition, three callers.
 *
 * R3F sizes its canvas from a ResizeObserver, and Chrome does not deliver the
 * *initial* observation to a hidden document — which is what the page is during
 * every Vite full-reload triggered from the editor in front of it. Becoming
 * visible again does not replay the lost observation either: the canvas sits at
 * the default 300×150 with no renderer behind it, a black screen with a healthy
 * HUD that only a manual window resize could revive. The measurement hook also
 * listens to window `resize`, so a synthetic one is exactly the kick it is
 * waiting for; when the measurement already landed, re-measuring the same size
 * is a no-op. Verified live: dispatching `resize` on the stuck page took the
 * canvas from 300×150 to full size — even while the document was still hidden,
 * which is why the kick is unconditional rather than gated on visibility.
 *
 * It lives here rather than in `firstLight.ts` because rung 1 of the ladder
 * below *is* this call, and a module that imported the state machine to reach
 * its own first rung would be a cycle. `firstLight.ts` calls it for the other
 * two occasions: mount, and the moment a renderer exists to hand a measurement
 * to.
 *
 * A synthetic `resize` event never fires a ResizeObserver, which is why this is
 * only rung 1 — rung 2 changes the layout for real.
 */
export function replayMeasurement(): void {
  window.dispatchEvent(new Event('resize'))
}

export interface PresentationWatch {
  /** Stop watching; called on unmount and after the remount lever is pulled. */
  cancel(): void
}

export function watchPresentation(
  canvas: HTMLCanvasElement,
  options: {
    /** Rebuild the canvas and renderer wholesale. The last rung. */
    readonly remount: () => void
    /** Whether this instance may still pull the remount lever. */
    readonly allowRemount: boolean
    /**
     * Called once, when this watch has nothing more to say: a sample came
     * back lit, or the ladder is exhausted. The boot overlay's fade waits on
     * it — fading out over a canvas that has not presented reveals black —
     * and the exhausted case releases the fade too, deliberately: at that
     * point the probe may simply be unreadable, and an overlay hiding a
     * possibly-fine scene forever is strictly worse than revealing the black
     * one the log has already warned about. Only trustworthy where the probe
     * is — a WebGPU canvas; `drawImage` of a WebGL canvas without
     * `preserveDrawingBuffer` may legally read back black between frames, so
     * a host on that backend must not gate anything solely on this.
     */
    readonly onPresented?: () => void
  },
): PresentationWatch {
  let cancelled = false
  let attempts = 0
  let timer = 0
  let deferralLogged = false

  const probeCanvas = document.createElement('canvas')
  probeCanvas.width = 512
  probeCanvas.height = 16
  const probe = probeCanvas.getContext('2d', { willReadFrequently: true })

  const nudge = (): void => {
    replayMeasurement()
    const wrapper = canvas.parentElement
    if (wrapper === null) return
    // A real layout change, then back: this is what fires the ResizeObserver.
    wrapper.style.width = 'calc(100% - 1px)'
    window.setTimeout(() => {
      wrapper.style.width = ''
    }, 90)
  }

  const resetSwapChain = (): void => {
    // Reassigning width — even to the same value — drops the canvas's current
    // GPU texture and forces the context to produce a fresh one.
    const width = canvas.width
    canvas.width = width
  }

  const check = (): void => {
    if (cancelled) return
    if (probe === null) return
    if (document.visibilityState !== 'visible') {
      // An occluded window legitimately never presents; keep waiting. The
      // visibilitychange listener below re-checks the moment that changes —
      // Chrome's occlusion detection fires it even without a tab switch, so
      // a window dragged back into view is verified within a frame.
      if (!deferralLogged) {
        deferralLogged = true
        log.info('presentation check deferred: document not visible')
      }
      timer = window.setTimeout(check, RETRY_MS)
      return
    }
    if (hasLitPixels(canvas, probe)) {
      if (attempts > 0) {
        log.info('presentation recovered', { attempts })
      }
      standDown()
      options.onPresented?.()
      return
    }

    attempts += 1
    if (attempts <= 1) {
      log.warn('canvas has not presented; replaying measurement', { attempts })
      replayMeasurement()
    } else if (attempts <= 3) {
      log.warn('canvas still black; nudging layout and swap chain', {
        attempts,
      })
      resetSwapChain()
      nudge()
    } else if (options.allowRemount) {
      log.warn(
        'canvas never presented despite nudges; rebuilding the renderer',
        { attempts },
      )
      // This instance is finished either way: the remount replaces the canvas
      // and the effect that owns this watch starts a fresh one for it.
      standDown()
      options.remount()
      return
    } else {
      /*
       * Either the scene is legitimately black everywhere sampled, or the GPU
       * process is beyond what a page can repair. Say so and stand down — and
       * *stand down* means the listener too. Only the success path used to
       * detach it, so after giving up every subsequent tab switch re-armed the
       * ladder: four `getImageData` readbacks and a swap-chain reset on every
       * visibility change, for the rest of the session, on a page that had
       * already concluded there was nothing left to try.
       */
      log.warn('presentation watchdog giving up; reload if the scene is black')
      standDown()
      // Exhausted counts as settled — see `onPresented`'s contract above.
      options.onPresented?.()
      return
    }
    timer = window.setTimeout(check, RETRY_MS)
  }

  /** Stop watching: this instance has nothing left to do, either way. */
  const standDown = (): void => {
    window.clearTimeout(timer)
    document.removeEventListener('visibilitychange', onVisible)
  }

  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return
    window.clearTimeout(timer)
    // Half a second for the loop to actually draw a frame now that rAF runs.
    timer = window.setTimeout(check, 500)
  }
  document.addEventListener('visibilitychange', onVisible)

  timer = window.setTimeout(check, FIRST_CHECK_MS)
  return {
    cancel() {
      cancelled = true
      standDown()
    },
  }
}
