import { SURFACE_LUMINANCE } from '@inertialref/rendering'
import { integratedSkyGain, sensorRadiance } from './radiance.ts'
import {
  AddEquation,
  BackSide,
  Color,
  CustomBlending,
  DataTexture,
  InstancedBufferAttribute,
  LinearFilter,
  MeshBasicNodeMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PointsNodeMaterial,
  RGBAFormat,
  SrcAlphaFactor,
  type Texture,
  Vector3,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  Fn,
  instancedBufferAttribute,
  length,
  Loop,
  max,
  mix,
  mx_fractal_noise_float,
  mx_worley_noise_float,
  normalize,
  normalWorld,
  oneMinus,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  sqrt,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { AtmosphereRecipe } from '@inertialref/rendering'

/*
 * Every material the scene draws, as node graphs.
 *
 * Built imperatively and handed to meshes through the `material` prop rather
 * than declared as JSX. R3F reconciles node materials perfectly well once they
 * are `extend()`ed, but the scene here is already mutated imperatively for the
 * reason `SceneView.tsx` gives at the top, and a material constructed in one
 * place is a material whose uniforms can be written from the frame loop without
 * a second lookup.
 *
 * The three materials that carry real TSL — star, atmosphere, star field — are
 * each a self-contained function returning its own uniforms and reaching into
 * nothing else. That shape is deliberate: `docs/design/technical.md` § The path
 * names terrain, atmosphere and the star field as the three places a
 * hand-written pipeline might eventually be worth it, and asks that they stay
 * expressible as standalone passes so that decision stays available.
 */

/** Scene-linear radiance of a star's disk, in multiples of diffuse white. */
const STAR_RADIANCE = 1

/**
 * Solar limb darkening, visual band. 0.6 is a G star, which is what the default
 * seed puts the player in front of.
 */
const LIMB_DARKENING = 0.6

export interface StarMaterial {
  readonly material: MeshBasicNodeMaterial
  readonly color: { value: Color }
  /** Presentation seconds; the granulation churns against it. */
  readonly time: { value: number }
  /**
   * Multiplier on the disk's radiance, 1 from afar.
   *
   * The camera's stop-down when a star fills the frame. At the authored
   * radiance the whole disk clips to the tone curve's ceiling and every
   * surface feature vanishes into one white circle; a real photograph of a
   * near sun is exposed *for the sun*, which is when the granulation and the
   * limb become the picture. Driven from the star's angular radius by the
   * host — the nearest thing this renderer yet has to eye adaptation.
   */
  readonly exposure: { value: number }
}

/**
 * A star's disk: unlit, above white, limb-darkened — and alive.
 *
 * This is the material the HDR path exists for. `docs/design/art.md` makes the
 * star the scene's reference white — everything else sits below it — so its
 * radiance is authored well above 1 and the tone curve decides what a given
 * display can do with that. On the sRGB path the disk saturates, which is what
 * a star does; on the extended path it is the one thing in the frame brighter
 * than the HUD.
 *
 * Limb darkening rather than a flat disk because `I(mu)/I(1) = 1 − u(1 − mu)`
 * costs one dot product and is the difference between a light source and a hole
 * cut in the sky.
 *
 * The surface itself is two octaves of cellular convection. Worley noise *is*
 * what granulation looks like — bright cell centers draining into dark
 * intergranular lanes — and a fractal octave underneath stands in for
 * supergranulation and mottling. Drawn at a scale the eye can read rather than
 * the Sun's true one (a real granule is a thousandth of the radius, sub-pixel
 * from any orbit), and drifted slowly with presentation time so a star held in
 * frame at time warp visibly simmers. Near the limb the lanes warm toward the
 * chromosphere's orange — the same reason eclipse photographs ring the disk in
 * red — keyed to `mu` so it costs nothing at disk center.
 */
export function createStarMaterial(): StarMaterial {
  const color = uniform(new Color(1, 1, 1))
  const time = uniform(0)
  const exposure = uniform(1)

  // `abs` because a sphere seen from inside — which happens for exactly one
  // frame if the origin rebases while a star fills the view — otherwise flips
  // `mu` negative and turns the disk black.
  const mu = abs(
    dot(normalize(normalWorld), normalize(cameraPosition.sub(positionWorld))),
  )
  const limb = oneMinus(float(LIMB_DARKENING).mul(oneMinus(mu)))

  // The unit sphere's own surface as the noise domain, so the pattern rides
  // the star at every drawn size and never swims when the mesh rescales.
  const surface = normalize(positionLocal)
  const churn = time.mul(0.003)
  const granulation = oneMinus(
    mx_worley_noise_float(surface.mul(48).add(vec3(churn, churn, 0))).mul(0.34),
  )
  const mottling = mx_fractal_noise_float(
    surface.mul(7).add(vec3(0, churn.mul(0.4), 0)),
  ).mul(0.05)

  const chromosphere = mix(
    vec3(1),
    vec3(1.12, 0.74, 0.52),
    pow(oneMinus(mu), 3).mul(0.55),
  )

  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = color
    .mul(limb)
    .mul(granulation.add(mottling))
    .mul(chromosphere)
    .mul(float(STAR_RADIANCE).mul(exposure))
  return { material, color, time, exposure }
}

export interface AtmosphereMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Body center in render space. Written every frame — the planet is orbiting. */
  readonly centre: { value: Vector3 }
  /** Render-space radius of the shell, and of the ground beneath it. */
  readonly outerRadius: { value: number }
  readonly innerRadius: { value: number }
  /** Unit vector from the body toward its star, in render space. */
  readonly sunDirection: { value: Vector3 }
  /** The key light's color; the sky is scattered starlight. */
  readonly sunColour: { value: Color }
  /** The body's spin axis in render space; the oblateness is along it. */
  readonly spinAxis: { value: Vector3 }
  /** Polar radius over equatorial, 1 for a sphere. See the stretch note. */
  readonly flattening: { value: number }
  /**
   * Point the shell at one body's precomputed scattering: the recipe's
   * coefficients and the two tables baked from it. Idempotent and cheap, so
   * the host writes it every frame like every other uniform.
   */
  setScattering(
    recipe: AtmosphereRecipe,
    transmittance: Texture,
    multiScatter: Texture,
  ): void
}

