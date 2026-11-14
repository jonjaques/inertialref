import type { Node } from 'three/webgpu'
import {
  cross,
  dot,
  exp,
  float,
  If,
  length,
  max,
  min,
  mix,
  saturate,
  select,
  sqrt,
  vec3,
} from 'three/tsl'
import {
  type AirUniforms,
  airMediumAt,
  clearedBeam,
  crowdedSamples,
  type Marched,
  ORBIT_AIRLIGHT,
  phasesToward,
  stepShare,
  sunTableAt,
  SURFACE_AIR_SAMPLES,
} from './air.ts'
import { CLOUD_DEPTH_CLAMP_KM } from './cloudDepth.ts'
import type { CloudBodyUniforms } from './cloudUniforms.ts'

/*
 * The air a composite pixel already carries, split at the cloud span's start
 * (§5.11). The scene drew one of two airs at each pixel: the shell's, where
 * its back-side fragment survived the depth test, or a surface's own
 * (`airToward`), where something in front of the shell's far wall killed it.
 * The composite reproduces whichever it was, in two segments — the eye to
 * t₀ and t₀ to the span's end — so the identity can put the cloud between
 * them.
 *
 * Units are the air's: positions and distances in sea-level units about the
 * body's center, body-fixed, as `marchAir` takes them. The one quantity in
 * other units is the scene's depth, which arrives as the depth copy stores
 * it — render kilometers along the ray — with `units`, the sea-level units a
 * kilometer of it is (1000/(compression·R)), beside it: the clamp is a test
 * on the stored value, and a depth converted first could not be told from a
 * real one that far out.
 *
 * Every table read names level 0. The class is chosen per pixel, so the
 * marches sit in non-uniform control flow, where a fragment read with
 * implicit derivatives is refused (plan §5.2).
 */

/**
 * The air's terms at one sample: `airMediumAt`, `marchAir`'s per-sample
 * terms. A parameter so a test can stand a reproduction of them in where the
 * real one is not yet written; production passes nothing.
 */
export type AirMediumFn = typeof airMediumAt

/** The shell's twelve crowded samples, six a segment on either side of t₀. */
export const SKY_SEGMENT_SAMPLES = 6
/** `airToward`'s four, a segment. */
export const SURFACE_SEGMENT_SAMPLES = SURFACE_AIR_SAMPLES

/*
 * The shell's own depth test, at the depth copy's precision. R16F steps by
 * 2⁻¹¹ to 2⁻¹⁰ of its value and the copy truncates rather than rounding
 * (`cloudDepth.ts`), so a sky pixel's stored depth can read up to a step
 * short of the far wall it stands at: twice the coarser step admits it. The
 * shell's tessellated mesh lies inside its analytic wall by far less than
 * that where a far wall stands. The inscribed sphere is no part of this test:
 * its facets lie up to 120 m inside the analytic sphere on Earth, and a test
 * against the shell's ground branch at a tighter tolerance reads every disk
 * pixel from orbit as sky, speckled where rounding crosses back.
 */
const SKY_DEPTH_TOLERANCE = 2e-3
/** At or past this the copy stores its clamp: nothing was drawn, or it is past 60,000 km. */
const SKY_CLAMP_KM = CLOUD_DEPTH_CLAMP_KM * (1 - SKY_DEPTH_TOLERANCE)

const LEVEL = { level: true } as const

/** A body's eye in the air's units: sea-level units about its center, body-fixed. */
export const airEye = (body: CloudBodyUniforms): Node<'vec3'> =>
  body.up.mul(float(1).add(body.eye.div(body.datumRadius)))

/**
 * The sea-level units one kilometer of the depth copy is, for `skyClass` and
 * `compositeAir`: the copy holds render kilometers, a render meter is
 * 1/compression true ones, and R true meters are one unit. The trace and the
 * composite both take it here, because its reciprocal compiles just as well
 * and reads a 3 km ridge on far-shore as some 3,000 units deep, past every
 * wall: the class of every texel is then sky.
 */
export const depthUnits = (body: CloudBodyUniforms): Node<'float'> =>
  float(1000).div(body.compression.mul(body.datumRadius))

