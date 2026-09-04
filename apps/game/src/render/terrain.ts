import {
  Color,
  DataTexture,
  LinearFilter,
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
  exp,
  float,
  Fn,
  If,
  length,
  max,
  mix,
  normalize,
  normalLocal,
  oneMinus,
  min,
  positionLocal,
  pow,
  saturate,
  smoothstep,
  sqrt,
  texture,
  uniform,
  varying,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import type { LinearRgb } from '@inertialref/universe'
import {
  OPEN_OCEAN,
  REFLECTANCE_CEILING,
  type SurfaceMaterial,
  type TerrainPalette,
} from '@inertialref/rendering'
import { asVector, bumped, fbmFetch, noiseSampler } from './noiseNodes.ts'
import { NOISE_CELLS, noiseTexture } from './noiseTexture.ts'
import { groundWearOf } from './wear.ts'
import {
  DEFAULT_SURFACE_QUALITY,
  groundBandsFor,
  type GroundDetail,
} from './quality.ts'

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
  setAlbedoMap(map: Texture | null, hasMap: boolean): void
  /**
   * The ground's slice of the surface-quality lever — the sea's goes to
   * `WaterMaterial`, the rocks' to the scatter. Compares before it writes.
   */
  setQuality(ground: GroundDetail): void
  /**
   * Bake mode: 0 draws the ground, 1 writes its reflectance, 2 writes the
   * sphere's normal-map record — the slopes east and north in RG and the sea
   * mask in B. On for the orbital bake's twelve draws and back to 0 before
   * the frame's own.
   */
  setBakeMode(mode: 0 | 1 | 2): void
}

/**
 * Ground wavelength of the coarsest detail octave, meters.
 *
 * Four kilometers, and the ceiling on it is float32 rather than taste. This
 * octave is evaluated on the *direction* — a unit vector, so it is continuous
 * over the whole body with no patch, face or level seam anywhere — and a float32
 * direction resolves about 6 × 10⁻⁸ of a radian. Asking for features finer than
 * roughly a hundred meters of ground quantizes the noise domain into visible
 * steps; three octaves down from four kilometers stops an order of magnitude
 * short of that.
 */
const MACRO_METRES = 4000

/**
 * And of the middle octave, evaluated on the patch-local position instead.
 *
 * Anchor-relative meters are exact — a patch anchor is subtracted in float64 on
 * the CPU, so `positionLocal` resolves to microns — but they are *patch*-local,
 * so this octave's phase jumps across a patch boundary. It is invisible for two
 * reasons and both are load-bearing: the contrast is a tenth, and the field
 * fades out entirely once a pixel covers more than a couple of wavelengths, so
 * at any distance where the boundary itself is a visible line the detail on
 * both sides of it is already gone.
 */
const MICRO_METRES = 7

/** Peak-to-peak relief of the micro octave, meters. Half the canonical floor. */
const MICRO_RELIEF = 0.25

/**
 * Ground wavelength of the coarsest **grain** octave, meters.
 *
 * The band below the mesh. A patch at the detail floor is 0.35 to 1.41 m a cell
 * across the zoo, and standing at two meters one of those cells is two hundred
 * display pixels across — so everything between a cell and a pixel is this
 * band's, and there was nothing there: the ground under the camera drew as a
 * smooth swell with `MICRO_METRES`'s seven-meter octave on it and no texture at
 * all.
 *
 * Seventy centimeters down to nine, at a slope of about fifteen degrees, which
 * is what lunar regolith measures at centimeter baselines.
 */
export const GRAIN_METRES = 0.7

/** Octaves of it. Two reaches 17 cm; the third, at 9 cm, was a fetch a pixel over the whole near ground for a band the chop under it already carries. */
const GRAIN_OCTAVES = 2

/** Peak-to-peak relief of the coarsest grain octave, meters. */
const GRAIN_RELIEF = 0.035

/**
 * How many grain wavelengths the field repeats over.
 *
 * The whole point of this band is that its domain is **continuous across a
 * patch boundary**, which `positionLocal` is not: two patches have different
 * anchors, so a noise on the patch-local position jumps phase at every edge —
 * invisible at seven meters of wavelength and a straight line across the ground
 * at seventy centimeters. The obvious fix is the *body-fixed* position, and that
 * is worse: `anchor + local` is 1.7 × 10⁶ on Luna where float32 resolves 0.1 m,
 * which quantizes a nine-centimeter octave out of existence.
 *
 * So the domain is the body-fixed position **reduced modulo this period on the
 * CPU, in float64**, and the noise is periodic over it. Two patches whose
 * anchors differ by any amount agree exactly wherever they overlap, because both
 * evaluate the same periodic function of the same reduced coordinate — and the
 * coordinate stays under 45 m, where float32 resolves microns.
 *
 * `NOISE_CELLS`, because every octave has to close on the texture's period:
 * octave `i` has `32 · 2ⁱ` wavelengths in it, a whole number for both. The
 * repeat is 22.4 m of ground — a few periods across the frame at the distance
 * the band survives to from a standing stance, more from a hover, and the
 * grain is under the swell and the macro band there.
 */
