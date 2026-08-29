import {
  Color,
  DataTexture,
  MeshBasicNodeMaterial,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector3,
} from 'three/webgpu'
import {
  acos,
  atan,
  attribute,
  clamp,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  Fn,
  length,
  max,
  mix,
  mx_fractal_noise_float,
  normalize,
  normalLocal,
  oneMinus,
  min,
  positionLocal,
  pow,
  saturate,
  sign,
  smoothstep,
  sqrt,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import {
  NO_MORPH_DISTANCE,
  REFLECTANCE_CEILING,
  type SurfaceMaterial,
  type TerrainPalette,
} from '@inertialref/rendering'

/*
 * The ground's own material.
 *
 * `render/planet.ts` draws a body from a photograph. This draws one from its
 * geology, and the two have to agree at the seam where a descent crosses from
 * one to the other — which is why the photometry here is the same lunar-Lambert
 * blend, taken from the same `lunarLambert` split, rather than Three's standard
 * lighting model. A `MeshStandardNodeMaterial` under the scene's ambient light
 * was survivable while terrain was nine patches under a landing ship. It is not
 * survivable now that the quadtree draws the whole disk: the ground *is* the
 * picture of the planet, and a rough dielectric sphere is not what a regolith
 * world looks like at any phase angle.
 *
 * **Everything in this graph is in body-fixed axes.** The normal is body-fixed
 * because the geometry is; the eye arrives body-fixed because the morph already
 * needed it that way; and the sun is rotated into body-fixed axes by the host,
 * which is one quaternion on the CPU instead of a normal matrix in the shader
 * and leaves nothing in this file mixing two frames. The alternative —
 * transforming the shading normal to world space to meet a world-space sun —
 * costs the same and has one more place to be wrong.
 *
 * **What is missing from the plan's material, and why.** § 7 asks for hex-tiling
 * and triplanar projection, and both are answers to questions an *authored*
 * material set asks: hex-tiling breaks the visible period of a tiled texture and
 * triplanar chooses which way to project one onto a curved surface. The design
 * bible's "few dozen authored assets" do not exist yet, so the detail here is
 * gradient noise evaluated on the body-fixed position — which has no period to
 * break and no projection to choose. When the art budget lands, `detailField`
 * below is the seam, and both techniques come back with the textures that need
 * them.
 */

/** The uniforms the host writes each frame. */
export interface TerrainMaterial {
  readonly material: MeshBasicNodeMaterial
  /** Unit vector toward the star, **in the body's own rotating axes**. */
  readonly sunDirection: { value: Vector3 }
  readonly sunColour: { value: Color }
  readonly sunIntensity: { value: number }
  /** How much sky one display pixel subtends, radians. See `pixelAngle`. */
  setPixelAngle(radians: number): void
  /** Point the material at one body's surface appearance. Idempotent. */
  setPalette(palette: TerrainPalette, datumRadius: number): void
  /**
   * The archive's albedo map for this body, or null where there is none.
   *
   * Written every frame like every other uniform, because the loader hands back
   * a `Texture` before its pixels arrive and the graph is built once against
   * whatever the manifest says exists.
   */
  setAlbedoMap(map: Texture | null): void
}

/**
 * Ground wavelength of the coarsest detail octave, meters.
 *
 * Four kilometres, and the ceiling on it is float32 rather than taste. This
 * octave is evaluated on the *direction* — a unit vector, so it is continuous
 * over the whole body with no patch, face or level seam anywhere — and a float32
 * direction resolves about 6 × 10⁻⁸ of a radian. Asking for features finer than
 * roughly a hundred metres of ground quantizes the noise domain into visible
 * steps; three octaves down from four kilometres stops an order of magnitude
 * short of that.
 */
const MACRO_METRES = 4000

/**
 * And of the finest, evaluated on the patch-local position instead.
 *
 * Anchor-relative metres are exact — a patch anchor is subtracted in float64 on
 * the CPU, so `positionLocal` resolves to microns — but they are *patch*-local,
 * so this octave's phase jumps across a patch boundary. It is invisible for two
 * reasons and both are load-bearing: the contrast is a tenth, and the field
 * fades out entirely once a pixel covers more than a couple of wavelengths, so
 * at any distance where the boundary itself is a visible line the detail on
 * both sides of it is already gone.
 *
 * Sub-metre relief is Phase 4's, and it needs the floating-origin trick applied
 * to the noise domain rather than a finer octave here.
 */
const MICRO_METRES = 7

/** Peak-to-peak relief of the micro octave, meters. Half the canonical floor. */
const MICRO_RELIEF = 0.25

export function createTerrainMaterial(): TerrainMaterial {
  const sunDirection = uniform(new Vector3(1, 0, 0))
  const sunColour = uniform(new Color(1, 1, 1))
  const sunIntensity = uniform(1)
  const macroFrequency = uniform(1)

  /*
   * One colour and one `(roughness, grain, bump)` triple per deposit.
   *
   * The three scalars ride in a vector so that laying one deposit over another
   * is two `mix`es rather than five: whatever wins the colour has to win its
   * roughness and its grain with it, and a slope that is half regolith and half
   * bedrock genuinely is half as smooth.
   */
  const rock = deposit()
  const regolith = deposit()
  const basalt = deposit()
  const sand = deposit()
  const evaporite = deposit()
  const ice = deposit()

  const mineralLow = uniform(new Color(1, 1, 1))
  const mineralHigh = uniform(new Color(1, 1, 1))
  const freshGain = uniform(1.6)
  const lunarLambert = uniform(0.92)
  const terminator = uniform(0.05)
  const aeolian = uniform(0)
  const evaporitic = uniform(0)
  const repose = uniform(0.16)
  const maxElevation = uniform(1)
  const seaEnabled = uniform(0)
  const seaDatum = uniform(0)
  const oceanColour = uniform(new Color(0.012, 0.04, 0.13))
  const skyColour = uniform(new Color(0, 0, 0))
  const skyStrength = uniform(0)
  const sunsetTint = uniform(new Color(1, 1, 1))
  /**
   * How much of the sky one display pixel subtends, radians.
   *
   * The lens's own figure, written by the host from the same `LensView` the
   * terrain selection was made against — so the detail fades out exactly where
   * the mesh it decorates stops being refined, and a zoom moves both together.
   */
  const pixelAngle = uniform(1e-3)
  /*
   * The archive's own picture of this body, and whether there is one.
   *
   * A mapped body's ground wears its published map — the same photograph the
   * sphere behind it is drawn from — because that is the truth about its
   * large-scale albedo and no generator gets a vote
   * ([art](../../../../docs/design/art.md)). What the cover field invents in its
   * place is switched off by `mapped`: the maria, the ray systems and the
   * compositional ramp are all *in* the photograph already, and inventing a
   * second set on top of them is two disagreeing planets in one frame.
   *
   * The geometric deposits stay on both paths. A map is ten kilometres a texel
   * and knows nothing about the slope under the camera, so bedrock on a scarp
   * and frost on a north-facing floor are things only the terrain can say.
   */
  const albedoMap = texture(BLANK)
  const mapped = uniform(0)

  const eyeLocal = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => (object?.userData.eyeLocal as Vector3 | undefined) ?? ZERO,
  )
  const morphBand = uniform(new Vector2()).onObjectUpdate(
    ({ object }) =>
      (object?.userData.morphBand as Vector2 | undefined) ?? NO_MORPH,
  )
  /*
   * The patch's own anchor, which is what turns an anchor-relative vertex back
   * into a place on the body.
   *
   * float32 at planetary magnitude, and that is exactly good enough for what
   * reads it: a direction (to a twentieth of a microradian) and an altitude (to
   * an eighth of a metre on Luna). Nothing that needs metre precision goes
   * through it — the detail octave that does reads `positionLocal` directly,
   * which never leaves the patch.
   */
  const anchor = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => (object?.userData.anchor as Vector3 | undefined) ?? ZERO,
  )
  /*
   * How far the *rounded* anchor sits above the datum, meters.
   *
   * An anchor is a point on the datum sphere by construction, so this would be
   * zero — except that the uniform above is float32, and half a metre is one
   * step at Earth's radius. Measured in float64 against the same rounded
   * vector the shader receives, so `altitude` below is exact rather than
   * exact-up-to-a-per-patch-offset. A constant offset per patch is a grid of
   * rectangles across a flat sea.
   */
  const anchorAltitude = uniform(0).onObjectUpdate(
    ({ object }) => (object?.userData.anchorAltitude as number | undefined) ?? 0,
  )

  /*
   * Three varyings, and none of them may take an attribute's name.
   *
   * `varying` and `attribute` both become identifiers in the generated WGSL, so
   * a varying called `terrainCover` beside the attribute of that name is a
   * redeclaration — which surfaces as `[Invalid ShaderModule "vertex"]` with the
   * real message on a channel the page console does not carry, and a planet that
   * draws nothing at all.
   */
  const shadedNormal = varying(vec3(), 'terrainShaded')
  const localPosition = varying(vec3(), 'terrainLocal')
  const surfaceCover = varying(vec4(), 'terrainDeposit')

  const material = new MeshBasicNodeMaterial()

  /*
   * The morph, and the three things that ride along with it.
   *
   * Position and normal are Phase 1's; the cover is the material's, and it has
   * to make the same journey or every ray edge and mare margin slides by one
   * child cell across the morph band. `terrainPatch.test.ts` holds the endpoint
   * for all three: a fully morphed child *is* its parent.
   */
  material.positionNode = Fn(() => {
    const target = attribute('terrainMorph', 'vec3')
    const targetNormal = attribute('terrainMorphNormal', 'vec3')
    const cover = attribute('terrainCover', 'vec4')
    const targetCover = attribute('terrainMorphCover', 'vec4')
    const distance = length(positionLocal.sub(eyeLocal))
    // `max` on the denominator rather than a branch: a patch at level 0 has no
    // parent and arrives with both ends of its band at the same enormous
    // number, which has to read as "never morph" rather than as a divide.
    const k = saturate(
      distance
        .sub(morphBand.x)
        .div(max(morphBand.y.sub(morphBand.x), float(1))),
    )
    const moved = mix(positionLocal, target, k)
    shadedNormal.assign(normalize(mix(normalLocal, targetNormal, k)))
    localPosition.assign(moved)
    surfaceCover.assign(mix(cover, targetCover, k))
    return moved
  })()

  material.colorNode = Fn(() => {
    const local = localPosition
    const cover = surfaceCover

    /* --- where on the body this is ---------------------------------------- */

    /*
     * The outward radial — the geometric normal of the datum, which altitude,
     * latitude, the terminator and the map's own longitude are all measured
     * against — built so that it can be *differentiated*.
     *
     * `normalize(anchor + local)` is the obvious form and its value is fine.
     * Its derivative is not: at Earth's radius one float32 step is half a metre
     * and a pixel two kilometres up covers a few, so the screen-space
     * difference of that sum is a tenth noise and constant-biased per patch.
     * Everything downstream of the derivative then reads per-patch — which drew
     * the flat sea as a grid of rectangles, because the mip level the albedo map
     * was sampled at changed at every patch boundary.
     *
     * `anchor + local = |anchor| · (anchorDir + local/|anchor|)`, exactly, and
     * the direction of the right-hand side is a unit vector plus a small,
     * precise increment. The derivative below is then taken from `local` alone.
     */
    const anchorLength = max(length(anchor), float(1))
    const anchorDirection = anchor.div(anchorLength)
    const up = normalize(anchorDirection.add(local.div(anchorLength)))
    const radius = length(anchor.add(local))

    /*
     * Altitude, without subtracting two planetary radii from each other.
     *
     * `length(anchor + local) − datumRadius` is the obvious form and it is
     * unusable: both terms are 6.4 × 10⁶ on Earth, where one float32 step is
     * half a metre, so the difference arrives quantized to half a metre — inside
     * a water band four metres wide. The shoreline came out as a stair, and the
     * morph walks `local` across those steps every frame as the camera moves,
     * so the stair *crawled*. Two kilometres above an island chain that is the
     * coastline visibly warping several times a second.
     *
     * The cancellation is avoided rather than tolerated. Since
     * `|p|² − |a|² = 2(a·l) + l·l` exactly, and `|p| − |a|` is that over
     * `|p| + |a|`, the large numbers never meet: `a·l` is 6 × 10⁸ against a
     * `local` of a hundred metres, and the quotient lands within ten microns.
     * `anchorAltitude` carries the last half-metre — how far the *rounded*
     * anchor sits off the datum, measured in float64 against the same vector
     * the uniform holds.
     */
    const altitude = dot(anchor, local)
      .mul(2)
      .add(dot(local, local))
      .div(max(radius.add(anchorLength), float(1)))
      .add(anchorAltitude)
    const relief = saturate(altitude.div(max(maxElevation, float(1))))

    const normal = normalize(shadedNormal)
    // `1 − cos θ` rather than the angle: it is one dot product, it is the form
    // the angle of repose is expressed in, and it has more resolution near flat
    // — which is where every threshold in this material sits.
    const slope = saturate(oneMinus(dot(normal, up)))

    /* --- the detail field -------------------------------------------------- */

    /*
     * How much ground one pixel covers, in meters — from the lens and the
     * distance, **not** from a screen-space derivative.
     *
     * Every octave below fades out once this passes its own wavelength, which
     * is the whole of this material's anti-aliasing: a noise field sampled
     * finer than the pixel grid is white noise that crawls when the camera
     * moves, and there is no mip chain to save it because there is no texture.
     * It doubles as the fix for the one seam the micro octave has — the
     * patch-local phase jump is only visible at a distance where the octave
     * carrying it has already faded to nothing.
     *
     * `max(length(dFdx(local)), …)` is the obvious way to measure it and it is
     * wrong in a way that is invisible until you look at flat ground: `local`
     * is linear across a triangle, so its screen derivative is **constant over
     * the whole triangle** and steps at every edge. The fade then steps with
     * it, and at two kilometres up — where the far ground is coarse enough that
     * one cell covers a hundred pixels — the ground draws as flat-toned
     * quadrilaterals, each one a mesh cell wearing its own amount of detail.
     *
     * The distance to the eye is exact and continuous, the lens's pixel angle
     * is a uniform, and their product is the same number without the staircase.
     * Divided by how square-on the surface is, because a grazing pixel covers
     * far more ground than a head-on one and it is grazing pixels that alias.
     */
    const view = normalize(eyeLocal.sub(local))
    const squareOn = max(dot(normal, view).abs(), float(0.08))
    const footprint = length(eyeLocal.sub(local)).mul(pixelAngle).div(squareOn)

    const macroFade = oneMinus(
      smoothstep(float(MACRO_METRES * 0.25), float(MACRO_METRES), footprint),
    )
    const microFade = oneMinus(
      smoothstep(float(MICRO_METRES * 0.4), float(MICRO_METRES * 2), footprint),
    )

    // Direction-domain, so it is one continuous field over the whole body with
    // no patch, no cube face and no level in it.
    const macro = mx_fractal_noise_float(up.mul(macroFrequency), 3, 2, 0.5).mul(
      macroFade,
    )
    // Metres-domain, so it stays sharp at arm's length. See `MICRO_METRES`.
    const micro = mx_fractal_noise_float(
      local.mul(float(1 / MICRO_METRES)),
      2,
      2.1,
      0.55,
    ).mul(microFade)
    const detail = macro.mul(0.6).add(micro.mul(0.4))

    /* --- which deposit is here --------------------------------------------- */

    /*
     * The deposits are layered rather than weighted, and that is the physical
     * story as well as the cheaper one: bedrock is what a body is, and
     * everything else lies *on* it. A six-way normalized splat has to invent a
     * rule for what happens when three weights all say 0.4; a stack of `mix`es
     * says the ice is on top of the sand, which is true.
     */
    /*
     * How flat, twice — and both bands are **wide** on purpose.
     *
     * Every deposit here is chosen from the mesh's own normal, and the mesh is
     * a level of detail: two patches covering adjacent ground at different
     * levels genuinely report different slopes for it, by about the error the
     * selection refines to. A narrow band turns that difference into a step in
     * the material, and near-flat ground sits inside the band — measured on
     * Earth's coastal plain with `level` running from 11° to 23°, the ground
     * drew as flat-toned quadrilaterals differing by 4%, one per mesh cell.
     *
     * Widened to reach the angle of repose itself, the same LOD difference
     * moves the weight by a fraction of a percent, because near-flat ground is
     * no longer in the transition at all. It costs nothing: the deposits are
     * *about* the angle of repose, and 33° is where loose material stops
     * resting whatever it is made of.
     *
     * The real fix is for the deposits to read the canonical field rather than
     * the mesh, which means more channels on the cover and belongs with the
     * scatter that will want them.
     */
    const flat = oneMinus(smoothstep(repose.mul(0.6), repose.mul(2.2), slope))
    // A dune sea and a playa need flatter ground than a regolith mantle does.
    const level = oneMinus(smoothstep(repose.mul(0.05), repose.mul(1), slope))

    /*
     * Water is a different material, not a different colour — and it is decided
     * *before* the deposits, because two of them are nonsense underneath it.
     *
     * `groundElevation` clamps the mesh **to** the sea datum, so an ocean is
     * already flat geometry sitting at a known altitude and the test is one
     * comparison rather than a mask that has to be generated, streamed and
     * morphed. The band is two metres, which is a few times the eighth of a
     * metre float32 resolves an altitude to at planetary scale: narrower and
     * the shoreline shimmers, wider and it is a beach.
     *
     * An ocean is also the flattest and lowest ground on the body, which is the
     * evaporite's own definition — so without this gate Earth's entire sea
     * surface came out as salt flat at 2.4 times the reference, and the water
     * underneath it was a white sheet.
     */
    const water = seaEnabled.mul(
      oneMinus(smoothstep(seaDatum.sub(2), seaDatum.add(2), altitude)),
    )
    const dry = oneMinus(water)
    /*
     * Low ground, measured from the *shoreline* rather than from the datum.
     *
     * A playa is a lake bed that dried, so what makes ground low is how far it
     * is above the water — and on an ocean world the datum is not the water.
     * `seaDatum` is zero where there is no sea, which is the same expression.
     *
     * The band is narrow because a closed basin floor is a narrow thing. Half a
     * percent to five percent of the relief budget is 40 to 500 m above the
     * shoreline on Earth; taken out to a fifth of the budget instead, which was
     * the first reading of "low", every flat hectare below two and a half
     * kilometres was a salt flat and the whole planet's lowland went white.
     */
    const lowGround = oneMinus(
      smoothstep(
        seaDatum.add(maxElevation.mul(0.004)),
        seaDatum.add(maxElevation.mul(0.05)),
        altitude,
      ),
    )

    const mantled = flat
    const flooded = saturate(cover.y).mul(oneMinus(mapped))
    /*
     * A dune sea is not on the high ground: an erg is where saltating grains
     * *end up*, which is the low flat middle of a basin rather than a plateau.
     * Mars's ergs ring Hellas and the polar basins, and there is nothing on the
     * flanks of Tharsis.
     */
    const blown = saturate(
      aeolian.mul(level).mul(dry).mul(oneMinus(smoothstep(0.25, 0.7, relief))),
    )
    const dried = saturate(evaporitic.mul(level).mul(dry).mul(lowGround))
    // Volatiles last, because they condense on top of everything else.
    const frozen = saturate(cover.w)

    let colour = mix(rock.albedo, regolith.albedo, mantled)
    colour = mix(colour, basalt.albedo, flooded)
    colour = mix(colour, sand.albedo, blown)
    colour = mix(colour, evaporite.albedo, dried)
    colour = mix(colour, ice.albedo, frozen)

    let scalars = mix(rock.params, regolith.params, mantled)
    scalars = mix(scalars, basalt.params, flooded)
    scalars = mix(scalars, sand.params, blown)
    scalars = mix(scalars, evaporite.params, dried)
    scalars = mix(scalars, ice.params, frozen)

    const roughness = scalars.x
    const grain = scalars.y
    const bump = scalars.z

    /* --- what it reflects --------------------------------------------------- */

    // The invented channels, switched off where the archive has a photograph.
    const invented = oneMinus(mapped)
    // The compositional ramp, as a tint on whatever deposit won.
    const mineral = mix(mineralLow, mineralHigh, mix(float(0.5), cover.z, invented))
    /*
     * Mottling: the detail field spent on reflectance rather than on shape, and
     * nothing at all on water.
     *
     * The fine octave is patch-local, so its phase jumps at a patch boundary —
     * invisible against ground that has its own structure, and a grid of
     * rectangles across a flat sea, which has none. A wave field is not in this
     * noise and mottling an ocean with rock grain is the one thing that would
     * make it read as wet concrete.
     */
    const mottle = float(1).add(detail.mul(grain).mul(dry))
    // And the one high-contrast feature an airless world has.
    const fresh = mix(float(1), freshGain, saturate(cover.x).mul(invented))

    /*
     * The published map, sampled by direction rather than by a UV attribute.
     *
     * The layout is `SphereGeometry`'s, which is what every albedo map in the
     * archive is authored against and what `buildShapeMesh` reproduces for the
     * small bodies — so the same photograph fits the sphere and the patches in
     * front of it, and a descent does not cross a colour change.
     *
     * Sampled with **explicit gradients**, and the wrap is why. Longitude comes
     * out of an `atan2`, so it jumps by a whole turn along one meridian; the
     * value is right on both sides of that seam because the sampler repeats,
     * but the *derivative* the hardware infers there is enormous, which picks
     * the coarsest mip and draws the seam as a blurred stripe from pole to
     * pole. Wrapping the derivative into half a turn is exact everywhere except
     * a fragment that genuinely spans half the planet.
     */
    const mapUv = vec2(
      atan(up.z, up.x.negate()).mul(1 / (2 * Math.PI)),
      oneMinus(acos(clamp(up.y, -1, 1)).mul(1 / Math.PI)),
    )
    /*
     * And its gradients, analytically, from the *tangential* part of a
     * precise screen-space step.
     *
     * `d(up) = (I − up⊗up)·d(local)/|anchor|`, and the two texture axes follow
     * from differentiating the pair above: longitude gives
     * `(z·dx − x·dz)/(x² + z²)` and latitude `dy/√(1 − y²)`, sharing the same
     * denominator because `x² + z² = 1 − y²` on a unit vector.
     *
     * The wrap goes away with it. A `dFdx` of a longitude computed from an
     * `atan` jumps by a whole turn along one meridian, which selects the
     * coarsest mip and draws a blurred stripe from pole to pole; the analytic
     * form is continuous there because the *angle* is the thing that wrapped,
     * not its rate of change.
     */
    const horizontal = max(oneMinus(up.y.mul(up.y)), float(1e-8))
    const uvGradient = (
      step: ReturnType<typeof dFdx>,
    ): ReturnType<typeof vec2> => {
      const along = step.sub(up.mul(dot(step, up))).div(anchorLength)
      return vec2(
        up.z
          .mul(along.x)
          .sub(up.x.mul(along.z))
          .div(horizontal)
          .mul(1 / (2 * Math.PI)),
        along.y.div(sqrt(horizontal)).mul(1 / Math.PI),
      )
    }
    const published = mix(
      vec3(1),
      sampled(albedoMap, mapUv, uvGradient(dFdx(local)), uvGradient(dFdy(local))),
      mapped,
    )

    /*
     * The ceiling, spent once and here.
     *
     * On a mapped body the palette holds ratios rather than reflectances, so
     * bedrock arrives at 1.18 and means it — clamped at the palette's end it
     * would flatten every contrast the photograph has. What may not exceed one
     * is the product: a diffuse surface that reflects more than it receives
     * gains energy at every bounce and blows out to white while its neighbours
     * are correctly exposed.
     */
    const ground = min(
      colour.mul(published).mul(mineral).mul(mottle).mul(fresh),
      float(REFLECTANCE_CEILING),
    )

    /*
     * Not all the way to the deep-ocean colour where there is a map.
     *
     * A photograph's "ocean" is mostly bathymetry wearing water's colour, which
     * is why the open sea has to be replaced — but the banks and the reefs in it
     * are real turquoise that no depth test here can reproduce. The same 0.65
     * `render/planet.ts` keeps them with, for the same reason. On a body with no
     * map there is nothing to keep, and the replacement is total.
     */
    const surfaceAlbedo = mix(
      ground,
      oceanColour,
      water.mul(mix(float(1), float(0.65), mapped)),
    )
    // Water is smooth and rock is not; the glint below is what the roughness
    // is actually spent on.
    const surfaceRoughness = mix(roughness, float(0.06), water)

    /* --- the shading normal ------------------------------------------------- */

    /*
     * Detail relief, as a screen-space gradient of the height field.
     *
     * Mikkelsen's unparametrized bump mapping, which is what `bumpMap()` in TSL
     * does for a texture — written out here because the base normal it has to
     * perturb is the *morphed* one, in body-fixed axes, and the built-in reads
     * `normalView`. Working in body-fixed axes throughout is what keeps this
     * consistent with the rest of the graph; the algorithm needs only that the
     * position and the normal are in the same frame.
     *
     * Water gets none of it. A wave field is not in this noise, and mottling a
     * flat sea with rock grain is the one thing that would make an ocean read
     * as wet concrete.
     */
    const height = detail.mul(float(MICRO_RELIEF)).mul(bump).mul(dry)
    /*
     * The position derivatives are **not** normalized, and that is the one
     * place this departs from `bumpMap()` in TSL.
     *
     * The built-in differences a *texture*, so its `dH` is dimensionless and
     * normalizing the position derivatives is what makes the result independent
     * of the texture's scale. Here `height` is in metres, so the two halves have
     * to be measured against the same ruler: left normalized, `det` is a
     * per-triangle constant while `dH` grows with the pixel footprint, which
     * makes the bump strengthen with distance *and* step at every triangle
     * edge. At two kilometres up, with the far ground coarse enough that one
     * cell covers a hundred pixels, that draws flat-toned quadrilaterals across
     * the plain.
     *
     * Unnormalized, `det` goes as the footprint squared and so does the
     * gradient term, so the quotient is scale-free — which is what Mikkelsen's
     * derivation actually says.
     */
    const sigmaX = dFdx(local)
    const sigmaY = dFdy(local)
    const r1 = cross(sigmaY, normal)
    const r2 = cross(normal, sigmaX)
    const determinant = dot(sigmaX, r1)
    const gradient = sign(determinant).mul(
      dFdx(height).mul(r1).add(dFdy(height).mul(r2)),
    )
    const shaded = normalize(determinant.abs().mul(normal).sub(gradient))

    /* --- the light ---------------------------------------------------------- */

    const sun = normalize(sunDirection)

    /*
     * The terminator is measured against the *radial*, not the shading normal,
     * and it is widened by the body's own relief.
     *
     * A slope may face the sun on the far side of a planet and it is still on
     * the far side; letting the shading normal decide alone lights specks in
     * the dark, which is the classic artifact. But a hard geometric terminator
     * is wrong in the other direction: a peak of height `h` catches the sun
     * `√(2h/R)` of a radian past it, which on Luna's 22 km of relief is 0.16 —
     * six times the 0.025 an airless disk is drawn with. `terminator` carries
     * the wider of the two, so the lit peaks past the shadow line are the
     * terrain's own and not a soft focus over the whole limb.
     */
    const incidence = dot(up, sun)
    const daylight = smoothstep(terminator.negate(), terminator, incidence)

    // Lunar-Lambert. Lommel-Seeliger normalized so head-on gives 1, blended
    // toward Lambert by however much air there is over the surface.
    const mu0 = max(dot(shaded, sun), float(0))
    const mu = max(dot(shaded, view), float(0.05))
    // Normalized so head-on illumination and view give 1; the `sign` is a guard
    // that zeroes it where there is no light rather than a term. Identical to
    // `render/planet.ts`, because the two have to agree across the seam a
    // descent crosses.
    const lommel = mu0.div(mu0.add(mu)).mul(2)
    const photometric = mix(mu0, lommel.mul(mu0.sign()), lunarLambert)

    // Direct light reddens as the sun drops, because it is arriving through
    // hundreds of kilometers of air. Nothing on an airless world.
    const lowSun = smoothstep(float(0.35), float(0.02), incidence)
    const tint = mix(vec3(1), sunsetTint, lowSun.mul(skyStrength).mul(0.85))
    const sunlight = sunColour.mul(sunIntensity).mul(tint)

    /*
     * Skylight, which on a body with air is most of what lights a shadow — and
     * it is taken **out of** the direct beam rather than added beside it.
     *
     * That is conservation and it is also the only way the two halves of a
     * descent agree. Light scattered into the sky is light that did not arrive
     * along the sun ray, so a surface under air receives about as much in total
     * as one without it; added on top instead, the streamed ground came out 15%
     * brighter than the photograph of the same planet, measured either side of
     * the eight-pixel gate on Mars — a step at the switch, in the one place
     * this phase promises there is none.
     *
     * A hemisphere rather than a direction, so it keys off how much sky the
     * point can see — for a heightfield, how radial its normal is — and off the
     * sun still being up. The atmosphere shell in front of the terrain already
     * carries the inscatter between the camera and the ground; what it cannot
     * do is put light *on* the ground.
     */
    const diffuse = skyStrength.mul(SKY_FRACTION)
    const skyView = saturate(dot(shaded, up)).mul(0.5).add(0.5)
    const direct = surfaceAlbedo
      .mul(photometric)
      .mul(daylight)
      .mul(sunlight)
      .mul(oneMinus(diffuse))
    const ambient = skyColour
      .mul(diffuse)
      .mul(skyView)
      .mul(saturate(incidence.add(0.25)))
      .mul(sunlight)
      .add(float(AMBIENT))
    const indirect = surfaceAlbedo.mul(ambient)

    /*
     * Sun-glint on water: Fresnel, two lobes, and the *radial* rather than the
     * shaded normal.
     *
     * The same three facts `render/planet.ts` spends on an ocean seen from
     * orbit. Water reflects 2% head-on and nearly everything at grazing
     * incidence, so the glint is modest under a high sun and a blown sheet
     * toward the limb; two lobes because a single tight exponent reads as a
     * chrome ball and the wide skirt is most of what the eye calls "sea"; and
     * the radial normal because the wave field is not in any of this geometry.
     */
    const half = normalize(sun.add(view))
    const facing = max(dot(view, half), float(0))
    const fresnel = float(0.02).add(pow(oneMinus(facing), 5).mul(0.98))
    const lobe = max(dot(up, half), float(0))
    const sharpness = float(2).div(
      max(surfaceRoughness.mul(surfaceRoughness), float(1e-4)),
    )
    const glint = pow(lobe, sharpness)
      .add(pow(lobe, sharpness.div(16)).mul(0.32))
      .mul(fresnel)
      .mul(water)
      .mul(daylight)

    return direct.add(indirect).add(sunlight.mul(glint))
  })()

  return {
    material,
    sunDirection,
    sunColour,
    sunIntensity,
    setPixelAngle(radians) {
      pixelAngle.value = radians
    },
    setPalette(palette, datumRadius) {
      write(rock, palette.rock)
      write(regolith, palette.regolith)
      write(basalt, palette.basalt)
      write(sand, palette.sand)
      write(evaporite, palette.evaporite)
      write(ice, palette.ice)
      mineralLow.value.setRGB(
        palette.mineralLow.r,
        palette.mineralLow.g,
        palette.mineralLow.b,
      )
      mineralHigh.value.setRGB(
        palette.mineralHigh.r,
        palette.mineralHigh.g,
        palette.mineralHigh.b,
      )
      freshGain.value = palette.freshGain
      lunarLambert.value = palette.lunarLambert
      terminator.value = palette.terminator
      aeolian.value = palette.aeolian
      evaporitic.value = palette.evaporitic
      repose.value = palette.repose
      maxElevation.value = palette.maxElevation
      seaEnabled.value = palette.seaLevel === null ? 0 : 1
      seaDatum.value = palette.seaLevel ?? 0
      oceanColour.value.setRGB(
        palette.oceanColour.r,
        palette.oceanColour.g,
        palette.oceanColour.b,
      )
      skyColour.value.setRGB(
        palette.skyColour.r,
        palette.skyColour.g,
        palette.skyColour.b,
      )
      skyStrength.value = palette.airThickness
      sunsetTint.value.setRGB(
        palette.sunsetTint.r,
        palette.sunsetTint.g,
        palette.sunsetTint.b,
      )
      /*
       * The macro octave's frequency, in cycles per unit of the *direction*.
       *
       * A direction is dimensionless, so the wavelength has to be converted
       * through the body's own size — which is also what makes one constant
       * serve a 236 km moon and a 6,371 km planet: four kilometres of ground is
       * four kilometres of ground on both.
       */
      macroFrequency.value = (2 * Math.PI * datumRadius) / MACRO_METRES
    },
    setAlbedoMap(map) {
      albedoMap.value = map ?? BLANK
      mapped.value = map === null ? 0 : 1
    },
  }
}