/** March samples through the shell. See the budget note in the doc comment. */
const ATMOSPHERE_SAMPLES = 12

/**
 * Scattered radiance to scene units. The march produces radiance per unit
 * sun irradiance; the scene's convention absorbs a π into every surface
 * (albedo·μ *is* the drawn color), so the sky gets the same treatment plus
 * a small artistic gain — calibrated against the previous shell's tuned
 * brightness so every body arrived at the same exposure it left.
 */
const ATMOSPHERE_GAIN = 24

/** Aerosol forward-scattering asymmetry. 0.76 is Earth haze; universal here. */
const MIE_G = 0.76

/*
 * 1×1 stand-ins so a shell whose tables have not arrived runs the identical
 * graph: full transmittance and no multiple scattering, with the scattering
 * coefficients defaulting to zero — a vacuum that draws nothing, rather than
 * one frame of some other planet's sky.
 *
 * Filtered like the tables they stand in for, or the graph is not identical
 * where it counts: `DataTexture` defaults to nearest, the WGSL builder reads a
 * nearest texture with `textureLoad` and no sampler, and the baked tables are
 * linear and read with `textureSample`. Two different programs — and the one
 * the shell is first compiled with is the one it keeps, because a value swap
 * rebuilds no WGSL, so a nearest stand-in leaves the real tables read at mip
 * 0 with no interpolation between their entries. The terrain stand-in has the
 * sharper version of the same trap — see `BLANK` in `terrain.ts`.
 */
