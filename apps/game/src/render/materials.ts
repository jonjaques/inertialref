import {
  AddEquation,
  BackSide,
  Color,
  CustomBlending,
  InstancedBufferAttribute,
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  OneFactor,
  PointsNodeMaterial,
  SrcAlphaFactor,
  Vector3,
  ZeroFactor,
} from 'three/webgpu'
import {
  abs,
  cameraPosition,
  clamp,
  cross,
  dot,
  exp,
  float,
  instancedBufferAttribute,
  length,
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
  uniform,
  uv,
  vec3,
} from 'three/tsl'

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

/** Scene-linear radiance of a star's disc, in multiples of diffuse white. */
const STAR_RADIANCE = 8

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
   * Multiplier on the disc's radiance, 1 from afar.
   *
   * The camera's stop-down when a star fills the frame. At the authored
   * radiance the whole disc clips to the tone curve's ceiling and every
   * surface feature vanishes into one white circle; a real photograph of a
   * near sun is exposed *for the sun*, which is when the granulation and the
   * limb become the picture. Driven from the star's angular radius by the
   * host — the nearest thing this renderer yet has to eye adaptation.
   */
  readonly exposure: { value: number }
}

/**
 * A star's disc: unlit, above white, limb-darkened — and alive.
 *
 * This is the material the HDR path exists for. `docs/design/art.md` makes the
 * star the scene's reference white — everything else sits below it — so its
 * radiance is authored well above 1 and the tone curve decides what a given
 * display can do with that. On the sRGB path the disc saturates, which is what
 * a star does; on the extended path it is the one thing in the frame brighter
 * than the HUD.
 *
 * Limb darkening rather than a flat disc because `I(mu)/I(1) = 1 − u(1 − mu)`
 * costs one dot product and is the difference between a light source and a hole
 * cut in the sky.
 *
 * The surface itself is two octaves of cellular convection. Worley noise *is*
 * what granulation looks like — bright cell centres draining into dark
 * intergranular lanes — and a fractal octave underneath stands in for
 * supergranulation and mottling. Drawn at a scale the eye can read rather than
 * the Sun's true one (a real granule is a thousandth of the radius, sub-pixel
 * from any orbit), and drifted slowly with presentation time so a star held in
 * frame at time warp visibly simmers. Near the limb the lanes warm toward the
 * chromosphere's orange — the same reason eclipse photographs ring the disc in
 * red — keyed to `mu` so it costs nothing at disc centre.
 */
export function createStarMaterial(): StarMaterial {
  const color = uniform(new Color(1, 1, 1))
  const time = uniform(0)
  const exposure = uniform(1)

  // `abs` because a sphere seen from inside — which happens for exactly one
  // frame if the origin rebases while a star fills the view — otherwise flips
  // `mu` negative and turns the disc black.
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

  const material = new MeshBasicNodeMaterial()
  material.colorNode = color
    .mul(limb)
    .mul(granulation.add(mottling))
    .mul(chromosphere)
    .mul(float(STAR_RADIANCE).mul(exposure))
  return { material, color, time, exposure }
}

export interface AtmosphereMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Scattering colour looking down through the air. */
  readonly zenithColour: { value: Color }
  /** Forward-scattered colour at the terminator: the sunset, from orbit. */
  readonly limbColour: { value: Color }
  /** Body centre in render space. Written every frame — the planet is orbiting. */
  readonly centre: { value: Vector3 }
  /** Render-space radius of the shell, and of the ground beneath it. */
  readonly outerRadius: { value: number }
  readonly innerRadius: { value: number }
  /** Unit vector from the body towards its star, in render space. */
  readonly sunDirection: { value: Vector3 }
  /** The haze's authored optical thickness, 0..1 with Earth at 1. */
  readonly opticalThickness: { value: number }
  /** The body's spin axis in render space; the oblateness is along it. */
  readonly spinAxis: { value: Vector3 }
  /** Polar radius over equatorial, 1 for a sphere. See the stretch note. */
  readonly flattening: { value: number }
}

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
 * Two square roots, no loop, and that is the point. Spike 2 measured a
 * 256-sample single-scattering raymarch at **7.27 ms on an M5** against a 3.0 ms
 * budget for atmosphere *and* post; a raymarch does not fit here even as the
 * only thing on screen.
 *
 * **A placeholder with a named replacement.** Uniform density is wrong — air is
 * exponential in altitude — and a path length is not scattering. The specified
 * answer is Bruneton's precomputed transmittance and multiple-scattering LUTs,
 * which spike 2 promoted from optimisation to requirement and which is M2 work.
 * What this buys meanwhile is a limb that thins towards space, a sky from the
 * ground and a terminator in the right place, all from geometry rather than
 * asserted by a constant.
 */
