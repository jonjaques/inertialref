import {
  Color,
  MeshBasicNodeMaterial,
  type Node,
  Vector2,
  Vector3,
} from 'three/webgpu'
import {
  attribute,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  Fn,
  If,
  length,
  max,
  min,
  mix,
  normalize,
  oneMinus,
  positionLocal,
  pow,
  saturate,
  screenUV,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from 'three/tsl'
import type { LinearRgb } from '@inertialref/universe'
import { OPEN_OCEAN, type TerrainPalette } from '@inertialref/rendering'
import {
  asVector,
  bumped,
  fbmFetch,
  noiseSampler,
  type Vector,
} from './noiseNodes.ts'
import { NOISE_CELLS, noiseTexture } from './noiseTexture.ts'
import { seaWearOf } from './wear.ts'
import { WAVE_OCTAVES } from './quality.ts'
import {
  AIR_SCALE_HEIGHT,
  AMBIENT,
  BLACK_RGB,
  paint,
  SKY_FRACTION,
} from './terrain.ts'

/*
 * The sea's own material.
 *
 * The ground under a sea is a seabed, drawn by `render/terrain.ts` like any
 * other ground, and this is the sheet laid over it at the datum — the second
 * of the two surfaces `buildPatch` emits for a patch the sea reaches. What it
 * does is what a real surface of water does: it reflects the sky and the sun
 * by Fresnel's law, it refracts what is under it, and it absorbs that light
 * by the path it takes through the water, so a shelf is turquoise and the
 * deep is the liquid's own colour. The refraction is real rather than a tint:
 * the sheet reads the frame the opaque pass just drew — the seabed, lit —
 * through `viewportSharedTexture`, displaced by the wave slope, and attenuates
 * it by `e^(−absorption · path)`. What is not here is a reflection of the
 * land in the water; that is a screen-space search this material does not
 * make, and the sky and the sun are what the eye reads as "sea" from any
 * distance a ship flies at.
 *
 * **Everything is in body-fixed axes**, for the reason the ground gives, and
 * the sheet morphs onto its parent exactly as the ground does — the same
 * `terrainMorph` attribute, the same band — so the two surfaces hand over at
 * the same distance and the shoreline does not swim at a level boundary.
 *
 * The three liquids share the graph and differ in uniforms: water and a
 * hydrocarbon sea in colour and absorption, magma in a glow that is most of
 * the picture and an absorption that takes the seabed out of it.
 */

export interface WaterMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Unit vector toward the star, **in the body's own rotating axes**. */
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  /** Presentation seconds; the waves drift against it. */
  readonly time: { value: number }
  /** How much sky one display pixel subtends, radians. See `pixelAngle`. */
  setPixelAngle(radians: number): void
  /** Point the material at one body's liquid. Idempotent. */
  setPalette(palette: TerrainPalette): void
  /** The tuneables `state/preferences.ts` exposes. */
  setQuality(quality: WaterQuality): void
}

/** What the graphics settings may turn down. */
export interface WaterQuality {
  /** Screen-space refraction of the seabed. Off reads the liquid's colour alone. */
  readonly refraction: boolean
  /**
   * Wave fields: one is the swell, two adds the chop. Zero is a flat sheet
   * with the sun in it. Capped at `WAVE_OCTAVES`, which the graph is built to.
   */
  readonly waveOctaves: number
}

export const DEFAULT_WATER_QUALITY: WaterQuality = {
  refraction: true,
  waveOctaves: WAVE_OCTAVES,
}

/**
 * Wavelength of the coarsest wave octave, meters.
 *
 * Wind waves on an open sea run from a few meters to a few tens; twelve is a
 * swell a landing ship's shadow crosses in a second, and three octaves below
 * it reach the meter-scale chop the sun glints off.
 */
export const WAVE_METRES = 12

/** Peak-to-peak relief of the coarsest wave octave, meters. */
const WAVE_RELIEF = 0.6

/**
 * The chop: a second field at four times the wave frequency, a quarter as
 * high. The swell alone reads as glass at a two-meter stance, because a
 * twelve-meter wave's slope is a few degrees and the sky's reflection is flat
 * across it; the chop is what breaks the reflection up into water.
 */
const CHOP_RELIEF = 0.14

/**
 * How many wave wavelengths the field repeats over. See `GRAIN_PERIOD` in
 * `render/terrain.ts` for why the domain is reduced on the CPU: 32 wavelengths
 * is 384 m of sea, about a period across the frame from a standing stance at
 * the distance the swell survives to, and several from a low hover.
 */
export const WAVE_PERIOD = NOISE_CELLS

/** One body-fixed coordinate reduced into the wave field's period, in wavelengths. */
export function waveWrap(meters: number): number {
  const cycles = meters / WAVE_METRES
  return cycles - Math.floor(cycles / WAVE_PERIOD) * WAVE_PERIOD
}

