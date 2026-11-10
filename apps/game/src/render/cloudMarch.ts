import type { Node } from 'three/webgpu'
import {
  Break,
  clamp,
  exp,
  float,
  If,
  int,
  Loop,
  max,
  min,
  mix,
  oneMinus,
  saturate,
  select,
  sqrt,
  vec3,
} from 'three/tsl'
import {
  airMediumAt,
  clearedBeam,
  ORBIT_AIRLIGHT,
  phasesToward,
  psiTableAt,
  stepShare,
  sunTableAt,
  type TableRead,
} from './air.ts'
import { airEye, airSegment } from './cloudCompositeAir.ts'
import { cloudSample, shellCrossing } from './cloudGeometry.ts'
import { type CloudKnotWriter, KNOT_TRANSMITTANCE } from './cloudKnots.ts'
import type {
  CloudFarResult,
  CloudMedium,
  CloudRay,
  CloudSample,
} from './cloudNodes.ts'
import type { CloudTraceDeps } from './cloudTrace.ts'
import type { CloudBodyUniforms, CloudUniforms } from './cloudUniforms.ts'

/*
 * The per-ray fine march: adaptive steps out of cloud and an optical-depth
 * bound in it, maximum-random segment mixing, the step-integral light, the
 * air on a coarse schedule, and a handover to the far march by footprint
 * (§5.5). A function of its injected medium, sun and phase, so a package
 * tests it against an analytic slab.
 *
 * **A step never crosses a layer's boundary.** Each of the six boundary
 * spheres is crossed where §5.2's quadratic says, once a ray, and a step
 * ends at the next crossing ahead of it as it ends at the span's end. The
 * schedule alone does not: an out-of-cloud step reaches 1 km, fog is 150 m
 * thick, and a step whose sample stood in the clear under a base would carry
 * that clear air up to a kilometer into the layer and lose every part of it
 * the step covered. With the ends on the boundaries a constant slab
 * integrates to e^−σL exactly, however the steps fall, and a segment opens
 * and closes on its layer's own crossings, where the knots are recorded.
 *
 * **The sample stands just inside its step.** It is taken at the step's start
 * plus an inset of half a meter and a millionth of the distance, or half the
 * way to the next boundary where that is nearer. A step that starts on a
 * boundary would otherwise sample the boundary itself, where the altitude's
 * own rounding (0.25 m on Earth from orbit, §5.3) decides which side the
 * medium reads, and a sample read from the side behind it carries the wrong
 * medium over the whole step.
 *
 * **Jitter is the first step's length**: a share ξ of the step the schedule
 * gives, so the grid every later step falls on moves by up to that step from
 * frame to frame while the span is still covered from t₀ on. Starting the
 * first sample at t₀ + ξ·Δ instead drops the first ξ·Δ of every ray — up to
 * 50 m of a cloud's lit face, an optical depth of 3.4 in cumulus.
 */

export interface CloudMarchResult {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly reproject: Node<'float'>
  readonly end: Node<'float'>
  readonly front: Node<'float'>
  readonly deviation: Node<'float'>
  /** Where the fine budget ran out, or the far distance. */
  readonly stopped: Node<'float'>
  /** T_a(t₀, stopped): what a far march's light, relative to where it starts, is dimmed by. */
  readonly throughput: Node<'vec3'>
  /** The sum of the opacity weights the depth moments are taken over: 1 − T, accumulated stably. */
  readonly opacity: Node<'float'>
  readonly steps: Node<'float'>
  /** 1 where the budget ran out before the far distance; 0 otherwise. */
  readonly exhausted: Node<'float'>
}

/**
 * The air's per-sample terms, `airMediumAt`'s shape. The march takes it as a
 * parameter, defaulting to `airMediumAt`, so a test can light the air with
 * the beam it was handed and see which beam that was (§5.11).
 */
export type CloudAirFn = typeof airMediumAt

export type CloudMarchDeps = Omit<CloudTraceDeps, 'far' | 'depth'>