export function createAtmosphereMaterial(): AtmosphereMaterial {
  const centre = uniform(new Vector3())
  const outerRadius = uniform(1)
  const innerRadius = uniform(1)
  const sunDirection = uniform(new Vector3(0, 1, 0))
  const zenithColour = uniform(new Color(0.28, 0.48, 0.95))
  const limbColour = uniform(new Color(0.86, 0.45, 0.26))
  const opticalThickness = uniform(1)
  const spinAxis = uniform(new Vector3(0, 1, 0))
  const flattening = uniform(1)

  /*
   * The intersection maths below assumes spheres, and a giant is not one:
   * Saturn's air follows a surface 9.8% flatter than its equator. Drawn
   * spherical anyway, the shell floats a tenth of a radius above each pole —
   * and worse, the analytic "ground" is a sphere of the *equatorial* radius,
   * so the polar sky is drawn as air over ground the oblate planet never
   * fills: a detached grey gasket around the whole limb, unmissable on
   * Jupiter and Saturn. So both endpoints are mapped into a space stretched
   * 1/flattening along the spin axis, where the ellipsoid *is* the sphere the
   * maths assumes, and the mesh itself is scaled oblate to match. Path
   * lengths in stretched space run up to `flattening` short along the axis —
   * a bounded few percent, spent on air over a pole, against a shell that
   * visibly detaches from the planet.
   */
  const axis = normalize(spinAxis)
  const stretchGain = float(1)
    .div(max(flattening, float(1e-3)))
    .sub(1)
  // Both relative to the centre already, so `centre` drops out below.
  const eyeRelative = cameraPosition.sub(centre)
  const eye = eyeRelative.add(axis.mul(dot(eyeRelative, axis).mul(stretchGain)))
  const wallRelative = positionWorld.sub(centre)
  const wall = wallRelative.add(
    axis.mul(dot(wallRelative, axis).mul(stretchGain)),
  )

  const rayDirection = normalize(wall.sub(eye))
  const toCentre = eye.negate()

  // Closest approach along the ray, and the impact parameter squared. `|d × c|`
  // with d a unit vector gives the perpendicular distance directly and, unlike
  // solving the quadratic, cannot go imaginary on a grazing ray — which is every
  // ray that matters here.
  const closest = dot(toCentre, rayDirection)
  const impactSquared = max(length(cross(rayDirection, toCentre)).pow(2), 0)

  const halfOuter = sqrt(
    max(outerRadius.mul(outerRadius).sub(impactSquared), 0),
  )
  const halfInner = sqrt(
    max(innerRadius.mul(innerRadius).sub(impactSquared), 0),
  )

  // Clamped at 0 so a camera already inside the air starts counting from itself.
  const near = max(closest.sub(halfOuter), 0)
  // `step` rather than a branch: 1 when the ray passes inside the planet, and
  // then the air stops at the ground instead of continuing to the far wall.
  const meetsGround = step(impactSquared, innerRadius.mul(innerRadius))
  const far = mix(
    closest.add(halfOuter),
    max(closest.sub(halfInner), near),
    meetsGround,
  )
  const airDepth = max(far.sub(near), 0)

  /*
   * Exponential density, from the altitude the ray actually flies at.
   *
   * Uniform density was the placeholder's biggest lie: it drew the halo as a
   * band with a hard outer edge, when a real limb is a gradient that thins by
   * e-folds all the way to space — that gradient *is* the smoothness of every
   * orbital photograph. The density is sampled at the segment's closest
   * approach to the centre, clamped to the segment: for the halo that is the
   * graze point, and for a camera inside the shell looking up it degrades to
   * the camera's own altitude, which is the right answer in both places. The
   * fall-off constant puts ~1% of sea-level density at the authored ceiling,
   * so the shell ends by vanishing rather than by being cut.
   */
  const tClosest = clamp(closest, near, far)
  const closePoint = eye.add(rayDirection.mul(tClosest))
  const thickness = max(outerRadius.sub(innerRadius), 1e-6)
  const altitude = saturate(length(closePoint).sub(innerRadius).div(thickness))
  // The `(1 − a)` factor takes the density to exactly zero at the ceiling.
  // The exponential alone leaves e⁻⁴·⁵ ≈ 1% there, which on the HDR canvas
  // renders the shell's outer edge as a visible cut — a hard hairline ring
  // around every giant, where a real limb simply runs out of air.
  const density = exp(altitude.mul(-4.5)).mul(oneMinus(altitude))

  // Normalised against the deepest path the shell admits — grazing it at the
  // planet's edge — so a moon's wisp and a gas giant's envelope read the same,
  // and the render-space scale drops out. It has to: distance compression
  // rescales both radii together every time the LOD tier changes.
  const deepest = max(
    sqrt(
      max(outerRadius.mul(outerRadius).sub(innerRadius.mul(innerRadius)), 0),
    ).mul(2),
    1e-6,
  )
  // The 6 calibrates Earth: a grazing ray through sea-level air is opaque.
  // Everything the colour section does — whitening included — keys off this,
  // so a thin atmosphere stays translucent *and* stays its own colour: Mars's
  // butterscotch never has enough depth to scatter its way to white.
  const optical = airDepth
    .div(deepest)
    .mul(density)
    .mul(opticalThickness.mul(6))

  // Beer–Lambert, so the limb saturates smoothly rather than clipping to a hard
  // edge wherever the path runs long.
  const alpha = oneMinus(exp(optical.negate()))

  // Day/night from the middle of the air actually crossed, not from the fragment.
  // The fragment is on the far wall of the shell, a planet-diameter away from
  // the air being shaded, and using it puts the terminator on the wrong limb.
  // The midpoint degrades correctly at both ends: from orbit it is the graze
  // point, from the ground it is a few kilometres over the player's head.
  const sample = eye.add(rayDirection.mul(near.add(far).mul(0.5)))
  // Signed, not saturated: the twilight ring below needs to know how far past
  // the terminator the air is, and saturating collapsed the whole night side
  // onto one value. The sample is in stretched space and the sun direction is
  // not; the terminator this misplaces by is bounded by the flattening.
  const sunlit = dot(normalize(sample), normalize(sunDirection))
  // A wide terminator rather than a step: air scatters around the edge, which is
  // the entire reason twilight exists.
  const daylight = smoothstep(-0.35, 0.25, sunlit)

  /*
   * Colour from optical depth, standing in for the LUT with three real
   * behaviours instead of one asserted blend:
   *
   * **Thin air is the zenith colour** — single scattering, which for a clear
   * atmosphere is Rayleigh blue. **Thick air whitens** — multiple scattering
   * desaturates, which is why the base of Earth's limb is white-blue in every
   * photograph and the gradient above it runs white → blue → black. **Dense
   * air near the terminator warms to the limb colour** — the sunset ring,
   * confined to where the sun is low (|sunlit| small) *and* the path is thick,
   * which stacks the ISS dusk gradient in its published order: orange at the
   * bottom, white above it, blue on top, night above that.
   */
  const whiteness = oneMinus(exp(optical.mul(-0.7)))
  // 0.55, not more: the whitening must brighten the authored colour, not
  // replace it. At 0.75 Saturn's cream limb went chalk white.
  const bright = mix(zenithColour, vec3(1), whiteness.mul(0.55))
  const twilight = oneMinus(smoothstep(0.0, 0.4, abs(sunlit)))
  // The sunset hugs the sun's azimuth: away from it the twilight ring cools
  // back through white to blue, which is how the ISS dusk photographs run —
  // amber under the sun, steel blue at the frame's edges.
  const sunward = pow(saturate(dot(rayDirection, normalize(sunDirection))), 6)
    .mul(0.75)
    .add(0.25)
  const scattered = mix(
    bright,
    limbColour,
    twilight.mul(whiteness).mul(sunward).mul(0.95),
  )

  /*
   * Forward scattering: the glow around the star seen through the air.
   *
   * Aerosols scatter strongly ahead, so air between the camera and the star
   * brightens far beyond what it sends sideways — the reason a crescent's
   * atmosphere ring blooms around the sun's position and a sunset limb glows
   * where the sun sits behind it. A narrow phase-function stand-in, weighted
   * to the twilight band so the day side does not wear a permanent hot spot.
   */
  // Two lobes: a tight one for the glow around the star itself, and a wide
  // shoulder — real aerosol phase functions keep scattering strongly out to
  // tens of degrees — which is what stretches the ring around a crescent's
  // dark limb past the lit tips.
  const cosSun = saturate(dot(rayDirection, normalize(sunDirection)))
  const toward = pow(cosSun, 32).add(pow(cosSun, 5).mul(0.35))
  const glow = limbColour
    .mul(toward)
    .mul(whiteness)
    .mul(twilight.mul(0.75).add(0.25))

  const material = new MeshBasicNodeMaterial()
  material.colorNode = scattered
    .mul(mix(0.03, 1, daylight))
    .add(glow.mul(mix(0.1, 1, daylight)))
  material.opacityNode = alpha.mul(mix(0.12, 1, daylight))
  material.transparent = true
  material.depthWrite = false
  material.side = BackSide
  return {
    material,
    centre,
    outerRadius,
    innerRadius,
    sunDirection,
    zenithColour,
    limbColour,
    opticalThickness,
    spinAxis,
    flattening,
  }
}

