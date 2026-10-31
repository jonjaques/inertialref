import {
  DataTexture,
  LinearFilter,
  type Node,
  RGBAFormat,
  type Texture,
  Vector3,
} from 'three/webgpu'
import {
  abs,
  clamp,
  cross,
  dot,
  exp,
  float,
  length,
  Loop,
  max,
  mix,
  normalize,
  oneMinus,
  pow,
  saturate,
  sqrt,
  step,
  texture,
  uniform,
  vec2,
  vec3,
} from 'three/tsl'
import {
  AEROSOL_ASYMMETRY,
  type AtmosphereRecipe,
  MULTI_SCATTER_HEIGHT,
  MULTI_SCATTER_WIDTH,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from '@inertialref/rendering'

/*
 * The air a body's surfaces are seen through: the shell's recipe and tables
 * as uniforms, and the march through them, shared by the shell, the sphere,
 * the ground and the sea.
 *
 * The atmosphere shell is a back-side sphere, so it survives the depth test
 * only outside the planet's silhouette; everything the air does in front of
 * a surface has to happen in that surface's material. Each of the three
 * carried an authored veil for it — an airmass over a flat atmosphere, a
 * haze color, 0.15 of extinction per airmass, 0.55 toward white, 0.68 of the
 * surface — and none of it was the sky the shell drew beside it. On a desert
 * at noon the horizon sky went to the gray-white a long path makes while the
 * sand met it in a hard line: 50 km of ground was veiled 27% where the
 * path's transmittance is 0.22, and the veil's color was a haze color the
 * sky did not have. One march and one set of tables, and the ground fades
 * to exactly the sky that continues above it, on every body, from every
 * height, with nothing authored in between.
 *
 * Positions are in sea-level units about the body's center — the datum is
 * 1, the tables' ceiling is `top` — which is the unit the tables are baked
 * in, and the one that survives distance compression. The shell's doc
 * comment has the budget: twelve samples with two table reads each is the
 * march the LUTs made affordable, and a surface takes a third of that.
 */

const TRANSMITTANCE = [TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT] as const
const MULTI_SCATTER = [MULTI_SCATTER_WIDTH, MULTI_SCATTER_HEIGHT] as const

/**
 * A table coordinate in [0, 1]² as the bake means it: 0 and 1 are the first
 * and last texels' centers, where the bake put its first and last samples.
 *
 * A sampler puts them at the texture's edges, half a texel further out, so a
 * bare read lands a quarter texel off the CPU's `sampleLut` midway across.
 * On Ψ's 32 columns that is a degree of sun, and through twilight a degree
 * is a factor of three in the sky.
 */
function texelCentered(
  coordinate: Node<'vec2'>,
  [width, height]: readonly [number, number],
): Node<'vec2'> {
  return coordinate
    .mul(vec2((width - 1) / width, (height - 1) / height))
    .add(vec2(0.5 / width, 0.5 / height))
}

/*
 * 1×1 stand-ins so a material whose tables have not arrived runs the
 * identical graph: full transmittance and no multiple scattering, with the
 * scattering coefficients defaulting to zero — a vacuum that draws nothing,
 * rather than one frame of some other planet's sky.
 *
 * Filtered like the tables they stand in for, or the graph is not identical
 * where it counts: `DataTexture` defaults to nearest, the WGSL builder reads a
 * nearest texture with `textureLoad` and no sampler, and the baked tables are
 * linear and read with `textureSample`. Two different programs — and the one
 * a material is first compiled with is the one it keeps, because a value swap
 * rebuilds no WGSL, so a nearest stand-in leaves the real tables read at mip
 * 0 with no interpolation between their entries. The terrain stand-in has the
 * sharper version of the same trap — see `BLANK` in `terrain.ts`. One
 * stand-in object per node, or two nodes compile to one binding — and one
 * object per role across every material, as `BLANK` is: a material's
 * textures are not its own to dispose, so a pair allocated per material is a
 * pair per body visual, kept for the session.
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
 * The uniforms one material marches through: the recipe's coefficients in
 * sea-level units, the two tables, and `top`, the tables' ceiling over sea
 * level — 1 with no air. `set` points them at one body's air, idempotently
 * and without a rebuild; `clear` is a vacuum, which draws nothing,
 * extinguishes nothing and passes the beam white.
 */
export function createAirUniforms() {
  const top = uniform(1)
  const betaRayleigh = uniform(new Vector3(0, 0, 0))
  const mieScatter = uniform(new Vector3(0, 0, 0))
  const mieExtinction = uniform(new Vector3(0, 0, 0))
  const ozone = uniform(new Vector3(0, 0, 0))
  const ozonePeak = uniform(0)
  const ozoneHalfWidth = uniform(1)
  const hRayleigh = uniform(1)
  const hMie = uniform(1)
  const transmittance = texture(LUT_WHITE)
  const multiScatter = texture(LUT_BLACK)
  return {
    top,
    betaRayleigh,
    mieScatter,
    mieExtinction,
    ozone,
    ozonePeak,
    ozoneHalfWidth,
    hRayleigh,
    hMie,
    transmittance,
    multiScatter,
    set(recipe: AtmosphereRecipe, sunTable: Texture, psiTable: Texture): void {
      top.value = recipe.topRatio
      betaRayleigh.value.set(...recipe.betaRayleigh)
      mieScatter.value.set(...recipe.mieScatter)
      mieExtinction.value.set(...recipe.mieExtinction)
      ozone.value.set(...recipe.ozone)
      ozonePeak.value = recipe.ozonePeak
      ozoneHalfWidth.value = recipe.ozoneHalfWidth
      hRayleigh.value = recipe.hRayleigh
      hMie.value = recipe.hMie
      transmittance.value = sunTable
      multiScatter.value = psiTable
    },
    clear(): void {
      top.value = 1
      betaRayleigh.value.set(0, 0, 0)
      mieScatter.value.set(0, 0, 0)
      mieExtinction.value.set(0, 0, 0)
      ozone.value.set(0, 0, 0)
      ozonePeak.value = 0
      ozoneHalfWidth.value = 1
      hRayleigh.value = 1
      hMie.value = 1
      // The tables as well as the coefficients. `sunThrough` hands back the
      // transmittance table as the beam's color, with no coefficient to zero
      // it, so a material cleared for an airless body but still bound to the
      // last body's tables lit Luna's low sun through Earth's sea-level
      // column — one shared ground material, one shared sea, and a walk from
      // one world to the next.
      transmittance.value = LUT_WHITE
      multiScatter.value = LUT_BLACK
    },
  }
}

export type AirUniforms = ReturnType<typeof createAirUniforms>

/** What a march hands back: the light the path adds, and what it lets through. */
export interface Marched {
  /** In-scattered light along the path, before the sun's color and the gain. */
  readonly inscatter: Node<'vec3'>
  readonly transmittance: Node<'vec3'>
}

/**
 * The march: `samples` midpoint samples from `near` to `far` along
 * `direction` from `origin`, all in sea-level units. Per sample: exponential
 * Rayleigh and aerosol densities — with the `(1 − h)` factor that takes both
 * to exactly zero at the ceiling, kept identical to the bake so the tables
 * and the march agree about where the air ends — the ozone tent, view
 * transmittance accumulated in-loop, sun transmittance and Ψ read from the
 * tables at (altitude, sun-cosine).
 *
 * The samples crowd toward the segment's lowest point, where its air is
 * densest — the eye, looking up from the ground; the tangent point, on a
 * limb seen from orbit — at the squares of an even spread on each side, as
 * `marchSample` places the CPU's. Twelve spread evenly up a 120 km column
 * put the first 5 km high and drew a noon zenith at 39% of its converged
 * light: past e^−4 of Earth's aerosol, the part that makes most of a clear
 * zenith under a high sun. Both branches are evaluated and `right` picks
 * one, so each keeps its denominator off zero.
 *
 * `Loop` and `toVar` emit statements, so this is called from inside a
 * material's `Fn` and nowhere else; built at material scope the loop is
 * never emitted and the accumulators stay at their zeros, which compiles
 * cleanly and draws a vacuum.
 */
export function marchAir(
  air: AirUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  sun: Node<'vec3'>,
  samples: number,
  /**
   * How much of Enhanced's limb this march draws, 0 to 1: the glow the gas
   * would scatter if it fell off over `LIMB_HEIGHTS` times its height,
   * gained `LIMB_GAIN` times, added to the physics above the limb's own
   * line and nowhere in the extinction. The shell from orbit is the one
   * caller that passes more than 0, and a number builds no second density.
   */
  limb: Node<'float'> | number = 0,
): Marched {
  const shellHeight = max(air.top.sub(1), 1e-6)
  const nu = dot(direction, sun)
  const phaseRayleigh = float(3 / (16 * Math.PI)).mul(nu.mul(nu).add(1))
  const g = AEROSOL_ASYMMETRY
  const phaseMie = float((1 - g * g) / (4 * Math.PI)).div(
    pow(max(float(1 + g * g).sub(nu.mul(2 * g)), 1e-4), 1.5),
  )

  const span = max(far.sub(near), 0)
  const closest = dot(origin.negate(), direction)
  const perigee = clamp(closest.sub(near), 0, span)
  const split = perigee.div(max(span, 1e-9))
  const before = max(split, 1e-6)
  const after = max(oneMinus(split), 1e-6)
  const inscatter = vec3(0).toVar()
  const opticalDepth = vec3(0).toVar()

  Loop(samples, ({ i }) => {
    const u = float(i).add(0.5).div(samples)
    const right = step(split, u)
    const toward = split.sub(u).div(before)
    const away = u.sub(split).div(after)
    const t = near.add(
      mix(
        perigee.sub(perigee.mul(toward.mul(toward))),
        perigee.add(span.sub(perigee).mul(away.mul(away))),
        right,
      ),
    )
    const stepLength = mix(
      perigee.mul(toward).mul(2).div(before),
      span.sub(perigee).mul(away).mul(2).div(after),
      right,
    ).div(samples)
    const point = origin.add(direction.mul(t))
    const radius = length(point)
    const height = max(radius.sub(1), 0)
    const height01 = saturate(height.div(shellHeight))
    const fade = oneMinus(height01)
    const densityR = exp(height.div(air.hRayleigh).negate()).mul(fade)
    const densityM = exp(height.div(air.hMie).negate()).mul(fade)
    const scatterR =
      limb === 0
        ? densityR
        : densityR.add(
            exp(height.div(air.hRayleigh.mul(LIMB_HEIGHTS)).negate())
              .mul(fade)
              .sub(densityR)
              .mul(float(LIMB_GAIN).mul(limb)),
          )

    // The ozone tent absorbs and scatters nothing; `densities` holds the
    // same shape on the CPU.
    const densityO = max(
      float(1).sub(
        abs(height.sub(air.ozonePeak)).div(max(air.ozoneHalfWidth, 1e-9)),
      ),
      0,
    )
    const extinction = air.betaRayleigh
      .mul(densityR)
      .add(air.mieExtinction.mul(densityM))
      .add(air.ozone.mul(densityO))
    const stepTau = extinction.mul(stepLength)
    // Transmittance to the middle of this step: the half keeps the midpoint
    // rule honest about its own sample's extinction.
    const viewT = exp(opticalDepth.add(stepTau.mul(0.5)).negate())

    const muSun = dot(point, sun).div(max(radius, 1e-5))
    const lutUv = vec2(muSun.add(1).mul(0.5), height01)
    const sunT = air.transmittance.sample(
      texelCentered(lutUv, TRANSMITTANCE),
    ).rgb
    // ln Ψ, read geometrically; see `bakeMultipleScattering`. The stand-in
    // reads as e⁰ = 1, against coefficients that are zero until the
    // tables arrive, so it still draws a vacuum.
    const psi = exp(
      air.multiScatter.sample(texelCentered(lutUv, MULTI_SCATTER)).rgb,
    )

    const single = air.betaRayleigh
      .mul(scatterR)
      .mul(phaseRayleigh)
      .add(air.mieScatter.mul(densityM).mul(phaseMie))
      .mul(sunT)
    const multiple = psi.mul(
      air.betaRayleigh.mul(scatterR).add(air.mieScatter.mul(densityM)),
    )
    inscatter.addAssign(viewT.mul(single.add(multiple)).mul(stepLength))
    opticalDepth.addAssign(stepTau)
  })

  return { inscatter, transmittance: exp(opticalDepth.negate()) }
}

/** March samples a surface takes through the air in front of it. */
export const SURFACE_AIR_SAMPLES = 4

/**
 * Enhanced's limb from orbit: the gas glows as if it fell off over this many
 * of its own scale heights — 25 km on Earth, where the physics is 8.5 — and
 * the glow that adds above the physics is gained this much. Together they
 * are the soft ring the home page wraps the disk in: at 50 km over Earth's
 * limb, half the line's own light where the physics has a third of a
 * percent, fading to none at the top of the shell.
 */
export const LIMB_HEIGHTS = 3
export const LIMB_GAIN = 4

/**
 * The air between the eye and a point on a surface, both in sea-level units
 * about the body's center. The segment starts where it enters the air —
 * where the eye is, inside it — and ends at the point, so a surface seen
 * from orbit is veiled by the whole slant column and one seen from a beach
 * by the meters between, with no second model for either.
 */
export function airToward(
  air: AirUniforms,
  eye: Node<'vec3'>,
  point: Node<'vec3'>,
  sun: Node<'vec3'>,
  samples = SURFACE_AIR_SAMPLES,
): Marched {
  const toPoint = point.sub(eye)
  const span = length(toPoint)
  const direction = toPoint.div(max(span, 1e-9))
  const toCenter = eye.negate()
  // `|d × c|` for the impact parameter, as the shell takes it: it cannot go
  // imaginary on a grazing ray, which is every ray that matters here.
  const closest = dot(toCenter, direction)
  const impactSquared = max(length(cross(direction, toCenter)).pow(2), 0)
  const top = air.top
  const halfOuter = sqrt(max(top.mul(top).sub(impactSquared), 0))
  const near = clamp(closest.sub(halfOuter), 0, span)
  return marchAir(air, eye, direction, near, span, sun, samples)
}

/**
 * The sun's transmittance to a point, read from the table at its altitude
 * and the sun's cosine over its own horizontal: what the direct beam arrives
 * as, reddened and dimmed by the column it crossed. White without air.
 */
export function sunThrough(
  air: AirUniforms,
  point: Node<'vec3'>,
  sun: Node<'vec3'>,
): Node<'vec3'> {
  const radius = length(point)
  const height01 = saturate(
    max(radius.sub(1), 0).div(max(air.top.sub(1), 1e-6)),
  )
  const muSun = dot(point, sun).div(max(radius, 1e-5))
  return air.transmittance.sample(
    texelCentered(vec2(muSun.add(1).mul(0.5), height01), TRANSMITTANCE),
  ).rgb
}

/** The point's radial, for a march that only has the point. */
export const radialOf = (point: Node<'vec3'>): Node<'vec3'> => normalize(point)
