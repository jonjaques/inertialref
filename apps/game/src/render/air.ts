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
  If,
  length,
  Loop,
  max,
  mix,
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
  AEROSOL_FORWARD_PEAK,
  type AtmosphereRecipe,
  LIMB_BRIGHTNESS,
  LIMB_CEILING_FALLOFFS,
  LIMB_GAIN,
  MULTI_SCATTER_HEIGHT,
  MULTI_SCATTER_WIDTH,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from '@inertialref/rendering'
import { enhancedSky } from './radiance.ts'

/*
 * The air a body's surfaces are seen through: the shell's recipe and tables
 * as uniforms, and the march through them, shared by the shell, the sphere,
 * the ground and the sea.
 *
 * The atmosphere shell is a back-side sphere, so it survives the depth test
 * only outside the planet's silhouette; everything the air does in front of
 * a surface has to happen in that surface's material. An authored veil there
 * — an airmass over a flat atmosphere, a haze color, a fixed extinction per
 * airmass — is not the sky the shell draws beside it: on a desert at noon
 * the horizon sky is the gray-white a long path makes, and 50 km of sand
 * veiled 27% where the path's transmittance is 0.22, in a haze color the sky
 * does not have, meets it in a hard line. One march and one set of tables,
 * and the ground fades to exactly the sky that continues above it, on every
 * body, from every height, with nothing authored in between.
 *
 * Positions are in sea-level units about the body's center — the datum is
 * 1, the tables' ceiling is `top` — which is the unit the tables are baked
 * in, and the one that survives distance compression. The shell's doc
 * comment has the budget: twelve samples with two table reads each is the
 * march the LUTs made affordable, and a surface takes a third of that.
 *
 * Enhanced's limb from orbit is a second march through the same tables
 * (`marchLimb`): the recipe stretched `LIMB_STRETCH` of its own scale
 * heights tall, which the shell draws past the disk's edge and nothing
 * draws in front of a surface. Composed over the sphere, the ground and the
 * sea it is the same column of gas a second time at nadir — a blue veil
 * that tints a Blue Marble's Sahara magenta, 143 : 125 : 137 where the
 * physics alone draws 140 : 114 : 109 — so a surface takes the physical
 * air's light alone, and all three take it from the one march. What the
 * lift does to a surface is take the air's extinction off it
 * (`clearedFromOrbit`).
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
 * identical graph: full transmittance, and a Ψ table of zeros — ln Ψ = 0,
 * which reads as Ψ = 1 — against scattering coefficients that default to
 * zero, so nothing multiplies it: a vacuum that draws nothing, rather than
 * one frame of some other planet's sky. Only the coefficients keep the
 * stand-in dark, which is why `set` writes them and the tables together.
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
 * sea-level units, the two tables, `top`, the tables' ceiling over sea
 * level — 1 with no air — and the limb: `limb`, how far the eye stands
 * outside the air (`RenderBody.limb`), and `limbFalloff`, the ring's
 * fall-off for that eye (`limbFalloff`), which only the shell's second
 * march reads. `set` points them at one body's air, idempotently and without a
 * rebuild, `lift` writes the limb beside it, and `clear` is a vacuum, which
 * draws nothing, extinguishes nothing and passes the beam white.
 */