export const GRAIN_PERIOD = NOISE_CELLS

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
  const seabed = deposit()
  const pigment = deposit()

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
  const oceanColour = uniform(
    new Color(OPEN_OCEAN.r, OPEN_OCEAN.g, OPEN_OCEAN.b),
  )
  /*
   * Whether the sea is a sheet over this ground or a colour painted on it.
   *
   * One where `WaterPatches` draws the datum as a surface of its own, and the
   * ground under it is a seabed; zero where there is no sheet — a mapped body
   * — and the flat clamped ground wears the water's colour.
   */
  const seaSheet = uniform(0)
  const liquidGlow = uniform(new Color(0, 0, 0))
  /*
   * The surface-quality lever, as the count of detail bands that run:
   * two is the macro and micro octaves with the grain, one the macro alone,
   * zero none. A uniform rather than a build option so the setting takes
   * effect on the next frame, and a *branch* on it rather than a multiply
   * by zero, because a noise multiplied by zero is a noise evaluated — and
   * the evaluation is the cost this exists to remove.
   */
  const detailBands = uniform(groundBandsFor(DEFAULT_SURFACE_QUALITY.ground))
  /*
   * Bake mode: the graph answers "what does this ground reflect, and is it
   * sea" instead of "what colour is this pixel". One graph rather than a
   * second material, so the sphere's picture of a body and the ground's are
   * the same deposits, the same tints and the same rivers by construction —
   * the one way the seam rule can hold for a bake without a second copy of
   * the stack to keep in step.
   */
  const bakeMode = uniform(0)
  const skyColour = uniform(new Color(0, 0, 0))
  const hazeColour = uniform(new Color(0, 0, 0))
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
   * The geometric deposits stay on both paths. A map is ten kilometers a texel
   * and knows nothing about the slope under the camera, so bedrock on a scarp
   * and frost on a north-facing floor are things only the terrain can say.
   */
  const albedoMap = texture(BLANK)
  const mapped = uniform(0)
  // The baked noise every detail octave is a fetch of. See `noiseTexture.ts`.
  const noise = noiseSampler(noiseTexture())

  /*
   * The per-mesh inputs, read off what the mesh wears — one record, one key,
   * dressed by `groundWear.ts`. See `wear.ts` for what each is and why the
   * anchor arrives rounded with its altitude measured against that rounding.
   */
  const eyeLocal = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => groundWearOf(object).eyeLocal,
  )
  const morphBand = uniform(new Vector2()).onObjectUpdate(
    ({ object }) => groundWearOf(object).morphBand,
  )
  /*
   * The patch's own anchor, which is what turns an anchor-relative vertex back
   * into a place on the body.
   *
   * float32 at planetary magnitude, and that is exactly good enough for what
   * reads it: a direction (to a twentieth of a microradian) and an altitude (to
   * an eighth of a meter on Luna). Nothing that needs meter precision goes
   * through it — the detail octave that does reads `positionLocal` directly,
   * which never leaves the patch.
   */
  const anchor = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => groundWearOf(object).anchor,
  )
  /*
   * How far the *rounded* anchor sits above the datum, meters, so `altitude`
   * below is exact rather than exact-up-to-a-per-patch-offset.
   */
  const anchorAltitude = uniform(0).onObjectUpdate(
    ({ object }) => groundWearOf(object).anchorAltitude,
  )
  /*
   * The patch anchor reduced modulo the grain period, in grain wavelengths.
   *
   * Handed over already small, which is the whole trick: added to
   * `positionLocal` it gives a coordinate that is continuous across every
   * patch boundary *and* exact, where the body-fixed position is continuous
   * and quantized and the patch-local one is exact and discontinuous. See
   * `GRAIN_PERIOD`.
   */
  const grainOrigin = uniform(new Vector3()).onObjectUpdate(
    ({ object }) => groundWearOf(object).grainOrigin,
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
  const surfaceCover2 = varying(vec4(), 'terrainDeposit2')

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
    const cover2 = attribute('terrainCover2', 'vec4')
    const targetCover2 = attribute('terrainMorphCover2', 'vec4')
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
    surfaceCover2.assign(mix(cover2, targetCover2, k))
    return moved
  })()

  material.colorNode = Fn(() => {
    const local = localPosition
    const cover = surfaceCover
    const cover2 = surfaceCover2

    /* --- where on the body this is ---------------------------------------- */

    /*
     * The outward radial — the geometric normal of the datum, which altitude,
     * latitude, the terminator and the map's own longitude are all measured
     * against — built so that it can be *differentiated*.
     *
     * `normalize(anchor + local)` is the obvious form and its value is fine.
     * Its derivative is not: at Earth's radius one float32 step is half a meter
     * and a pixel two kilometers up covers a few, so the screen-space
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
     * half a meter, so the difference arrives quantized to half a meter — inside
     * a water band four meters wide. The shoreline came out as a stair, and the
     * morph walks `local` across those steps every frame as the camera moves,
     * so the stair *crawled*. Two kilometers above an island chain that is the
     * coastline visibly warping several times a second.
     *
     * The cancellation is avoided rather than tolerated. Since
     * `|p|² − |a|² = 2(a·l) + l·l` exactly, and `|p| − |a|` is that over
     * `|p| + |a|`, the large numbers never meet: `a·l` is 6 × 10⁸ against a
     * `local` of a hundred meters, and the quotient lands within ten microns.
     * `anchorAltitude` carries the last half-meter — how far the *rounded*
     * anchor sits off the datum, measured in float64 against the same vector
     * the uniform holds.
     */
    const altitude = dot(anchor, local)
      .mul(2)
      .add(dot(local, local))
      .div(max(radius.add(anchorLength), float(1)))
      .add(anchorAltitude)
    const relief = saturate(altitude.div(max(maxElevation, float(1))))

    /*
     * How much of this body the generator gets to invent.
     *
     * Zero where the archive has a photograph. Everything below that is a claim
     * the map already makes — the maria, the ray systems, the compositional
     * ramp, and where the water is — is multiplied by it, because a second set
     * on top of the first is two disagreeing planets in one frame.
     */
    const invented = oneMinus(mapped)

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
     * it, and at two kilometers up — where the far ground is coarse enough that
     * one cell covers a hundred pixels — the ground draws as flat-toned
     * quadrilaterals, each one a mesh cell wearing its own amount of detail.
     *
     * The distance to the eye is exact and continuous, the lens's pixel angle
     * is a uniform, and their product is the same number without the staircase.
     * Divided by how square-on the surface is, because a grazing pixel covers
     * far more ground than a head-on one and it is grazing pixels that alias.
     */
    const toEye = eyeLocal.sub(local)
    const view = normalize(toEye)
    const squareOn = max(dot(normal, view).abs(), float(0.08))
    const footprint = length(toEye).mul(pixelAngle).div(squareOn)

    const macroFade = oneMinus(
      smoothstep(float(MACRO_METRES * 0.25), float(MACRO_METRES), footprint),
    )
    const microFade = oneMinus(
      smoothstep(float(MICRO_METRES * 0.4), float(MICRO_METRES * 2), footprint),
    )

    /*
     * Each octave runs only where it is worth anything: inside a branch on
     * its own fade as well as on the quality lever. Past its fade an octave
     * multiplies out to zero, and a zero that cost a Perlin evaluation per
     * pixel is most of what a whole-screen ground costs at a retina size —
     * the far ground, which is most of the frame from any height, pays for
     * none of the micro or the grain this way.
     */
    // Direction-domain, so it is one continuous field over the whole body with
    // no patch, no cube face and no level in it.
    /*
     * Each field is a value and a gradient — `x` and `yzw` of the fetch —
     * and the gradient is carried in meters per meter along the body-fixed
     * axes: the direction-domain band's slope over `|anchor|`, because a
     * step of one meter on the ground is `1/|anchor|` of a unit direction;
     * the meter-domain bands' over their own wavelengths.
     */
    const macro = vec4(0).toVar()
    If(detailBands.greaterThan(0.5).and(macroFade.greaterThan(0)), () => {
      const field = fbmFetch(noise, asVector(up.mul(macroFrequency)), 2)
      macro.assign(
        vec4(field.x, field.yzw.mul(macroFrequency).div(anchorLength)).mul(
          macroFade,
        ),
      )
    })
    // Meters-domain, so it stays sharp at arm's length. See `MICRO_METRES`.
    const micro = vec4(0).toVar()
    If(detailBands.greaterThan(1.5).and(microFade.greaterThan(0)), () => {
      const field = fbmFetch(
        noise,
        asVector(local.mul(float(1 / MICRO_METRES))),
        1,
      )
      micro.assign(
        vec4(field.x, field.yzw.mul(float(1 / MICRO_METRES))).mul(microFade),
      )
    })
    const detail = macro.x.mul(0.6).add(micro.x.mul(0.4))
    const detailSlope = macro.yzw.mul(0.6).add(micro.yzw.mul(0.4))

    /*
     * And the grain: the band between a mesh cell and a pixel.
     *
     * Its own fade, its own domain and its own amplitude, so it is a separate
     * term from `detail` rather than two more octaves of it — `detail` is spent
     * on reflectance as well as on shape, and mottling an ocean or a dust plain
     * at nine centimeters is not the same decision as bumping it.
     */
    const grainFade = oneMinus(
      smoothstep(
        float(GRAIN_METRES * 0.3),
        float(GRAIN_METRES * 1.5),
        footprint,
      ),
    )
    const grit = vec4(0).toVar()
    If(detailBands.greaterThan(1.5).and(grainFade.greaterThan(0)), () => {
      const field = fbmFetch(
        noise,
        asVector(grainOrigin.add(local.mul(float(1 / GRAIN_METRES)))),
        GRAIN_OCTAVES,
      )
      grit.assign(
        vec4(field.x, field.yzw.mul(float(1 / GRAIN_METRES))).mul(grainFade),
      )
    })

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
    const mantled = oneMinus(
      smoothstep(repose.mul(0.6), repose.mul(2.2), slope),
    )
    // A dune sea and a playa need flatter ground than a regolith mantle does.
    const level = oneMinus(smoothstep(repose.mul(0.05), repose.mul(1), slope))

    /*
     * Water is a different material, not a different colour — and it is decided
     * *before* the deposits, because two of them are nonsense underneath it.
     *
     * `groundElevation` clamps the mesh **to** the sea datum, so an ocean is
     * already flat geometry sitting at a known altitude and the test is one
     * comparison rather than a mask that has to be generated, streamed and
     * morphed. The band is four meters, which is a few times the eighth of a
     * meter float32 resolves an altitude to at planetary scale: narrower and
     * the shoreline shimmers, wider and it is a beach.
     *
     * **It runs upward from the datum, not across it, and that follows from the
     * clamp.** No vertex is ever below the sea, so a band centred on the datum
     * has half of itself in ground that does not exist and the sea sits on its
     * midpoint: `water` saturates at 0.5, `dry` never falls below 0.5, and every
     * gate below that spends `dry` is half-open over open ocean — the mottle and
     * the bump the comments here say a sea must not have, and the salt flat the
     * next paragraph says this gate removes, all at half strength.
     *
     * An ocean is also the flattest and lowest ground on the body, which is the
     * evaporite's own definition — so without this gate Earth's entire sea
     * surface came out as salt flat at 2.4 times the reference, and the water
     * underneath it was a white sheet.
     *
     * **And it is `invented`, so a mapped body has none of it.** The generated
     * field and the archive's photograph disagree about where Earth's land is —
     * the terrain carve-out is exactly that they are two different sources and
     * only one of them has been ingested — so painting deep ocean wherever the
     * *generated* sea datum says water goes puts open sea over the map's
     * continents. Measured either side of the eight-pixel gate it was 48% of
     * the drawn value, and the picture was a blue planet with the coastlines in
     * the wrong places. Where a photograph exists it wins, which is the same
     * rule the maria and the ray systems already follow.
     */
    const flat = seaEnabled
      .mul(invented)
      .mul(oneMinus(smoothstep(seaDatum, seaDatum.add(4), altitude)))
    /*
     * Under a sheet the ground here is the *seabed* and is drawn as one: a
     * shelf that shows through the water. The painted water survives only
     * where there is no sheet. The rivers are the cover's `wet` channel and
     * are painted whichever way the sea is drawn, because a river is a few
     * hundred meters wide and a sheet of its own would be a mesh per valley.
     */
    const submerged = flat.mul(seaSheet)
    const river = saturate(cover2.x).mul(invented)
    const water = max(flat.mul(oneMinus(seaSheet)), river)
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
     * kilometers was a salt flat and the whole planet's lowland went white.
     */
    const lowGround = oneMinus(
      smoothstep(
        seaDatum.add(maxElevation.mul(0.004)),
        seaDatum.add(maxElevation.mul(0.05)),
        altitude,
      ),
    )

    const flooded = saturate(cover.y).mul(invented)
    /*
     * A dune sea is not on the high ground: an erg is where saltating grains
     * *end up*, which is the low flat middle of a basin rather than a plateau.
     * Mars's ergs ring Hellas and the polar basins, and there is nothing on the
     * flanks of Tharsis.
     */
    const blown = saturate(
      aeolian
        .mul(level)
        .mul(dry)
        .mul(oneMinus(smoothstep(0.25, 0.7, relief))),
    )
    const dried = saturate(evaporitic.mul(level).mul(dry).mul(lowGround))
    /*
     * Volatiles last, because they condense on top of everything else — and
     * subject to the same repose rule as the regolith under them.
     *
     * Without `flat` this is the outermost mix in both stacks at a weight of
     * exactly one on every mapless icy moon: `iceCover`'s shell term saturates
     * at a bulk density of 1,680, which is Mimas, Enceladus, Tethys, Dione,
     * Rhea, Iapetus, Miranda, Ariel, Umbriel, Titania and Oberon. Eleven bodies
     * whose bedrock, regolith and basalt were all mixed out, and with them the
     * whole slope path — so the one thing that makes a crater wall read as a
     * crater wall could never appear on any of them, and they drew as featureless
     * white. Frost slides off a steep slope exactly as dust does, so it takes
     * the same `mantled` weight the regolith does.
     */
    const frozen = saturate(cover.w).mul(mantled)
    /*
     * The seabed under a sheet, and the growth over the land.
     *
     * The seabed goes on after the wind-blown and evaporite deposits and
     * before the ice, because a shelf is sorted fines whatever the shore
     * beside it is made of, and frost lies on a frozen sea's floor as it does
     * on anything. The pigment goes on *before* the ice and after every
     * mineral deposit: a biosphere covers whatever soil it grows in, and the
     * cap covers the biosphere. It is thinned on steep ground with the
     * regolith it roots in — bare rock at the angle of repose is bare.
     */
    const seafloor = submerged.mul(
      smoothstep(seaDatum.sub(maxElevation.mul(0.12)), seaDatum, altitude),
    )
    const grown = saturate(cover2.y).mul(invented).mul(dry).mul(mantled)

    let colour = mix(rock.albedo, regolith.albedo, mantled)
    colour = mix(colour, basalt.albedo, flooded)
    colour = mix(colour, sand.albedo, blown)
    colour = mix(colour, evaporite.albedo, dried)
    colour = mix(colour, seabed.albedo, seafloor)
    colour = mix(colour, pigment.albedo, grown)
    colour = mix(colour, ice.albedo, frozen)

    let scalars = mix(rock.params, regolith.params, mantled)
    scalars = mix(scalars, basalt.params, flooded)
    scalars = mix(scalars, sand.params, blown)
    scalars = mix(scalars, evaporite.params, dried)
    scalars = mix(scalars, seabed.params, seafloor)
    scalars = mix(scalars, pigment.params, grown)
    scalars = mix(scalars, ice.params, frozen)

    const roughness = scalars.x
    const grain = scalars.y
    const bump = scalars.z

    /* --- what it reflects --------------------------------------------------- */

    /*
     * The compositional ramp, as a tint on whatever deposit won — and *white*
     * where a photograph already carries the composition.
     *
     * Neutralized at the tint rather than at the ramp position, which is the
     * distinction that matters here. The ramp's ends are deliberately asymmetric
     * — `{0.9, 0.93, 1.02}` against `{1.1, 1.04, 0.93}` — so its midpoint is
     * `{1, 0.985, 0.975}` rather than white, and pinning `cover.z` to 0.5 on a
     * mapped body multiplies the archive's photograph by a fixed warm tint
     * 1.25% down in luminance that `render/planet.ts` does not carry. That is a
     * step at the eight-pixel gate of the same order as the 1.7% the deposit
     * gain was tuned to reach, and in the one place this phase promises none.
     */
    const mineral = mix(mix(mineralLow, mineralHigh, cover.z), vec3(1), mapped)
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
    // Sampled only on a mapped body. The stand-in is one white texel, and a
    // fetch with explicit gradients is legal inside a branch — but it is
    // still a fetch, on every pixel of every mapless world.
    const published = vec3(1).toVar()
    If(mapped.greaterThan(0.5), () => {
      published.assign(
        sampled(
          albedoMap,
          mapUv,
          uvGradient(dFdx(local)),
          uvGradient(dFdy(local)),
        ),
      )
    })

    /*
     * The ceiling, spent once and here.
     *
     * On a mapped body the palette holds multipliers on a photograph rather
     * than reflectances, so clamping at the palette's end would clamp the
     * multiplier and flatten every contrast the photograph has. What may not
     * exceed one is the product: a surface that reflects more than it receives
     * gains energy at every bounce and blows out to white while its neighbours
     * are correctly exposed.
     */
    const raw = colour.mul(published).mul(mineral).mul(mottle).mul(fresh)
    /*
     * Ceilinged by the brightest channel, so the whole colour scales together.
     *
     * A per-channel `min` is the obvious form and it does not clamp a colour,
     * it *rotates* one: an evaporite whose red is over the ceiling and whose
     * blue is not comes back with its red clipped and its blue untouched, so
     * the hue slides toward grey exactly where the surface is brightest. The
     * palette's reference ceiling keeps bedrock, regolith and basalt under the
     * line by construction; the deposits above the brightest one a body can
     * reach — an evaporite at 1.9 of the reference, on the ten Saturnian and
     * Uranian moons where it lands at 1.42 — are what this catches.
     */
    const peak = max(max(raw.r, raw.g), raw.b)
    const ground = raw.mul(
      min(float(1), float(REFLECTANCE_CEILING).div(max(peak, float(1e-4)))),
    )

    /*
     * The painted water's colour. Open sea — where there is no sheet — is
     * the liquid's deep colour; a river is a few meters deep and shows its
     * bed through the water, so the channel is the bed tinted rather than
     * the deep colour laid on.
     */
    const riverColour = mix(ground.mul(0.55), oceanColour.mul(2.2), float(0.6))
    const surfaceAlbedo = mix(
      mix(ground, oceanColour, water),
      riverColour,
      river.mul(seaSheet.add(oneMinus(seaEnabled))),
    )
    // Water is smooth and rock is not; the glint below is what the roughness
    // is actually spent on.
    const surfaceRoughness = mix(roughness, float(0.06), water)
    // A magma river is its own light; the sea sheet carries the glow for the
    // sea, and the painted water carries it for the channels.
    const emission = liquidGlow.mul(water)

    /* --- the shading normal ------------------------------------------------- */

    /*
     * Detail relief, as the height field's own gradient.
     *
     * The fields carry their slopes, so the shading normal is the mesh normal
     * tilted by the tangential part of the summed slope — no screen-space
     * derivative anywhere in it. Differencing the height across pixels is
     * the form the texture cannot take: a trilinear fetch is piecewise linear, so its screen difference
     * is constant across a texel and the texel grid shows through the shading
     * as a crease at arm's length. The analytic gradient is smooth where the
     * value is only continuous.
     *
     * Water gets none of it. A wave field is not in this noise, and mottling
     * a flat sea with rock grain is the one thing that would make an ocean
     * read as wet concrete.
     */
    const slopeOfDetail = detailSlope
      .mul(float(MICRO_RELIEF))
      .add(grit.yzw.mul(float(GRAIN_RELIEF)))
      .mul(bump)
      .mul(dry)
    const shaded = bumped(asVector(normal), asVector(slopeOfDetail))

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
      // Through `skyView` as well, and not beside it: a floor added after the
      // hemisphere term is a flat wash, which is the one thing `AMBIENT` says
      // it is not. A crater floor sees half the sky a plain does.
      .add(skyView.mul(float(AMBIENT)))
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

    /*
     * Aerial perspective: the ground seen through its own air.
     *
     * The atmosphere shell in front of the terrain is a back-side sphere, so it
     * only survives the depth test **outside** the planet's silhouette —
     * everything the air does between the camera and the ground has to happen
     * here, which is the same reason `render/planet.ts` carries this term for
     * the disk. Identical arithmetic, because the two are the same body and the
     * gate between them is one pixel of relief: without it the streamed ground
     * came out 48% darker and far more saturated than the photograph it
     * replaces, at 900 km over Earth.
     *
     * The airmass is the flat-atmosphere 1/μ from both directions — light in,
     * view out — clamped where it stops being true and the shell's halo takes
     * over anyway.
     */
    /*
     * The view leg is the shorter of two paths, because the flat-atmosphere
     * `1/μ` is a statement about looking down from space and says something
     * absurd from a standing camera: the ground forty meters away, seen at
     * five degrees, is not behind eleven atmospheres of air. The air between
     * a point and the eye is at most the distance between them over the
     * scale height, and that term takes over exactly where the orbital one
     * stops being true — below the gate, at the ground, where the seam the
     * disk shares has no say. `AIR_SCALE_HEIGHT` is Earth's; the haze's own
     * thickness already scales the whole veil.
     */
    const viewLeg = min(
      float(1).div(max(mu, float(0.09))),
      length(toEye).div(float(AIR_SCALE_HEIGHT)),
    )
    const airmass = viewLeg
      .add(float(1).div(max(incidence, float(0.09))))
      .mul(0.5)
    const veil = oneMinus(exp(airmass.mul(-0.15)))
      .mul(skyStrength)
      .mul(smoothstep(float(-0.06), float(0.28), incidence))
    const veilColour = mix(hazeColour, vec3(1), veil.mul(0.55)).mul(sunlight)

    const surface = direct.add(indirect).add(sunlight.mul(glint)).add(emission)
    // 0.68 for the reason the disk uses it: at 0.8 the whole thing goes milky
    // and the ocean loses its depth, where the photographs keep a saturated
    // blue mid-disk under the veil.
    const lit = mix(surface, veilColour, veil.mul(0.68))
    /*
     * The bake: mode 1 is the reflectance alone; mode 2 is the sphere's
     * normal-map record — the mesh normal's components along geographic east
     * and north in RG as `x / 2 + 1/2`, and the sea mask in B, which is the
     * layout `render/planet.ts` reads the archive's map in, so the disk
     * decodes a bake and a photograph through one path. The half-up encoding
     * is not only for symmetry with the archive: a signed channel does not
     * survive the material's output stage — measured through the harness,
     * a north of −0.19 read back as zero from a float target — and half the
     * relief is downhill. Two passes rather than the mask in the
     * reflectance's alpha lane, because an opaque node material writes an
     * alpha of one whatever the opacity node says — measured as a mask of
     * 1.0 over every face of the first bake, and a sphere that was all sea.
     *
     * The frame is the sphere's own. The spin axis is +Y in body-fixed axes,
     * north is the axis with its radial part removed, and east is north × up
     * — the same three lines `planet.ts` builds from `normalWorld` and the
     * rotated axis, so a slope written here is read back in the frame it was
     * measured in. Degenerate at the two poles, where the sphere's frame is
     * too. The slope is the *mesh* normal's rather than the bumped one's: at
     * a texel of kilometers every detail octave has faded to nothing, and the
     * sphere's own exaggeration is applied where it reads. Under the sea the
     * mesh is the seabed and the sea is flat, so the mask zeroes the slope.
     */
    const seaMask = max(flat, river)
    const bakeNorth = normalize(vec3(0, 1, 0).sub(up.mul(up.y)))
    const bakeEast = cross(bakeNorth, up)
    const bakeSlope = vec2(dot(normal, bakeEast), dot(normal, bakeNorth)).mul(
      oneMinus(seaMask),
    )
    const baked = mix(
      mix(ground, riverColour, river),
      vec3(bakeSlope.mul(0.5).add(0.5), seaMask),
      saturate(bakeMode.sub(1)),
    )
    return mix(lit, baked, saturate(bakeMode))
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
      write(seabed, palette.seabed)
      write(pigment, palette.pigment)
      paint(mineralLow, palette.mineralLow)
      paint(mineralHigh, palette.mineralHigh)
      freshGain.value = palette.freshGain
      lunarLambert.value = palette.lunarLambert
      terminator.value = palette.terminator
      aeolian.value = palette.aeolian
      evaporitic.value = palette.evaporitic
      repose.value = palette.repose
      maxElevation.value = palette.maxElevation
      seaEnabled.value = palette.seaLevel === null ? 0 : 1
      seaDatum.value = palette.seaLevel ?? 0
      seaSheet.value = palette.sheet
      paint(oceanColour, palette.oceanColour)
      paint(liquidGlow, palette.liquid?.glow ?? BLACK_RGB)
      paint(skyColour, palette.skyColour)
      paint(hazeColour, palette.hazeColour)
      skyStrength.value = palette.airThickness
      paint(sunsetTint, palette.sunsetTint)
      /*
       * The macro octave's frequency, in cycles per unit of the *direction*.
       *
       * A direction is dimensionless, so the wavelength has to be converted
       * through the body's own size — which is also what makes one constant
       * serve a 236 km moon and a 6,371 km planet: four kilometers of ground is
       * four kilometers of ground on both.
       */
      macroFrequency.value = (2 * Math.PI * datumRadius) / MACRO_METRES
    },
    setQuality(ground) {
      const bands = groundBandsFor(ground)
      if (detailBands.value !== bands) detailBands.value = bands
    },
    setBakeMode(mode) {
      bakeMode.value = mode
    },
    setAlbedoMap(map, hasMap) {
      /*
       * The **key** decides whether a body is mapped; the texture only supplies
       * the pixels. Two predicates was one predicate too many: `texturesFor`
       * returns `NO_TEXTURES` for a key with no manifest entry, so a body that
       * gained a key before its asset shipped had the palette calling it mapped
       * — white reference, deposit ratios at one — while this called it
       * unmapped and switched the invented cover and the ocean back on. A white
       * planet with invented maria on it, and the sphere beside it drawing
       * something else again.
       */
      albedoMap.value = map ?? BLANK
      mapped.value = hasMap ? 1 : 0
    },
  }
}