function lutPixel(r: number, g: number, b: number): DataTexture {
  const map = new DataTexture(new Uint8Array([r, g, b, 255]), 1, 1, RGBAFormat)
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
}
const LUT_WHITE = /*@__PURE__*/ lutPixel(255, 255, 255)
const LUT_BLACK = /*@__PURE__*/ lutPixel(0, 0, 0)

/**
 * The atmosphere, as the length of air a view ray actually crosses.
 *
 * The shell is a back-side sphere, so the fragment is always on its far wall and
 * the opaque planet has already depth-killed anything inside its silhouette.
 * What is left is the segment of the view ray that is inside the air, and that
 * is a ray–sphere intersection with the near end clamped to the camera:
 *
 *     near = max(t꜀ − √(Rₐ² − b²), 0)
 *     far  = the ground if the ray meets it in front, otherwise the far wall
 *
 * Clamping the near end is what makes one expression serve both cases. From
 * orbit the camera is outside and `near` is where the ray entered the air; from
 * the ground the camera is *inside* and `near` is zero, so the sky is the air
 * between the player and space rather than a whole chord they are standing in
 * the middle of. A symmetric chord — which is what this was first — reports a
 * ground observer's zenith as twice the air that is actually above them.
 *
 * **This is the LUT path the placeholder always named.** Spike 2 measured a
 * 256-sample single-scattering raymarch at **7.27 ms on an M5** against a
 * 3.0 ms budget for atmosphere *and* post, which is why the first shell was
 * analytic. What makes a march affordable now is precomputation: 12 samples,
 * each one exponential-density evaluation plus two table reads — sun
 * transmittance T(r, μs) and Hillaire's multiple-scattering Ψ(r, μs), baked
 * per body in `@inertialref/rendering` where the physics is testable in Node.
 * Twelve samples against the measured 256 is ~0.35 ms of march on the same
 * hardware, inside the budget with the post untouched.
 *
 * What the tables buy over the analytic blend is that nothing here asserts a
 * color any more: the sunset ring is the transmittance table reddening
 * low-sun light, twilight is Ψ carrying second-order light past the
 * terminator, Mars's butterscotch and its blue dusk both fall out of its
 * authored haze — the same inputs, now interpreted as physics instead of
 * paint.
 *
 * The shell composites as L + T·background — real extinction, not alpha art
 * — via premultiplied custom blending; the alpha written is the mean
 * extinction, so the night side's dark air still dims the stars behind it,
 * which a photograph agrees with.
 */