export function createAirUniforms() {
  const top = uniform(1)
  const limb = uniform(0)
  const limbFalloff = uniform(0)
  const betaRayleigh = uniform(new Vector3(0, 0, 0))
  const mieScatter = uniform(new Vector3(0, 0, 0))
  const mieExtinction = uniform(new Vector3(0, 0, 0))
  const mieForward = uniform(new Vector3(0, 0, 0))
  const aerosolSky = uniform(0)
  const ozone = uniform(new Vector3(0, 0, 0))
  const ozonePeak = uniform(0)
  const ozoneHalfWidth = uniform(1)
  const detachedPeak = uniform(0)
  const detachedHalfWidth = uniform(1)
  const detachedExtinction = uniform(0)
  const detachedScatter = uniform(new Vector3(0, 0, 0))
  const hRayleigh = uniform(1)
  const hMie = uniform(1)
  const transmittance = texture(LUT_WHITE)
  const multiScatter = texture(LUT_BLACK)
  return {
    top,
    betaRayleigh,
    mieScatter,
    mieExtinction,
    mieForward,
    aerosolSky,
    ozone,
    ozonePeak,
    ozoneHalfWidth,
    detachedPeak,
    detachedHalfWidth,
    detachedExtinction,
    detachedScatter,
    hRayleigh,
    hMie,
    transmittance,
    multiScatter,
    limb,
    limbFalloff,
    set(recipe: AtmosphereRecipe, sunTable: Texture, psiTable: Texture): void {
      top.value = recipe.topRatio
      betaRayleigh.value.set(...recipe.betaRayleigh)
      mieScatter.value.set(...recipe.mieScatter)
      mieExtinction.value.set(...recipe.mieExtinction)
      mieForward.value.set(...recipe.mieForward)
      aerosolSky.value = recipe.aerosolSky
      ozone.value.set(...recipe.ozone)
      ozonePeak.value = recipe.ozonePeak
      ozoneHalfWidth.value = recipe.ozoneHalfWidth
      detachedPeak.value = recipe.detachedPeak
      detachedHalfWidth.value = recipe.detachedHalfWidth
      detachedExtinction.value = recipe.detachedExtinction
      detachedScatter.value.set(...recipe.detachedScatter)
      hRayleigh.value = recipe.hRayleigh
      hMie.value = recipe.hMie
      transmittance.value = sunTable
      multiScatter.value = psiTable
    },
    lift(strength: number, falloff: number): void {
      limb.value = strength
      limbFalloff.value = falloff
    },
    clear(): void {
      top.value = 1
      limb.value = 0
      limbFalloff.value = 0
      betaRayleigh.value.set(0, 0, 0)
      mieScatter.value.set(0, 0, 0)
      mieExtinction.value.set(0, 0, 0)
      mieForward.value.set(0, 0, 0)
      aerosolSky.value = 0
      ozone.value.set(0, 0, 0)
      ozonePeak.value = 0
      ozoneHalfWidth.value = 1
      detachedPeak.value = 0
      detachedHalfWidth.value = 1
      detachedExtinction.value = 0
      detachedScatter.value.set(0, 0, 0)
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
  clearBeam?: Node<'float'>,
): Marched {
  const shellHeight = max(air.top.sub(1), 1e-6)
  const phase = phasesToward(direction, sun)
  const inscatter = vec3(0).toVar()
  const opticalDepth = vec3(0).toVar()

  crowdedSamples(origin, direction, near, far, samples, (point, stepLength) => {
    const radius = length(point)
    const height = max(radius.sub(1), 0)
    const height01 = saturate(height.div(shellHeight))
    const fade = oneMinus(height01)
    const densityR = exp(height.div(air.hRayleigh).negate()).mul(fade)
    const densityM = exp(height.div(air.hMie).negate()).mul(fade)

    // The ozone tent absorbs and scatters nothing; `densities` holds the
    // same shape on the CPU.
    const densityO = tentAt(height, air.ozonePeak, air.ozoneHalfWidth)
    // The detached layer's tent, the same shape on the CPU: small particles
    // that take gray and scatter their color with Rayleigh's phase.
    const densityD = tentAt(height, air.detachedPeak, air.detachedHalfWidth)
    const scatterD = air.detachedScatter.mul(densityD)
    const extinction = air.betaRayleigh
      .mul(densityR)
      .add(air.mieExtinction.mul(densityM))
      .add(air.ozone.mul(densityO))
      .add(air.detachedExtinction.mul(densityD))
    const stepTau = extinction.mul(stepLength)
    /*
     * Transmittance to the start of this step, and the step's light as the
     * integral over a step of constant density, (1 − e^−τ)/σ, rather than
     * the midpoint's transmittance times the length. The two agree to a
     * part in ten thousand at a step of 0.04 optical depths, which is
     * Earth's; at a step of eleven — the first of twelve crowded toward a
     * surface under Titan's haze — the midpoint rule keeps four percent of
     * the light, so an opaque haze draws at half its albedo with a dark
     * seam where its march meets the shell's at the silhouette.
     */
    const viewT = exp(opticalDepth.negate())
    const stepLight = stepLength.mul(
      oneMinus(exp(stepTau.negate())).div(max(stepTau, vec3(1e-7))),
    )

    const muSun = dot(point, sun).div(max(radius, 1e-5))
    const sunT = sunTableAt(air, muSun, height01).toVar()
    // Behind a uniform branch: on the ground and under a photographic lens
    // the strength is zero, and the overhead read `clearedBeam` takes per
    // sample would be mixed in at nothing.
    if (clearBeam !== undefined)
      If(clearBeam.greaterThan(0), () => {
        sunT.assign(clearedBeam(air, sunT, height01, clearBeam))
      })
    const psi = psiTableAt(air, muSun, height01)
    // The aerosol scatters the sky's color sideways and the limb's toward
    // the sun, turning between them along its lobe's own shape; the multiple
    // scattering keeps the sideways color, as the Ψ bake does.
    const scatterToward = mix(air.mieScatter, air.mieForward, phase.forward)
    const single = air.betaRayleigh
      .mul(densityR)
      .add(scatterD)
      .mul(phase.rayleigh)
      .add(scatterToward.mul(densityM).mul(phase.mie))
      .mul(sunT)
    const multiple = psi.mul(
      air.betaRayleigh
        .mul(densityR)
        .add(air.mieScatter.mul(densityM))
        .add(scatterD),
    )
    inscatter.addAssign(viewT.mul(single.add(multiple)).mul(stepLight))
    opticalDepth.addAssign(stepTau)
  })

  return { inscatter, transmittance: exp(opticalDepth.negate()) }
}

/** A tent in height, 1 at `peak` and nothing from `halfWidth` either side. */
function tentAt(
  height: Node<'float'>,
  peak: Node<'float'>,
  halfWidth: Node<'float'>,
): Node<'float'> {
  return max(float(1).sub(abs(height.sub(peak)).div(max(halfWidth, 1e-9))), 0)
}

/**
 * The two phase functions for a view direction against the sun: Rayleigh's,
 * and Henyey–Greenstein at the one aerosol asymmetry — and the lobe's share
 * of its peak toward the sun, which is how far the aerosol's color has
 * turned from the sky's (`mieScatter`) to the limb's (`mieForward`).
 */
function phasesToward(
  direction: Node<'vec3'>,
  sun: Node<'vec3'>,
): {
  readonly rayleigh: Node<'float'>
  readonly mie: Node<'float'>
  readonly forward: Node<'float'>
} {
  const nu = dot(direction, sun)
  const g = AEROSOL_ASYMMETRY
  const mie = float((1 - g * g) / (4 * Math.PI)).div(
    pow(max(float(1 + g * g).sub(nu.mul(2 * g)), 1e-4), 1.5),
  )
  return {
    rayleigh: float(3 / (16 * Math.PI)).mul(nu.mul(nu).add(1)),
    mie,
    forward: mie.div(AEROSOL_FORWARD_PEAK),
  }
}

/**
 * The sun's transmittance at one sample, read at `muSun`, the sun's cosine
 * over the sample's horizontal, and at `height01`, the altitude fraction —
 * the sample's own for the physics, the stretched one for the limb.
 */
export function sunTableAt(
  air: AirUniforms,
  muSun: Node<'float'>,
  height01: Node<'float'>,
): Node<'vec3'> {
  const lutUv = vec2(muSun.add(1).mul(0.5), height01)
  return air.transmittance.sample(texelCentered(lutUv, TRANSMITTANCE)).rgb
}

/**
 * Ψ at one sample, in the same coordinates. ln Ψ, read geometrically; see
 * `bakeMultipleScattering`. The stand-in reads as e⁰ = 1, against
 * coefficients that are zero until the tables arrive, so it still draws a
 * vacuum.
 */
function psiTableAt(
  air: AirUniforms,
  muSun: Node<'float'>,
  height01: Node<'float'>,
): Node<'vec3'> {
  const lutUv = vec2(muSun.add(1).mul(0.5), height01)
  return exp(air.multiScatter.sample(texelCentered(lutUv, MULTI_SCATTER)).rgb)
}

/**
 * `samples` midpoint samples from `near` to `far` along `direction` from
 * `origin`, crowded toward the segment's lowest point as the doc comment on
 * `marchAir` describes, each handed to `each` with its step length. A
 * `Loop`, so it lives inside a material's `Fn`.
 */
function crowdedSamples(
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  samples: number,
  each: (point: Node<'vec3'>, stepLength: Node<'float'>) => void,
): void {
  const span = max(far.sub(near), 0)
  const closest = dot(origin.negate(), direction)
  const perigee = clamp(closest.sub(near), 0, span)
  const split = perigee.div(max(span, 1e-9))
  const before = max(split, 1e-6)
  const after = max(oneMinus(split), 1e-6)
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
    each(origin.add(direction.mul(t)), stepLength)
  })
}