export interface CompositeAir {
  /** The shell's own depth test: D at or past the air's outer far wall. */
  readonly sky: Node<'bool'>
  /** L_a(0, t₀), T_a(0, t₀): physical throughput, the beam cleared as the class's. */
  readonly toStart: Marched
  /** L_a(0, min(t₁, D)) built from the two segments. */
  readonly toEnd: Node<'vec3'>
  /** T_a(0, min(t₁, D)), physical: the residual meter's chain to the span's end. */
  readonly throughEnd: Node<'vec3'>
  /** T'_a(0, t₀): what the cloud's own light is dimmed by (cleared on surfaces under Enhanced from orbit). */
  readonly seen: Node<'vec3'>
}

/**
 * Where the ray enters the air's outer sphere (0 from inside it), and the far
 * wall where it leaves: the shell's `near` and, for a ray that does not meet
 * the ground, its `far`.
 */
export function outerSpan(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
): { readonly near: Node<'float'>; readonly wall: Node<'float'> } {
  // As the shell and `airToward` form it: `|d × c|` for the impact parameter
  // cannot go imaginary on a grazing ray, which is every ray that matters.
  const toCenter = eye.negate()
  const closest = dot(toCenter, direction)
  const impactSquared = max(length(cross(direction, toCenter)).pow(2), 0)
  const halfOuter = sqrt(max(air.top.mul(air.top).sub(impactSquared), 0))
  return { near: max(closest.sub(halfOuter), 0), wall: closest.add(halfOuter) }
}

function classOf(
  depth: Node<'float'>,
  units: Node<'float'>,
  wall: Node<'float'>,
): Node<'bool'> {
  return depth
    .mul(units)
    .greaterThanEqual(wall.mul(1 - SKY_DEPTH_TOLERANCE))
    .or(depth.greaterThanEqual(SKY_CLAMP_KM))
}

/**
 * The class test alone, which the trace calls for its own texel too (§5.11):
 * sky where the scene's depth lies at or past the air's outer far wall,
 * `closest + halfOuter` as the shell forms it, or where the copy stored its
 * clamp. `eye` is in sea-level units about the center, `direction` a unit
 * vector in the same axes, `depth` the depth copy's kilometers as stored and
 * `units` the sea-level units one of them is.
 */
export function skyClass(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  depth: Node<'float'>,
  units: Node<'float'>,
): Node<'bool'> {
  return classOf(depth, units, outerSpan(air, eye, direction).wall)
}

/**
 * One segment of the air, `marchAir`'s accumulation over `crowdedSamples`
 * from `near` to `far`: the same crowding, the same step integral, the same
 * beam behind the same uniform branch, with every read at level 0 and each
 * sample's terms from `medium`. `clearBeam` is `marchAir`'s: null for the
 * shell, which clears nothing.
 *
 * `Loop` and `toVar` emit statements, so this is called from inside a
 * material's or a kernel's `Fn`, as `marchAir` is.
 */
export function airSegment(
  air: AirUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  sun: Node<'vec3'>,
  samples: number,
  clearBeam: Node<'float'> | null,
  medium: AirMediumFn = airMediumAt,
): Marched {
  const shellHeight = max(air.top.sub(1), 1e-6)
  const phases = phasesToward(direction, sun)
  const inscatter = vec3(0).toVar()
  const throughput = vec3(1).toVar()
  crowdedSamples(origin, direction, near, far, samples, (point, stepLength) => {
    const radius = length(point)
    const height = max(radius.sub(1), 0)
    const height01 = saturate(height.div(shellHeight))
    const muSun = dot(point, sun).div(max(radius, 1e-5))
    const sunT = sunTableAt(air, muSun, height01, LEVEL).toVar()
    if (clearBeam !== null)
      If(clearBeam.greaterThan(0), () => {
        sunT.assign(clearedBeam(air, sunT, height01, clearBeam, LEVEL))
      })
    const terms = medium(air, height, muSun, phases, sunT, LEVEL)
    const stepTau = terms.extinction.mul(stepLength)
    const stepThrough = exp(stepTau.negate()).toVar()
    const stepLight = stepLength.mul(stepShare(stepTau, stepThrough))
    inscatter.addAssign(
      throughput.mul(terms.single.add(terms.multiple)).mul(stepLight),
    )
    throughput.mulAssign(stepThrough)
  })
  return { inscatter, transmittance: throughput }
}