export function createAtmosphereMaterial(): AtmosphereMaterial {
  const centre = uniform(new Vector3())
  const outerRadius = uniform(1)
  const innerRadius = uniform(1)
  const sunDirection = uniform(new Vector3(0, 1, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const spinAxis = uniform(new Vector3(0, 1, 0))
  const flattening = uniform(1)

  // The recipe, as uniforms — coefficients per planet radius, matching the
  // tables' units exactly; see `atmosphereRecipe` for where they come from.
  const betaRayleigh = uniform(new Vector3(0, 0, 0))
  const mieScatter = uniform(new Vector3(0, 0, 0))
  const mieExtinction = uniform(0)
  const hRayleigh = uniform(1)
  const hMie = uniform(1)
  const transmittanceLut = texture(LUT_WHITE)
  const multiScatterLut = texture(LUT_BLACK)

  /*
   * The intersection math below assumes spheres, and a giant is not one:
   * Saturn's air follows a surface 9.8% flatter than its equator. Drawn
   * spherical anyway, the shell floats a tenth of a radius above each pole —
   * and worse, the analytic "ground" is a sphere of the *equatorial* radius,
   * so the polar sky is drawn as air over ground the oblate planet never
   * fills: a detached gray gasket around the whole limb, unmissable on
   * Jupiter and Saturn. So both endpoints are mapped into a space stretched
   * 1/flattening along the spin axis, where the ellipsoid *is* the sphere the
   * math assumes, and the mesh itself is scaled oblate to match. Path
   * lengths in stretched space run up to `flattening` short along the axis —
   * a bounded few percent, spent on air over a pole, against a shell that
   * visibly detaches from the planet.
   */
  /*
   * The whole march lives inside one `Fn`, and that is not style. `Loop` and
   * `toVar` accumulators emit *statements*, and statements only exist inside
   * a shader function's stack — built at material scope they dangle off the
   * graph, the loop is never emitted, and the accumulators stay at their
   * initial zeros. That failure compiles cleanly, logs nothing, and renders
   * a vacuum: the limb still *looked* atmospheric from orbit because the
   * surface material's aerial veil was doing all the work, and the first
   * unmistakable symptom was a black noon sky from the ground.
   */
  const sky = Fn(() => {
    const axis = normalize(spinAxis)
    const stretchGain = float(1)
      .div(max(flattening, float(1e-3)))
      .sub(1)
    // Both relative to the center already, so `centre` drops out below.
    const eyeRelative = cameraPosition.sub(centre)
    const eye = eyeRelative.add(
      axis.mul(dot(eyeRelative, axis).mul(stretchGain)),
    )
    const wallRelative = positionWorld.sub(centre)
    const wall = wallRelative.add(
      axis.mul(dot(wallRelative, axis).mul(stretchGain)),
    )

    /*
     * Planet-radius units from here down: the ground is 1, the shell top is
     * `top`. This is the one scale that survives distance compression — both
     * render radii are rescaled together whenever the LOD tier moves — and it
     * is the unit the tables were baked in, so a LUT coordinate is just an
     * altitude fraction and a cosine.
     */
    const eyeUnits = eye.div(innerRadius)
    const wallUnits = wall.div(innerRadius)
    const top = outerRadius.div(innerRadius)
    const shellHeight = max(top.sub(1), 1e-6)

    const rayDirection = normalize(wallUnits.sub(eyeUnits))
    const toCentre = eyeUnits.negate()

    // Closest approach along the ray, and the impact parameter squared.
    // `|d × c|` with d a unit vector gives the perpendicular distance directly
    // and, unlike solving the quadratic, cannot go imaginary on a grazing ray
    // — which is every ray that matters here.
    const closest = dot(toCentre, rayDirection)
    const impactSquared = max(length(cross(rayDirection, toCentre)).pow(2), 0)

    const halfOuter = sqrt(max(top.mul(top).sub(impactSquared), 0))
    const halfInner = sqrt(max(float(1).sub(impactSquared), 0))

    // Clamped at 0 so a camera already inside the air starts counting from
    // itself.
    const near = max(closest.sub(halfOuter), 0)
    // 1 when the ray passes inside the planet **ahead of the camera** — then
    // the air stops at the ground instead of continuing to the far wall. The
    // second step is load-bearing: without it, looking up from the ground
    // counts as "meets ground" because the backwards extension of the ray
    // does, and the zenith sky computes zero air.
    const meetsGround = step(impactSquared, 1).mul(step(float(0), closest))
    const far = mix(
      closest.add(halfOuter),
      max(closest.sub(halfInner), near),
      meetsGround,
    )

    /*
     * The march. Twelve midpoint samples between where the ray enters the air
     * and where it leaves it (or lands). Per sample: exponential Rayleigh and
     * aerosol densities — with the `(1 − h)` factor that takes both to exactly
     * zero at the ceiling, kept identical to the bake so the tables and the
     * march agree about where the air ends — view transmittance accumulated
     * in-loop, sun transmittance and Ψ read from the tables at (altitude,
     * sun-cosine).
     */
    const sun = normalize(sunDirection)
    const nu = dot(rayDirection, sun)
    const phaseRayleigh = float(3 / (16 * Math.PI)).mul(nu.mul(nu).add(1))
    const phaseMie = float((1 - MIE_G * MIE_G) / (4 * Math.PI)).div(
      pow(max(float(1 + MIE_G * MIE_G).sub(nu.mul(2 * MIE_G)), 1e-4), 1.5),
    )

    const stepLength = max(far.sub(near), 0).div(ATMOSPHERE_SAMPLES)
    const inscatter = vec3(0).toVar()
    const opticalDepth = vec3(0).toVar()

    Loop(ATMOSPHERE_SAMPLES, ({ i }) => {
      const t = near.add(float(i).add(0.5).mul(stepLength))
      const point = eyeUnits.add(rayDirection.mul(t))
      const radius = length(point)
      const height = max(radius.sub(1), 0)
      const height01 = saturate(height.div(shellHeight))
      const fade = oneMinus(height01)
      const densityR = exp(height.div(hRayleigh).negate()).mul(fade)
      const densityM = exp(height.div(hMie).negate()).mul(fade)

      const extinction = betaRayleigh
        .mul(densityR)
        .add(mieExtinction.mul(densityM))
      const stepTau = extinction.mul(stepLength)
      // Transmittance to the middle of this step: the half keeps the midpoint
      // rule honest about its own sample's extinction.
      const viewT = exp(opticalDepth.add(stepTau.mul(0.5)).negate())

      const muSun = dot(point, sun).div(max(radius, 1e-5))
      const lutUv = vec2(muSun.add(1).mul(0.5), height01)
      const sunT = transmittanceLut.sample(lutUv).rgb
      const psi = multiScatterLut.sample(lutUv).rgb

      const single = betaRayleigh
        .mul(densityR)
        .mul(phaseRayleigh)
        .add(mieScatter.mul(densityM).mul(phaseMie))
        .mul(sunT)
      const multiple = psi.mul(
        betaRayleigh.mul(densityR).add(mieScatter.mul(densityM)),
      )
      inscatter.addAssign(viewT.mul(single.add(multiple)).mul(stepLength))
      opticalDepth.addAssign(stepTau)
    })

    const radiance = inscatter.mul(sunColour).mul(ATMOSPHERE_GAIN)
    const survives = exp(opticalDepth.negate())
    const extinguished = oneMinus(
      survives.x.add(survives.y).add(survives.z).div(3),
    )
    return vec4(radiance, extinguished)
  })()

  const material = sensorRadiance(new MeshBasicNodeMaterial())
  material.colorNode = sky.rgb
  material.opacityNode = sky.a
  material.transparent = true
  material.depthWrite = false
  material.side = BackSide
  /*
   * Premultiplied compositing: out = L + T̄·background. The color node is
   * radiance, not radiance-divided-by-alpha, so the blend must add it whole
   * and use alpha only to extinguish what is behind — which is what
   * (One, OneMinusSrcAlpha) is. Alpha writes are (Zero, One) for the same
   * reason the starfield's are: additive passes stamping alpha into the
   * extended-range canvas is the compositor artifact `flare.ts` documents.
   */
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = OneFactor
  material.blendDst = OneMinusSrcAlphaFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor

  return {
    material,
    centre,
    outerRadius,
    innerRadius,
    sunDirection,
    sunColour,
    spinAxis,
    flattening,
    setScattering(recipe, transmittance, multiScatter) {
      betaRayleigh.value.set(...recipe.betaRayleigh)
      mieScatter.value.set(...recipe.mieScatter)
      mieExtinction.value = recipe.mieExtinction
      hRayleigh.value = recipe.hRayleigh
      hMie.value = recipe.hMie
      transmittanceLut.value = transmittance
      multiScatterLut.value = multiScatter
    },
  }
}

export interface StarfieldMaterial {
  readonly material: PointsNodeMaterial
  readonly positions: InstancedBufferAttribute
  /** Linear sRGB per star, from its blackbody temperature. */
  readonly colours: InstancedBufferAttribute
  /** Integrated illuminance in lux, before the lens collects it. */
  readonly prominence: InstancedBufferAttribute
  /** Screen size of the brightest star, in logical pixels. */
  readonly size: { value: number }
  readonly angularDensity: { value: number }
  readonly integrated: { value: number }
  readonly visibility: InstancedBufferAttribute
}

/**
 * The distant star field, as instanced sprites rather than points.
 *
 * Not a stylistic choice. **WebGPU renders point primitives at exactly one
 * pixel** and has no point-size facility at all, so `PointsNodeMaterial` on a
 * `Points` object silently ignores `sizeNode` under the WebGPU backend: the
 * field would have shrunk on the one backend this migration is for and stayed
 * correct on the WebGL fallback, which is the worst way for a rendering bug to
 * behave. three's documented answer is a `Sprite` fed by an instanced position
 * attribute, with `Sprite.count` driving the draw.
 *
 * @param capacity Instances to allocate. The buffer is written in place and only
 *   the draw count moves; reallocating per survey would rebuild the pipeline.
 */
export function createStarfieldMaterial(capacity: number): StarfieldMaterial {
  const positions = new InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  )
  const colours = new InstancedBufferAttribute(
    new Float32Array(capacity * 3),
    3,
  )
  const prominence = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  const visibility = new InstancedBufferAttribute(new Float32Array(capacity), 1)
  const integrated = uniform(0)
  const size = uniform(1.8)
  const angularDensity = uniform(1)

  // Round, with a soft edge. A star is a point source seen through an aperture,
  // and the corners of the quad fade to nothing rather than being discarded —
  // the blend is cheaper than the branch at this instance count.
  const radius = length(uv().sub(0.5)).mul(2)
  const profile = oneMinus(smoothstep(0.15, 1, radius))
  // Typed explicitly for the reason `terrain.ts` gives: the literal widens.
  const scale = instancedBufferAttribute<'float'>(prominence, 'float')

  const material = sensorRadiance(new PointsNodeMaterial())
  material.positionNode = instancedBufferAttribute(positions)
  const visible = instancedBufferAttribute<'float'>(visibility, 'float')
  material.sizeNode = integrated
    .greaterThan(0.5)
    .select(visible.mul(0.55).add(0.45).mul(3.4), size)
  material.sizeAttenuation = false
  material.colorNode = instancedBufferAttribute<'vec3'>(colours, 'vec3')
    .mul(profile.mul(profile))
    .mul(
      integrated
        .greaterThan(0.5)
        .select(
          visible.mul(1.15).add(0.45).mul(integratedSkyGain),
          scale.mul(angularDensity).div(SURFACE_LUMINANCE),
        ),
    )
  material.opacityNode = profile
  material.transparent = true
  material.depthWrite = false
  // Overlapping stars in a dense field add rather than occlude, and the Milky
  // Way's band is that addition and nothing else. Custom rather than
  // `AdditiveBlending` for the alpha factors alone: the preset adds alpha
  // (One, One) too, and twenty thousand sprites stamping alpha into the
  // extended-range canvas is the same compositing artifact the lens flare
  // wore as hard rectangles — see `flare.ts` for the full autopsy. The
  // color factors here are exactly the preset's.
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = SrcAlphaFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  return {
    material,
    positions,
    colours,
    prominence,
    visibility,
    integrated,
    size,
    angularDensity,
  }
}

/*
 * `createBodyMaterial` used to live here: one `MeshStandardNodeMaterial` and a
 * flat color per body kind. It is gone. A planet is not a rough dielectric
 * sphere — it is a photometric surface with measured maps, an ocean that glints,
 * a cloud deck at its own altitude and, in one case, rings that shadow it. See
 * `render/planet.ts`.
 */

/*
 * The streamed ground is `render/terrain.ts`, not this file. It carries its own
 * photometry rather than a standard material's, because the quadtree draws the
 * whole disk: the ground *is* the picture of the planet, and a rough dielectric
 * sphere under the scene's ambient light is not what a regolith world looks
 * like at any phase angle.
 */
