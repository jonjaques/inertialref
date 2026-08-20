import { CustomToneMapping, type Node, type Renderer } from 'three/webgpu'
import { clamp, Fn, luminance, mat3, smoothstep, uniform, vec3 } from 'three/tsl'

/*
 * One tone curve, two output ranges.
 *
 * `docs/design/art.md` § HDR asks for three things that are usually in tension:
 * an ACES-derived curve, an SDR image that is *the same image* as the HDR one
 * rather than a differently-authored one, and a mapping that behaves from 2×
 * display headroom to 16×. The last is the hard one, because spike 1 established
 * that the page cannot find out which it is on — there is no headroom API in any
 * browser.
 *
 * What resolves it: the curve is three's `acesFilmicToneMapping` exactly, up to
 * its final clamp, and the only difference between the two paths is how far that
 * clamp is allowed to go. At `headroom = 1` this function is bit-identical to the
 * stock ACES tonemapper. Above 1, values the SDR path would have clipped are
 * re-expanded into the extra range and nothing below the shoulder moves at all.
 * So the two paths cannot disagree about the picture — only about how much of
 * the highlight survives.
 *
 * This is why the built-in tonemapper could not simply be selected: it ends in
 * `color.clamp()`, which throws away precisely the range extended output exists
 * to carry.
 *
 * Not yet the whole specification. The asymmetric eye adaptation (0.4 s to
 * bright, 3.5 s to dark) and the star-as-reference-white exposure are separate
 * work on `toneMappingExposure`; this is the response curve underneath them.
 */

// sRGB => XYZ => D65_2_D60 => AP1 => RRT_SAT, and its inverse. Copied from
// three's `acesFilmicToneMapping` rather than referenced because the built-in
// is not decomposed — the fit and the clamp are one function there.
const ACES_INPUT = /*@__PURE__*/ mat3(
  0.59719, 0.35458, 0.04823,
  0.076, 0.90834, 0.01566,
  0.0284, 0.13383, 0.83777,
)

const ACES_OUTPUT = /*@__PURE__*/ mat3(
  1.60475, -0.53108, -0.07367,
  -0.10208, 1.10813, -0.00605,
  -0.00327, -0.07276, 1.07602,
)

/**
 * Live handles on the curve.
 *
 * Structural rather than the TSL uniform type: all this module needs to promise
 * is that the numbers can be written, and `engine.gl.tone.shoulder.value = 0.6`
 * from the console is the point of exposing them at all.
 */
export interface ToneCurveControls {
  /** Ceiling in multiples of diffuse white. 1 is SDR. See `EXTENDED_HEADROOM`. */
  readonly headroom: { value: number }
  /** Where the highlight lift begins, in tonemapped luminance. Below it, the two paths are identical. */
  readonly shoulder: { value: number }
}

/**
 * Where the extra range starts being used.
 *
 * High enough that skin, terrain and hull sit entirely below it — those must not
 * change between an SDR and an HDR screenshot — and low enough that a star's
 * limb has somewhere to go before the disc saturates.
 */
const DEFAULT_SHOULDER = 0.72

/**
 * Register the curve as `CustomToneMapping` and select it.
 *
 * Registration is per-renderer because `library` is: the node library is where
 * three looks up a tone mapping constant, and a renderer that has not been told
 * about `CustomToneMapping` logs "Unsupported Tone Mapping configuration" and
 * renders untonemapped.
 */
export function installToneCurve(renderer: Renderer, headroom: number): ToneCurveControls {
  const headroomUniform = uniform(headroom)
  const shoulderUniform = uniform(DEFAULT_SHOULDER)

  const toneCurve = Fn(([color, exposure]: [Node, Node]) => {
    const graded = ACES_OUTPUT.mul(rrtAndOdtFit(ACES_INPUT.mul(color.mul(exposure).div(0.6))))

    // Lift by luminance, not per channel: scaling the channels independently
    // would pull a saturated highlight towards white as it brightens, which is
    // the one thing a star's colour must not do — the star is the scene's
    // reference white and its temperature is data, not art direction.
    const lift = smoothstep(shoulderUniform, 1, luminance(graded)).mul(headroomUniform.sub(1)).add(1)

    // Both bounds explicitly `vec3`. `clamp` builds its node from whatever it is
    // handed, and a vec3 value against float bounds generates a WGSL `clamp`
    // whose three arguments do not agree on a type. That does not warn, does not
    // throw and does not appear in the console — it renders the entire scene
    // black. `graded.clamp()` gets away with plain numbers because a const is
    // converted where a uniform node is not.
    return clamp(graded.mul(lift), vec3(0), vec3(headroomUniform))
  })

  renderer.library.addToneMapping(toneCurve, CustomToneMapping)
  selectToneCurve(renderer)

  return { headroom: headroomUniform, shoulder: shoulderUniform }
}

/**
 * Re-select the curve on a renderer that already has it registered.
 *
 * Separate from installation because something else sets `toneMapping` after
 * the renderer is built and has to be undone without building a second curve —
 * see `commitToneCurve` in `createRenderer.ts` for who and why. Installing twice
 * would work and would leave the caller holding uniforms attached to a graph
 * that is no longer the one being drawn.
 */
export function selectToneCurve(renderer: Renderer): void {
  renderer.toneMapping = CustomToneMapping
}

/** The ACES RRT + ODT rational fit. Source: selfshadow/ltc_code `ltc_blit.fs`. */
const rrtAndOdtFit = /*@__PURE__*/ Fn(([color]: [Node]) => {
  const a = color.mul(color.add(0.0245786)).sub(0.000090537)
  const b = color.mul(color.add(0.432951).mul(0.983729)).add(0.238081)
  return a.div(b)
})
