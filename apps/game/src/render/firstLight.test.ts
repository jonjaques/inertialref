import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PresentedSignal,
  bootStatusLine,
  createFirstLight,
} from './firstLight.ts'
import { hasLitPixels } from './presentationWatchdog.ts'

/*
 * The boot cluster, in Node.
 *
 * None of this was testable before: the contract lived as four `useState`s and
 * five effects inside an eight-hundred-line component, and `hasLitPixels` — the
 * one piece that is pure arithmetic — was reachable only by loading the whole
 * application. Every case below is one of `CONTEXT.md`'s "must not come back"
 * items or the failure its own comment warns about.
 *
 * `document` is faked to two listener methods: `createFirstLight` registers a
 * `visibilitychange` handler for the measurement replay, and that is the only
 * DOM it touches when its adapters are injected.
 */

beforeEach(() => {
  const listeners: Record<string, (() => void)[]> = {}
  vi.stubGlobal('document', {
    addEventListener: (kind: string, fn: () => void) => {
      ;(listeners[kind] ??= []).push(fn)
    },
    removeEventListener: () => {},
  })
})

/** A signal the test resolves by hand. The seam's third adapter. */
function manual(): { signal: PresentedSignal; present: () => void } {
  let settle: (() => void) | null = null
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  return {
    signal: { wait: () => done, cancel: () => {} },
    present: () => settle?.(),
  }
}

interface Harness {
  light: ReturnType<typeof createFirstLight>
  present: () => void
  /** The last options the adapter was built with. */
  options: () => { allowRemount: boolean; remount: () => void } | null
  backends: string[]
}

function harness(): Harness {
  let last: { allowRemount: boolean; remount: () => void } | null = null
  const backends: string[] = []
  const { signal, present } = manual()
  const light = createFirstLight({
    replay: () => {},
    signal: (_canvas, backend, options) => {
      backends.push(backend)
      last = options
      return signal
    },
  })
  return { light, present, options: () => last, backends }
}

const CANVAS = {} as HTMLCanvasElement
const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

describe('first light', () => {
  it('lifts the cover only when both halves have landed', async () => {
    const { light, present } = harness()
    expect(light.store.getState().phase).toBe('booting')

    light.watch(CANVAS, 'webgpu')
    present()
    await settled()
    // Pixels alone are not enough: the scene is on screen and the textures are
    // not, which is the stutter the cover exists to hide.
    expect(light.store.getState().phase).toBe('booting')

    light.warmed()
    expect(light.store.getState().phase).toBe('revealing')

    light.revealed()
    expect(light.store.getState().phase).toBe('done')
  })

  it('does not lift on the warm-up alone', () => {
    // Fading out over a canvas that has not presented reveals exactly the black
    // frame the cover exists to hide.
    const { light } = harness()
    light.warmed()
    expect(light.store.getState().phase).toBe('booting')
  })

  it('keeps the warm-up latched across a renderer rebuild', async () => {
    /*
     * MUST NOT COME BACK. The HDR toggle rebuilds the renderer and re-runs the
     * warm-up mid-session. If `warmed` could un-set, the cover would drop over
     * a running game the moment somebody changed a display setting.
     */
    const { light, present } = harness()
    light.watch(CANVAS, 'webgpu')
    present()
    await settled()
    light.warmed()
    light.revealed()
    expect(light.store.getState().phase).toBe('done')

    // The rebuild: a fresh canvas, a fresh warm-up, a fresh signal.
    light.watch(CANVAS, 'webgpu')
    light.warmed()
    expect(light.store.getState().phase).toBe('done')
  })

  it('chooses the backend’s own evidence, inside the module', () => {
    // The leak this closed: `presentationWatchdog.ts` documented that its probe
    // is trustworthy only on a WebGPU canvas and then handed enforcement to its
    // caller, which read `output.backend` and implemented the alternative
    // inline. Firefox sat at "first light…" indefinitely.
    const { light, backends } = harness()
    light.watch(CANVAS, 'webgl')
    expect(backends).toEqual(['webgl'])
  })

  it('withholds the remount lever after the first rebuild', () => {
    /*
     * A genuinely all-black scene must not rebuild the renderer forever. The
     * epoch is what the canvas key reads, so bumping it *is* the remount, and
     * the second watch is the one that has to be told it cannot ask again.
     */
    const { light, options } = harness()
    light.watch(CANVAS, 'webgpu')
    expect(options()?.allowRemount).toBe(true)

    options()?.remount()
    expect(light.store.getState().epoch).toBe(1)

    light.watch(CANVAS, 'webgpu')
    expect(options()?.allowRemount).toBe(false)
  })

  it('releases the cover when the ladder is exhausted', async () => {
    /*
     * The watchdog calls `onPresented` when a sample comes back lit *or* when
     * it has run out of rungs, and both release the fade. An overlay hiding a
     * possibly-fine scene forever is strictly worse than revealing the black
     * one the log has already warned about — so the adapter cannot distinguish
     * them, and this asserts that it does not try.
     */
    const { light, present } = harness()
    light.warmed()
    light.watch(CANVAS, 'webgpu')
    expect(light.store.getState().phase).toBe('booting')
    present() // the exhausted case looks exactly like the lit one
    await settled()
    expect(light.store.getState().phase).toBe('revealing')
  })

  it('ignores a watch that has been replaced', async () => {
    // A canvas that is going away has nothing to say about the one that
    // replaced it, and letting it settle would skip the new canvas's own
    // verification pass.
    const pending: { resolve: (() => void) | null } = { resolve: null }
    const old: PresentedSignal = {
      wait: () =>
        new Promise<void>((resolve) => {
          pending.resolve = resolve
        }),
      cancel: () => {},
    }
    const never: PresentedSignal = {
      wait: () => new Promise(() => {}),
      cancel: () => {},
    }
    let first = true
    const light = createFirstLight({
      replay: () => {},
      signal: () => {
        const chosen = first ? old : never
        first = false
        return chosen
      },
    })
    light.warmed()
    light.watch(CANVAS, 'webgpu')
    light.watch(CANVAS, 'webgpu')
    pending.resolve?.()
    await settled()
    expect(light.store.getState().phase).toBe('booting')
  })

  it('reports what boot is doing as it goes', () => {
    const { light } = harness()
    expect(light.store.getState().status).toBe('waking the renderer…')
    light.progress({ label: 'baking atmospheres', done: 22, total: 55 })
    expect(light.store.getState().status).toBe('baking atmospheres 22/55')
    light.warmed()
    expect(light.store.getState().status).toBe('first light…')
  })
})

