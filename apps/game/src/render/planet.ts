import {
  Color,
  DataTexture,
  DoubleSide,
  MeshBasicNodeMaterial,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three/webgpu'
import {
  cameraPosition,
  cross,
  dot,
  exp,
  float,
  length,
  max,
  min,
  mix,
  normalize,
  normalWorld,
  oneMinus,
  pow,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl'
import type { BodyTextures } from './planetTextures.ts'

/*
 * A planet, shaded from its own photometry.
 *
 * Everything here is one node graph with per-body uniforms, which matters more
 * than it looks: the WebGPU backend keys pipelines on generated source, so
 * twenty-eight bodies that differ only in their uniforms and texture bindings
 * compile once. A branch per body would be twenty-eight pipelines and a visible
 * stall on arrival in the Solar System.
 *
 * ## Why the lighting is hand-written
 *
 * `MeshStandardNodeMaterial` and a point light would be less code. It would also
 * be the wrong model. A planet lit by a star at 150 million kilometres is a
 * *directional* problem, three's shadow and attenuation machinery has nothing to
 * contribute, and — the part that actually decides it — **planetary surfaces are
 * not Lambertian**. The full Moon is famously flat: no limb darkening at all,
 * because regolith backscatters. A Lambertian moon has a bright centre and a
 * dark rim, which is what every naive renderer produces and what nobody has ever
 * photographed.
 *
 * So the diffuse term is the **lunar-Lambert** function planetary scientists
 * actually use — a blend of Lambert and Lommel-Seeliger, weighted per body:
 *
 *     I = albedo · μ₀ · [ (1 − k)  +  k · 2/(μ₀ + μ) ]
 *
 * At `k = 0` that is Lambert, which is right for a thick atmosphere. At `k → 1`
 * it is Lommel-Seeliger, which is right for airless regolith and is why the
 * Moon looks like a disc rather than a ball.
 *
 * ## What each map contributes
 *
 * | map      | carries                                                     |
 * | -------- | ----------------------------------------------------------- |
 * | `albedo` | the surface, sRGB                                            |
 * | `normal` | tangent-space normals, with an ocean mask in **alpha**       |
 * | `night`  | city lights, revealed as the terminator passes               |
 * | `clouds` | coverage in alpha, on its own shell — and its shadow, here   |
 *
 * A body with none of them still shades: the maps default to flat, and the base
 * colour and albedo carry it. That is the procedural case, and it is most of the
 * galaxy.
 */

/* ------------------------------------------------------------------------- */
/* Fallbacks                                                                  */
/* ------------------------------------------------------------------------- */

function pixel(r: number, g: number, b: number, a: number): Texture {
  const data = new Uint8Array([r, g, b, a])
  const map = new DataTexture(data, 1, 1, RGBAFormat)
  map.needsUpdate = true
  return map
}

/*
 * One-texel stand-ins, so that a body with no maps runs the identical graph.
 *
 * The alternative is a second material without the sampling, which is a second
 * pipeline and a second thing to keep correct. A 1×1 texture costs one cache hit
 * per fragment and nothing else.
 *
 * `FLAT_NORMAL` is `(128, 128, 255, 0)`: straight up in tangent space, and alpha
 * zero because a world with no ocean mask has no ocean, not an ocean everywhere.
 */
const WHITE = pixel(255, 255, 255, 255)
const BLACK = pixel(0, 0, 0, 255)
const FLAT_NORMAL = pixel(128, 128, 255, 0)
const CLEAR = pixel(255, 255, 255, 0)

export interface PlanetMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Unit vector towards the star, render space. */
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  /** The body's spin axis in render space; the normal-map frame is built on it. */
  readonly spinAxis: { value: Vector3 }
  /** Body centre in render space, for the ring-shadow projection. */
  readonly centre: { value: Vector3 }
  /** Tint, and the whole surface where there is no albedo map. */
  readonly baseColour: { value: Color }
  readonly albedoScale: { value: number }
  /** How much of the lunar-Lambert blend is Lommel-Seeliger. */
  readonly lunarLambert: { value: number }
  /** Multiplier on the normal map's horizontal gradients. */
  readonly reliefScale: { value: number }
  /** Half-width of the terminator, in cosine of the incidence angle. */
  readonly terminator: { value: number }
  readonly nightStrength: { value: number }
  readonly specularStrength: { value: number }
  readonly specularSharpness: { value: number }
  /** Cloud shell height as a fraction of the body's radius. */
  readonly cloudHeight: { value: number }
  readonly cloudShadow: { value: number }
  /** Ring radii as multiples of the drawn radius. Zero disables the shadow. */
  readonly ringInner: { value: number }
  readonly ringOuter: { value: number }
  readonly ringOpacity: { value: number }
  setTextures(maps: BodyTextures): void
}

/**
 * Build the surface material for one body.
 *
 * Textures may be `null` and may still be downloading — `TextureLoader` hands
 * back the object before the image arrives — so the graph is built once against
 * whatever the manifest says exists and the pixels appear when they appear.
 */
export function createPlanetMaterial(): PlanetMaterial {
  const albedoMap = texture(WHITE)
  const normalMap = texture(FLAT_NORMAL)
  const nightMap = texture(BLACK)
  const cloudMap = texture(CLEAR)
  const ringMap = texture(CLEAR)

  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const spinAxis = uniform(new Vector3(0, 1, 0))
  const centre = uniform(new Vector3())
  const baseColour = uniform(new Color(1, 1, 1))
  const albedoScale = uniform(1)
  const lunarLambert = uniform(0.9)
  const reliefScale = uniform(1)
  const terminator = uniform(0.02)
  const nightStrength = uniform(1)
  const specularStrength = uniform(0)
  const specularSharpness = uniform(900)
  const cloudHeight = uniform(0)
  const cloudShadow = uniform(0)
  const ringInner = uniform(0)
  const ringOuter = uniform(0)
  const ringOpacity = uniform(0)

  const surfaceUv = uv()

  /* --- the surface frame -------------------------------------------------- */

  // The geometric normal: the sphere's, not the map's. Every *shadowing*
  // decision uses this one, because a mountain on the night side is still on the
  // night side — letting a normal-mapped slope catch the sun across the
  // terminator produces lit specks floating in the dark, which is the classic
  // normal-map-on-a-planet artefact.
  const geometric = normalize(normalWorld)
  const axis = normalize(spinAxis)

  // Geographic north at this point: the spin axis with its radial part removed.
  // Degenerate exactly at the poles, where the map is degenerate too.
  const north = normalize(axis.sub(geometric.mul(dot(axis, geometric))))
  // Right-handed (east, north, up): east × north = up.
  const east = cross(north, geometric)

  const tangentNormal = normalMap.xyz.mul(2).sub(1)
  const shaded = normalize(
    east
      .mul(tangentNormal.x.mul(reliefScale))
      .add(north.mul(tangentNormal.y.mul(reliefScale)))
      .add(geometric.mul(tangentNormal.z)),
  )

  const view = normalize(cameraPosition.sub(positionWorld))
  const light = normalize(sunDirection)

  /* --- shadowing ---------------------------------------------------------- */

  const incidence = dot(geometric, light)
  const daylight = smoothstep(terminator.negate(), terminator, incidence)

  /*
   * The rings' shadow on the planet.
   *
   * Follow the sun ray from this point until it crosses the equatorial plane; if
   * it lands between the ring radii, the ring is between here and the star.
   * Exact, three dot products, and it is the thing that makes Saturn look
   * photographed rather than modelled — those bands move with the season and no
   * amount of surface detail substitutes for them.
   */
  const radial = positionWorld.sub(centre)
  const heightAbovePlane = dot(radial, axis)
  const alongAxis = dot(light, axis)
  // Away from zero, or a ray parallel to the ring plane divides by nothing.
  const safeAlongAxis = max(alongAxis.abs(), float(1e-4)).mul(alongAxis.sign())
  const toPlane = heightAbovePlane.div(safeAlongAxis).negate()
  const crossing = radial.add(light.mul(toPlane))
  const crossingRadius = length(crossing)
  const throughRing = step(ringInner, crossingRadius)
    .mul(step(crossingRadius, ringOuter))
    // Only when the plane is towards the star, not behind us.
    .mul(step(float(0), toPlane))
  const ringSpan = max(ringOuter.sub(ringInner), float(1e-4))
  const ringSample = ringMap.sample(
    vec2(crossingRadius.sub(ringInner).div(ringSpan), 0.5),
  )
  const ringShade = oneMinus(
    throughRing.mul(ringSample.a).mul(ringOpacity).mul(0.92),
  )

  /*
   * The cloud deck's shadow, from the deck drawn on its own shell above.
   *
   * The sun ray reaches this point after crossing the cloud layer some distance
   * away, and that distance grows as the sun gets low — which is why the shadow
   * of a cloud stretches towards the terminator instead of sitting under it.
   * Converting the offset to texture coordinates needs the cosine of the
   * latitude, because a metre of longitude is worth more near the poles.
   */
  const upwards = max(dot(geometric, light), float(0.12))
  const reach = cloudHeight.div(upwards)
  const cosLatitude = max(sin(surfaceUv.y.mul(Math.PI)), float(0.15))
  const shadowUv = vec2(
    surfaceUv.x.sub(
      dot(light, east)
        .mul(reach)
        .div(cosLatitude.mul(2 * Math.PI)),
    ),
    surfaceUv.y.add(dot(light, north).mul(reach).div(Math.PI)),
  )
  const cloudCover = cloudMap.sample(shadowUv).a
  const cloudShade = oneMinus(cloudCover.mul(cloudShadow))

  /* --- the photometric function ------------------------------------------- */

  const mu0 = max(dot(shaded, light), float(0))
  const mu = max(dot(shaded, view), float(0.05))
  // Lommel-Seeliger, normalised so that head-on illumination and view give 1.
  const lommelSeeliger = mu0.div(mu0.add(mu)).mul(2)
  const photometric = mix(mu0, lommelSeeliger.mul(mu0.sign()), lunarLambert)

  const albedo = albedoMap.rgb.mul(baseColour).mul(albedoScale)
  const sunlight = sunColour.mul(sunIntensity)
  const lit = daylight.mul(ringShade).mul(cloudShade)

  const diffuse = albedo.mul(photometric).mul(sunlight).mul(lit)

  /*
   * Sun-glint, on water only.
   *
   * The ocean mask rides in the normal map's alpha, so this costs no extra
   * sample. The half-vector uses the *geometric* normal rather than the shaded
   * one: the normal map describes ten-kilometre topography, and the thing that
   * makes a specular highlight on an ocean is the wave field, which is not in
   * any map at this resolution.
   */
  const ocean = normalMap.a
  const half = normalize(light.add(view))
  const glint = pow(max(dot(geometric, half), float(0)), specularSharpness)
    .mul(ocean)
    .mul(specularStrength)
    .mul(lit)

  /*
   * Night lights, revealed slightly *before* the terminator.
   *
   * Cities are visible in late twilight from orbit, and starting the ramp just
   * on the lit side is what stops them switching on like a light bulb. The band
   * is asymmetric for the same reason twilight is.
   */
  const night = nightMap.rgb
    .mul(smoothstep(float(0.05), float(-0.14), incidence))
    .mul(nightStrength)
    // A city under cloud is not visible from orbit.
    .mul(oneMinus(cloudCover.mul(0.85)))

  const material = new MeshBasicNodeMaterial()
  material.colorNode = diffuse.add(sunlight.mul(glint)).add(night)

  const handle: PlanetMaterial = {
    material,
    sunDirection,
    sunColour,
    sunIntensity,
    spinAxis,
    centre,
    baseColour,
    albedoScale,
    lunarLambert,
    reliefScale,
    terminator,
    nightStrength,
    specularStrength,
    specularSharpness,
    cloudHeight,
    cloudShadow,
    ringInner,
    ringOuter,
    ringOpacity,
    setTextures(maps) {
      albedoMap.value = maps.albedo ?? WHITE
      normalMap.value = maps.normal ?? FLAT_NORMAL
      nightMap.value = maps.night ?? BLACK
      cloudMap.value = maps.clouds ?? CLEAR
      ringMap.value = maps.ring ?? CLEAR
    },
  }
  return handle
}

/* ------------------------------------------------------------------------- */
/* Clouds                                                                     */
/* ------------------------------------------------------------------------- */

export interface CloudMaterial {
  readonly material: MeshBasicNodeMaterial
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  readonly opacity: { value: number }
  /** Longitude offset in turns; the deck rotates against the surface. */
  readonly drift: { value: number }
  setTexture(map: Texture | null): void
}

/**
 * The cloud shell: a slightly larger sphere, lit and transparent.
 *
 * Its own mesh rather than a layer composited into the surface, because it has
 * to be *above* the surface — it casts a shadow down, it catches light at the
 * terminator after the ground has gone dark, and it turns at its own rate.
 * Venus's atmosphere laps its surface every sixty days.
 *
 * Lambertian, not lunar-Lambert: a cloud top is the closest thing in nature to
 * a perfect diffuser, which is exactly what the regolith model is a correction
 * *away* from.
 */
export function createCloudMaterial(): CloudMaterial {
  const map = texture(CLEAR)
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const opacity = uniform(1)
  const drift = uniform(0)

  const surfaceUv = uv()
  const drifted = vec2(surfaceUv.x.add(drift), surfaceUv.y)
  const cover = map.sample(drifted)

  const normal = normalize(normalWorld)
  const light = normalize(sunDirection)
  const incidence = dot(normal, light)
  // A wider terminator than the ground's: cloud tops are ten kilometres up and
  // stay in sunlight after the surface below them has not.
  const daylight = smoothstep(float(-0.22), float(0.12), incidence)

  const material = new MeshBasicNodeMaterial()
  material.colorNode = cover.rgb
    .mul(sunColour)
    .mul(sunIntensity)
    .mul(max(incidence, float(0)).mul(0.85).add(0.15))
    .mul(daylight)
  material.opacityNode = cover.a.mul(opacity).mul(daylight)
  material.transparent = true
  material.depthWrite = false

  return {
    material,
    sunDirection,
    sunColour,
    sunIntensity,
    opacity,
    drift,
    setTexture(value) {
      map.value = value ?? CLEAR
    },
  }
}

/* ------------------------------------------------------------------------- */
/* Rings                                                                      */
/* ------------------------------------------------------------------------- */

export interface RingMaterial {
  readonly material: MeshBasicNodeMaterial
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  /** Ring radii as a fraction of the mesh's own extent, 0..1. */
  readonly innerFraction: { value: number }
  /** Centre of the body that casts a shadow on the ring, render space. */
  readonly centre: { value: Vector3 }
  /** That body's drawn radius, in the ring mesh's own units. */
  readonly bodyRadius: { value: number }
  readonly opticalDepth: { value: number }
  /** Tint for a ring with no map — a procedural giant's. */
  readonly baseColour: { value: Color }
  setTexture(map: Texture | null): void
}

/**
 * A ring system, as a slab of ice seen from one side or the other.
 *
 * Three things have to be right or it reads as a decal:
 *
 * **The planet's shadow falls on it.** A cylinder test along the sun direction:
 * the ring is dark where the body is between it and the star, and the shadow's
 * edge sweeping across the rings is one of the sights of the Solar System.
 *
 * **The lit and unlit faces are different pictures.** Looking at the sunward
 * face you see backscatter — the rings are bright and the dense B ring is
 * brightest. Looking at the shadowed face you see *transmission*, so the dense
 * parts go dark and the thin ones glow, and the whole thing inverts. Cassini
 * spent thirteen years photographing both.
 *
 * **They are radially structured and azimuthally uniform.** So the map is a
 * strip, sampled by radius, and the mesh is 512 segments around because a ring
 * seen edge-on is a straight line and any faceting shows.
 */
export function createRingMaterial(): RingMaterial {
  const map = texture(CLEAR)
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const innerFraction = uniform(0.5)
  const centre = uniform(new Vector3())
  const bodyRadius = uniform(0.4)
  const opticalDepth = uniform(0.7)
  const baseColour = uniform(new Color(1, 1, 1))

  // The geometry is an annulus in its own XZ plane with an outer radius of 1, so
  // the radial coordinate is available without a UV channel — and without the
  // seam that any UV parameterisation of a disc has to put somewhere.
  const radius = length(vec2(positionLocal.x, positionLocal.z))
  const across = saturate(
    radius.sub(innerFraction).div(max(oneMinus(innerFraction), float(1e-3))),
  )
  const band = map.sample(vec2(across, 0.5))

  const normal = normalize(normalWorld)
  const view = normalize(cameraPosition.sub(positionWorld))
  const light = normalize(sunDirection)

  // Which face of the slab is towards the star, and which towards the camera.
  const lightSide = dot(normal, light)
  const viewSide = dot(normal, view)
  const sameSide = step(float(0), lightSide.mul(viewSide))

  /*
   * Single scattering through a slab of ice.
   *
   * The standard planetary-rings result, and it is worth using rather than a
   * Lambert stand-in because it gets three things right at once that otherwise
   * need three separate hacks:
   *
   *     I/F = (ω₀/4) · μ₀/(μ₀ + μ) · [1 − e^(−τ(1/μ₀ + 1/μ))]
   *
   * A dense ring saturates rather than growing brighter without limit; a thin
   * one brightens as the geometry closes towards edge-on, because the line of
   * sight crosses more particles; and the whole thing dims towards zero as the
   * rings turn edge-on to the *sun*, which is the seasonal cycle that took
   * Cassini seven years to watch once.
   *
   * `ω₀ = 0.6` is water ice. The gain that follows is the I/F convention's
   * factor of π, which is what turns a reflectance into something the tone
   * mapper can treat like every other surface in the scene.
   */
  const opticalThickness = opticalDepth.mul(band.a)
  const muLight = max(lightSide.abs(), float(0.03))
  const muView = max(viewSide.abs(), float(0.02))
  const crossings = opticalThickness.mul(
    float(1).div(muLight).add(float(1).div(muView)),
  )
  const single = float(0.6 / 4)
    .mul(muLight.div(muLight.add(muView)))
    .mul(oneMinus(exp(crossings.negate())))
    .mul(Math.PI)

  // Opacity is what the line of sight actually blocks, which is the same slab
  // seen from the camera and nothing to do with the star.
  const opaque = oneMinus(exp(opticalThickness.div(muView).negate()))

  /*
   * Backscatter from the lit face, transmission through the unlit one.
   *
   * Looking at the sunward face you see reflected light, and the dense B ring is
   * the brightest thing there. Cross the ring plane and you are looking at light
   * that came *through* — so the dense parts go dark and the thin ones glow, and
   * the whole picture inverts. Warm, because ice passes red more readily than
   * blue. Cassini spent thirteen years photographing both.
   */
  const backscatter = band.rgb.mul(single)
  const transmitted = band.rgb
    .mul(vec3(1.0, 0.86, 0.68))
    .mul(exp(opticalThickness.div(muLight).negate()))
    .mul(0.6)

  /*
   * The planet's shadow on its own rings.
   *
   * A cylinder test: the point is eclipsed when it lies behind the body along
   * the sun direction and within a body radius of that line. The soft edge is
   * the Sun's angular diameter doing what it does — from Saturn the penumbra is
   * narrow but it is not a step, and a hard edge is the single most obvious tell
   * that a shadow was computed rather than cast.
   */
  const ringRadial = positionWorld.sub(centre)
  const alongSun = dot(ringRadial, light)
  const offAxis = length(ringRadial.sub(light.mul(alongSun)))
  const eclipsed = step(alongSun, float(0)).mul(
    oneMinus(smoothstep(bodyRadius.mul(0.97), bodyRadius.mul(1.03), offAxis)),
  )
  const sunlit = oneMinus(eclipsed)

  const material = new MeshBasicNodeMaterial()
  material.colorNode = mix(transmitted, backscatter, sameSide)
    .mul(baseColour)
    .mul(sunColour)
    .mul(sunIntensity)
    .mul(sunlit)
  material.opacityNode = min(opaque, float(1))
  material.transparent = true
  material.depthWrite = false
  material.side = DoubleSide

  return {
    material,
    sunDirection,
    sunColour,
    sunIntensity,
    innerFraction,
    centre,
    bodyRadius,
    opticalDepth,
    baseColour,
    setTexture(value) {
      map.value = value ?? CLEAR
    },
  }
}
