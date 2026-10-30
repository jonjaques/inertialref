import {
  sensorRadiance,
  sceneRadianceGain,
  visibilityAmbient,
} from './radiance.ts'
import {
  Color,
  MeshBasicNodeMaterial,
  Vector2,
  Vector3,
  Vector4,
} from 'three/webgpu'
import {
  attribute,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  Fn,
  fract,
  If,
  length,
  max,
  min,
  mix,
  modelViewMatrix,
  normalize,
  oneMinus,
  positionLocal,
  positionPrevious,
  positionView,
  pow,
  reflect,
  saturate,
  screenUV,
  smoothstep,
  sqrt,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
  vertexIndex,
} from 'three/tsl'
import type { LinearRgb } from '@inertialref/universe'
import { OPEN_OCEAN, type TerrainPalette } from '@inertialref/rendering'
import {
  asField,
  asVector,
  bumped,
  mixPerChannel,
  noiseFetch,
  noiseSampler,
  type Vector,
} from './noiseNodes.ts'
import { NOISE_CELLS, noiseTexture } from './noiseTexture.ts'
import { seaWearOf } from './wear.ts'
import { vertexMorphFactor } from './morph.ts'
import { WAVE_OCTAVES } from './quality.ts'
import { AIR_SCALE_HEIGHT, BLACK_RGB, paint, SKY_FRACTION } from './terrain.ts'
import { landReflection, seaFrame, type SeaFrameNode } from './seaReflection.ts'

/*
 * The sea's own material.
 *
 * The ground under a sea is a seabed, drawn by `render/terrain.ts` like any
 * other ground, and this is the sheet laid over it at the datum — the second
 * of the two surfaces `buildPatch` emits for a patch the sea reaches. What it
 * does is what a real surface of water does: it reflects the sky, the sun and
 * the land standing over it by Fresnel's law, it refracts what is under it,
 * and it absorbs that light by the path it takes through the water, so a shelf
 * is turquoise and the deep is the liquid's own color. The refraction is real
 * rather than a tint: the sheet reads the frame the opaque pass just drew —
 * the seabed, lit — displaced by the wave slope, and attenuates it by
 * `e^(−absorption · path)`. The land comes from the same frame, by a search
 * of the depth behind it (`render/seaReflection.ts`); where the search finds
 * nothing the sky is the reflection.
 *
 * **Everything is in body-fixed axes**, for the reason the ground gives, and
 * the sheet morphs onto its parent exactly as the ground does — the same
 * `terrainMorph` attribute, the same band — so the two surfaces hand over at
 * the same distance and the shoreline does not swim at a level boundary.
 *
 * The three liquids share the graph and differ in uniforms: water and a
 * hydrocarbon sea in color and absorption, magma in a glow that is most of
 * the picture and an absorption that takes the seabed out of it.
 *
 * **It is two materials over one set of uniforms.** Reading the frame is a
 * texture binding and a copy, and the copy ends the scene pass and begins it
 * again — so whether the sheet reads it is a fact about the pipeline, not a
 * value a uniform can switch off. `full` draws with the material that reads
 * the frame and its depth; `plain` and `flat` with the one built without, and
 * the scene pass stays whole.
 */

export interface WaterMaterial {
  /** The material the sea lever selects: see `setQuality`. */
  readonly material: MeshBasicNodeMaterial
  /** Every material the lever can select. Each is its own pipeline to warm. */
  readonly materials: readonly MeshBasicNodeMaterial[]
  /** Unit vector toward the star, **in the body's own rotating axes**. */
  readonly sunDirection: { value: Vector3 }
  readonly sunColor: { value: Color }
  readonly sunIntensity: { value: number }
  /** The presentation instant, seconds. The waves and the surf run against it. */
  setTime(seconds: number): void
  /** How much sky one display pixel subtends, radians. See `pixelAngle`. */
  setPixelAngle(radians: number): void
  /** Point the material at one body's liquid. Idempotent. */
  setPalette(palette: TerrainPalette): void
  /** The tuneables `state/preferences.ts` exposes. */
  setQuality(quality: WaterQuality): void
}

