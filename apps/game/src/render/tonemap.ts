import {
  CustomToneMapping,
  type Node,
  type Renderer,
  type ToneMapping,
} from 'three/webgpu'
import {
  clamp,
  colorSpaceToWorking,
  float,
  Fn,
  log2,
  luminance,
  mat3,
  max,
  mix,
  smoothstep,
  sqrt,
  uniform,
  vec3,
  vec4,
  workingToColorSpace,
} from 'three/tsl'
import { CALIBRATED_STAR_RADIANCE } from './bodyUniforms.ts'
import { LINEAR_P3 } from './gamut.ts'

/* The photographic response preserves channel ratios through highlights.
 * The ACES branch belongs to explicitly calibrated cinematic staging and
 * diagnostic comparisons. Camera modes share one final output encoder.
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
    // Branches share one detector result; inlining it at each use can exceed
    // WGSL's private-storage budget before the shader reaches the GPU.
    const input = color.mul(exposure).toVar()
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
    /*
     * Where the display runs out, toward white rather than down. A saturated
     * light whose luminance the curve has taken to the top still has a
     * channel past one, and scaling the whole color down until it fits drew
     * a 2° sun — deep orange at a hundred times the surface white — at a
     * luminance of 0.55 beside its pale aureole at 0.79: the brightest thing
     * in the sky as a dark spot in its own glow. A camera clips that disk
     * toward white. Mixing with the gray of its own luminance keeps the
     * luminance and the opponent-plane hue angle exactly, takes only as much
     * saturation as the channel needs, and starts only in the curve's top 5%,
     * so everything below it, a star's darkened limb included, keeps the color
     * it was drawn with.
     */
    const over = max(max(mapped.r, mapped.g), mapped.b)
    const bleach = smoothstep(0.95, 1, response).mul(
      over.sub(1).max(0).div(over.sub(response).max(1e-6)).min(0.97),
    )
    const bleached = mix(mapped, vec3(response), bleach)
    const peak = max(max(bleached.r, bleached.g), bleached.b).max(1)
    const neutral = bleached.div(peak)
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
    // would shift a saturated highlight's hue as it brightens, and a star's
    // hue is its temperature, which is data, not art direction. How far the
    // top of the curve whitens is the bleach above, which keeps the hue.
    //
    // And by the *scene's* luminance, on a log scale that reaches the peak at
    // the star's own radiance, rather than by the graded value. The graded
    // curve is all but flat above three times diffuse white, so a lift keyed
    // on it hands nearly the whole headroom to everything past that: the
    // noon aureole three degrees off the sun, at 2.8, draws at 1.67 on a 2×
    // display against the disk's 1.97 — a sun that is not the brightest
    // thing in its own sky. Below the shoulder nothing moves, so an SDR and
    // an HDR capture still agree on skin, terrain and hull, and the ramp is
    // the same at any headroom, which the curve cannot know.
    //
    // The shoulder is held under 0.98 for the solve, because it is written
    // from the console: past about 0.985 its scene luminance passes the
    // star's own and the ramp runs backward, and past 1.017 the fit never
    // reaches it: the root is negative and the lift NaN in every pixel.
    const start = shoulderLuminance(shoulderUniform.min(0.98))
    const reach = log2(y.div(start)).div(
      log2(float(CALIBRATED_STAR_RADIANCE).div(start)),
    )
    const lift = smoothstep(0, 1, reach.clamp(0, 1))
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

/**
 * The scene luminance whose graded value is `shoulder`: the rational fit
 * below, solved for its input. It is a quadratic, and the positive root is the
 * one on the curve. The neutral look feeds the fit `y / 0.6`, hence the 0.6.
 */
const shoulderLuminance = /*@__PURE__*/ Fn(([shoulder]: [Node<'float'>]) => {
  const a = float(1).sub(shoulder.mul(0.983729))
  const b = float(0.0245786).sub(shoulder.mul(0.983729 * 0.432951))
  const c = shoulder.mul(0.238081).add(0.000090537).negate()
  const root = b
    .negate()
    .add(sqrt(b.mul(b).sub(a.mul(c).mul(4))))
    .div(a.mul(2))
  return root.mul(0.6)
})

/** The ACES RRT + ODT rational fit. Source: selfshadow/ltc_code `ltc_blit.fs`. */
const rrtAndOdtFit = /*@__PURE__*/ Fn(([color]: [Node<'vec3'>]) => {
  const a = color.mul(color.add(0.0245786)).sub(0.000090537)
  const b = color.mul(color.add(0.432951).mul(0.983729)).add(0.238081)
  return a.div(b)
})