/** Out of cloud: from 50 m, growing 1% a step, to 1 km (plan §5.2). */
const STEP_FIRST = 50
const STEP_GROWTH = 1.01
const STEP_LONGEST = 1000
/** In cloud: an optical depth of 0.3 a step, floored at 3 m + 60 m per 16 km (Nubis Evolved). */
const STEP_DEPTH = 0.3
const STEP_FLOOR = 3
const STEP_FLOOR_SLOPE = 60 / 16_000
/** The march stops under 1% transmittance, counting the open segment's estimate. */
const EXIT_TRANSMITTANCE = 0.01
/** The air is sampled every eighth step, and wherever a segment opens or closes. */
const AIR_EVERY = 8
/** The sky's light on a cloud, a placeholder: Ψ × σ_s × ½, isotropic (§5.10). */
const SKY_SHARE = 0.5
const ISOTROPIC = 1 / (4 * Math.PI)
/** The front is where the ray's opacity first reaches a half (plan §5.5). */
const FRONT_TRANSMITTANCE = 0.5
/** The sample's inset into its step: meters, and a share of the distance. */
const INSET = 0.5
const INSET_RELATIVE = 1e-6
/**
 * A crossing this close ahead of t is t: two float32 steps at the distance,
 * so a boundary the step already ended on is not met again a rounding later.
 */
const AHEAD = 1e-3
const AHEAD_RELATIVE = 2e-7
/** Farther than any ray reaches: a boundary the ray does not cross. */
const NEVER = 1e30
/** The air past an early exit: `airToward`'s four samples, the composite's surface segment. */
const BEHIND_SAMPLES = 4

const LEVEL: TableRead = { level: true }

/* ------------------------------------------------------------------------- */
/* Rays and samples                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Every crossing of the six layer boundaries along a ray from the eye, each
 * a register: the march asks for the next one ahead at every step.
 */
function layerCrossings(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
): Node<'float'>[] {
  const spheres: [Node<'float'>, Node<'float'>][] = [
    [body.eyeOver.x, body.boundaries.x],
    [body.eyeOver.y, body.boundaries.y],
    [body.eyeOver.z, body.boundaries.z],
    [body.eyeOver.w, body.boundaries.w],
    [body.eyeOverHigh.x, body.boundariesHigh.x],
    [body.eyeOverHigh.y, body.boundariesHigh.y],
  ]
  return spheres.flatMap(([over, boundary]) => {
    const crossing = shellCrossing(body, mu, over, boundary)
    return [crossing.near, crossing.far].map((t) =>
      select(crossing.hit, t, float(NEVER)).toVar(),
    )
  })
}

/** The first crossing past `t`, or never. */
function nextCrossing(
  crossings: readonly Node<'float'>[],
  t: Node<'float'>,
): Node<'float'> {
  const past = t.add(AHEAD).add(t.mul(AHEAD_RELATIVE))
  return crossings.reduce<Node<'float'>>(
    (nearest, crossing) =>
      min(nearest, select(crossing.greaterThan(past), crossing, float(NEVER))),
    float(NEVER),
  )
}

/**
 * Registers of a sample, so the branches after it read one value: a node
 * first built inside one branch is declared in that branch's scope.
 */
function held(sample: CloudSample): CloudSample {
  return {
    offset: sample.offset.toVar(),
    distance: sample.distance.toVar(),
    altitude: sample.altitude.toVar(),
    sunMu: sample.sunMu.toVar(),
    footprint: sample.footprint.toVar(),
  }
}

function heldMedium(medium: CloudMedium): CloudMedium {
  return {
    fraction: medium.fraction.toVar(),
    sigma: medium.sigma.toVar(),
    layer: medium.layer.toVar(),
    column: medium.column.toVar(),
    radius: medium.radius.toVar(),
    depth: medium.depth.toVar(),
  }
}

/**
 * Horizontal meters a stretch of the ray covers at a sample: the stretch
 * times the sine of the ray's angle to the local vertical, whose cosine is
 * (r_e·μ + t)/r(t) from heights — r(t) is R + h, a sum, never a difference.
 */
function horizontal(
  body: CloudBodyUniforms,
  ray: CloudRay,
  sample: CloudSample,
  stretch: Node<'float'>,
): Node<'float'> {
  const radius = max(body.datumRadius.add(sample.altitude), 1)
  const cosine = body.datumRadius
    .add(body.eye)
    .mul(ray.mu)
    .add(sample.distance)
    .div(radius)
  return stretch.mul(sqrt(max(oneMinus(cosine.mul(cosine)), 0)))
}