export interface StarfieldMaterial {
  readonly material: PointsNodeMaterial
  readonly positions: InstancedBufferAttribute
  /** Linear sRGB per star, from its blackbody temperature. */
  readonly colours: InstancedBufferAttribute
  /**
   * How prominent each star should be, 0 to 1, computed by the host.
   *
   * Not flux. What a star looks like is its luminosity over the square of its
   * distance, and a catalogue drawn at uniform brightness looks like a
   * screensaver rather than a sky — but *linear* flux is unusable directly: the
   * apparent flux of the stars within 150 ly spans 20 magnitudes, a factor of
   * 10^8, and normalising against the brightest leaves the median star at 10^-5
   * and the sky black. The host converts flux to apparent magnitude and maps
   * that onto a perceptual ramp, which is what a magnitude scale is for. See
   * `SceneView`; the distance it needs has been thrown away by the time the
   * sprites reach the shell.
   */
  readonly prominence: InstancedBufferAttribute
  /** Screen size of the brightest star, in logical pixels. */
  readonly size: { value: number }
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
  const size = uniform(3.4)

  // Round, with a soft edge. A star is a point source seen through an aperture,
  // and the corners of the quad fade to nothing rather than being discarded —
  // the blend is cheaper than the branch at this instance count.
  const radius = length(uv().sub(0.5)).mul(2)
  const profile = oneMinus(smoothstep(0.15, 1, radius))
  const scale = instancedBufferAttribute(prominence)