/**
 * The air a pixel carries, split at `t0`: the class, and each class's own
 * air over the eye-to-t₀ and t₀-to-end segments, where the end is
 * min(`t1`, D). `t0` and `t1` are in sea-level units along the ray; the rest
 * as `skyClass` takes them, and `cleared` is `clearedFromOrbit`'s value.
 *
 * A sky pixel takes the shell's rule — no beam clearing, physical
 * transmittance, six samples a segment where the shell takes twelve. A
 * surface takes `airToward`'s — four a segment, the beam cleared by
 * `cleared·ORBIT_AIRLIGHT`, and the cloud's own light seen through the
 * cleared transmittance (plan §5.6: the air in front of a cloud takes
 * `clearedFromOrbit` as a surface's does). The blocked air takes the physical
 * one whatever the class: the air it cancels was accumulated through it.
 *
 * Called from inside a `Fn`: the class's branch is a statement.
 */
export function compositeAir(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  t0: Node<'float'>,
  t1: Node<'float'>,
  depth: Node<'float'>,
  sun: Node<'vec3'>,
  cleared: Node<'float'>,
  units: Node<'float'>,
  medium: AirMediumFn = airMediumAt,
): CompositeAir {
  const { near, wall } = outerSpan(air, eye, direction)
  const sky = classOf(depth, units, wall)
  const start = max(t0, near)
  const end = max(min(t1, depth.mul(units)), start)
  const frontLight = vec3(0).toVar()
  const frontThrough = vec3(1).toVar()
  const spanLight = vec3(0).toVar()
  const spanThrough = vec3(1).toVar()
  const march = (samples: number, clearBeam: Node<'float'> | null): void => {
    const front = airSegment(
      air,
      eye,
      direction,
      near,
      start,
      sun,
      samples,
      clearBeam,
      medium,
    )
    const span = airSegment(
      air,
      eye,
      direction,
      start,
      end,
      sun,
      samples,
      clearBeam,
      medium,
    )
    frontLight.assign(front.inscatter)
    frontThrough.assign(front.transmittance)
    spanLight.assign(span.inscatter)
    spanThrough.assign(span.transmittance)
  }
  If(sky, () => {
    march(SKY_SEGMENT_SAMPLES, null)
  }).Else(() => {
    march(SURFACE_SEGMENT_SAMPLES, cleared.mul(ORBIT_AIRLIGHT))
  })
  return {
    sky,
    toStart: { inscatter: frontLight, transmittance: frontThrough },
    toEnd: frontLight.add(frontThrough.mul(spanLight)),
    throughEnd: frontThrough.mul(spanThrough),
    seen: select(sky, frontThrough, mix(frontThrough, vec3(1), cleared)),
  }
}

/* ------------------------------------------------------------------------- */
/* The air by the ray's direction                                             */
/* ------------------------------------------------------------------------- */

/*
 * Where the scene's depth does not cut the cloud's span short, the air a
 * pixel carries is a function of its ray's direction and its class alone:
 * the eye stands on the body's vertical, the span is the shell's, and the
 * sun is the frame's. So it can be formed once a frame on a grid of
 * directions and read a pixel, where a march a pixel is four fifths of the
 * composite's fragment.
 *
 * One term will not interpolate over any grid of directions: the aerosol's
 * phase, which rises sixtyfold over the last 20° toward the sun. It is a
 * factor of the aerosol's single scattering and constant along a ray, so
 * the light is carried as two sums, the aerosol's single scattering per
 * unit of its phase and the rest, and the phase is applied a pixel
 * (`directionLight`). The split is exact for a medium whose single
 * scattering is linear in the aerosol's phase and turns its color by
 * `phases.forward`, which `airMediumAt` is and which `marchAir` is.
 */

/** The air's terms on one ray, as a table of directions holds them. */
export interface DirectionAir {
  /** T_a(0, t₀), physical. */
  readonly through: Node<'vec3'>
  /** L_a(0, end) less the aerosol's single scattering. */
  readonly rest: Node<'vec3'>
  /** The aerosol's single scattering to the end, per unit of its phase, in its sideways color. */
  readonly aerosol: Node<'vec3'>
}

/** Samples of the segment from the eye to t₀, by class: what a table can afford that a pixel could not. */
export interface FrontSamples {
  readonly sky: number
  readonly surface: number
}

/**
 * One segment as `airSegment` marches it, its light in the two sums: one
 * loop, because a second march over the same bounds read for less than the
 * first is miscompiled under the WGSL on Apple's adapter (measured: a
 * transmittance read alone after a lit march of the same segment came back
 * 0.14 where it is 0.50).
 */