/* ------------------------------------------------------------------------- */
/* The march's registers                                                      */
/* ------------------------------------------------------------------------- */

/** The open segment: one layer's crossing of one column (§5.7). */
function openSegment() {
  return {
    open: float(0).toVar(),
    layer: int(-1).toVar(),
    start: float(0).toVar(),
    column: float(0).toVar(),
    fraction: float(0).toVar(),
    through: float(1).toVar(),
    light: vec3(0).toVar(),
    lightRadius: vec3(0).toVar(),
    sky: vec3(0).toVar(),
    // The segment's own opacity weights, Σ through·(1 − e^−τ), and their
    // first two moments in depth past t₀; its fraction scales all three at
    // its close, as it scales its light.
    weight: float(0).toVar(),
    first: float(0).toVar(),
    second: float(0).toVar(),
  }
}

/** The ray's: what closed segments, the air and the schedule have left. */
function rayRegisters(ray: CloudRay, uniforms: CloudUniforms) {
  return {
    t: ray.start.toVar(),
    steps: float(0).toVar(),
    /** The schedule's last step, unscaled and unclipped: what the next grows from. */
    growth: float(STEP_FIRST).toVar(),
    /** 1 until the first step has taken the jitter. */
    fresh: float(1).toVar(),
    closed: float(1).toVar(),
    first: vec3(0).toVar(),
    firstRadius: vec3(0).toVar(),
    sky: vec3(0).toVar(),
    weight: float(0).toVar(),
    moment: float(0).toVar(),
    moment2: float(0).toVar(),
    front: float(-1).toVar(),
    radius: uniforms.served.layers.radius.x.toVar(),
    air: vec3(1).toVar(),
    blocked: vec3(0).toVar(),
    airLength: float(0).toVar(),
    psi: vec3(1).toVar(),
  }
}

/* ------------------------------------------------------------------------- */
/* The fine march                                                             */
/* ------------------------------------------------------------------------- */