describe('the status line', () => {
  it('names the running producer and the whole census', () => {
    expect(
      bootStatusLine(
        { label: 'baking atmospheres', done: 22, total: 55 },
        false,
      ),
    ).toBe('baking atmospheres 22/55')
  })

  it('says a producer is starting rather than showing 0 of anything', () => {
    // "0/19" reads as stuck; an ellipsis reads as starting.
    expect(
      bootStatusLine(
        { label: 'warming surface maps', done: 0, total: 19 },
        false,
      ),
    ).toBe('warming surface maps…')
  })

  it('stops counting once the warm-up is done and the wait is for pixels', () => {
    expect(bootStatusLine(null, false)).toBe('waking the renderer…')
    expect(
      bootStatusLine({ label: 'building bodies', done: 55, total: 55 }, true),
    ).toBe('first light…')
  })
})

/* ------------------------------------------------------------------------- */

/**
 * A 2D context that answers `getImageData` from a buffer the test supplies.
 *
 * `hasLitPixels` reads exactly three methods, so this is the whole surface.
 */
function stubProbe(fill: (i: number) => number): CanvasRenderingContext2D {
  return {
    clearRect: () => {},
    drawImage: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: Uint8ClampedArray.from({ length: w * h * 4 }, (_v, i) => fill(i)),
    }),
  } as unknown as CanvasRenderingContext2D
}

describe('hasLitPixels', () => {
  const canvas = { width: 1920, height: 1080 }

  it('calls a canvas that has never presented black', () => {
    // Pure transparent black is what a canvas reads back before its first
    // present, and it is the only thing the watchdog is entitled to act on.
    expect(
      hasLitPixels(
        canvas,
        stubProbe(() => 0),
      ),
    ).toBe(false)
  })

  it('does not mistake dither noise for a scene', () => {
    // `> 2`, not `> 0`: the threshold leaves room for noise without letting a
    // real star through.
    expect(
      hasLitPixels(
        canvas,
        stubProbe((i) => (i % 4 === 3 ? 255 : 2)),
      ),
    ).toBe(false)
  })

  it('finds a single star in a strip of empty sky', () => {
    /*
     * THE CASE ITS OWN COMMENT WARNS ABOUT, and nothing checked it. A star is
     * one or two device pixels; a 16×16 thumbnail of a starfield averages every
     * one of them to black, and the detector would then "fix" a perfectly
     * healthy sky by rebuilding the renderer under it. Native-resolution strips
     * are what keep the star. One lit pixel in 512×16 has to be enough.
     */
    const star = 400 * 4
    expect(
      hasLitPixels(
        canvas,
        stubProbe((i) => (i >= star && i < star + 3 ? 220 : 0)),
      ),
    ).toBe(true)
  })

  it('reads a lit scene as lit', () => {
    expect(
      hasLitPixels(
        canvas,
        stubProbe(() => 40),
      ),
    ).toBe(true)
  })

  it('samples a canvas smaller than one strip without reading past it', () => {
    // A canvas stuck at the default 300×150 is exactly the failure the watchdog
    // is looking at, so the strip arithmetic has to survive it.
    expect(
      hasLitPixels(
        { width: 300, height: 150 },
        stubProbe(() => 0),
      ),
    ).toBe(false)
  })
})
