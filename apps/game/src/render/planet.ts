import {
  Color,
  DataTexture,
  DoubleSide,
  LinearFilter,
  MeshBasicNodeMaterial,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three/webgpu'
import {
  cameraPosition,
  cos,
  cross,
  dot,
  exp,
  float,
  length,
  luminance,
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
  sqrt,
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
 * a hundred and thirty bodies that differ only in their uniforms and texture bindings
 * compile once. A branch per body would be twenty-eight pipelines and a visible
 * stall on arrival in the Solar System.
 *
 * ## Why the lighting is hand-written
 *
 * `MeshStandardNodeMaterial` and a point light would be less code. It would also
 * be the wrong model. A planet lit by a star at 150 million kilometers is a
 * *directional* problem, three's shadow and attenuation machinery has nothing to
 * contribute, and — the part that actually decides it — **planetary surfaces are
 * not Lambertian**. The full Moon is famously flat: no limb darkening at all,
 * because regolith backscatters. A Lambertian moon has a bright center and a
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
 * Moon looks like a disk rather than a ball.
 *
 * ## What each map contributes
 *
 * | map      | carries                                                     |
 * | -------- | ----------------------------------------------------------- |
 * | `albedo` | the surface, sRGB                                            |
 * | `normal` | tangent-space slopes in **RG**, an ocean mask in **B**       |
 * | `night`  | city lights, revealed as the terminator passes               |
 * | `clouds` | coverage in alpha, on its own shell — and its shadow, here   |
 *
 * The normal's Z is reconstructed as √(1 − x² − y²) — exact for a unit normal
 * — because the blue channel carries the ocean mask instead. The mask lived in
 * alpha once, and alpha is semantic to everything that touches an image:
 * libwebp's lossless encoder zeroes the RGB under transparent pixels, which
 * erased the whole Moon map the day the encoder went lossless. A color
 * channel is just data.
 *
 * A body with none of them still shades: the maps default to flat, and the base
 * color and albedo carry it. That is the procedural case, and it is most of the
 * galaxy.
 */

/* ------------------------------------------------------------------------- */
/* Fallbacks                                                                  */
/* ------------------------------------------------------------------------- */

function pixel(r: number, g: number, b: number, a: number): Texture {
  const data = new Uint8Array([r, g, b, a])
  const map = new DataTexture(data, 1, 1, RGBAFormat)
  // Linear, like the maps these stand in for. A nearest `DataTexture` — the
  // constructor's default — is read with `textureLoad` and no sampler, which
  // is a different program from the one a loaded map draws with, and the
  // warm-up would be compiling that one. `lutPixel` in `materials.ts` and
  // `BLANK` in `terrain.ts` say the rest.
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
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
 * `FLAT_NORMAL` is `(128, 128, 0, 255)`: zero slope in RG — the shader
 * reconstructs Z, so flat needs no blue — and blue zero because a world with
 * no ocean mask has no ocean, not an ocean everywhere.
 */
const WHITE = pixel(255, 255, 255, 255)
const BLACK = pixel(0, 0, 0, 255)
const FLAT_NORMAL = pixel(128, 128, 0, 255)
const CLEAR = pixel(255, 255, 255, 0)

export interface PlanetMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Unit vector toward the star, render space. */
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  /** The body's spin axis in render space; the normal-map frame is built on it. */
  readonly spinAxis: { value: Vector3 }
  /** Body center in render space, for the ring-shadow projection. */
  readonly centre: { value: Vector3 }
  /** Tint, and the whole surface where there is no albedo map. */
  readonly baseColour: { value: Color }
  /**
   * A multiplier on the sampled albedo, for the eye a photograph implies.
   *
   * 1 for everything the renderer draws at a distance, and for every body
   * bright enough that the scene's own exposure already suits it. `Bodies.tsx`
   * raises it only for a *dark* body *filling the frame* — see `adaptationFor`
   * there for why that is an exposure decision rather than a lie about albedo.
   */
  readonly albedoScale: { value: number }
  /** How much of the lunar-Lambert blend is Lommel-Seeliger. */
  readonly lunarLambert: { value: number }
  /** Multiplier on the normal map's horizontal gradients. */
  readonly reliefScale: { value: number }
  /**
   * How much the disk darkens toward its edge, 0..1. A deep atmosphere
   * reflects from optical depth ~1, so a grazing view sees higher, thinner,
   * darker gas: every Cassini and Hubble giant rolls off at the limb, and a
   * giant drawn without it is a flat decal. Airless photometry gets this from
   * lunar-Lambert instead, so rocky worlds leave it at 0.
   */
  readonly limbDarkening: { value: number }
  /**
   * Chroma multiplier, 1 neutral. The published giant maps are near true
   * color, which is paler than any released photograph — press images are
   * stretched, and the stretched look is what a planet "looks like" to every
   * eye that will judge this render. A quarter more chroma is the difference
   * between a cream ball and Jupiter.
   */
  readonly saturation: { value: number }
  /**
   * Equatorial jet speed in UV turns per second, 0 for solid surfaces. Real
   * magnitudes are ~1e-7: invisible at 1×, a visible shear of the bands at
   * high time warp — which is exactly how the real thing behaves.
   */
  readonly flowRate: { value: number }
  /** Presentation seconds; the band flow integrates against it. */
  readonly time: { value: number }
  /** Half-width of the terminator, in cosine of the incidence angle. */
  readonly terminator: { value: number }
  readonly nightStrength: { value: number }
  readonly specularStrength: { value: number }
  readonly specularSharpness: { value: number }
  /** Scattering color of the air, seen looking down through it. */
  readonly hazeColour: { value: Color }
  /** What the low sun turns: the sunset tint the air lends the light. */
  readonly hazeLimb: { value: Color }
  /** How much air sits over this surface. 0 disables the whole aerial term. */
  readonly hazeStrength: { value: number }
  /** What deep water looks like from orbit; the map's bathymetry is not it. */
  readonly oceanColour: { value: Color }
  /** Cloud shell height as a fraction of the body's radius. */
  readonly cloudHeight: { value: number }
  readonly cloudShadow: { value: number }
  /**
   * Ring radii in render space — the same units `positionWorld` carries —
   * because the shadow test measures the sun ray's plane-crossing against
   * them. Zero disables the shadow.
   */
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
  // Opaque white, not CLEAR: a ring with no strip is a uniform slab, and the
  // shadow term multiplies by the sampled alpha — a clear fallback would
  // silently disable the shadow for every mapless ring. Ringless bodies are
  // already excluded by `ringOpacity` and zero radii.
  const ringMap = texture(WHITE)

  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const spinAxis = uniform(new Vector3(0, 1, 0))
  const centre = uniform(new Vector3())
  const baseColour = uniform(new Color(1, 1, 1))
  const albedoScale = uniform(1)
  const lunarLambert = uniform(0.9)
  const reliefScale = uniform(1)
  const limbDarkening = uniform(0)
  const saturation = uniform(1)
  const flowRate = uniform(0)
  const time = uniform(0)
  const terminator = uniform(0.02)
  const nightStrength = uniform(1)
  const specularStrength = uniform(0)
  const specularSharpness = uniform(420)
  const hazeColour = uniform(new Color(0.28, 0.48, 0.95))
  const hazeLimb = uniform(new Color(0.92, 0.42, 0.2))
  const hazeStrength = uniform(0)
  // Open-ocean reflectance in linear sRGB — a few percent, blue. Measured off
  // the mid-Pacific in orbital photographs, not off the albedo map, whose
  // "ocean" is bathymetry data wearing water's color.
  const oceanColour = uniform(new Color(0.012, 0.04, 0.13))
  const cloudHeight = uniform(0)
  const cloudShadow = uniform(0)
  const ringInner = uniform(0)
  const ringOuter = uniform(0)
  const ringOpacity = uniform(0)

  const surfaceUv = uv()

  /*
   * Differential rotation, as a UV shear.
   *
   * A giant has no surface; its "map" is weather, and the weather moves. The
   * equatorial jet leads and the higher-latitude jets alternate — the cosine
   * stands in for the measured zonal wind profile — so under time warp the
   * bands genuinely shear past each other instead of turning as a shell.
   * `flowRate` carries the real magnitude, which keeps this honest: nothing
   * visibly moves in real time, exactly as nothing visibly does.
   */
  const latitude = surfaceUv.y.sub(0.5).mul(Math.PI)
  const jets = cos(latitude.mul(8)).mul(0.6).add(0.4)
  const flowUv = vec2(
    surfaceUv.x.add(time.mul(flowRate).mul(jets)),
    surfaceUv.y,
  )

  /* --- the surface frame -------------------------------------------------- */

  // The geometric normal: the sphere's, not the map's. Every *shadowing*
  // decision uses this one, because a mountain on the night side is still on the
  // night side — letting a normal-mapped slope catch the sun across the
  // terminator produces lit specks floating in the dark, which is the classic
  // normal-map-on-a-planet artifact.
  const geometric = normalize(normalWorld)
  const axis = normalize(spinAxis)

  // Geographic north at this point: the spin axis with its radial part removed.
  // Degenerate exactly at the poles, where the map is degenerate too.
  const north = normalize(axis.sub(geometric.mul(dot(axis, geometric))))
  // Right-handed (east, north, up): east × north = up.
  const east = cross(north, geometric)

  // Slopes from RG; Z reconstructed, because B is the ocean mask (see header).
  const tangentSlope = normalMap.xy.mul(2).sub(1)
  const tangentUp = sqrt(
    max(
      oneMinus(
        tangentSlope.x
          .mul(tangentSlope.x)
          .add(tangentSlope.y.mul(tangentSlope.y)),
      ),
      float(0),
    ),
  )
  const shaded = normalize(
    east
      .mul(tangentSlope.x.mul(reliefScale))
      .add(north.mul(tangentSlope.y.mul(reliefScale)))
      .add(geometric.mul(tangentUp)),
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
   * photographed rather than modeled — those bands move with the season and no
   * amount of surface detail substitutes for them.
   */
  const radial = positionWorld.sub(centre)
  const heightAbovePlane = dot(radial, axis)
  const alongAxis = dot(light, axis)
  // Away from zero, or a ray parallel to the ring plane divides by nothing.
  // Not `sign()`, whose value at exactly zero is zero — precisely the input
  // the clamp exists to survive.
  const alongAxisSign = float(1).sub(step(alongAxis, float(0)).mul(2))
  const safeAlongAxis = max(alongAxis.abs(), float(1e-4)).mul(alongAxisSign)
  const toPlane = heightAbovePlane.div(safeAlongAxis).negate()
  const crossing = radial.add(light.mul(toPlane))
  const crossingRadius = length(crossing)
  const throughRing = step(ringInner, crossingRadius)
    .mul(step(crossingRadius, ringOuter))
    // Only when the plane is toward the star, not behind us.
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
   * of a cloud stretches toward the terminator instead of sitting under it.
   * Converting the offset to texture coordinates needs the cosine of the
   * latitude, because a meter of longitude is worth more near the poles.
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
  // Lommel-Seeliger, normalized so that head-on illumination and view give 1.
  const lommelSeeliger = mu0.div(mu0.add(mu)).mul(2)
  const photometric = mix(mu0, lommelSeeliger.mul(mu0.sign()), lunarLambert)

  /*
   * The light itself reddens as the sun drops. A surface near the terminator
   * is lit through hundreds of kilometers of air that has scattered the blue
   * away, which is why every orbital photograph puts an amber band along the
   * dawn and dusk lines — the ground there is lit by sunset. Keyed to the
   * geometric incidence, because it is the sun's altitude that decides the
   * path length, not the slope of any hill; and scaled by how much air the
   * body has, because the Moon's terminator is gray to the end.
   */
  const lowSun = smoothstep(float(0.35), float(0.02), incidence)
  const lightTint = mix(vec3(1), hazeLimb, lowSun.mul(hazeStrength).mul(0.85))
  const sunlight = sunColour.mul(sunIntensity).mul(lightTint)
  const lit = daylight.mul(ringShade).mul(cloudShade)

  /*
   * Water and land are different materials, not different colors.
   *
   * The mask rides in the normal map's blue. Where it says water, the map's
   * color is mostly *bathymetry* — the sea floor, which no photograph from
   * orbit shows — so the albedo is pulled toward a uniform deep-ocean blue.
   * Fully replacing it would erase the real shallow-water turquoise on the
   * banks and reefs, which photographs do show; 0.65 keeps them.
   */
  const ocean = normalMap.b
  const surfaceAlbedo = albedoMap
    .sample(flowUv)
    .rgb.mul(baseColour)
    .mul(albedoScale)
  // Chroma about the sample's own luminance; past 1 the mix extrapolates,
  // which is what a saturation boost is.
  const rich = mix(vec3(luminance(surfaceAlbedo)), surfaceAlbedo, saturation)
  const albedo = mix(rich, oceanColour, ocean.mul(0.65))

  // See `limbDarkening` on the interface. The exponent is gentle because the
  // aerial veil re-brightens the last few degrees on top of this.
  const facingView = max(dot(geometric, view), float(0.02))
  const limbShade = mix(float(1), pow(facingView, 0.55), limbDarkening)

  const diffuse = albedo.mul(photometric).mul(sunlight).mul(lit).mul(limbShade)

  /*
   * Sun-glint, on water only: the star mirrored in the wave field.
   *
   * Three facts carry it. **Fresnel**: water reflects 2% head-on and nearly
   * everything at grazing incidence, so the glint is modest under a high sun
   * and becomes a blown white-gold sheet toward the limb and the terminator —
   * which is exactly where the photographs put it. **Two lobes**: wave slopes
   * spread the reflection into a bright core inside a wide skirt; a single
   * tight exponent reads as a chrome ball, and the skirt is most of what the
   * eye recognizes as "sea". **The geometric normal**: the normal map is
   * ten-kilometer topography, and the wave field is not in any map at this
   * resolution.
   *
   * The gain sets the core near diffuse white under a high sun and lets the
   * grazing case run well past 1 — that is what the HDR headroom is for, and
   * the tone curve's shoulder is what keeps it from clipping to a disk.
   */
  const half = normalize(light.add(view))
  const facing = max(dot(view, half), float(0))
  const fresnel = float(0.02).add(pow(oneMinus(facing), 5).mul(0.98))
  const lobe = max(dot(geometric, half), float(0))
  const glint = pow(lobe, specularSharpness)
    .add(pow(lobe, specularSharpness.div(16)).mul(0.32))
    .mul(fresnel)
    .mul(float(60))
    .mul(ocean)
    .mul(specularStrength)
    .mul(lit)

  /*
   * Aerial perspective: the disk seen through its own air.
   *
   * The atmosphere shell only survives the depth test outside the planet's
   * silhouette, so everything the air does *in front of* the ground has to
   * happen here. This is the term that turns a map wrapped on a sphere into a
   * planet photographed through weather: a faint blue lift at nadir growing
   * into a white-blue wash at the limb, warmed wherever the sun is low. The
   * airmass is the flat-atmosphere 1/μ approximation from both directions —
   * light in, view out — which is wrong past ~85° and clamped there, where the
   * shell's halo takes over anyway.
   */
  const airmass = float(1)
    .div(max(mu, float(0.09)))
    .add(float(1).div(max(dot(geometric, light), float(0.09))))
    .mul(0.5)
  const veil = oneMinus(exp(airmass.mul(-0.15)))
    .mul(hazeStrength)
    .mul(smoothstep(float(-0.06), float(0.28), incidence))
    .mul(ringShade)
  const veilColour = mix(hazeColour, vec3(1), veil.mul(0.55)).mul(
    sunColour.mul(sunIntensity).mul(lightTint),
  )

  const surfaceLight = diffuse.add(sunlight.mul(glint))
  // 0.68, not higher: at 0.8 the whole disk went milky and the ocean lost
  // its depth — the photographs keep a saturated blue mid-disk under the veil.
  const shadedSurface = mix(surfaceLight, veilColour, veil.mul(0.68))

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
    // And one under a hundred kilometers of slant air is dimmed by it.
    .mul(oneMinus(veil.mul(0.6)))

  const material = new MeshBasicNodeMaterial()
  material.colorNode = shadedSurface.add(night)

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
    limbDarkening,
    saturation,
    flowRate,
    time,
    terminator,
    nightStrength,
    specularStrength,
    specularSharpness,
    hazeColour,
    hazeLimb,
    hazeStrength,
    oceanColour,
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
      ringMap.value = maps.ring ?? WHITE
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
  /** Tint for a deck with no map — Titan's, and every procedural world's. */
  readonly baseColour: { value: Color }
  /** What the low sun turns the deck: the body's sunset color. */
  readonly sunsetColour: { value: Color }
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
  // Opaque white, not CLEAR: opacity comes from the sampled alpha, so a clear
  // fallback renders a mapless deck — Titan's, which the data declares opaque
  // — at zero opacity, an invisible shell updated every frame for nothing.
  const map = texture(WHITE)
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const opacity = uniform(1)
  const drift = uniform(0)
  const baseColour = uniform(new Color(1, 1, 1))
  const sunsetColour = uniform(new Color(1, 0.55, 0.28))

  const surfaceUv = uv()
  const drifted = vec2(surfaceUv.x.add(drift), surfaceUv.y)
  const cover = map.sample(drifted)

  const normal = normalize(normalWorld)
  const light = normalize(sunDirection)
  const incidence = dot(normal, light)
  // A wider terminator than the ground's: cloud tops are ten kilometers up and
  // stay in sunlight after the surface below them has not.
  const daylight = smoothstep(float(-0.22), float(0.12), incidence)

  /*
   * Clouds catch the sunset before anything else does. They are the highest
   * thing on the planet and stay lit — by reddened, nearly horizontal light —
   * after the ground under them has gone dark, which is why the amber band in
   * every orbital dusk photograph is drawn on the weather, not the ground.
   * The old shading floor of 0.15 is cut to 0.04: it existed to keep night
   * clouds legible and instead laid a gray film over the whole night side.
   */
  const glow = mix(
    vec3(1),
    sunsetColour,
    smoothstep(float(0.3), float(0.0), incidence),
  )

  const material = new MeshBasicNodeMaterial()
  material.colorNode = cover.rgb
    .mul(baseColour)
    .mul(sunColour)
    .mul(sunIntensity)
    .mul(glow)
    .mul(max(incidence, float(0)).mul(0.96).add(0.04))
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
    baseColour,
    sunsetColour,
    setTexture(value) {
      map.value = value ?? WHITE
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
  /** Center of the body that casts a shadow on the ring, render space. */
  readonly centre: { value: Vector3 }
  /**
   * That body's drawn radius in render space — the cylinder test runs on
   * `positionWorld`, so mesh-local units would never eclipse anything.
   */
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
  // Opaque white, not CLEAR: the optical thickness is `opticalDepth · band.a`,
  // so a clear fallback zeroes the thickness and a mapless ring — every
  // procedural giant's, and Jupiter's, Uranus's and Neptune's — renders fully
  // transparent. White makes it a uniform slab whose density comes from
  // `opticalDepth` and whose color comes from `baseColour`.
  const map = texture(WHITE)
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
  // seam that any UV parameterisation of a disk has to put somewhere.
  const radius = length(vec2(positionLocal.x, positionLocal.z))
  const across = saturate(
    radius.sub(innerFraction).div(max(oneMinus(innerFraction), float(1e-3))),
  )
  const band = map.sample(vec2(across, 0.5))

  const normal = normalize(normalWorld)
  const view = normalize(cameraPosition.sub(positionWorld))
  const light = normalize(sunDirection)

  // Which face of the slab is toward the star, and which toward the camera.
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
   * one brightens as the geometry closes toward edge-on, because the line of
   * sight crosses more particles; and the whole thing dims toward zero as the
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
      map.value = value ?? WHITE
    },
  }
}