/** March samples a surface takes through the air in front of it. */
export const SURFACE_AIR_SAMPLES = 4

/**
 * March samples the shell takes through the lifted gas. Eight against the
 * physics' twelve: the stretched profile is `LIMB_STRETCH` times smoother
 * than the one it stretches, so a sample crowded to the perigee covers it.
 */
export const LIMB_SAMPLES = 8

/**
 * Where the air ends for the eye's lift, in sea-level units: `top` inside
 * the air, the ring's ceiling for this eye at the full lift — or `top`, for
 * an air that already reaches past it. `limbReach` on the CPU is the same
 * formula, and sizes the mesh the shell is drawn on.
 */
export function limbReachOf(air: AirUniforms): Node<'float'> {
  const ceiling = air.limbFalloff.mul(LIMB_CEILING_FALLOFFS).add(1)
  return air.top.add(max(ceiling, air.top).sub(air.top).mul(air.limb))
}

/**
 * Enhanced's limb: the recipe stretched to fall off over `limbFalloff` —
 * `LIMB_STRETCH` of the gas's own scale heights, a fifth of the eye's
 * height under that (`LIMB_STANDOFF`) — marched from `near` to `far` like
 * the physics, and drawn `LIMB_BRIGHTNESS` times over.
 *
 * The stretch is one number, the fall-off over the gas's own scale height,
 * and the lifted recipe is the physical gas with every height multiplied by
 * it and every coefficient divided by it, `LIMB_GAIN` times over: the same
 * column of gas, that much taller.
 *
 * Without its ozone, the second place the ring departs from a stretched
 * physics. Ozone absorbs and scatters nothing; what it does is take the
 * orange out of light that crosses the stratosphere edgeways, which is what
 * turns a twilight zenith blue from the ground, and the physics keeps it
 * for that. Stretched with the gas and drawn six times over, the tent sits
 * across the ring's middle and takes the orange out of the band between the
 * foot and the crown: a sunrise from low orbit reads orange under violet
 * with no white between, and every lit rim a blue-violet. Without it the
 * band is orange under white under blue, its crop 0.036 RMSE of the
 * composite's against 0.046 with it. The tables the ring is lit through
 * keep the ozone; the sun that reaches the ring has crossed the real one.
 *
 * The aerosol rides in the ring at its whole column, falls off over the
 * gas's own scale height, and scatters without taking. Its extinction
 * would take the limb's own line, which is where the physics is: it
 * scatters nothing toward an eye square to the sun, and taking it halves
 * what the physics draws under it. What it has that the gas does not is
 * its forward lobe, fifty times the side-scatter, and the lobe is the
 * orange: a sunrise at the limb, the ring of a backlit Earth, every
 * reference photograph's glow toward the sun is reddened sunlight thrown
 * forward by the aerosol at the foot, and its gray is the white between
 * the orange and the blue. So the ring keeps the lobe and drops the
 * extinction. Over the gas's own height and not the ring's: that is the
 * lower third of the ring on every world, so the lobe stays at the foot.
 * Stretched with the gas, Titan's haze, three times its gas, reaches past
 * it, and the lobe spread that high paints a broad tan-white arch over a
 * limb photographed as a thin line. Under the gas's height — Earth's
 * boundary layer stretched to 3.6 km — the white is a thread at the foot,
 * and Earth's sunrise limb from low orbit is orange under blue; over
 * 8.5 km it is orange under white under blue, its frame 0.030 RMSE of the
 * composite's against 0.044. At a quarter of the column the orange is a
 * thread too. A dust that is the whole column (`aerosolSky`) is the
 * exception: it rides at its whole column and takes as it scatters, which
 * the march below says why. A detached layer stays in the physics: drawn
 * six times over it is a second outline standing off the first.
 *
 * The tables are read at the height the stretch maps the sample to,
 * `h / stretch` — the ring lit as the gas of a planet stretched the same
 * way is, which has exactly the physical gas's transmittance there. Read
 * at the sample's own height, the ring is lit by the sun through the air
 * that is actually there, which at a sample's height over the foot is
 * nearly none: the ring toward a rising sun is a white glare with the
 * orange in the physical line alone. Read at the root of the stretch,
 * between the two, the orange on Earth's sunrise limb from low orbit is a
 * thread under a band of blue; at the stretch itself, seen from four radii
 * toward a sun a degree and a half over the foot's horizon, red stays over
 * blue twenty kilometers up (1.02 : 0.82 : 0.56). The horizon is this
 * planet's, whatever height the table is read at: the table's own horizon,
 * read at a fraction of the height, puts a crown well up the ring in shadow
 * with the sun a degree behind the disk, where that crown sees the sun well
 * past the terminator, and a backlit Earth draws no ring at all. So a beam
 * that climbs from its sample reads
 * the table as it stands, and a beam that descends is read at its own
 * grazing height on this planet, as the horizontal table there squared
 * over the horizontal table at the sample — the far half of the tangent
 * column and the near part down to it — and as nothing once the grazing
 * height is under the ground. The two agree where the beam is level.
 * Nothing here authors a color.
 *
 * Gated on the lift and on Enhanced by one uniform branch, so the shell
 * under a photographic lens or inside the air pays none of it; the
 * accumulators keep their zeros and the composite is the physics alone.
 */