export function cloudMarch(
  ray: CloudRay,
  jitter: Node<'float'>,
  sky: Node<'bool'>,
  deps: CloudMarchDeps,
  knots: CloudKnotWriter | null,
): CloudMarchResult {
  const { uniforms } = deps
  const body = uniforms.served
  const air = deps.air ?? airMediumAt
  const phases = phasesToward(ray.direction, body.sun)
  const crossings = layerCrossings(body, ray.mu)
  // The handover is by footprint, never by altitude: past farDistance a
  // trace texel spans more than farFootprint.
  const stop = clamp(uniforms.trace.farDistance, ray.start, ray.end).toVar()
  const r = rayRegisters(ray, uniforms)
  const seg = openSegment()

  /** T_cl times the open segment's current mix. */
  const running = (): Node<'float'> =>
    r.closed.mul(mix(float(1), seg.through, seg.fraction))

  /** L_c so far: the phase of the mean radius so far, fetched once, on the first order; the sky's light isotropic. */
  function lightSoFar(): Node<'vec3'> {
    const lit = r.first.x.add(r.first.y).add(r.first.z)
    const radii = r.firstRadius.x.add(r.firstRadius.y).add(r.firstRadius.z)
    // A ray that met no lit cloud has 0/0 here, and a NaN radius reads the
    // table at a NaN coordinate whose product with no light is NaN, not 0.
    const radius = select(
      lit.greaterThan(0),
      radii.div(max(lit, 1e-30)),
      r.radius,
    )
    return deps.phase
      .droplets(ray.nu, radius)
      .mul(r.first)
      .add(r.sky.mul(ISOTROPIC))
  }

  /**
   * The air over the length walked since its last sample, as a step of
   * constant medium at this sample (§5.11). Its light behind the cloud is
   * the blocked air, taken with the texel's class's beam: the table's own
   * for sky, cleared `ORBIT_AIRLIGHT` of the way for a surface.
   */
  function sampleAir(s: CloudSample): void {
    const R = body.datumRadius
    const height = max(s.altitude, 0).div(R)
    const height01 = saturate(height.div(max(body.air.top.sub(1), 1e-6)))
    const table = sunTableAt(body.air, s.sunMu, height01, LEVEL)
    const cleared = clearedBeam(
      body.air,
      table,
      height01,
      body.cleared.mul(ORBIT_AIRLIGHT),
      LEVEL,
    )
    const beam = select(sky, table, cleared)
    const medium = air(body.air, height, s.sunMu, phases, beam, LEVEL)
    r.psi.assign(psiTableAt(body.air, s.sunMu, height01, LEVEL))
    const length = r.airLength.div(R)
    const tau = medium.extinction.mul(length)
    const through = exp(tau.negate())
    const light = r.air
      .mul(medium.single.add(medium.multiple))
      .mul(length)
      .mul(stepShare(tau, through))
    r.blocked.addAssign(running().sub(1).mul(light))
    r.air.mulAssign(through)
    r.airLength.assign(0)
  }

  /** One mix a segment: its clear share passes, its cloudy share through its whole depth. */
  function close(): void {
    const c = seg.fraction
    const passed = mix(float(1), seg.through, c)
    const scale = r.closed.mul(c)
    r.first.addAssign(seg.light.mul(scale))
    r.firstRadius.addAssign(seg.lightRadius.mul(scale))
    r.sky.addAssign(seg.sky.mul(scale))
    r.weight.addAssign(scale.mul(seg.weight))
    r.moment.addAssign(scale.mul(seg.first))
    r.moment2.addAssign(scale.mul(seg.second))
    if (knots !== null)
      If(passed.lessThan(KNOT_TRANSMITTANCE), () => {
        knots.record(seg.start, r.t, r.closed.mul(passed), lightSoFar())
      })
    r.closed.mulAssign(passed)
    seg.open.assign(0)
    seg.layer.assign(int(-1))
    seg.fraction.assign(0)
    seg.through.assign(1)
    seg.light.assign(vec3(0))
    seg.lightRadius.assign(vec3(0))
    seg.sky.assign(vec3(0))
    seg.weight.assign(0)
    seg.first.assign(0)
    seg.second.assign(0)
  }

  function open(m: CloudMedium): void {
    seg.open.assign(1)
    seg.layer.assign(m.layer)
    seg.start.assign(r.t)
    seg.column.assign(m.column)
  }

  /**
   * The air when it is due or a segment closes or opens, then the close
   * itself. An opening samples it too: a segment's first steps are the lit
   * face of its cloud, and the air's throughput eight steps stale is up to
   * 8 km of out-of-cloud steps behind them.
   */
  function transition(
    closing: Node<'bool'>,
    opening: Node<'bool'>,
    s: CloudSample,
  ): void {
    const due = r.steps.mod(AIR_EVERY).equal(0)
    If(closing.or(opening).or(due), () => {
      sampleAir(s)
    })
    If(closing, () => {
      close()
    })
  }

  /** A constant-medium step of `length` inside the open segment (§5.7–5.8). */
  function step(m: CloudMedium, s: CloudSample, length: Node<'float'>): void {
    const tau = m.sigma.mul(length)
    const through = exp(tau.negate())
    // (1 − e^−τ), by air.ts's series under τ = 0.01, where the subtraction
    // cancels in float32.
    const share = tau.mul(stepShare(vec3(tau), vec3(through)).x)
    const sun = deps.sun(s, m, body)
    // Dimmed by the air between t₀ and this step as it is gathered: a
    // segment is up to a column's width of slant path, and the air's
    // throughput at its far end would dim its near light by the difference.
    const seen = r.air.mul(seg.through.mul(share))
    const lit = sun.air.mul(sun.cloud).mul(seen)
    seg.light.addAssign(lit)
    seg.lightRadius.addAssign(lit.mul(m.radius))
    seg.sky.addAssign(r.psi.mul(seen).mul(SKY_SHARE))
    const weight = seg.through.mul(share)
    const depth = r.t.add(length.mul(0.5)).sub(ray.start)
    seg.weight.addAssign(weight)
    seg.first.addAssign(weight.mul(depth))
    seg.second.addAssign(weight.mul(depth).mul(depth))
    const fraction = max(seg.fraction, m.fraction)
    const before = r.closed.mul(mix(float(1), seg.through, fraction))
    const after = r.closed.mul(
      mix(float(1), seg.through.mul(through), fraction),
    )
    If(
      r.front.lessThan(0).and(after.lessThanEqual(FRONT_TRANSMITTANCE)),
      () => {
        const crossed = saturate(
          before.sub(FRONT_TRANSMITTANCE).div(max(before.sub(after), 1e-9)),
        )
        r.front.assign(r.t.add(length.mul(crossed)))
      },
    )
    seg.through.mulAssign(through)
    seg.fraction.assign(fraction)
    r.radius.assign(m.radius)
  }

  /** The medium's step: the segment's bookkeeping, the schedule, the light. */
  function stepMedium(
    s: CloudSample,
    bound: Node<'float'>,
    next: Node<'float'>,
  ): void {
    const m = heldMedium(deps.medium(s, body))
    const left = m.layer
      .notEqual(seg.layer)
      .or(horizontal(body, ray, s, r.t.sub(seg.start)).greaterThan(seg.column))
    const closing = seg.open.greaterThan(0).and(left).toVar()
    const layered = m.layer.greaterThanEqual(int(0))
    transition(closing, layered.and(seg.open.equal(0).or(closing)), s)
    If(layered.and(seg.open.equal(0)), () => {
      open(m)
    })
    const outside = min(
      STEP_LONGEST,
      max(STEP_FIRST, r.growth.mul(STEP_GROWTH)),
    )
    const floor = r.t.mul(STEP_FLOOR_SLOPE).add(STEP_FLOOR)
    const inside = clamp(
      float(STEP_DEPTH).div(max(m.sigma, 1e-9)),
      floor,
      outside,
    )
    const schedule = select(m.sigma.greaterThan(0), inside, outside)
    const scaled = schedule.mul(
      select(r.fresh.greaterThan(0), jitter, float(1)),
    )
    next.assign(min(r.t.add(scaled), bound))
    r.growth.assign(schedule)
    r.fresh.assign(0)
    If(seg.open.greaterThan(0).and(m.sigma.greaterThan(0)), () => {
      step(m, s, next.sub(r.t))
    })
  }

  Loop(
    {
      start: int(0),
      end: int(uniforms.trace.maxSteps),
      type: 'int',
      condition: '<',
    },
    () => {
      If(r.t.greaterThanEqual(stop), () => {
        Break()
      })
      If(running().lessThan(EXIT_TRANSMITTANCE), () => {
        Break()
      })
      const bound = min(nextCrossing(crossings, r.t), stop).toVar()
      const inset = min(
        bound.sub(r.t).mul(0.5),
        r.t.mul(INSET_RELATIVE).add(INSET),
      )
      const s = held(
        cloudSample(ray, r.t.add(inset), body, uniforms.camera.pixelAngle),
      )
      const next = float(0).toVar()
      stepMedium(s, bound, next)
      r.airLength.addAssign(next.sub(r.t))
      r.t.assign(next)
      r.steps.addAssign(1)
    },
  )

  // The air over the last stretch, then the segment the march ended in.
  const last = held(cloudSample(ray, r.t, body, uniforms.camera.pixelAngle))
  If(r.airLength.greaterThan(0), () => {
    sampleAir(last)
  })
  If(seg.open.greaterThan(0), () => {
    close()
  })
  /*
   * Stopped under 1%, the march leaves the air from here to t₁ to nobody:
   * no far march follows an exit, and the composite still adds L_a(0, t₁)
   * under the cloud's whole opacity, so an opaque cloud on the horizon
   * would wear every kilometer of air behind it to the union's top, some
   * 350 of them from Earth's ground. The cloud's transmittance is held at
   * the exit's, under 1%, from here on.
   */
  If(r.closed.lessThan(EXIT_TRANSMITTANCE).and(r.t.lessThan(ray.end)), () => {
    const R = body.datumRadius
    const behind = airSegment(
      body.air,
      airEye(body),
      ray.direction,
      r.t.div(R),
      ray.end.div(R),
      body.sun,
      BEHIND_SAMPLES,
      select(sky, float(0), body.cleared.mul(ORBIT_AIRLIGHT)),
      air,
    )
    r.blocked.addAssign(r.air.mul(r.closed.sub(1)).mul(behind.inscatter))
  })

  const opacity = r.weight
  const mean = r.moment.div(max(opacity, 1e-30))
  const reproject = select(opacity.greaterThan(0), ray.start.add(mean), ray.end)
  const exhausted = r.steps
    .greaterThanEqual(uniforms.trace.maxSteps)
    .and(r.t.lessThan(stop))
    .and(r.closed.greaterThanEqual(EXIT_TRANSMITTANCE))
  return {
    light: lightSoFar(),
    air: r.blocked,
    transmittance: r.closed,
    reproject,
    end: ray.end,
    front: select(r.front.greaterThanEqual(0), r.front, reproject),
    deviation: select(
      opacity.greaterThan(0),
      sqrt(max(r.moment2.div(max(opacity, 1e-30)).sub(mean.mul(mean)), 0)),
      float(0),
    ),
    stopped: r.t,
    throughput: r.air,
    opacity,
    steps: r.steps,
    exhausted: select(exhausted, float(1), float(0)),
  }
}