  const material = new PointsNodeMaterial()
  material.positionNode = instancedBufferAttribute(positions)
  /*
   * Prominence is spent on *size* as well as intensity, and both keep a floor.
   *
   * A real star is far smaller than a pixel; what makes Sirius look bigger than
   * its neighbours is the eye's and the lens's response to a brighter point
   * source, not its angular diameter. So size carries most of the range — but
   * intensity has to carry some of it too, because a sprite that is only
   * *smaller* stops reading as fainter once it is down to a pixel.
   *
   * Neither goes to zero. The faintest star in a 40 ly sweep is 20 magnitudes
   * below the brightest; drawn to scale it would be invisible, and so would the
   * three quarters of the sky that are M dwarfs. The floors are where a real
   * sky's limiting magnitude is: past it, everything is drawn at the threshold
   * of visibility rather than not drawn at all.
   */
  material.sizeNode = size.mul(scale.mul(0.55).add(0.45))
  material.sizeAttenuation = false
  material.colorNode = instancedBufferAttribute(colours)
    .mul(profile.mul(profile))
    .mul(scale.mul(1.15).add(0.45))
  material.opacityNode = profile
  material.transparent = true
  material.depthWrite = false
  // Overlapping stars in a dense field add rather than occlude, and the Milky
  // Way's band is that addition and nothing else. Custom rather than
  // `AdditiveBlending` for the alpha factors alone: the preset adds alpha
  // (One, One) too, and twenty thousand sprites stamping alpha into the
  // extended-range canvas is the same compositing artifact the lens flare
  // wore as hard rectangles — see `flare.ts` for the full autopsy. The
  // colour factors here are exactly the preset's.
  material.blending = CustomBlending
  material.blendEquation = AddEquation
  material.blendSrc = SrcAlphaFactor
  material.blendDst = OneFactor
  material.blendEquationAlpha = AddEquation
  material.blendSrcAlpha = ZeroFactor
  material.blendDstAlpha = OneFactor
  return { material, positions, colours, prominence, size }
}

/*
 * `createBodyMaterial` used to live here: one `MeshStandardNodeMaterial` and a
 * flat colour per body kind. It is gone. A planet is not a rough dielectric
 * sphere — it is a photometric surface with measured maps, an ocean that glints,
 * a cloud deck at its own altitude and, in one case, rings that shadow it. See
 * `render/planet.ts`.
 */

/**
 * Streamed terrain.
 *
 * One material for every patch on the body, because the streamer's altitude fade
 * applies to all of them together and a material per patch is a pipeline per
 * patch. The fade stays a plain `opacity` property rather than an `opacityNode`:
 * the cost is identical and it keeps the `transparent` toggle — which an opaque
 * material would otherwise ignore — next to the number it depends on.
 */
export function createTerrainMaterial(): MeshStandardNodeMaterial {
  return new MeshStandardNodeMaterial({
    color: 0x9c8367,
    roughness: 1,
    flatShading: false,
  })
}