export function marchLimb(
  air: AirUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  sun: Node<'vec3'>,
  samples: number,
): Node<'vec3'> {
  const inscatter = vec3(0).toVar()
  const opticalDepth = vec3(0).toVar()
  const strength = air.limb.mul(enhancedSky)

  If(strength.greaterThan(0), () => {
    const shellHeight = max(air.top.sub(1), 1e-6)
    const ceiling = max(limbReachOf(air).sub(1), 1e-6)
    const falloff = max(air.limbFalloff, 1e-6)
    const stretch = falloff.div(max(air.hRayleigh, 1e-9))
    const column = float(LIMB_GAIN).div(stretch).mul(strength)
    // The tables are read at the height the stretch maps the sample to;
    // see the doc comment for why not at its own.
    const readingHeight = stretch.mul(shellHeight)
    const phase = phasesToward(direction, sun)

    crowdedSamples(
      origin,
      direction,
      near,
      far,
      samples,
      (point, stepLength) => {
        const radius = length(point)
        const height = max(radius.sub(1), 0)
        // To zero at the ceiling, as the physics goes to zero at its top.
        const fade = oneMinus(saturate(height.div(ceiling)))
        const density = exp(height.div(falloff).negate()).mul(fade)
        // The aerosol over the gas's own height (see the doc comment).
        const aerosolHeight = air.hRayleigh
        const densityM = exp(height.div(aerosolHeight).negate()).mul(fade)
        /*
         * Where the aerosol is the sky (`aerosolSky`) it rides at its whole
         * column — the cap on its height keeps the coefficient's share of
         * the stretch, so a dust mixed with its gas is restored to the column
         * the physics draws — and it takes as it scatters, below. Six times
         * an opaque dust that takes nothing is a white band (Mars's sunset
         * limb from low orbit at 219 : 192 : 191); taking, six times over
         * is six times its lit surface, a butterscotch line on the edge.
         */
        const aerosolColumn = column.mul(
          mix(
            float(1),
            air.hMie.mul(stretch).div(aerosolHeight),
            air.aerosolSky,
          ),
        )
        // The gas without its ozone; see the doc comment.
        const extinction = air.betaRayleigh
          .mul(density)
          .mul(column)
          .add(
            air.mieExtinction
              .mul(densityM)
              .mul(aerosolColumn)
              .mul(air.aerosolSky),
          )
        const stepTau = extinction.mul(stepLength)
        const viewT = exp(opticalDepth.add(stepTau.mul(0.5)).negate())

        const height01 = saturate(height.div(readingHeight))
        const muSun = dot(point, sun).div(max(radius, 1e-5))
        const climbing = step(0, muSun)
        // The beam's grazing height on this planet, and whether it clears
        // the ground; a climbing beam's lowest point is the sample.
        const level = radius.mul(sqrt(max(oneMinus(muSun.mul(muSun)), 0)))
        const graze = max(level.sub(1), 0)
        const clears = mix(step(1, level), float(1), climbing)
        const horizontalAt = (h: Node<'float'>) =>
          sunTableAt(air, float(0), saturate(h.div(readingHeight)))
        const descending = horizontalAt(graze)
          .pow(2)
          .div(max(horizontalAt(height), 1e-4))
        const sunT = mix(
          descending,
          sunTableAt(air, muSun, height01),
          climbing,
        ).mul(clears)
        const psi = psiTableAt(air, muSun, height01)
        const scatterR = air.betaRayleigh.mul(density).mul(column)
        const scatterM = air.mieScatter.mul(densityM).mul(aerosolColumn)
        // The lobe in the limb's color toward the sun, as `marchAir` turns it.
        const scatterToward = mix(air.mieScatter, air.mieForward, phase.forward)
          .mul(densityM)
          .mul(aerosolColumn)
        const single = scatterR
          .mul(phase.rayleigh)
          .add(scatterToward.mul(phase.mie))
          .mul(sunT)
        const multiple = psi.mul(scatterR.add(scatterM))
        inscatter.addAssign(viewT.mul(single.add(multiple)).mul(stepLength))
        opticalDepth.addAssign(stepTau)
      },
    )
  })

  // The ring's light alone: its own extinction dims the gas behind it along
  // the chord, and nothing else (`throughLimb`).
  return inscatter.mul(LIMB_BRIGHTNESS)
}

