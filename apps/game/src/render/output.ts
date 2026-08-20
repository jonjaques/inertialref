/*
 * What the renderer is allowed to put on the screen, and who decides.
 *
 * Kept free of `three`, `navigator` and the DOM so the decision has a test in
 * Node. The half that touches the browser is `capability.ts`; this file is the
 * arithmetic between what the browser reported and what the player asked for.
 *
 * Design source: `docs/design/art.md` § HDR and `docs/spikes.md` § 1, which
 * measured the three candidate display signals across three browsers on one
 * physical panel and concluded that none of them answers "is this display worth
 * authoring HDR for". Everything below follows from that being unanswerable.
 */

/** The three-state override. `docs/design/art.md` calls it mandatory. */
export type OutputPreference = 'auto' | 'extended' | 'standard'

/** What the renderer was actually built to do. Never `auto`. */
export type OutputMode = 'extended' | 'standard'

/**
 * The three signals, separated because two of them are opinions and one is a
 * fact.
 *
 * `dynamicRangeHigh` is a *display* signal and it is wrong in both directions:
 * Chrome and Safari report it true for an ordinary laptop panel with 2×
 * headroom, and Firefox reports it false for that same panel. `extendedCanvas`
 * is a *capability* signal — a `configure()` that either threw or did not — and
 * it is the only one that cannot be argued with.
 */
export interface OutputCapability {
  /** `navigator.gpu` exists. Necessary, nowhere near sufficient. */
  readonly webgpu: boolean
  /** `(dynamic-range: high)` matches. Live — it changes when a window moves. */
  readonly dynamicRangeHigh: boolean
  /** An `rgba16float` canvas with `toneMapping: 'extended'` configured without throwing. */
  readonly extendedCanvas: boolean
}

/**
 * Resolve the preference against what the browser can actually do.
 *
 * The asymmetry is deliberate and is the whole point of the three states:
 *
 * - `standard` always wins. Somebody turning HDR off is never overruled.
 * - `extended` overrides the *media query* but not the *probe*. The media query
 *   is a guess about a display and a player looking at that display knows
 *   better; the probe is Firefox refusing to configure an `rgba16float` canvas,
 *   and no preference makes that possible.
 * - `auto` requires all three, which is the expression `docs/design/art.md`
 *   spells out verbatim.
 */
export function resolveOutputMode(
  preference: OutputPreference,
  capability: OutputCapability,
): OutputMode {
  if (preference === 'standard') return 'standard'
  if (!capability.extendedCanvas) return 'standard'
  if (preference === 'extended') return 'extended'
  return capability.webgpu && capability.dynamicRangeHigh
    ? 'extended'
    : 'standard'
}

/**
 * The ceiling the tone curve rolls off to, in multiples of diffuse white.
 *
 * There is no headroom API — spike 1 checked, `screen.highDynamicRangeHeadroom`
 * is absent in all three browsers — so this is *authored*, not probed, and it is
 * authored to the smallest headroom anybody has measured: the 2.0× EDR of the
 * laptop panel the spike ran on. Undershooting leaves range unused on an XDR
 * display; overshooting clips highlights on the common one. The curve itself is
 * continuous in this number, which is what "the curve must hold from 2× to 16×"
 * asks for.
 */
export const EXTENDED_HEADROOM = 2

export function headroomFor(mode: OutputMode): number {
  return mode === 'extended' ? EXTENDED_HEADROOM : 1
}

/** What the renderer ended up as, for the HUD and for `ir.status()`. */
export interface RendererDescription {
  readonly backend: 'webgpu' | 'webgl'
  readonly mode: OutputMode
  readonly preference: OutputPreference
  readonly headroom: number
  readonly capability: OutputCapability
}

/** One line, for the dock header and the console. */
export function describeOutput(description: RendererDescription): string {
  const range =
    description.mode === 'extended'
      ? `extended ${description.headroom}×`
      : 'sRGB'
  return `${description.backend} · ${range} · ${description.preference}`
}