/** What the graphics settings may turn down. */
export interface WaterQuality {
  /**
   * Whether the sheet reads the frame behind it: the seabed refracted and the
   * land mirrored. Off selects the material built without the read, which
   * draws the liquid's color and the sky's reflection and leaves the scene
   * pass unsplit.
   */
  readonly frame: boolean
  /**
   * Wave fields: one is the swell, two adds the chop. Zero is a flat sheet
   * with the sun in it. Capped at `WAVE_OCTAVES`, which the graph is built to.
   */
  readonly waveOctaves: number
}

export const DEFAULT_WATER_QUALITY: WaterQuality = {
  frame: true,
  waveOctaves: WAVE_OCTAVES,
}

/**
 * Wavelength of the coarsest wave octave, meters.
 *
 * Wind waves on an open sea run from a few meters to a few tens; twelve is a
 * swell a landing ship's shadow crosses in a second, and three octaves below
 * it reach the meter-scale chop the sun glints off.
 */
export const WAVE_METERS = 12

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
  const cycles = meters / WAVE_METERS
  return cycles - Math.floor(cycles / WAVE_PERIOD) * WAVE_PERIOD
}

/**
 * How fast each field drifts, wavelengths of its own domain per second, along
 * the three body-fixed axes. The swell's and the chop's differ in direction
 * so the two never lock together into one pattern sliding across the sea.
 */
export const SWELL_DRIFT: readonly [number, number, number] = [
  0.045, 0.02, -0.03,
]
export const CHOP_DRIFT: readonly [number, number, number] = [0.11, -0.07, 0.05]

/**
 * The period the wave clock is reduced by, seconds, on the CPU in float64.
 *
 * Presentation time is seconds after J2000 — 8.2 × 10⁸ of them in 2026 —
 * and float32 holds that to the nearest 64 s, so a drift multiplied by it in
 * the shader moves the sea once a minute. Every drift above times this is a
 * whole number of `WAVE_PERIOD`s, so the field at the reduced instant is the
 * field at the real one; `water.test.ts` holds the arithmetic to the
 * constants.
 */
export const WAVE_CLOCK_PERIOD = 6_400

/**
 * The swell's period, seconds: deep water's dispersion, `T = √(2πλ / g)`, for
 * the coarsest wavelength under a standard gravity. The surf runs in at it, so
 * the line at the shore keeps time with the waves offshore.
 */
export const SWELL_PERIOD = Math.sqrt((2 * Math.PI * WAVE_METERS) / 9.81)

/**
 * Depth between two crests of the surf, meters. Crests run in along the depth
 * contours, so two or three of them share the foam's zone, which ends at 1.4 m.
 */
const SURF_SPACING = 0.45

/*
 * Where each wave octave fades, as fractions of its own wavelength of pixel
 * footprint. The baked noise carries four texels a wavelength, so a quarter
 * of one is a texel a pixel and a half is two — the field's Nyquist limit —
 * and every octave runs past it, to two and a half wavelengths a pixel and
 * more. Past it an octave is per-pixel noise, and that noise is the picture:
 * a low sun's glitter path is the chop's facets catching it, and the
 * middle distance from 2 km is the swell's grain. Faded at the limit, they
 * go to a smooth streak and a glassy sea — for a frame at 2 km a fifth
 * shorter, because past the limit every fetch is minified, and a minified
 * fetch of an unmipped 3D texture misses its cache on every pixel. Each
 * octave has its own branch on its own fade, so the swell's second octave
 * stops at its own limit rather than its parent's.
 */
const SWELL_FADE: readonly [number, number] = [0.4, 3]
const SWELL_DETAIL_FADE: readonly [number, number] = [0.8, 6]
const CHOP_FADE: readonly [number, number] = [0.32, 2.4]

/**
 * The eye's height over the water at which the land's reflection has gone,
 * meters; it starts to go at half of it. From higher the sea under the eye is
 * seen nearly square on, where Fresnel's law leaves two percent of any
 * reflection, and what is left is the far field, where the waves have already
 * smeared it and the depth behind it is the coarsest the frame holds. Past
 * the reach the search does not run at all.
 */