/**
 * The physics beside the lifted gas, not behind it. A stretched gas fronts
 * the physical limb along a tangent and passes a quarter of its blue and
 * two thirds of its red, and from low orbit that turns a sunrise's blue
 * band gray-tan — 68 : 66 : 62 where the plate has 153 : 188 : 252. The
 * limb's own line and its band are the photograph, so the ring adds to
 * them and takes nothing from them — nor from what is behind the shell: the
 * composite's transmittance is the physics' alone, which is why
 * `marchLimb` hands back light and no transmittance.
 */
export function throughLimb(physical: Marched, ring: Node<'vec3'>): Marched {
  return {
    inscatter: ring.add(physical.inscatter),
    transmittance: physical.transmittance,
  }
}

/**
 * The air between the eye and a point on a surface, both in sea-level units
 * about the body's center: the physics' light, under every lens, because
 * the lifted gas is the shell's (see the module's doc comment), and its
 * extinction except as Enhanced draws a surface from orbit
 * (`clearedFromOrbit`). The segment starts where it enters the air —
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
  const physical = marchAir(
    air,
    eye,
    direction,
    near,
    span,
    sun,
    samples,
    clearedFromOrbit(air).mul(ORBIT_AIRLIGHT),
  )
  return {
    inscatter: physical.inscatter,
    transmittance: mix(physical.transmittance, vec3(1), clearedFromOrbit(air)),
  }
}

/**
 * How far Enhanced draws a surface clear of the air's extinction: the lift
 * under Enhanced, so nothing inside the air or under a photographic lens.
 *
 * From orbit the measured air dims a surface twice, on the sun's way down
 * and the eye's way out, to about two thirds of its own light at nadir, and
 * reddens it toward the terminator: a Blue Marble's Sahara draws at
 * 140 : 114 : 109 where the composite the home page shows draws
 * 169 : 142 : 129, and a half-lit Earth's day side reads dark brown under a
 * hard terminator. The deep-space composite is where the bible licenses
 * the cheat (`art.md`), so from outside the air Enhanced lights the
 * surface at its own light in the beam's hue (`sunThrough`), shows it
 * without the view path's extinction, and keeps the air's light over it — the
 * physics' airlight, which is the haze toward the limb, lit by the beam
 * cleared `ORBIT_AIRLIGHT` of the way — and the sphere,
 * the ground and the sea take it from the one lift, as they take the air.
 * On the ground the lift is nothing and the air is the measured one.
 */