/* ------------------------------------------------------------------------- */
/* Past the handover                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The fine march's result with the far march's added from where it stopped
 * to t₁ (§5.5): the far light and blocked air dimmed by the air and cloud
 * the fine march left, the far air that cloud hides taken out of B, their
 * depth moments merged by opacity, and the far stretch recorded as one knot
 * when it holds cloud. Nothing runs where the fine march reached t₁ or
 * exited early.
 */
export function marchFar(
  fine: CloudMarchResult,
  ray: CloudRay,
  far: (from: Node<'float'>) => CloudFarResult,
  knots: CloudKnotWriter | null,
): CloudMarchResult {
  const out = {
    light: fine.light.toVar(),
    air: fine.air.toVar(),
    transmittance: fine.transmittance.toVar(),
    reproject: fine.reproject.toVar(),
    front: fine.front.toVar(),
    deviation: fine.deviation.toVar(),
    opacity: fine.opacity.toVar(),
  }
  If(
    fine.stopped
      .lessThan(ray.end)
      .and(fine.transmittance.greaterThanEqual(EXIT_TRANSMITTANCE)),
    () => {
      const result = far(fine.stopped)
      const carried = fine.throughput.mul(fine.transmittance)
      out.light.addAssign(carried.mul(result.light))
      // B past the stop is T_a·{T·B_far + (T − 1)·L_far}: the far march's
      // own blocked air is relative to its start, so the air the fine
      // march's cloud already hides behind it is the second term, and
      // without it everything past a nearly opaque near cloud shows through.
      out.air.addAssign(
        fine.throughput.mul(
          result.air
            .mul(fine.transmittance)
            .add(result.airLight.mul(fine.transmittance.sub(1))),
        ),
      )
      // Moments past t₀, the fine ones recovered from their mean and spread.
      const fineMean = fine.reproject.sub(ray.start)
      const fineFirst = fineMean.mul(fine.opacity)
      const fineSecond = fine.deviation
        .mul(fine.deviation)
        .add(fineMean.mul(fineMean))
        .mul(fine.opacity)
      const farMean = result.depthMean.sub(ray.start)
      const weight = fine.transmittance.mul(oneMinus(result.transmittance))
      const opacity = fine.opacity.add(weight)
      const first = fineFirst.add(weight.mul(farMean))
      const second = fineSecond.add(
        weight.mul(
          result.depthDeviation
            .mul(result.depthDeviation)
            .add(farMean.mul(farMean)),
        ),
      )
      const mean = first.div(max(opacity, 1e-30))
      const total = fine.transmittance.mul(result.transmittance)
      If(opacity.greaterThan(0), () => {
        out.reproject.assign(ray.start.add(mean))
        out.deviation.assign(
          sqrt(max(second.div(opacity).sub(mean.mul(mean)), 0)),
        )
        // Where the fine march never reached half opacity and the far one
        // does, the front is the far stretch's mean depth.
        If(
          fine.transmittance
            .greaterThan(FRONT_TRANSMITTANCE)
            .and(total.lessThanEqual(FRONT_TRANSMITTANCE)),
          () => {
            out.front.assign(result.depthMean)
          },
        ).ElseIf(fine.transmittance.greaterThan(FRONT_TRANSMITTANCE), () => {
          out.front.assign(ray.start.add(mean))
        })
      })
      out.opacity.assign(opacity)
      out.transmittance.assign(total)
      if (knots !== null)
        If(result.transmittance.lessThan(KNOT_TRANSMITTANCE), () => {
          knots.record(fine.stopped, ray.end, total, out.light)
        })
    },
  )
  return { ...fine, ...out }
}