/**
 * A texture read with explicit gradients, as a colour.
 *
 * `TextureNode.sample` and `.grad` each return a `TextureNode` and each are
 * *typed* as returning the base `Node`, so chaining them loses both the second
 * method and the swizzle at the end. Re-narrowed once here rather than three
 * casts at the call site.
 */
function sampled(
  map: TextureLike,
  uvNode: ReturnType<typeof vec2>,
  dx: ReturnType<typeof vec2>,
  dy: ReturnType<typeof vec2>,
): ReturnType<typeof vec3> {
  const node = map.sample(uvNode) as unknown as TextureLike
  return (node.grad(dx, dy) as unknown as TextureLike)
    .rgb as unknown as ReturnType<typeof vec3>
}

type TextureLike = ReturnType<typeof texture>

/** One deposit's uniforms: what it reflects, and how it takes the light. */
function deposit(): Deposit {
  return {
    albedo: uniform(new Color(1, 1, 1)),
    params: uniform(new Vector3(1, 0, 0)),
  }
}

interface Deposit {
  readonly albedo: ReturnType<typeof uniform<Color>>
  readonly params: ReturnType<typeof uniform<Vector3>>
}

function write(into: Deposit, from: SurfaceMaterial): void {
  into.albedo.value.setRGB(from.albedo.r, from.albedo.g, from.albedo.b)
  into.params.value.set(from.roughness, from.grain, from.bump)
}