const REFLECTION_REACH = 1_000

/** The index of refraction the path length is bent by. Water's; close enough for the rest. */
const REFRACTIVE_INDEX = 1.33

/**
 * What one sea material is built with. Both are *build* options rather than
 * uniforms because each is a texture binding — the frame, and its depth — and
 * a binding is a fact about the pipeline.
 */
interface WaterBuild {
  /** Read the frame behind the sheet: the refraction, and the copy that splits the pass. */
  readonly refraction: boolean
  /** Search the depth behind the sheet for the land's reflection. Implies the frame. */
  readonly reflection: boolean
}

const FULL_SEA: WaterBuild = { refraction: true, reflection: true }
const PLAIN_SEA: WaterBuild = { refraction: false, reflection: false }

export function createWaterMaterial(): WaterMaterial {
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColor = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  // The wave clock, reduced by `WAVE_CLOCK_PERIOD`, and the surf's phase in
  // cycles, reduced by one: both from float64 on the CPU.
  const waveTime = uniform(0)
  const surfPhase = uniform(0)
  const pixelAngle = uniform(1e-3)
  const liquidColor = uniform(
    new Color(OPEN_OCEAN.r, OPEN_OCEAN.g, OPEN_OCEAN.b),
  )
  const absorption = uniform(new Vector3(0.35, 0.065, 0.025))
  const glow = uniform(new Color(0, 0, 0))
  const skyColor = uniform(new Color(0, 0, 0))
  const hazeColor = uniform(new Color(0, 0, 0))
  const skyStrength = uniform(0)
  const sunsetTint = uniform(new Color(1, 1, 1))
  const terminator = uniform(0.05)
  const waveOctaves = uniform(DEFAULT_WATER_QUALITY.waveOctaves)

  // The per-mesh inputs, read off what the sheet wears — one record, one key,
  // dressed by `groundWear.ts`; `wear.ts` says what each is.
  const eyeLocal = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => seaWearOf(object).eyeLocal,
  )
  const morphBand = uniform(new Vector2()).onObjectUpdate(
    ({ object }) => seaWearOf(object).morphBand,
  )
  const morphEdges = uniform(new Vector4(0, 0, 0, 0)).onObjectUpdate(
    ({ object }) => seaWearOf(object).morphEdges,
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

  /*
   * One sheet material. The uniforms above are shared, so the two builds are
   * one sea that a frame can draw either way; the varyings and the noise
   * binding are per material, because each belongs to the graph that reads it.
   */
  const build = (options: WaterBuild): MeshBasicNodeMaterial => {
    const localPosition = varying(vec3(), 'waterLocal')
    const waterDepth = varying(float(), 'waterDeep')
    const noise = noiseSampler(noiseTexture())

    const material = sensorRadiance(
      new MeshBasicNodeMaterial(),
      false,
      false,
      0.3,
    )
    material.transparent = true
    material.depthWrite = true

    material.positionNode = Fn(() => {
      // Typed explicitly for the reason `terrain.ts` gives: the literal widens.
      const target = attribute<'vec3'>('terrainMorph', 'vec3')
      const depth = attribute<'float'>('waterDepth', 'float')
      const targetDepth = attribute<'float'>('waterMorphDepth', 'float')
      // The sheet has its patch's vertices, so it holds its patch's edges.
      const k = vertexMorphFactor(
        float(vertexIndex),
        positionLocal,
        eyeLocal,
        morphBand,
        morphEdges,
      )
      const moved = mix(positionLocal, target, k)
      // Both sides of the velocity, for the reason `terrain.ts` gives.
      positionPrevious.assign(moved)
      localPosition.assign(moved)
      waterDepth.assign(mix(depth, targetDepth, k))
      return moved
    })()

    const shading = Fn(() => {
      const local = localPosition
      const depth = max(waterDepth, float(0))

      /* --- the frame -------------------------------------------------------- */

      const anchorLength = max(length(anchor), float(1))
      const anchorDirection = anchor.div(anchorLength)
      // The datum's own normal, and the one the sheet is flat against. Built
      // the way the ground builds it, so it can be differentiated.
      const up = normalize(anchorDirection.add(local.div(anchorLength)))
      const toEye = eyeLocal.sub(local)
      const view = normalize(toEye)
      const squareOn = max(dot(up, view), float(0.08))
      const footprint = length(toEye).mul(pixelAngle).div(squareOn)

      /* --- the waves -------------------------------------------------------- */

      /*
       * Wave relief as a periodic field on the reduced coordinate, drifting
       * against the presentation clock, each octave faded out once a pixel
       * covers enough of its wavelength that it is noise (`SWELL_FADE`).
       */
      const fade = (
        [start, end]: readonly [number, number],
        wavelength: number,
      ) =>
        oneMinus(
          smoothstep(
            float(start * wavelength),
            float(end * wavelength),
            footprint,
          ),
        )
      const waveFade = fade(SWELL_FADE, WAVE_METERS)
      const detailFade = fade(SWELL_DETAIL_FADE, WAVE_METERS / 2)
      const chopFade = fade(CHOP_FADE, WAVE_METERS / 4)
      const drift = vec3(...SWELL_DRIFT).mul(waveTime)
      const point = asVector(
        waveOrigin.add(local.mul(float(1 / WAVE_METERS))).add(drift),
      )
      const chopPoint = asVector(
        point.mul(4).add(vec3(...CHOP_DRIFT).mul(waveTime)),
      )
      /*
       * Each octave is a fetch of the baked noise inside a branch on its fade
       * and on the lever: past its fade a field multiplies out to zero, and a
       * zero that cost a fetch on every pixel of open sea is what the branch
       * is for. `waveOctaves` is a uniform so the setting needs no rebuild:
       * the chop goes first, then the swell, as the count falls. The swell's
       * two octaves are the fBm `fbmFetch` would sum — amplitude halving,
       * frequency doubling, normalized by one and a half — taken one at a
       * time so each has its own fade.
       */
      const swell = vec4(0).toVar()
      If(waveOctaves.greaterThan(0.5).and(waveFade.greaterThan(0)), () => {
        swell.assign(noiseFetch(noise, point).mul(waveFade))
      })
      const swellDetail = vec4(0).toVar()
      If(waveOctaves.greaterThan(0.5).and(detailFade.greaterThan(0)), () => {
        const octave = noiseFetch(noise, asVector(point.mul(2)))
        swellDetail.assign(
          vec4(octave.x.mul(0.5), octave.yzw).mul(detailFade.mul(waveFade)),
        )
      })
      const relief = asField(swell.add(swellDetail).div(1.5))
      const chop = vec4(0).toVar()
      If(waveOctaves.greaterThan(1.5).and(chopFade.greaterThan(0)), () => {
        chop.assign(noiseFetch(noise, chopPoint).mul(chopFade))
      })
      // The value, for the foam; the slope in meters per meter, for the normal.
      // `point` is in wavelengths, so a gradient per wavelength is one over
      // `WAVE_METERS` per meter, and the chop's domain is four times finer.
      const height = relief.x
        .mul(float(WAVE_RELIEF))
        .add(chop.x.mul(float(CHOP_RELIEF)))
      const slope = relief.yzw
        .mul(float(WAVE_RELIEF / WAVE_METERS))
        .add(chop.yzw.mul(float((CHOP_RELIEF * 4) / WAVE_METERS)))

      // The wave normal: the datum's, tilted by the tangential slope. See
      // `bumped` for why it is a gradient and not a screen-space difference.
      const normal = bumped(asVector(up), asVector(slope))

      /* --- the light -------------------------------------------------------- */

      const sun = normalize(sunDirection)
      const incidence = dot(up, sun)
      const daylight = smoothstep(terminator.negate(), terminator, incidence)
      const lowSun = smoothstep(float(0.35), float(0.02), incidence)
      const tint = mix(vec3(1), sunsetTint, lowSun.mul(skyStrength).mul(0.85))
      const sunlight = sunColor.mul(sunIntensity).mul(tint)
      const diffuse = skyStrength.mul(SKY_FRACTION)

      /* --- Fresnel ---------------------------------------------------------- */

      const cosView = saturate(dot(normal, view))
      const fresnel = float(0.02).add(pow(oneMinus(cosView), 5).mul(0.98))

      /* --- what comes up through the water ----------------------------------- */

      /*
       * The path the light takes: down to the seabed and back along the
       * refracted ray, which is bent toward the normal by Snell's law — so a
       * grazing view sees less water than the geometry suggests, and a shelf
       * stays turquoise to the horizon rather than going navy a hundred
       * meters out. Doubled, because the sun's light went down and the eye's
       * ray comes up.
       */
      const sinView = sqrt(saturate(oneMinus(cosView.mul(cosView))))
      const sinRefracted = sinView.div(REFRACTIVE_INDEX)
      const cosRefracted = sqrt(
        saturate(oneMinus(sinRefracted.mul(sinRefracted))),
      )
      const path = depth.mul(2).div(max(cosRefracted, float(0.2)))
      const transmittance = exp(absorption.mul(path).negate())

      /*
       * The seabed, from the frame already drawn, displaced by the wave
       * slope. The slope is taken in screen space directly — the same two
       * derivatives the normal is built from — so the displacement follows
       * the wave crests on screen whatever the camera's basis is in
       * body-fixed axes.
       */
      const shift = vec2(dFdx(height), dFdy(height)).mul(REFRACTION_SHIFT)
      const shifted = vec2(
        saturate(screenUV.x.add(shift.x)),
        saturate(screenUV.y.add(shift.y)),
      )
      const frame: SeaFrameNode | null = options.refraction
        ? seaFrame(shifted, options.reflection)
        : null
      const liquid = asVector(liquidColor)
      /*
       * The liquid's own color, lit: what scatters back out of the body of
       * the water where the seabed's light has been absorbed. Lambert on the
       * datum normal plus the skylight, the way the ground is lit, so the
       * sea and the shore agree about how bright the day is.
       */
      const skyView = float(1)
      const diffuseLight = max(incidence, float(0))
        .mul(daylight)
        .mul(oneMinus(diffuse))
        .add(skyColor.mul(diffuse).mul(saturate(incidence.add(0.25))))
        .add(skyView.mul(visibilityAmbient))
        .mul(sunlight)
      const bodyLight = liquid.mul(diffuseLight)
      // Without the frame the seabed is not seen, and what comes up through
      // the water is the water's own light.
      const subsurface =
        frame === null
          ? bodyLight
          : mixPerChannel(
              bodyLight,
              asVector(frame.rgb.div(sceneRadianceGain)),
              transmittance,
            )

      /* --- what reflects off it --------------------------------------------- */

      /*
       * The sky, as the reflection: its color at the day's strength, falling
       * to the same floor the ground's night side keeps, and the sun in it as
       * the two-lobe glint the sphere and the ground already share — on the
       * wave normal now, because the wave field is in this geometry.
       */
      const skyLight = skyColor
        .mul(skyStrength)
        .mul(saturate(incidence.add(0.15)))
        .mul(0.9)
        .add(vec3(visibilityAmbient))
        .mul(sunlight)
      const half = normalize(sun.add(view))
      const facing = max(dot(view, half), float(0))
      const glintFresnel = float(0.02).add(pow(oneMinus(facing), 5).mul(0.98))
      const lobe = max(dot(normal, half), float(0))
      let glint: Vector = asVector(
        pow(lobe, float(1800))
          .add(pow(lobe, float(110)).mul(0.32))
          .mul(glintFresnel)
          .mul(daylight)
          .mul(60),
      )

      /*
       * The land, where the search finds it: the reflected ray in view space,
       * weighted in over the sky by how much of the reflection it is. The
       * search runs only where the reflection can be seen — under the reach,
       * and where Fresnel leaves more than a few percent of it — and the sun's
       * glint goes where the land stands in front of it.
       */
      let reflection: Vector = asVector(skyLight)
      if (frame !== null && options.reflection) {
        const toView = (direction: Vector) =>
          asVector(normalize(modelViewMatrix.mul(vec4(direction, 0)).xyz))
        const height = dot(toEye, up)
        const reach = oneMinus(
          smoothstep(
            float(REFLECTION_REACH / 2),
            float(REFLECTION_REACH),
            height,
          ),
        ).mul(smoothstep(float(0.025), float(0.06), fresnel))
        const land = vec4(0).toVar()
        If(reach.greaterThan(0), () => {
          land.assign(
            landReflection(frame, {
              position: asVector(positionView),
              direction: asVector(
                reflect(normalize(positionView), toView(normal)),
              ),
              up: toView(asVector(up)),
            }),
          )
        })
        const mirrored = land.a.mul(reach)
        reflection = asVector(
          mix(skyLight, land.rgb.div(sceneRadianceGain), mirrored),
        )
        glint = asVector(glint.mul(oneMinus(mirrored)))
      }

      /* --- the surface ------------------------------------------------------ */

      let color: Vector = asVector(
        mix(subsurface, reflection, fresnel).add(sunlight.mul(glint)),
      )

      /*
       * Foam where the sea is shallower than a wave is high, broken up by the
       * swell so it is a line of surf rather than a white band — and running
       * in. The crests come ashore along the depth contours at the swell's
       * period: a crest stands where the depth over `SURF_SPACING` plus the
       * surf's phase is a whole number, so as the phase grows it stands in
       * shallower water. The swell's own value bends each crest so the lines
       * are not contours, and the foam trails seaward behind the crest that
       * left it.
       */
      const foamNoise = saturate(
        relief.x.mul(0.5).add(0.5).mul(1.6).sub(0.3).mul(waveFade),
      )
      const surf = fract(
        depth.div(SURF_SPACING).add(surfPhase).add(relief.x.mul(0.35)),
      )
      const crest = smoothstep(float(0), float(0.12), surf).mul(
        oneMinus(smoothstep(float(0.12), float(0.6), surf)),
      )
      const foam = oneMinus(smoothstep(float(0.05), float(1.4), depth))
        .mul(foamNoise)
        .mul(crest.mul(0.75).add(0.25))
        .mul(daylight.mul(0.8).add(0.2))
      color = asVector(mix(color, vec3(0.55).mul(diffuseLight), foam.mul(0.75)))

      // A magma sea is its own light, and so much of it that the reflection
      // and the seabed are drowned; a water sea adds nothing here.
      color = asVector(color.add(glow))

      /* --- the air in front of it -------------------------------------------- */

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
      const veilColor = mix(hazeColor, vec3(1), veil.mul(0.55)).mul(sunlight)
      return mix(color, veilColor, veil.mul(0.68))
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
    return material
  }

  const full = build(FULL_SEA)
  const plain = build(PLAIN_SEA)
  let selected = full

  return {
    get material() {
      return selected
    },
    materials: [full, plain],
    sunDirection,
    sunColor,
    sunIntensity,
    setTime(seconds) {
      waveTime.value =
        seconds - Math.floor(seconds / WAVE_CLOCK_PERIOD) * WAVE_CLOCK_PERIOD
      const cycles = seconds / SWELL_PERIOD
      surfPhase.value = cycles - Math.floor(cycles)
    },
    setPixelAngle(radians) {
      pixelAngle.value = radians
    },
    setPalette(palette) {
      const liquid = palette.liquid
      paint(liquidColor, palette.oceanColor)
      const absorb = liquid?.absorption ?? WATER_ABSORPTION
      absorption.value.set(absorb.r, absorb.g, absorb.b)
      paint(glow, liquid?.glow ?? BLACK_RGB)
      paint(skyColor, palette.skyColor)
      paint(hazeColor, palette.hazeColor)
      skyStrength.value = palette.airThickness
      paint(sunsetTint, palette.sunsetTint)
      terminator.value = palette.terminator
    },
    setQuality(quality) {
      selected = quality.frame ? full : plain
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