/**
 * One body-fixed coordinate reduced into the grain field's own period.
 *
 * In grain wavelengths, so the shader adds `positionLocal / GRAIN_METRES` to it
 * directly. See `GRAIN_PERIOD` in `render/terrain.ts` for why the reduction has
 * to happen on this side of the uniform.
 */
export function grainWrap(meters: number): number {
  const cycles = meters / GRAIN_METRES
  return cycles - Math.floor(cycles / GRAIN_PERIOD) * GRAIN_PERIOD
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
  paint(into.albedo, from.albedo)
  into.params.value.set(from.roughness, from.grain, from.bump)
}

/**
 * One palette colour into one uniform.
 *
 * Spelled out, each of these names its field three times, which is the shape a
 * `skyColour.b` pasted into the `hazeColour` block type-checks through and then
 * reads as an art choice rather than as a bug.
 */
export function paint(into: { value: Color }, from: LinearRgb): void {
  into.value.setRGB(from.r, from.g, from.b)
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
 * space. It is not the scene's own `ambientLight`, which this material does not
 * see: that one is a fill for the ship and the near-field props, and at 0.16 it
 * lights a night side to a tenth — bright enough to flatten the terminator,
 * which is what `SceneView` warns about.
 *
 * It is scaled by how much sky the point can see, so a crater floor is darker
 * at night than the plain around it rather than a flat wash. The sea keeps
 * the same floor, or the sheet and the shore differ at night.
 */
export const AMBIENT = 0.03

/**
 * The scale height the ground-level veil measures a path against, meters.
 *
 * Earth's 8.5 km. A horizontal path of one scale height at sea level holds
 * about the air a vertical column does, which is what makes it the unit the
 * orbital `1/μ` term is already in; the two legs of the veil can then be the
 * lesser of each other with nothing converted.
 */
export const AIR_SCALE_HEIGHT = 8_500

/**
 * How much of the light under a full atmosphere arrives from the sky rather
 * than along the sun ray, at `airThickness` 1.
 *
 * A third is the diffuse fraction of a clear terrestrial noon; it rises toward
 * one under overcast, which is a state this model does not carry. Scaled by
 * `airThickness` so Mars's 0.15 gives 5% and Luna's absent air gives none.
 */
export const SKY_FRACTION = 0.33

/*
 * A one-pixel white stand-in, so a body with no map runs the identical graph.
 *
 * The alternative is a branch on whether a texture exists, which is a second
 * pipeline for the same material — and a whole-disk selection is several
 * hundred patches through one of them.
 *
 * **Filtered, and that is load-bearing.** `DataTexture` defaults to
 * `NearestFilter` both ways, and the WGSL builder treats nearest-both-ways as
 * *unfilterable*: it binds the texture with no sampler and reads it with
 * `textureLoad`. The gradient sample `sampled` emits has no such path — it
 * names `<texture>_sampler` unconditionally — so against the default stand-in
 * the fragment stage references a binding that was never declared, Tint
 * refuses the module, and the ground of every mapless body streams 706 patches
 * into a black frame. A published map is loaded linear, which is why mapped
 * bodies never showed it, and why the boot warm-up — which compiles against
 * this stand-in — was compiling a pipeline that could not build.
 * `materials.gpu.test.ts` holds the stand-in and a real map to the same WGSL.
 */
const BLANK = /*@__PURE__*/ (() => {
  const map = new DataTexture(
    new Uint8Array([255, 255, 255, 255]),
    1,
    1,
    RGBAFormat,
  )
  map.magFilter = LinearFilter
  map.minFilter = LinearFilter
  map.needsUpdate = true
  return map
})()

export const BLACK_RGB: LinearRgb = { r: 0, g: 0, b: 0 }