/**
 * The floor no surface goes below, as a fraction of full illumination.
 *
 * **This one is legibility, not physics, and it is worth being clear about
 * which.** The night side of an airless body is lit by starlight and by
 * whatever else is in its sky, and both are far below this: earthshine on the
 * Moon is about 2.6 × 10⁻⁴ of sunlight — plainly visible to a dark-adapted eye
 * and nothing at all to a sensor exposed for daylight. Drawn at its own value
 * the night side is exactly black, which is true and is a hole in the frame.
 *
 * Three percent is where a night limb reads as a dark planet against darker
 * space. It is not the scene's own `ambientLight`, which this material no
 * longer sees: that one is a fill for the ship and the near-field props, and at
 * 0.16 through the old standard material it lit the night side to a tenth —
 * bright enough to flatten the terminator, which is what `SceneView` warns
 * about.
 *
 * It is scaled by how much sky the point can see, so a crater floor is darker
 * at night than the plain around it rather than a flat wash.
 */
const AMBIENT = 0.03

/**
 * How much of the light under a full atmosphere arrives from the sky rather
 * than along the sun ray, at `airThickness` 1.
 *
 * A third is the diffuse fraction of a clear terrestrial noon; it rises toward
 * one under overcast, which is a state this model does not carry. Scaled by
 * `airThickness` so Mars's 0.15 gives 5% and Luna's absent air gives none.
 */
const SKY_FRACTION = 0.33

/*
 * A one-pixel white stand-in, so a body with no map runs the identical graph.
 *
 * The alternative is a branch on whether a texture exists, which is a second
 * pipeline for the same material — and a whole-disk selection is several
 * hundred patches through one of them.
 */
const BLANK = /*@__PURE__*/ (() => {
  const map = new DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    RGBAFormat,
  )
  map.needsUpdate = true
  return map
})()

const ZERO = new Vector3()
/**
 * Both ends past any distance: a patch with no parent never morphs. The
 * selection's own finite sentinel, because `Number.MAX_VALUE` rounds to
 * Infinity in the float32 uniform and `Inf − Inf` is a NaN in the morph
 * denominator — see `NO_MORPH_DISTANCE`.
 */
const NO_MORPH = new Vector2(NO_MORPH_DISTANCE, NO_MORPH_DISTANCE)