function splitSegment(
  air: AirUniforms,
  origin: Node<'vec3'>,
  direction: Node<'vec3'>,
  near: Node<'float'>,
  far: Node<'float'>,
  sun: Node<'vec3'>,
  samples: number,
  clearBeam: Node<'float'> | null,
  medium: AirMediumFn,
): DirectionAir {
  const shellHeight = max(air.top.sub(1), 1e-6)
  const phases = phasesToward(direction, sun)
  const gas = { rayleigh: phases.rayleigh, mie: float(0), forward: float(0) }
  const haze = { rayleigh: float(0), mie: float(1), forward: float(0) }
  const rest = vec3(0).toVar()
  const aerosol = vec3(0).toVar()
  const throughput = vec3(1).toVar()
  crowdedSamples(origin, direction, near, far, samples, (point, stepLength) => {
    const radius = length(point)
    const height = max(radius.sub(1), 0)
    const height01 = saturate(height.div(shellHeight))
    const muSun = dot(point, sun).div(max(radius, 1e-5))
    const sunT = sunTableAt(air, muSun, height01, LEVEL).toVar()
    if (clearBeam !== null)
      If(clearBeam.greaterThan(0), () => {
        sunT.assign(clearedBeam(air, sunT, height01, clearBeam, LEVEL))
      })
    const plain = medium(air, height, muSun, gas, sunT, LEVEL)
    const forward = medium(air, height, muSun, haze, sunT, LEVEL)
    const stepTau = plain.extinction.mul(stepLength)
    const stepThrough = exp(stepTau.negate()).toVar()
    const stepLight = throughput
      .mul(stepLength.mul(stepShare(stepTau, stepThrough)))
      .toVar()
    rest.addAssign(stepLight.mul(plain.single.add(plain.multiple)))
    aerosol.addAssign(stepLight.mul(forward.single))
    throughput.mulAssign(stepThrough)
  })
  return { through: throughput, rest, aerosol }
}

/**
 * The air on one ray of a class, split at `t0` and ended at `end`, as
 * `compositeAir` forms it for a pixel of that class whose depth lies at or
 * past `end`: the same segments, the same crowding, the same beam. `front`
 * is the eye-to-t₀ segment's sample count by class; the span keeps the
 * class's own, which is what the scene's own march of it is nearest.
 *
 * Called from inside a `Fn`: the class's branch is a statement.
 */
export function directionAir(
  air: AirUniforms,
  eye: Node<'vec3'>,
  direction: Node<'vec3'>,
  t0: Node<'float'>,
  end: Node<'float'>,
  sky: Node<'bool'>,
  sun: Node<'vec3'>,
  cleared: Node<'float'>,
  front: FrontSamples,
  medium: AirMediumFn = airMediumAt,
): DirectionAir {
  const { near } = outerSpan(air, eye, direction)
  const start = max(t0, near)
  const stop = max(end, start)
  const through = vec3(1).toVar()
  const rest = vec3(0).toVar()
  const aerosol = vec3(0).toVar()
  const march = (
    frontSamples: number,
    spanSamples: number,
    clearBeam: Node<'float'> | null,
  ): void => {
    const before = splitSegment(
      air,
      eye,
      direction,
      near,
      start,
      sun,
      frontSamples,
      clearBeam,
      medium,
    )
    const span = splitSegment(
      air,
      eye,
      direction,
      start,
      stop,
      sun,
      spanSamples,
      clearBeam,
      medium,
    )
    through.assign(before.through)
    rest.assign(before.rest.add(before.through.mul(span.rest)))
    aerosol.assign(before.aerosol.add(before.through.mul(span.aerosol)))
  }
  If(sky, () => {
    march(front.sky, SKY_SEGMENT_SAMPLES, null)
  }).Else(() => {
    march(front.surface, SURFACE_SEGMENT_SAMPLES, cleared.mul(ORBIT_AIRLIGHT))
  })
  return { through, rest, aerosol }
}

/**
 * L_a(0, end) from a ray's two sums: the aerosol's phase toward the sun and
 * the turn of its color, which `airMediumAt` applies a sample, applied
 * once. The forward color enters as its ratio to the sideways one, a
 * channel at a time, so an air with no aerosol reads its zeros as nothing.
 */
export function directionLight(
  air: AirUniforms,
  terms: Pick<DirectionAir, 'rest' | 'aerosol'>,
  direction: Node<'vec3'>,
  sun: Node<'vec3'>,
): Node<'vec3'> {
  const phases = phasesToward(direction, sun)
  const turned = air.mieForward.div(max(air.mieScatter, vec3(1e-20)))
  return terms.rest.add(
    terms.aerosol.mul(mix(vec3(1), turned, phases.forward)).mul(phases.mie),
  )
}
