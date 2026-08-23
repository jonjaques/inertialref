import { getLogger } from '@inertialref/shared'
import { HalfFloatType, WebGPURenderer } from 'three/webgpu'
import { probeOutputCapability } from './capability.ts'
import {
  headroomFor,
  type OutputMode,
  type OutputPreference,
  type RendererDescription,
  resolveOutputMode,
} from './output.ts'
import {
  installToneCurve,
  selectToneCurve,
  type ToneCurveControls,
} from './tonemap.ts'

/*
 * Building the renderer.
 *
 * `docs/design/technical.md` § The path settles the shape of this file: three's
 * `WebGPURenderer` with TSL, not a hand-written WebGPU renderer, and the WebGL
 * path retained as a reduced-fidelity fallback rather than deleted. Both fall
 * out of one object — `WebGPURenderer` carries its own WebGL 2 backend and swaps
 * to it when the device request fails, so the fallback is a different backend
 * behind the same node graphs rather than a second renderer with a second set of
 * materials to keep in sync.
 *
 * What the fallback loses is decided here and nowhere else: no extended-range
 * output, because that is `rgba16float` canvas configuration and WebGL 2 has no
 * equivalent.
 */

const log = getLogger('game.render')

export interface RendererHandle {
  readonly renderer: WebGPURenderer
  readonly description: RendererDescription
  readonly tone: ToneCurveControls
}

/**
 * The part of what R3F hands the factory that this file uses.
 *
 * `EventTarget` rather than `OffscreenCanvas` deliberately: R3F declares its own
 * structural `interface OffscreenCanvas extends EventTarget {}`, which the DOM's
 * `OffscreenCanvas` is not assignable to and which is not assignable to the
 * DOM's. Widening to their common supertype is what makes this factory accepted
 * as a `gl` prop at all. The web `<Canvas>` always passes a real canvas element;
 * the union is there for the react-native entry point, which this app does not
 * use.
 */
interface CanvasProps {
  readonly canvas: HTMLCanvasElement | EventTarget
}

/**
 * Build the `gl` factory `<Canvas>` takes.
 *
 * Async because two things must happen before a frame can be drawn and both are
 * promises: the capability probe, which needs a GPU device, and
 * `renderer.init()`, which builds the backend. R3F awaits the factory, so
 * nothing renders against a half-initialized renderer.
 *
 * `onReady` rather than a return value because R3F owns the renderer from here,
 * and what the caller needs is the *description* — which backend, which output
 * range — for the dock and for `ir.status()`.
 */
/*
 * The renderer this module built last.
 *
 * Module scope because the invariant is per *canvas* and this application has
 * one, and because nothing above here is in a position to enforce it: the
 * factory is the only place a renderer is constructed, so it is the only place
 * that can guarantee the previous one is gone first. See `releaseRenderer` for
 * what goes wrong when two of them share a canvas.
 */
let live: RendererHandle | null = null

/*
 * One build per (canvas, preference), whoever asks and however often.
 *
 * StrictMode double-invokes this async factory, and for weeks the two builds
 * raced on the same canvas: whichever R3F root survived adopted the renderer
 * *its* invocation returned and bound the animation loop to it, and then the
 * other invocation's `releaseRenderer()` disposed exactly that renderer —
 * killing the loop with it — before building a replacement that nothing
 * drives. About half of all page loads came up as a black canvas with a
 * healthy HUD, a selected tone curve, a full-size framebuffer and not one
 * line in the console: `engine.gl` pointed at the loopless newcomer, whose
 * `_animationLoop` was null. Serializing the builds only made the kill
 * deterministic; the actual invariant is that *both* invocations must
 * resolve to the *same* renderer, so nothing ever disposes one a live root
 * has adopted. A genuinely new configuration — the HDR preference remounting
 * the canvas — still rebuilds, queued behind whatever is in flight.
 */
interface PendingBuild {
  readonly canvas: EventTarget
  readonly preference: OutputPreference
  readonly antialias: boolean
  readonly promise: Promise<WebGPURenderer>
}

let building: Promise<unknown> = Promise.resolve()
let current: PendingBuild | null = null

export function createRenderer(
  preference: OutputPreference,
  antialias: boolean,
  onReady: (handle: RendererHandle) => void,
): (props: CanvasProps) => Promise<WebGPURenderer> {
  return ({ canvas }) => {
    if (
      current !== null &&
      current.canvas === canvas &&
      current.preference === preference &&
      current.antialias === antialias
    ) {
      // The StrictMode re-invocation. Same renderer — but this mount's
      // `onReady` still has to fire, because it closes over this render's
      // state setters and the previous one's writes may have landed in a
      // discarded pass. The writes are idempotent.
      return current.promise.then((renderer) => {
        if (live !== null) onReady(live)
        return renderer
      })
    }

    const build = building.then(() =>
      buildRenderer(canvas, preference, antialias, onReady),
    )
    // Failures propagate to R3F through `build`; neither the queue nor the
    // memo may hold one, or every later attempt inherits a stale rejection.
    building = build.then(
      () => undefined,
      () => undefined,
    )
    const entry: PendingBuild = {
      canvas,
      preference,
      antialias,
      promise: build,
    }
    current = entry
    build.catch(() => {
      if (current === entry) current = null
    })
    return build
  }
}

