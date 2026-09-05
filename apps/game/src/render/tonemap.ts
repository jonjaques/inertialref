import {
  CustomToneMapping,
  type Node,
  type Renderer,
  type ToneMapping,
} from 'three/webgpu'
import {
  clamp,
  colorSpaceToWorking,
  Fn,
  luminance,
  mat3,
  max,
  smoothstep,
  uniform,
  vec3,
  vec4,
  workingToColorSpace,
} from 'three/tsl'
import { LINEAR_P3 } from './gamut.ts'

/* Natural retains the production ACES fit. Neutral applies the fit to
 * luminance, preserving channel ratios through the highlight range. Both use
 * one headroom lift and one output encoder; the choice belongs to the camera.
 */
const ACES_INPUT = /*@__PURE__*/ mat3(
  0.59719,
  0.35458,
  0.04823,
  0.076,
  0.90834,
  0.01566,
  0.0284,
  0.13383,
  0.83777,
)
const ACES_OUTPUT = /*@__PURE__*/ mat3(
  1.60475,
  -0.53108,
  -0.07367,
  -0.10208,
  1.10813,
  -0.00605,
  -0.00327,
  -0.07276,
  1.07602,
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
  readonly direct: { value: number }
  readonly wide: { value: number }
  readonly natural: { value: number }
}

/**
 * Where the extra range starts being used.
 *
 * High enough that skin, terrain and hull sit entirely below it — those must not
 * change between an SDR and an HDR screenshot — and low enough that a star's
 * limb has somewhere to go before the disk saturates.
 */
const DEFAULT_SHOULDER = 0.72

/** The controls of each renderer's curve, for the second install. */
const installed = new WeakMap<Renderer, ToneCurveControls>()

/**
 * Register the curve as `CustomToneMapping` and select it.
 *
 * Registration is per-renderer because `library` is: the node library is where
 * three looks up a tone mapping constant, and a renderer that has not been told
 * about `CustomToneMapping` logs "Unsupported Tone Mapping configuration" and
 * renders untonemapped.
 *
 * And once per renderer, because the library is: `addType` refuses a second
 * registration of a constant — it warns "Redefinition of node" and keeps the
 * first — so the graph a renderer draws with is the one installed first, for
 * the renderer's life. A second call hands back the controls of that graph
 * with `headroom` set to what it asked for, rather than uniforms attached to
 * a curve nothing draws.
 */
export function installToneCurve(
  renderer: Renderer,
  headroom: number,
): ToneCurveControls {
  const existing = installed.get(renderer)
  if (existing !== undefined) {
    existing.headroom.value = headroom
    selectToneCurve(renderer)
    return existing
  }

  const headroomUniform = uniform(headroom)
  const shoulderUniform = uniform(DEFAULT_SHOULDER)
  const directUniform = uniform(0)
  const wideUniform = uniform(0)
  const naturalUniform = uniform(1)

  const toneCurve = Fn(([color, exposure]: [Node<'vec3'>, Node<'float'>]) => {
    const input = color.mul(exposure)
    const light = wideUniform
      .greaterThan(0.5)
      .select(
        (
          workingToColorSpace(
            vec4(input, 1),
            LINEAR_P3,
          ) as unknown as Node<'vec4'>
        ).rgb,
        input,
      )
      .max(vec3(0))
    const y = wideUniform
      .greaterThan(0.5)
      .select(light.dot(vec3(0.2289, 0.6917, 0.0793)), luminance(light))
      .max(1e-10)
    const response = rrtAndOdtFit(vec3(y.div(0.6))).r.clamp()
    const mapped = light.mul(response.div(y))
    const peak = max(max(mapped.r, mapped.g), mapped.b).max(1)
    const neutral = mapped.div(peak)
    const calibrated = ACES_OUTPUT.mul(
      rrtAndOdtFit(ACES_INPUT.mul(input.div(0.6))),
    )
    const natural = wideUniform
      .greaterThan(0.5)
      .select(
        (
          workingToColorSpace(
            vec4(calibrated, 1),
            LINEAR_P3,
          ) as unknown as Node<'vec4'>
        ).rgb,
        calibrated,
      )
    const graded = naturalUniform.greaterThan(0.5).select(natural, neutral)

    // Lift by luminance, not per channel: scaling the channels independently
    // would pull a saturated highlight toward white as it brightens, which is
    // the one thing a star's color must not do — the star is the scene's
    // reference white and its temperature is data, not art direction.
    const lift = smoothstep(shoulderUniform, 1, luminance(graded))
      .mul(headroomUniform.sub(1))
      .add(1)

    // Both bounds explicitly `vec3`. `clamp` builds its node from whatever it is
    // handed, and a vec3 value against float bounds generates a WGSL `clamp`
    // whose three arguments do not agree on a type. That does not warn, does not
    // throw and does not appear in the console — it renders the entire scene
    // black. `graded.clamp()` gets away with plain numbers because a const is
    // converted where a uniform node is not.
    const result = directUniform
      .greaterThan(0.5)
      .select(
        clamp(light, vec3(0), vec3(headroomUniform)),
        clamp(graded.mul(lift), vec3(0), vec3(headroomUniform)),
      )
    return wideUniform
      .greaterThan(0.5)
      .select(
        (
          colorSpaceToWorking(
            vec4(result, 1),
            LINEAR_P3,
          ) as unknown as Node<'vec4'>
        ).rgb,
        result,
      )
  })

  // `@types/three` declares `NodeLibrary` as an empty class; the method is
  // there at runtime, in `renderers/common/nodes/NodeLibrary.js`.
  const library = renderer.library as {
    addToneMapping(curve: typeof toneCurve, toneMapping: ToneMapping): void
  }
  library.addToneMapping(toneCurve, CustomToneMapping)
  selectToneCurve(renderer)

  const controls = {
    headroom: headroomUniform,
    shoulder: shoulderUniform,
    direct: directUniform,
    wide: wideUniform,
    natural: naturalUniform,
  }
  installed.set(renderer, controls)
  return controls
}

export const toneCurveFor = (
  renderer: Renderer,
): ToneCurveControls | undefined => installed.get(renderer)

/**
 * Re-select the curve on a renderer that already has it registered.
 *
 * Separate from installation because something else sets `toneMapping` after
 * the renderer is built and has to be undone without touching the
 * registration — see `commitToneCurve` in `createRenderer.ts` for who and why.
 */
export function selectToneCurve(renderer: Renderer): void {
  renderer.toneMapping = CustomToneMapping
}

/** The ACES RRT + ODT rational fit. Source: selfshadow/ltc_code `ltc_blit.fs`. */
const rrtAndOdtFit = /*@__PURE__*/ Fn(([color]: [Node<'vec3'>]) => {
  const a = color.mul(color.add(0.0245786)).sub(0.000090537)
  const b = color.mul(color.add(0.432951).mul(0.983729)).add(0.238081)
  return a.div(b)
})