export function clearedFromOrbit(air: AirUniforms): Node<'float'> {
  return air.limb.mul(enhancedSky)
}

/**
 * The sun's transmittance to a point, read from the table at its altitude
 * and the sun's cosine over its own horizontal: what the direct beam arrives
 * as, reddened and dimmed by the column it crossed. White without air.
 *
 * As Enhanced draws a surface from orbit (`clearedFromOrbit`), the beam
 * keeps its hue and takes off its dimming (`clearedBeam`, down to
 * `ORBIT_BEAM_FLOOR`), and the hue is the slant's over
 * the column straight overhead: white at the subsolar point and warm toward
 * the terminator, so a sunward crescent is peach and not gray. Taken off
 * whole, the beam is white everywhere and a crescent Earth's lit sliver a
 * near-white gray; normalized as it stands, the column overhead tints the
 * whole lit face yellow, and Centauri II's, 0.012 RMSE of the composite's
 * under the beam the table holds, is 0.023 (0.019 over the column
 * overhead); divided by the column overhead and left dim, the crescent and
 * the terminator go dark.
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
  const table = sunTableAt(air, muSun, height01)
  return clearedBeam(air, table, height01, clearedFromOrbit(air))
}

/**
 * A beam read from the transmittance table, cleared by `strength` toward its
 * hue: the slant's color over the column straight overhead at `height01`,
 * with its dimming taken off down to `ORBIT_BEAM_FLOOR` of the overhead
 * light and kept under that.
 */