/** The index of refraction the path length is bent by. Water's; close enough for the rest. */
const REFRACTIVE_INDEX = 1.33

/**
 * What a sea is built with. `refraction` is a *build* option rather than a
 * uniform because the frame read is a texture binding, and a binding is a
 * fact about the pipeline: the production sheet reads the frame, and a
 * harness with no frame to read compiles the same graph without it.
 */
export interface WaterBuild {
  readonly refraction: boolean
}

/**
 * `mix` with one weight per channel. The typings admit only a scalar `t`;
 * WGSL's `mix(vec3, vec3, vec3)` is the operation a transmittance needs, one
 * weight per wavelength, and the node built is the same either way.
 */
const blend = (
  a: Node<'vec3'>,
  b: Node<'vec3'>,
  t: Node<'vec3'>,
): Node<'vec3'> => mix(a, b, t as unknown as Node<'float'>)

export function createWaterMaterial(
  build: WaterBuild = { refraction: true },
): WaterMaterial {
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const time = uniform(0)
  const pixelAngle = uniform(1e-3)
  const liquidColour = uniform(
    new Color(OPEN_OCEAN.r, OPEN_OCEAN.g, OPEN_OCEAN.b),
  )
  const absorption = uniform(new Vector3(0.35, 0.065, 0.025))
  const glow = uniform(new Color(0, 0, 0))
  const skyColour = uniform(new Color(0, 0, 0))
  const hazeColour = uniform(new Color(0, 0, 0))
  const skyStrength = uniform(0)
  const sunsetTint = uniform(new Color(1, 1, 1))
  const terminator = uniform(0.05)
  const refraction = uniform(1)
  const waveOctaves = uniform(DEFAULT_WATER_QUALITY.waveOctaves)

  // The per-mesh inputs, read off what the sheet wears — one record, one key,
  // dressed by `groundWear.ts`; `wear.ts` says what each is.
  const eyeLocal = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => seaWearOf(object).eyeLocal,
  )
  const morphBand = uniform(new Vector2()).onObjectUpdate(
    ({ object }) => seaWearOf(object).morphBand,
  )
  const anchor = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => seaWearOf(object).anchor,
  )
  /*
   * The anchor reduced modulo the wave period, in wavelengths — the sea's
   * `grainOrigin`, for the same reason: a wave field on the patch-local
   * position jumps phase at every patch edge, and on the body-fixed position
   * it is quantized out of existence. See `WAVE_PERIOD`.
   */
  const waveOrigin = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => seaWearOf(object).waveOrigin,
  )

  const localPosition = varying(vec3(), 'waterLocal')
  const waterDepth = varying(float(), 'waterDeep')
  const noise = noiseSampler(noiseTexture())

  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  material.depthWrite = true

  material.positionNode = Fn(() => {
    const target = attribute<'vec3'>('terrainMorph', 'vec3')
    const depth = attribute<'float'>('waterDepth', 'float')
    const targetDepth = attribute<'float'>('waterMorphDepth', 'float')
    const distance = length(positionLocal.sub(eyeLocal))
    const k = saturate(
      distance
        .sub(morphBand.x)
        .div(max(morphBand.y.sub(morphBand.x), float(1))),
    )
    const moved = mix(positionLocal, target, k)
    localPosition.assign(moved)
    waterDepth.assign(mix(depth, targetDepth, k))
    return moved
  })()

  const shading = Fn(() => {
    const local = localPosition
    const depth = max(waterDepth, float(0))

    /* --- the frame ---------------------------------------------------------- */

    const anchorLength = max(length(anchor), float(1))
    const anchorDirection = anchor.div(anchorLength)
    // The datum's own normal, and the one the sheet is flat against. Built
    // the way the ground builds it, so it can be differentiated.
    const up = normalize(anchorDirection.add(local.div(anchorLength)))
    const toEye = eyeLocal.sub(local)
    const view = normalize(toEye)
    const squareOn = max(dot(up, view), float(0.08))
    const footprint = length(toEye).mul(pixelAngle).div(squareOn)

    /* --- the waves ---------------------------------------------------------- */

    /*
     * Wave relief as a periodic field on the reduced coordinate, drifting
     * against the presentation clock, and faded out once a pixel covers a
     * few wavelengths — beyond that a wave field is white noise that
     * crawls, and the sun-glint's wide lobe is what the eye calls sea.
     */
    const waveFade = oneMinus(
      smoothstep(float(WAVE_METRES * 0.4), float(WAVE_METRES * 3), footprint),
    )
    const drift = vec3(time.mul(0.045), time.mul(0.02), time.mul(-0.03))
    const point = asVector(
      waveOrigin.add(local.mul(float(1 / WAVE_METRES))).add(drift),
    )
    const octaves = DEFAULT_WATER_QUALITY.waveOctaves
    const chopFade = oneMinus(
      smoothstep(
        float(WAVE_METRES * 0.08),
        float(WAVE_METRES * 0.6),
        footprint,
      ),
    )
    const chopPoint = asVector(
      point.mul(4).add(vec3(time.mul(0.11), time.mul(-0.07), time.mul(0.05))),
    )
    /*
     * Both fields are fetches of the baked noise, inside branches on their
     * fades and on the lever: past its fade a field multiplies out to zero,
     * and a zero that cost three fetches on every pixel of open sea is what
     * the branch is for. `waveOctaves` is a uniform so the setting needs no
     * rebuild: the chop goes first, then the swell, as the count falls.
     */
    const relief = vec4(0).toVar()
    If(waveOctaves.greaterThan(0.5).and(waveFade.greaterThan(0)), () => {
      relief.assign(fbmFetch(noise, point, octaves).mul(waveFade))
    })
    const chop = vec4(0).toVar()
    If(waveOctaves.greaterThan(1.5).and(chopFade.greaterThan(0)), () => {
      chop.assign(fbmFetch(noise, chopPoint, 1).mul(chopFade))
    })
    // The value, for the foam; the slope in meters per meter, for the normal.
    // `point` is in wavelengths, so a gradient per wavelength is one over
    // `WAVE_METRES` per meter, and the chop's domain is four times finer.
    const height = relief.x
      .mul(float(WAVE_RELIEF))
      .add(chop.x.mul(float(CHOP_RELIEF)))
    const slope = relief.yzw
      .mul(float(WAVE_RELIEF / WAVE_METRES))
      .add(chop.yzw.mul(float((CHOP_RELIEF * 4) / WAVE_METRES)))

    // The wave normal: the datum's, tilted by the tangential slope. See
    // `bumped` for why it is a gradient and not a screen-space difference.
    const normal = bumped(asVector(up), asVector(slope))

    /* --- the light ---------------------------------------------------------- */

    const sun = normalize(sunDirection)
    const incidence = dot(up, sun)
    const daylight = smoothstep(terminator.negate(), terminator, incidence)
    const lowSun = smoothstep(float(0.35), float(0.02), incidence)
    const tint = mix(vec3(1), sunsetTint, lowSun.mul(skyStrength).mul(0.85))
    const sunlight = sunColour.mul(sunIntensity).mul(tint)
    const diffuse = skyStrength.mul(SKY_FRACTION)

    /* --- Fresnel ------------------------------------------------------------ */

    const cosView = saturate(dot(normal, view))
    const fresnel = float(0.02).add(pow(oneMinus(cosView), 5).mul(0.98))

    /* --- what comes up through the water ------------------------------------- */

    /*
     * The path the light takes: down to the seabed and back along the
     * refracted ray, which is bent toward the normal by Snell's law — so a
     * grazing view sees less water than the geometry suggests, and a shelf
     * stays turquoise to the horizon rather than going navy a hundred meters
     * out. Doubled, because the sun's light went down and the eye's ray
     * comes up.
     */
    const sinView = sqrt(saturate(oneMinus(cosView.mul(cosView))))
    const sinRefracted = sinView.div(REFRACTIVE_INDEX)
    const cosRefracted = sqrt(
      saturate(oneMinus(sinRefracted.mul(sinRefracted))),
    )
    const path = depth.mul(2).div(max(cosRefracted, float(0.2)))
    const transmittance = exp(absorption.mul(path).negate())

    /*
     * The seabed, from the frame already drawn, displaced by the wave slope.
     * The slope is taken in screen space directly — the same two derivatives
     * the normal is built from — so the displacement follows the wave crests
     * on screen whatever the camera's basis is in body-fixed axes.
     */
    const shift = vec2(dFdx(height), dFdy(height))
      .mul(REFRACTION_SHIFT)
      .mul(refraction)
    const shifted = vec2(
      saturate(screenUV.x.add(shift.x)),
      saturate(screenUV.y.add(shift.y)),
    )
    const behind = build.refraction
      ? asVector(viewportSharedTexture(shifted).rgb)
      : asVector(liquidColour)
    /*
     * The liquid's own colour, lit: what scatters back out of the body of
     * the water where the seabed's light has been absorbed. Lambert on the
     * datum normal plus the skylight, the way the ground is lit, so the sea
     * and the shore agree about how bright the day is.
     */
    const skyView = float(1)
    const bodyLight = asVector(liquidColour)
      .mul(
        max(incidence, float(0))
          .mul(daylight)
          .mul(oneMinus(diffuse))
          .add(skyColour.mul(diffuse).mul(saturate(incidence.add(0.25))))
          .add(skyView.mul(float(AMBIENT))),
      )
      .mul(sunlight)
    const subsurface = blend(
      bodyLight,
      mix(bodyLight, behind, refraction),
      transmittance,
    )

    /* --- what reflects off it --------------------------------------------- */

    /*
     * The sky, as the reflection: its colour at the day's strength, falling
     * to the same floor the ground's night side keeps, and the sun in it as
     * the two-lobe glint the sphere and the ground already share — on the
     * wave normal now, because the wave field is in this geometry.
     */
    const skyLight = skyColour
      .mul(skyStrength)
      .mul(saturate(incidence.add(0.15)))
      .mul(0.9)
      .add(vec3(AMBIENT))
      .mul(sunlight)
    const half = normalize(sun.add(view))
    const facing = max(dot(view, half), float(0))
    const glintFresnel = float(0.02).add(pow(oneMinus(facing), 5).mul(0.98))
    const lobe = max(dot(normal, half), float(0))
    const glint = pow(lobe, float(1800))
      .add(pow(lobe, float(110)).mul(0.32))
      .mul(glintFresnel)
      .mul(daylight)
      .mul(60)

    /* --- the surface ---------------------------------------------------------- */

    let colour: Vector = asVector(
      mix(subsurface, skyLight, fresnel).add(sunlight.mul(glint)),
    )

    /*
     * Foam where the sea is shallower than a wave is high, broken up by the
     * fine octave so it is a line of surf rather than a white band.
     */
    const foamNoise = saturate(
      relief.x.mul(0.5).add(0.5).mul(1.6).sub(0.3).mul(waveFade),
    )
    const foam = oneMinus(smoothstep(float(0.05), float(1.4), depth))
      .mul(foamNoise)
      .mul(daylight.mul(0.8).add(0.2))
    colour = asVector(mix(colour, vec3(0.55).mul(sunlight), foam.mul(0.75)))

    // A magma sea is its own light, and so much of it that the reflection
    // and the seabed are drowned; a water sea adds nothing here.
    colour = asVector(colour.add(glow))

    /* --- the air in front of it ---------------------------------------------- */

    // The lesser of the orbital and the ground-level path, as the ground's
    // material measures it; see `AIR_SCALE_HEIGHT` there.
    const viewLeg = min(
      float(1).div(max(dot(up, view), float(0.09))),
      length(toEye).div(float(AIR_SCALE_HEIGHT)),
    )
    const airmass = viewLeg
      .add(float(1).div(max(incidence, float(0.09))))
      .mul(0.5)
    const veil = oneMinus(exp(airmass.mul(-0.15)))
      .mul(skyStrength)
      .mul(smoothstep(float(-0.06), float(0.28), incidence))
    const veilColour = mix(hazeColour, vec3(1), veil.mul(0.55)).mul(sunlight)
    return mix(colour, veilColour, veil.mul(0.68))
  })

  material.colorNode = shading()
  /*
   * The sheet fades in over the first half-meter of depth, so the shoreline
   * is a soft edge rather than a hard line where the datum plane cuts the
   * beach — and so the sheet under dry ground, which the depth test hides
   * anyway, contributes nothing where a sliver of it survives at a morph.
   */
  material.opacityNode = smoothstep(
    float(0.02),
    float(0.5),
    max(waterDepth, float(0)),
  )

  return {
    material,
    sunDirection,
    sunColour,
    sunIntensity,
    time,
    setPixelAngle(radians) {
      pixelAngle.value = radians
    },
    setPalette(palette) {
      const liquid = palette.liquid
      paint(liquidColour, palette.oceanColour)
      const absorb = liquid?.absorption ?? WATER_ABSORPTION
      absorption.value.set(absorb.r, absorb.g, absorb.b)
      paint(glow, liquid?.glow ?? BLACK_RGB)
      paint(skyColour, palette.skyColour)
      paint(hazeColour, palette.hazeColour)
      skyStrength.value = palette.airThickness
      paint(sunsetTint, palette.sunsetTint)
      terminator.value = palette.terminator
    },
    setQuality(quality) {
      const refract = quality.refraction ? 1 : 0
      if (refraction.value !== refract) refraction.value = refract
      const octaves = Math.max(
        0,
        Math.min(DEFAULT_WATER_QUALITY.waveOctaves, quality.waveOctaves),
      )
      if (waveOctaves.value !== octaves) waveOctaves.value = octaves
    },
  }
}

/** Water's, for a palette that names no liquid. */
const WATER_ABSORPTION: LinearRgb = { r: 0.35, g: 0.065, b: 0.025 }

/**
 * How far the wave slope displaces the refracted frame, in screen fractions
 * per meter of height gradient per pixel. Small, because the gradient is a
 * per-pixel difference and the shift should read as a shimmer rather than a
 * smear.
 */
const REFRACTION_SHIFT = 0.6
