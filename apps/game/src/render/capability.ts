import { getLogger } from '@inertialref/shared'
import type { OutputCapability } from './output.ts'

/*
 * The browser half of the HDR question.
 *
 * `docs/spikes.md` § 1 measured every signal a page can read and found that only
 * one of them is load-bearing: whether `GPUCanvasContext.configure()` accepts an
 * `rgba16float` canvas with `toneMapping: { mode: 'extended' }`. Chrome and
 * Safari accept it; Firefox throws, and no amount of media-query agreement
 * changes that. So the probe is a feature test, run once, and everything else
 * here is context around it.
 */

const log = getLogger('game.render')

/** Live, because a window can be dragged from an EDR display to one without. */
export const EXTENDED_RANGE_QUERY = '(dynamic-range: high)'

/**
 * Ask the browser, once, what it can actually put on the screen.
 *
 * Never throws: every failure here is a reason to render in sRGB, which is a
 * supported configuration rather than an error. A game that refuses to start
 * because it could not prove it was allowed to be pretty is worse than a game
 * that is not pretty.
 */
export async function probeOutputCapability(): Promise<OutputCapability> {
  // Read the display signal even where it cannot be acted on. It is reported
  // separately in the dock, and the case worth being able to see is exactly the
  // one this early return covers: a browser on an EDR display, saying so, with
  // no way to put anything extended on it. That is Firefox, and a panel that
  // showed `dynamic-range: high = false` there would be describing the browser
  // rather than the display and hiding the disagreement it exists to expose.
  const dynamicRangeHigh =
    typeof window === 'undefined' ? false : window.matchMedia(EXTENDED_RANGE_QUERY).matches

  if (typeof navigator === 'undefined' || navigator.gpu === undefined) {
    return { webgpu: false, dynamicRangeHigh, extendedCanvas: false }
  }

  let device: GPUDevice | null = null
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    // WebGPU present and unusable: a blocklisted driver, or a browser with no
    // GPU process to give. three's own fallback will take the WebGL backend.
    if (adapter === null) return { webgpu: true, dynamicRangeHigh, extendedCanvas: false }
    device = await adapter.requestDevice()
    return { webgpu: true, dynamicRangeHigh, extendedCanvas: probeExtendedCanvas(device) }
  } catch (cause) {
    log.warn('WebGPU device request failed; falling back to the WebGL backend', { cause: String(cause) })
    return { webgpu: true, dynamicRangeHigh, extendedCanvas: false }
  } finally {
    /*
     * The probe's device is the probe's, and it dies here.
     *
     * Handing it to the renderer instead looks like a saving — one adapter round
     * trip — and is a trap twice over. `requestDevice` may only be honoured once
     * per adapter, so a renderer that later wants its own gets a device that is
     * already lost; and a device shared with something that outlives this
     * function has no owner, which is how a dev-mode remount leaks one per
     * mount. three requests, owns and disposes its own from a fresh adapter.
     */
    device?.destroy()
  }
}

/**
 * The one signal that is a fact rather than an opinion.
 *
 * Configures a throwaway canvas exactly the way `WebGPURenderer` will when it is
 * given `outputType: HalfFloatType`, and reports whether that threw. Firefox
 * throws here with a message naming its own tracking bug; nothing else the page
 * can read distinguishes it from Chrome.
 */
function probeExtendedCanvas(device: GPUDevice): boolean {
  const context = document.createElement('canvas').getContext('webgpu')
  if (context === null) return false
  try {
    context.configure({ device, format: 'rgba16float', toneMapping: { mode: 'extended' } })
    // `configure` is specified to accept an unknown tone mapping mode silently,
    // so acceptance alone is not proof. Reading it back is — the spike verified
    // the echo against a `vec4f(8,4,2,1)` clear that survived the swap chain.
    return context.getConfiguration()?.toneMapping?.mode === 'extended'
  } catch {
    return false
  } finally {
    context.unconfigure()
  }
}

/**
 * Watch the display signal for the life of the page.
 *
 * Only meaningful under the `auto` preference, and only the *media query* moves:
 * the canvas probe is a property of the browser build and cannot change without
 * a reload. Returns its own unsubscribe.
 */
export function watchDynamicRange(onChange: (high: boolean) => void): () => void {
  const query = window.matchMedia(EXTENDED_RANGE_QUERY)
  const listener = (event: MediaQueryListEvent): void => onChange(event.matches)
  query.addEventListener('change', listener)
  return () => query.removeEventListener('change', listener)
}