function clearedBeam(
  air: AirUniforms,
  table: Node<'vec3'>,
  height01: Node<'float'>,
  strength: Node<'float'>,
): Node<'vec3'> {
  const overhead = air.transmittance.sample(
    texelCentered(vec2(1, height01), TRANSMITTANCE),
  ).rgb
  const slant = table.div(max(overhead, vec3(1e-4)))
  const brightest = max(max(slant.x, slant.y), slant.z)
  // The power halves the hue's reddening and nothing else. The dimming under
  // the floor multiplies outside it: taken inside, a beam 0.016 of the floor
  // draws at its square root, 0.125, and lights the night side's air.
  const kept = brightest.div(max(brightest, float(ORBIT_BEAM_FLOOR)))
  const hue = slant
    .div(max(brightest, float(1e-6)))
    .pow(vec3(ORBIT_BEAM_HUE))
    .mul(kept)
  return mix(table, hue, strength)
}

/**
 * How dim a beam may be, as a share of the overhead light, and still have
 * its dimming taken off. A beam the column has all but put out — a
 * thousandth of the overhead light, grazing the terminator — normalized to
 * full brightness is a full-strength orange, and it lights the air over the
 * night side beside a crescent and a sunrise limb: the sunrise limb's crop
 * is 0.057 RMSE of the composite's. Under the floor the beam is divided by
 * the floor and not by its own brightest channel, so it stays as far under
 * full brightness as it is under the floor, and the crop is 0.036.
 */
export const ORBIT_BEAM_FLOOR = 0.3

/**
 * How much of the slant's hue the beam keeps as Enhanced draws a surface
 * from orbit, as a power of it: a half keeps the reddening's square root.
 * The whole of it lights a sunward crescent a saturated orange-red with a
 * blown core, where the composite's crescent is a pale peach; none lights
 * it gray. At a half the crescent is peach-white, the half-lit plate 0.022
 * RMSE of the composite's against 0.023 whole, and Centauri II's gibbous
 * 0.014 against 0.018.
 */
const ORBIT_BEAM_HUE = 0.5

/**
 * How far the air over a surface from orbit is lit by the cleared beam.
 * Production's day side brightens into a pale haze just sunward of the
 * terminator, where the measured air's light falls away with the beam that
 * lights it: a half-lit Earth's terminator draws dark and hard. Lit by the
 * whole cleared beam the haze is there — the half-lit plate 0.021 RMSE of
 * the composite's against 0.025 — and a crescent's sliver and a dark limb
 * wash white (0.043 against 0.033). Half is between: 0.023 and 0.040.
 */
const ORBIT_AIRLIGHT = 0.5