async function buildRenderer(
  canvas: CanvasProps['canvas'],
  preference: OutputPreference,
  antialias: boolean,
  onReady: (handle: RendererHandle) => void,
): Promise<WebGPURenderer> {
  // Before anything else. Two renderers on one canvas is a killed tab.
  releaseRenderer()

  // See `CanvasProps`: the web renderer only ever hands over the element.
  const surface = canvas as HTMLCanvasElement
  const capability = await probeOutputCapability()
  const requested = resolveOutputMode(preference, capability)

  const renderer = new WebGPURenderer({
    canvas: surface,
    // MSAA is a constructor fact like `outputType`: on WebGPU it is samples 4
    // or nothing (the spec allows no 2×), and changing it remounts the canvas
    // through the same `<Canvas key>` the HDR preference uses.
    antialias,
    // Twenty orders of magnitude of depth in one scene. A linear buffer
    // z-fights everywhere in that range and this costs one fragment shader
    // instruction. Reversed-Z is complementary and is a separate change.
    logarithmicDepthBuffer: true,
    powerPreference: 'high-performance',
    // The single switch. `outputType: HalfFloatType` sets *both* the canvas
    // format (`rgba16float`) and `context.configure({ toneMapping: { mode:
    // 'extended' } })`. Spike 1 verified that setting `outputColorSpace`
    // instead does nothing whatever, because nothing in r182 reads it.
    ...(requested === 'extended' ? { outputType: HalfFloatType } : {}),
  })

  await renderer.init()

  /*
   * Clear to *opaque* black. The default clear alpha is 0, and on the
   * extended path that zero reaches the `rgba16float` canvas, which Chrome
   * composites premultiplied — so the alpha channel becomes visible
   * structure. That is how the lens flare's additive quads (whose preset
   * blending also adds alpha) drew their own footprints as hard rectangles,
   * dimmed every star inside them on an EDR display, and, once their alpha
   * writes were silenced, vanished over empty sky instead: rgb over
   * alpha-0 pixels is discarded by the compositor. Space is black, not
   * transparent; nothing behind the canvas was ever meant to show through.
   */
  renderer.setClearColor(0x000000, 1)

  /*
   * Take ownership of the draw-call counters.
   *
   * `Info.autoReset` is honored inside three's *own* `Animation` loop, which
   * is a `requestAnimationFrame` three starts for itself and which keeps
   * running whether or not anything uses it. R3F drives the renderer from its
   * loop instead, so the reset lands at a moment unrelated to any frame R3F
   * draws — and `info.render.drawCalls` read from the frame loop is reliably
   * zero while the same field read from the console is correct. A counter that
   * is right when you inspect it and wrong when you record it is worse than no
   * counter, so the reset moves to `GameEngine.frame`, right after sampling.
   */
  renderer.info.autoReset = false

  // Ask afterwards rather than assume. `init` is where the device request can
  // still fail and take the WebGL backend instead, and extended output does
  // not exist there whatever the probe said a moment earlier.
  const backend = 'isWebGPUBackend' in renderer.backend ? 'webgpu' : 'webgl'
  const mode: OutputMode = backend === 'webgpu' ? requested : 'standard'
  const headroom = headroomFor(mode)

  const tone = installToneCurve(renderer, headroom)
  const description: RendererDescription = {
    backend,
    mode,
    preference,
    headroom,
    capability,
  }

  log.info('renderer ready', {
    backend,
    output: mode,
    headroom,
    preference,
    antialias,
    dynamicRangeHigh: capability.dynamicRangeHigh,
    extendedCanvas: capability.extendedCanvas,
  })

  live = { renderer, description, tone }
  onReady(live)
  return renderer
}

/**
 * Put the tone curve back after R3F has configured the renderer.
 *
 * R3F sets `outputColorSpace` and `toneMapping` itself, once, inside
 * `configure()` — which runs *after* the `gl` factory resolves, so it lands on
 * top of `installToneCurve` and reverts the renderer to stock ACES with its
 * clamp to [0, 1]. Nothing about that is visible on the sRGB path, which is what
 * makes it worth a named function: on the extended path it throws away the
 * entire range this migration is for.
 *
 * `outputColorSpace` is deliberately left as R3F set it. `SRGBColorSpace` is
 * correct for extended output too — three applies the sRGB transfer without a
 * clamp, so 2.0 encodes to 1.353 and reaches the compositor intact, which is
 * what extended sRGB means.
 */
export function commitToneCurve(handle: RendererHandle): void {
  selectToneCurve(handle.renderer)
}

/**
 * Release whatever renderer is currently on the canvas.
 *
 * **R3F does not do this for a `WebGPURenderer`, and the consequence is a dead
 * tab.** Its unmount path calls `gl.renderLists.dispose()` and
 * `gl.forceContextLoss()`, both optional-chained and both WebGL-only — neither
 * exists on this renderer, so both are silent no-ops and the old renderer
 * survives its own unmount still holding the canvas.
 *
 * A second renderer then configures the same canvas, and the two disagree about
 * how big it is. Chrome says so, once per frame, forever:
 *
 *     The depth stencil attachment [Texture "depthBuffer"] size (300, 150) does
 *     not match the size of the other attachments' base plane (1800, 1026)
 *
 * — 300×150 being a canvas's default size, 1800×1026 the measured size at
 * devicePixelRatio 2. Every frame submits an invalid command buffer, and the tab
 * dies. It does *not* reproduce at devicePixelRatio 1, where both renderers
 * happen to agree, which is why a headless check will call this fixed when it
 * is not: **verify this on a Retina display or not at all.**
 *
 * Two things reach it in normal work, so neither is exotic: React StrictMode
 * mounts every component twice in development, and changing the HDR preference
 * remounts the canvas by design, because `outputType` is a constructor argument.
 */
export function releaseRenderer(): void {
  if (live === null) return
  live.renderer.dispose()
  live = null
}
