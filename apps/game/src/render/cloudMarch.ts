import type { Node } from 'three/webgpu'
import {
  abs,
  bool,
  Break,
  clamp,
  dot,
  exp,
  exp2,
  float,
  floor,
  If,
  int,
  length,
  log,
  Loop,
  max,
  min,
  mix,
  oneMinus,
  pow,
  saturate,
  select,
  sqrt,
  uint,
  vec2,
  vec3,
} from 'three/tsl'
import {
  airMediumAt,
  clearedBeam,
  ORBIT_AIRLIGHT,
  phasesToward,
  psiTableAt,
  stepShare as airShare,
  sunTableAt,
  type TableRead,
} from './air.ts'
import { airEye, airSegment } from './cloudCompositeAir.ts'
import { cloudSample, shellCrossing } from './cloudGeometry.ts'
import { type CloudKnotWriter, KNOT_TRANSMITTANCE } from './cloudKnots.ts'
import { UNSPREAD_SHAPE } from '@inertialref/rendering'
import type { CLOUD_PHASE_MODES, CLOUD_TRANSPORTS } from './cloudLevers.ts'
import {
  crossingDepth,
  crossingExponent,
  resolvedSlab,
  spreadDepth,
  statisticalSlab,
  stepLight,
  stepLightBand,
  stepShare,
} from './cloudMix.ts'
import type {
  CloudFarResult,
  CloudMedium,
  CloudPhaseNodes,
  CloudRay,
  CloudSample,
  CloudSun,
} from './cloudNodes.ts'
import type { CloudSunTaps } from './cloudSunlight.ts'
import type { CloudTraceDeps } from './cloudTrace.ts'
import type {
  CLOUD_CLIMATE_KINDS,
  CloudBodyUniforms,
  CloudLayerUniforms,
} from './cloudUniforms.ts'

/*
 * The per-ray fine march: adaptive steps out of cloud and an optical-depth
 * bound in it, a budget that always reaches the handover, the crossing's law
 * for a partly cloudy level, the step's integral of a source that falls
 * along it, the air on a coarse schedule, and a handover to the far march
 * dithered across a band of footprints (§5.4, §5.8, §5.9). A function of its
 * injected medium, sun and phase, so a package tests it against an analytic
 * slab.
 *
 * **A step never crosses a layer's boundary.** Each of the six boundary
 * spheres is crossed where §5.2's quadratic says, once a ray, and a step
 * ends at the next crossing ahead of it as it ends at the span's end. The
 * schedule alone does not: an out-of-cloud step reaches 1 km, fog is 150 m
 * thick, and a step whose sample stood in the clear under a base would carry
 * that clear air up to a kilometer into the layer and lose every part of it
 * the step covered. With the ends on the boundaries a constant slab
 * integrates to e^−σL exactly, however the steps fall.
 *
 * **The sample stands just inside its step.** It is taken at the step's start
 * plus an inset of half a meter and a millionth of the distance, or half the
 * way to the next boundary where that is nearer. A step that starts on a
 * boundary would otherwise sample the boundary itself, where the altitude's
 * own rounding (0.25 m on Earth from orbit, §5.3) decides which side the
 * medium reads, and a sample read from the side behind it carries the wrong
 * medium over the whole step. The sun is taken at the step's start itself:
 * half a meter into cumulus is 2% to 5% of the sun under equal sun and view
 * angles, more under a low one, and the step's integral is exact only
 * between the ends it is given.
 *
 * **A step is closed by the next one's sun.** The light a step adds is the
 * integral of a source log-linear between its two ends (`stepLight`), and a
 * step's far end is the next step's start, so the source at one sample
 * closes the step behind it and opens the one ahead: one sun a step, and one
 * more where a ray leaves cloud. The loop takes one iteration past its last
 * step to close it, so the sun is built into the program once.
 *
 * **A partly cloudy level is mixed by its crossing's law, a step at a
 * time.** Each level's crossings are known from the spheres before any step:
 * down to its base or through it whole, and up from its base where the ray
 * comes back. A crossing counts `n = √(1 + (ℓ/c)²)` columns over its chord,
 * a step takes its share by its length, and the level's transmittance is
 * then the same at any step count (`cloudMix.ts`). No register holds a
 * column open between steps.
 *
 * **A step is the resolved field or its level's statistics, and the ray
 * says which.** Up to a footprint of `cell·4^(dither − 1)` the medium answers
 * the resolved field, a cover of one, and a step is Beer's law. Past it the
 * medium answers the level's cloudy share and the depth whose transmittance
 * is the cloudy columns' mean, and the step is the crossing's law at the
 * level's own shape and sight length, which the march reads once a
 * crossing. The dither is the ray's, one value on every read of the medium
 * the ray makes, its taps' among them, so at one footprint a ray's crossing
 * is wholly one or the other.
 *
 * **A ray always reaches its handover, and keeps its fine steps near the
 * eye.** A step is never shorter than an even share, in the logarithm of
 * distance, of what is left to the handover for the steps left in the
 * budget. An even share of the distance itself binds from the first step of
 * any long ray, 286 m to 389 m a step inside a cumulus looking at a horizon,
 * where the schedule gives 8.5 m; the logarithm's share at 192 steps to 75 km
 * is 3.9% of the distance, under the schedule near the eye. The first step,
 * which the jitter shortens, and a step cut at a boundary do not count
 * against the budget: at most thirteen of them a ray, so a budget of
 * `maxSteps` is at most that many steps more.
 *
 * **Between two levels a step is a stride.** Outside every level's crossing
 * no medium holds cloud, so a step there finds nothing and carries only the
 * air, which is sampled once in eight steps. Under cirrus over cumulus 71 of
 * a ray's 106 steps crossed the 6.6 km between the two that way. A stride
 * is those eight steps taken as one, with the air sampled at each: the same
 * points along the ray to within a step, and an eighth of the iterations.
 *
 * **Jitter is the first step's length**: a share ξ of the step the schedule
 * gives, so the grid every later step falls on moves by up to that step from
 * frame to frame while the span is still covered from t₀ on. Starting the
 * first sample at t₀ + ξ·Δ instead drops the first ξ·Δ of every ray — up to
 * 50 m of a cloud's lit face, an optical depth of 3.4 in cumulus.
 *
 * **The light after first order is a second source through the same two
 * ends.** At every sun a step takes, the march forms the plane slab its
 * sample stands in and reads that slab's source of the sun's orders past
 * the first (`deps.source`, design §5.5), and the step's integral takes it
 * log-linear between its ends as it takes first order's. Held from a
 * step's start instead it reads a slab's radiance 15.7% off at worst where
 * the two ends read 6.4%.
 *
 * - **The slab is a rule's, and the step says which** (`cloudMix.ts`). A
 *   resolved step hands `resolvedSlab` the sun's two depths
 *   (`CloudSun.depth`). A statistical step stands for a spread of columns,
 *   and sums `statisticalSlab`'s Gauss points of them, read from the
 *   level's shape and its true mean depth; its opacity is the crossing's
 *   law, unchanged.
 * - **The view is laid in the sample's own frame,** the local vertical
 *   from heights: a ray's cosine to it turns 0.9° in 100 km on Earth, and
 *   the table's first three view cosines are within 7° of the horizon. The
 *   bearing is taken from the two directions laid on the face, which keeps
 *   its digits beside the vertical where `(ν − μ·μ₀)/√(1 − μ²)` loses them.
 *   Under a sun below the sample's horizon the lit face is the base, and
 *   the view's cosine turns over with it.
 * - **The factor of the sun by level** rides the slab as its column's
 *   cumuliform share, and the `transport` lever at `'plane'` hands the
 *   node none.
 * - **The light behind the 1% exit is added:** the sun's source past first
 *   order at the exit, times what the cloud still passes there. A deck is
 *   as bright again behind its hundredth as the source is deep in it, and
 *   without it a slab's reflected flux reads 2.14% low at worst where its
 *   bar is 2%.
 *
 * **The sky's light is a placeholder unless a march is built to read the
 * sky table** (`CloudMarchOptions.skyTable`, design §5.6): Ψ at a half,
 * isotropic, constant over a step. The table is one more sampled texture
 * in the kernel, which the trace's budget of twelve does not hold. Read
 * from the table, the sky's term is the mean radiance leaned toward the
 * side the sample's column is nearer, with the flux's view term, and joins
 * the same two ends.
 */

/** How first order takes its phase's radius (§5.4): the `phaseMode` lever's values. */
export type CloudPhaseMode = (typeof CLOUD_PHASE_MODES)[number]

export interface CloudMarchResult {
  readonly light: Node<'vec3'>
  readonly air: Node<'vec3'>
  readonly transmittance: Node<'float'>
  readonly reproject: Node<'float'>
  readonly end: Node<'float'>
  readonly front: Node<'float'>
  readonly deviation: Node<'float'>
  /** Where the fine march stopped: its handover's distance, or where it fell under 1%. */
  readonly stopped: Node<'float'>
  /** T_a(t₀, stopped): what a far march's light, relative to where it starts, is dimmed by. */
  readonly throughput: Node<'vec3'>
  /** The sum of the opacity weights the depth moments are taken over: 1 − T, accumulated stably. */
  readonly opacity: Node<'float'>
  /** Steps taken, the uncounted first and boundary ones among them. */
  readonly steps: Node<'float'>
  /**
   * 1 where the budget's floor lengthened a step in cloud past the
   * schedule's: resolution traded for reach. A clear step the floor
   * lengthens loses nothing, and is not counted: a ray that grazes a high
   * level from 57 km up has its first 50 m made 56 m at any budget.
   */
  readonly exhausted: Node<'float'>
  /**
   * The ray's work by kind, for the instrument's counters, as one unsigned
   * integer: its steps in cloud, plus `KIND_GAP` for each step outside
   * every level, plus `KIND_SUN` for each sun it took. Its steps inside a
   * level that found no cloud are `steps` less the first two. One register,
   * because a register a step is not free on a ray of 193 steps: three of
   * them cost the grazing rows 0.07 ms a frame.
   */
  readonly kinds: Node<'uint'>
  /** The taps the ray's suns read, and the taps their early out left unread (`CloudSunTaps`). */
  readonly taps: Node<'vec2'>
  /**
   * Meters from the eye at which the cloud's optical depth along the ray
   * reaches ln 50, placed inside the step that crosses it by the step's own
   * extinction; −1 where the fine march never reaches it.
   */
  readonly range: Node<'float'>
}

/**
 * The air's per-sample terms, `airMediumAt`'s shape. The march takes it as a
 * parameter, defaulting to `airMediumAt`, so a test can light the air with
 * the beam it was handed and see which beam that was (§5.11).
 */
export type CloudAirFn = typeof airMediumAt

export type CloudMarchDeps = Omit<CloudTraceDeps, 'far' | 'depth'>

export interface CloudMarchOptions {
  /**
   * ξ in [0, 1): where in the handover's band the ray stops,
   * `farDistance·band^ξ`. The band's near edge when absent.
   */
  readonly handover?: Node<'float'>
  /** How first order takes its phase's radius: the ray's mean a level when absent. */
  readonly phaseMode?: CloudPhaseMode
  /**
   * The ray's dither in [0, 1]: where its footprint stops reading the
   * resolved field and reads its level's statistics, `cell·4^(dither − 1)`.
   * Passed on every read of the medium the ray makes. A half when absent.
   */
  readonly dither?: Node<'float'>
  /**
   * Hold a step's source at its start where the march takes it at both
   * ends. The rule a test builds to watch the step's integral fail: 15%
   * high at a step depth of 0.3, and more at every longer one.
   */
  readonly sourceAtStart?: boolean
  /**
   * Take the schedule's own steps between two levels, where the march takes
   * a stride: the march a test holds the strides to.
   */
  readonly unstrided?: boolean
  /**
   * Read the sky's light on a cloud from the body's sky table (design
   * §5.6) where the march draws its placeholder. One more sampled texture
   * in the kernel that takes it.
   */
  readonly skyTable?: boolean
  /**
   * Gauss points a statistical step sums its columns' source at
   * (`statisticalSlab`): two when absent. One is two reads of the table
   * fewer, and reads broken cumulus from above 10 to 16 points higher.
   */
  readonly statisticalPoints?: 1 | 2
}

/** Out of cloud: from 50 m, growing 1% a step, to 1 km (plan §5.2). */
const STEP_FIRST = 50
const STEP_GROWTH = 1.01
const STEP_LONGEST = 1000
/**
 * In cloud: an optical depth of 0.3 a step, floored at 3 m + 60 m per 16 km
 * (Nubis Evolved). A depth of the medium the march draws, the one its
 * transmittance is formed from: where that medium is the scaled one, with
 * the droplets' diffraction out of it, this is a scaled depth.
 */
const STEP_DEPTH = 0.3
const STEP_FLOOR = 3
const STEP_FLOOR_SLOPE = 60 / 16_000
/** The budget's floor is taken from no nearer than this: at the eye a share of ln(stop/t) is unbounded. */
const BUDGET_FROM = 50
/**
 * Steps a ray may take past its budget: its first, which the jitter
 * shortens, one at each of the twelve boundary crossings, and the iteration
 * that closes the last step, with two to spare.
 */
const UNCOUNTED_STEPS = 16
/**
 * The march stops under 1% transmittance: the drawn medium's transmittance,
 * as `STEP_DEPTH` is its depth.
 */
const EXIT_TRANSMITTANCE = 0.01
/** The air is sampled every eighth step, and wherever a ray enters cloud, leaves it or changes level. */
const AIR_EVERY = 8
/**
 * A stride between two levels, in the schedule's steps: the eight the air
 * is sampled once in, each 1% longer than the last.
 */
const STRIDE = (STEP_GROWTH ** AIR_EVERY - 1) / (STEP_GROWTH - 1)
/**
 * What a step outside every level and a sun add to `CloudMarchResult.kinds`:
 * ten bits a count of the integer's 32, so each is exact to 1,023. A float
 * holds a whole number exactly to 2²⁴ only, which is three counts of eight
 * bits: 256 steps in cloud carried into the count outside every level.
 */
export const KIND_GAP = 1024
export const KIND_SUN = KIND_GAP * KIND_GAP
/**
 * The largest step budget the kinds count exactly, and so the largest the
 * `maxSteps` lever takes. A ray runs at most its budget and
 * `UNCOUNTED_STEPS` more, and takes a sun at each step in cloud and one
 * more where its last step is closed: 1,006 + 16 + 1 is a field's 1,023.
 * Past it 1,024 steps in cloud read as none, and one outside every level.
 */
export const CLOUD_MAX_STEPS_COUNTED = KIND_GAP - 1 - UNCOUNTED_STEPS - 1
/*
 * The climate's kind under a regime, and the `'slab'` transport's index, as
 * their uniforms hold them. Each is typed by the table it comes from and
 * not imported as a value: the levers import this file's step bound, and
 * the uniforms import the levers.
 */
const REGIME: (typeof CLOUD_CLIMATE_KINDS)['regime'] = 0
const SLAB_TRANSPORT: (typeof CLOUD_TRANSPORTS)[0] extends 'slab' ? 0 : never =
  0
/** The sky's light on a cloud, a placeholder: Ψ × σ_s × ½, isotropic (§5.10). */
const SKY_SHARE = 0.5
const ISOTROPIC = 1 / (4 * Math.PI)
/** The diffusion's extrapolation length, in transport depths: the sky's two sides are weighed from this far outside each face (§5.6). */
const SKY_REACH = 2 / 3
/** The least the product of two laid directions' lengths a bearing is taken from: under it a direction stands on the normal and has none. */
const NO_BEARING = 1e-6
/** The least a sine of the sun's zenith angle the sky's sunward lean is divided by. */
const SUN_OVERHEAD = 1e-3
/**
 * The front is where the ray's opacity first reaches a half (plan §5.5), in
 * the drawn medium's transmittance.
 */
const FRONT_TRANSMITTANCE = 0.5
/** The range is where the ray's optical depth reaches ln 50: a contrast of 2%, Koschmieder's. */
const RANGE_TRANSMITTANCE = 1 / 50
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
/** The least a chord or a depth is divided by. */
const TINY = 1e-9

const LEVEL: TableRead = { level: true }
const LEVELS = [0, 1, 2] as const

/** A level's component of a per-level vector. */
const of = (v: Node<'vec3'>, k: number): Node<'float'> =>
  k === 0 ? v.x : k === 1 ? v.y : v.z

/* ------------------------------------------------------------------------- */
/* Rays and samples                                                           */
/* ------------------------------------------------------------------------- */

/** One crossing of a level: where the ray is inside it, its chord and its horizontal run, meters. */
interface Crossing {
  readonly start: Node<'float'>
  readonly end: Node<'float'>
  readonly chord: Node<'float'>
  readonly run: Node<'float'>
}

/**
 * Every crossing of the six layer boundaries along a ray from the eye, each
 * a register the march asks for the next one ahead of at every step, and
 * the six crossings of the three levels they bound.
 *
 * A level is crossed at most twice: on the way down to its base, or through
 * it whole where the ray never reaches that base, and on the way up from the
 * base to the top. A crossing's horizontal run is its chord less the height
 * it climbs, squared and subtracted: the heights are the boundaries' own and
 * the eye's over them, never two radii (rule 52). A crossing starts at the
 * eye for an eye inside its level, so the share of its exponent a step takes
 * does not depend on where the scene or the handover stops the ray.
 */
function levelCrossings(
  body: CloudBodyUniforms,
  mu: Node<'float'>,
): {
  readonly spheres: readonly Node<'float'>[]
  readonly crossings: readonly Crossing[]
} {
  const { eyeOver, eyeOverHigh, boundaries, boundariesHigh } = body
  const levels = [
    { over: [eyeOver.x, eyeOver.y], bound: [boundaries.x, boundaries.y] },
    { over: [eyeOver.z, eyeOver.w], bound: [boundaries.z, boundaries.w] },
    {
      over: [eyeOverHigh.x, eyeOverHigh.y],
      bound: [boundariesHigh.x, boundariesHigh.y],
    },
  ] as const
  const spheres: Node<'float'>[] = []
  const crossings: Crossing[] = []
  levels.forEach(({ over, bound }) => {
    const [overBase, overTop] = over
    const [low, high] = bound
    const base = shellCrossing(body, mu, overBase, low)
    const top = shellCrossing(body, mu, overTop, high)
    for (const sphere of [base, top])
      for (const t of [sphere.near, sphere.far])
        spheres.push(select(sphere.hit, t, float(NEVER)).toVar())
    const thickness = high.sub(low)
    const reached = top.hit.and(thickness.greaterThan(0))
    const enter = max(top.near, 0)
    const leave = max(top.far, 0)
    // The base is ahead of the ray, or all round it. Decided by the far
    // root alone: from an eye on the base the near one is zero, a float's
    // step to either side.
    const ahead = base.hit.and(base.far.greaterThan(0))
    const crossing = (
      valid: Node<'bool'>,
      start: Node<'float'>,
      end: Node<'float'>,
      rise: Node<'float'>,
    ): void => {
      const chord = select(valid, max(end.sub(start), 0), float(0)).toVar()
      crossings.push({
        start: start.toVar(),
        end: start.add(chord).toVar(),
        chord,
        run: sqrt(max(chord.mul(chord).sub(rise.mul(rise)), 0)).toVar(),
      })
    }
    // From outside the level's top the ray falls its whole thickness to the
    // base, or none where it leaves through the top again; from inside, the
    // eye's own height over the boundary it leaves through.
    const fall = select(
      top.near.greaterThan(0),
      select(ahead, thickness, float(0)),
      select(ahead, overBase, overTop),
    )
    crossing(reached, enter, select(ahead, max(base.near, 0), leave), fall)
    crossing(reached.and(ahead), max(base.far, 0), leave, thickness)
  })
  return { spheres, crossings }
}

/** The first crossing past `t`, or never. */
function nextCrossing(
  spheres: readonly Node<'float'>[],
  t: Node<'float'>,
): Node<'float'> {
  const past = t.add(AHEAD).add(t.mul(AHEAD_RELATIVE))
  return spheres.reduce<Node<'float'>>(
    (nearest, crossing) =>
      min(nearest, select(crossing.greaterThan(past), crossing, float(NEVER))),
    float(NEVER),
  )
}

/**
 * Registers of a sample, so the branches after it read one value: a node
 * first built inside one branch is declared in that branch's scope.
 */
function held(sample: CloudSample, dither?: Node<'float'>): CloudSample {
  return {
    offset: sample.offset.toVar(),
    distance: sample.distance.toVar(),
    altitude: sample.altitude.toVar(),
    sunMu: sample.sunMu.toVar(),
    footprint: sample.footprint.toVar(),
    ...(dither === undefined ? {} : { dither }),
  }
}

/**
 * The share of a cell past which a footprint reads statistics where a ray
 * carries no dither: the medium's own default, a dither of a half
 * (`CloudSample.dither`), `4^(1/2 − 1)`. The two are one number in two
 * files, and a march that takes another applies a level's spread to a read
 * the medium answered as resolved.
 */
const SWITCH_SHARE = 4 ** (0.5 - 1)

/** A medium's registers, written a step and read by the steps after it. */
function mediumRegisters() {
  return {
    fraction: float(0).toVar(),
    sigma: float(0).toVar(),
    layer: int(-1).toVar(),
    radius: float(10).toVar(),
    depth: float(0).toVar(),
    whole: float(0).toVar(),
  }
}

/** The column's cumuliform share, for a medium that holds it: this step's, and the last cloudy step's. */
const shareRegisters = () => ({
  here: float(0).toVar(),
  stepped: float(0).toVar(),
})
type MediumRegisters = ReturnType<typeof mediumRegisters>

function assignMedium(to: MediumRegisters, from: CloudMedium): void {
  to.fraction.assign(from.fraction)
  to.sigma.assign(from.sigma)
  to.layer.assign(from.layer)
  to.radius.assign(from.radius)
  to.depth.assign(from.depth.x)
  to.whole.assign(from.depth.y)
}

/* ------------------------------------------------------------------------- */
/* First order's phase                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Where first order's light meets its phase (§5.4). A ray's ν is fixed, so a
 * level's phase is a function of radius alone along it, and the three ways
 * to take that radius differ in what a step multiplies its light by and in
 * what is held until the end.
 */
interface PhaseGather {
  /** What a step's light is multiplied by as it is added: the phase and its gain, or one. */
  weight(level: Node<'int'>, radius: Node<'float'>): Node<'vec3'>
  add(level: Node<'int'>, light: Node<'vec3'>, radius: Node<'float'>): void
  /** First order so far, phased. */
  total(): Node<'vec3'>
}

/** The phase times its gain, from the atlas's one fetch. */
function phased(
  phase: CloudPhaseNodes,
  nu: Node<'float'>,
  layers: CloudLayerUniforms,
  k: number,
  radius: Node<'float'>,
): Node<'vec3'> {
  const fetched = phase.phase(nu, layers, k, radius).toVar()
  return fetched.rgb.mul(fetched.a)
}

/**
 * The plan's shortcut: each level's light and its light-weighted radius
 * accumulated unphased, and the phase fetched once a level at the end and at
 * each knot, at the level's mean radius. One sharp ring at the mean.
 */
function meanGather(
  phase: CloudPhaseNodes,
  nu: Node<'float'>,
  layers: CloudLayerUniforms,
): PhaseGather {
  const light = LEVELS.map(() => vec3(0).toVar())
  const weighted = LEVELS.map(() => float(0).toVar())
  return {
    weight: () => vec3(1),
    add(level, added, radius) {
      const sum = added.x.add(added.y).add(added.z)
      LEVELS.forEach((k) => {
        const here = level.equal(int(k))
        light[k]!.addAssign(select(here, added, vec3(0)))
        weighted[k]!.addAssign(select(here, sum.mul(radius), float(0)))
      })
    },
    total() {
      return LEVELS.reduce<Node<'vec3'>>((sum, k) => {
        const lit = light[k]!.x.add(light[k]!.y).add(light[k]!.z)
        // A level that met no lit cloud has 0/0 here, and a NaN radius
        // reads the atlas at a NaN coordinate whose product with no light
        // is NaN, not 0.
        const radius = select(
          lit.greaterThan(0),
          weighted[k]!.div(max(lit, 1e-30)),
          of(layers.radius, k),
        )
        return sum.add(phased(phase, nu, layers, k, radius).mul(light[k]!))
      }, vec3(0))
    },
  }
}

/** The reference: the phase at every step's own radius. One fetch a step. */
function sampleGather(
  phase: CloudPhaseNodes,
  nu: Node<'float'>,
  layers: CloudLayerUniforms,
): PhaseGather {
  const light = vec3(0).toVar()
  const fetched = vec3(0).toVar()
  return {
    weight(level, radius) {
      LEVELS.forEach((k) => {
        If(level.equal(int(k)), () => {
          fetched.assign(phased(phase, nu, layers, k, radius))
        })
      })
      return fetched
    },
    add(_level, added) {
      light.addAssign(added)
    },
    total: () => light,
  }
}

/** The most radii a level's phase is prefetched at. */
const PHASE_BINS = 4

/**
 * The prefetch: on a level's first step the phase at `trace.phaseBins`
 * radii spaced evenly in log r over the level's range, and at every step a
 * blend of the two nearest by the step's radius. A quadrature of the
 * per-step phase over radius, with no fetch a step: a mix of radii draws as
 * a broadened ring. One kernel serves every bin count: it holds four and
 * fetches the first `phaseBins` of them.
 */
function binsGather(
  phase: CloudPhaseNodes,
  nu: Node<'float'>,
  layers: CloudLayerUniforms,
  count: Node<'float'>,
): PhaseGather {
  const light = vec3(0).toVar()
  const bins = Array.from({ length: PHASE_BINS }, () => vec3(0).toVar())
  const prefetched = int(-1).toVar()
  /** The level's least radius, and the logarithm of its range over it. */
  const least = float(1).toVar()
  const spread = float(0).toVar()
  const last = max(count.sub(1), 1)
  function prefetch(level: Node<'int'>): void {
    prefetched.assign(level)
    LEVELS.forEach((k) => {
      If(level.equal(int(k)), () => {
        const low = max(of(layers.radiusMin, k), 1e-3)
        least.assign(low)
        spread.assign(log(max(of(layers.radiusMax, k).div(low), 1)))
        bins.forEach((bin, b) => {
          If(count.greaterThan(b), () => {
            const radius = least.mul(exp(spread.mul(float(b).div(last))))
            bin.assign(phased(phase, nu, layers, k, radius))
          })
        })
      })
    })
  }
  return {
    weight(level, radius) {
      If(level.notEqual(prefetched), () => {
        prefetch(level)
      })
      // A level of one radius has no range to place a step in: its first bin.
      const along = select(
        spread.greaterThan(1e-6),
        saturate(log(max(radius.div(least), 1e-6)).div(max(spread, 1e-6))),
        float(0),
      ).mul(last)
      const lower = min(floor(along), max(count.sub(2), 0))
      const pick = (from: number): Node<'vec3'> =>
        select(
          lower.lessThan(0.5),
          bins[from]!,
          select(lower.lessThan(1.5), bins[from + 1]!, bins[from + 2]!),
        )
      return mix(pick(0), pick(1), saturate(along.sub(lower)))
    },
    add(_level, added) {
      light.addAssign(added)
    },
    total: () => light,
  }
}

function phaseGather(
  mode: CloudPhaseMode,
  deps: CloudMarchDeps,
  nu: Node<'float'>,
): PhaseGather {
  const { phase, uniforms } = deps
  const { layers } = uniforms.served
  if (mode === 'sample') return sampleGather(phase, nu, layers)
  if (mode === 'bins')
    return binsGather(phase, nu, layers, float(uniforms.trace.phaseBins))
  return meanGather(phase, nu, layers)
}

/* ------------------------------------------------------------------------- */
/* The march's registers                                                      */
/* ------------------------------------------------------------------------- */

/**
 * A level's statistics at the column a crossing began in, read once a
 * crossing: the cloudy share, the depth whose transmittance is the cloudy
 * columns' mean, the gamma's shape, the sight length, and the spread's mean
 * depth over that depth, which a slant path scales.
 */
function crossingStatistics() {
  return {
    fraction: float(0).toVar(),
    depth: float(0).toVar(),
    shape: float(UNSPREAD_SHAPE).toVar(),
    sight: float(1).toVar(),
    spread: float(1).toVar(),
    /** The cloudy columns' true mean depth: what the light after first order spreads its columns about. */
    mean: float(0).toVar(),
  }
}

/** The step waiting for the sun at its far end. */
function pendingStep() {
  return {
    on: float(0).toVar(),
    /** T_a·T_c at the step's start, each band. */
    seen: vec3(0).toVar(),
    /** The step's mixed optical depth. */
    depth: float(0).toVar(),
    /** The sun's light at its start, unphased, each band. */
    source: vec3(0).toVar(),
    /**
     * The source of the sun's light past first order at its start, per unit
     * of the sun's irradiance: one number for the three bands, which the
     * air's beam multiplies where the step is closed.
     */
    higher: float(0).toVar(),
    /** What the phase gives the step's light as it is added. */
    weight: vec3(1).toVar(),
    level: int(0).toVar(),
    radius: float(10).toVar(),
  }
}

/** The open knot: one crossing of a level, from its first cloudy step to its last. */
function openKnot() {
  return {
    open: float(0).toVar(),
    crossing: int(-1).toVar(),
    entry: float(0).toVar(),
    exit: float(0).toVar(),
    /** The cloud's transmittance where the crossing's first cloudy step began. */
    through: float(1).toVar(),
  }
}

/** The ray's: what the steps, the air and the schedule have left. */
function rayRegisters(ray: CloudRay) {
  return {
    t: ray.start.toVar(),
    steps: float(0).toVar(),
    /** Steps that count against the budget. */
    counted: float(0).toVar(),
    /** The schedule's last step, unscaled and unclipped: what the next grows from. */
    growth: float(STEP_FIRST).toVar(),
    /** 1 until the first step has taken the jitter. */
    fresh: float(1).toVar(),
    /** 1 once the budget's floor has lengthened a step in cloud. */
    floored: float(0).toVar(),
    /** Steps in cloud, steps outside every level and suns, packed: the counters'. */
    kinds: uint(0).toVar(),
    /** Taps read and taps left unread. */
    taps: vec2(0).toVar(),
    /** T_c so far. */
    through: float(1).toVar(),
    /** The crossing the last sample stood in. */
    crossing: int(-1).toVar(),
    /** The light after first order so far: the sun's higher orders and the sky's, which no phase multiplies. */
    rest: vec3(0).toVar(),
    weight: float(0).toVar(),
    moment: float(0).toVar(),
    moment2: float(0).toVar(),
    front: float(-1).toVar(),
    range: float(-1).toVar(),
    air: vec3(1).toVar(),
    blocked: vec3(0).toVar(),
    airLength: float(0).toVar(),
    psi: vec3(1).toVar(),
  }
}

/**
 * The sky table's three blocks at the air's last sample, what a step's sky
 * term is formed from, and that term at the pending step's start.
 */
function skyRegisters() {
  return {
    mean: vec3(0).toVar(),
    up: vec3(0).toVar(),
    sunward: vec3(0).toVar(),
    pending: vec3(0).toVar(),
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
  options: CloudMarchOptions = {},
): CloudMarchResult {
  const { uniforms } = deps
  const { trace } = uniforms
  const body = uniforms.served
  const air = deps.air ?? airMediumAt
  const phases = phasesToward(ray.direction, body.sun)
  const { spheres, crossings } = levelCrossings(body, ray.mu)
  // The handover is by footprint, never by altitude: past farDistance a
  // trace texel spans more than farFootprint. Dithered over the band's
  // footprints by ξ, so across pixels and frames the two marches cross-fade
  // where one distance would be a line in the picture.
  const band =
    options.handover === undefined
      ? float(1)
      : pow(max(trace.handoverBand, 1), options.handover)
  const stop = clamp(trace.farDistance.mul(band), ray.start, ray.end).toVar()
  const r = rayRegisters(ray)
  const m = mediumRegisters()
  /** The medium of the last cloudy step: what the sun at its far end is read with. */
  const stepped = mediumRegisters()
  const pending = pendingStep()
  const knot = openKnot()
  const column = crossingStatistics()
  const { dither } = options
  // 4^(dither − 1), once a ray: the share of a cell past which the medium
  // answers its level's statistics (`statisticsFootprint`), as the medium
  // takes it from the same dither.
  const switchShare =
    dither === undefined
      ? float(SWITCH_SHARE)
      : exp2(clamp(dither, 0, 1).mul(2).sub(2)).toVar()
  /** A level's component of a per-level vector, by the medium's own level. */
  const ofLevel = (v: Node<'vec3'>, level: Node<'int'>): Node<'float'> =>
    select(level.equal(int(0)), v.x, select(level.equal(int(1)), v.y, v.z))
  const gather = phaseGather(options.phaseMode ?? 'mean', deps, ray.nu)
  const skyTable = options.skyTable === true ? skyRegisters() : null
  /*
   * What the light after first order reads of each level, formed once a
   * ray, before its first step. Read from their uniforms at every sun
   * instead, a level's component of a handful of uniforms cost the frame
   * 0.15 to 0.3 ms at 1080p on the Mac mini's GPU, and formed once a
   * crossing they were formed again by every batch of rays one of which
   * was entering cloud.
   */
  const once = {
    /** The source node's own numbers of each level (`CloudSourceNodes.level`). */
    levels: LEVELS.map((k) => deps.source.level(int(k)).toVar()),
    /** Each level's footprint past which a step in it is statistical. */
    statistical: body.layers.cell.mul(switchShare).toVar(),
    /**
     * Each level's cumuliform share as the factor of the sun takes it. The
     * factor is the `'slab'` transport's. A regime's level is one share
     * everywhere, which its climate's uniforms hold; a climate whose share
     * varies by place is read by a medium that holds its column's, and
     * takes no factor from one that does not.
     */
    share: select(
      trace.transport
        .equal(uint(SLAB_TRANSPORT))
        .and(body.climate.kind.equal(uint(REGIME))),
      saturate(body.climate.convective),
      vec3(0),
    ).toVar(),
    /** The eye's distance from the body's center, and its vertical times that. */
    eyeRadius: body.datumRadius.add(body.eye).toVar(),
    eyeUp: body.up.mul(body.datumRadius.add(body.eye)).toVar(),
    sun: body.sun.toVar(),
    datum: body.datumRadius.toVar(),
  }
  // Declared here, in the march's own scope, and written only where the
  // medium turns out to hold its column's cumuliform share: a register
  // first built inside the loop's branch would be that branch's.
  const share = shareRegisters()
  let sharesHeld = false

  /** L_c so far: first order through its phase, and the light after it. */
  const lightSoFar = (): Node<'vec3'> => gather.total().add(r.rest)

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
    // The sky's light on the cloud, at the air's own sample: its three
    // blocks vary over kilometers of height, so one read a segment.
    if (skyTable === null)
      r.psi.assign(psiTableAt(body.air, s.sunMu, height01, LEVEL))
    else {
      const sky = deps.sky.at(s, body)
      skyTable.mean.assign(sky.mean)
      skyTable.up.assign(sky.up)
      skyTable.sunward.assign(sky.sunward)
    }
    const length = r.airLength.div(R)
    const tau = medium.extinction.mul(length)
    const through = exp(tau.negate())
    const light = r.air
      .mul(medium.single.add(medium.multiple))
      .mul(length)
      .mul(airShare(tau, through))
    r.blocked.addAssign(r.through.sub(1).mul(light))
    r.air.mulAssign(through)
    r.airLength.assign(0)
  }

  /** The crossing a distance along the ray stands in: its index, its level, its chord and its run. */
  function crossingAt(t: Node<'float'>) {
    let index: Node<'int'> = int(-1)
    let level: Node<'int'> = int(0)
    let chord: Node<'float'> = float(0)
    let run: Node<'float'> = float(0)
    crossings.forEach((crossing, j) => {
      const inside = t
        .greaterThanEqual(crossing.start)
        .and(t.lessThan(crossing.end))
      index = select(inside, int(j), index)
      level = select(inside, int(j >> 1), level)
      chord = select(inside, crossing.chord, chord)
      run = select(inside, crossing.run, run)
    })
    return {
      index: index.toVar(),
      level: level.toVar(),
      chord: chord.toVar(),
      run: run.toVar(),
    }
  }

  /**
   * The level's statistics at a crossing's first column, held for the
   * crossing. A medium that answers none is one column a cell across whose
   * depths do not spread, at which a resolved cloud is Beer's law.
   */
  function readStatistics(medium: CloudMedium): void {
    const { statistics } = medium
    if (statistics === undefined) {
      column.sight.assign(ofLevel(body.layers.cell, medium.layer))
      return
    }
    column.fraction.assign(statistics.fraction)
    column.depth.assign(statistics.depth)
    // A medium that holds no mean is one depth: its own.
    column.mean.assign(statistics.mean ?? statistics.depth)
    column.shape.assign(statistics.shape)
    column.sight.assign(statistics.sight)
    column.spread.assign(
      select(
        statistics.depth.greaterThan(TINY),
        spreadDepth(statistics.depth, statistics.shape).div(
          max(statistics.depth, TINY),
        ),
        float(1),
      ),
    )
  }

  /**
   * The pending step's light, now that the sources at its far end are
   * known: first order's, the sun's past first order through the air's
   * beam at the far end, which a step's length does not move by a part in
   * a hundred, and the sky's where the march reads its table.
   */
  function closeStep(
    sunlight: Node<'vec3'>,
    higher: Node<'float'>,
    air: Node<'vec3'>,
    sky: Node<'vec3'> | null,
  ): void {
    const held = options.sourceAtStart === true
    const light = pending.seen
      .mul(pending.weight)
      .mul(
        stepLight(
          pending.source,
          held ? pending.source : sunlight,
          pending.depth,
        ),
      )
    gather.add(pending.level, light, pending.radius)
    r.rest.addAssign(
      pending.seen
        .mul(air)
        .mul(
          stepLightBand(
            pending.higher,
            held ? pending.higher : higher,
            pending.depth,
          ),
        ),
    )
    if (skyTable !== null && sky !== null)
      r.rest.addAssign(
        pending.seen.mul(
          stepLight(
            skyTable.pending,
            held ? skyTable.pending : sky,
            pending.depth,
          ),
        ),
      )
    pending.on.assign(0)
  }

  /**
   * The sky's light a step adds, per unit of what reaches its start and of
   * its opacity: a placeholder, Ψ at a half, isotropic. A march built to
   * read the sky table takes `skyLight` at the step's two ends instead.
   */
  const skySource = (): Node<'vec3'> => r.psi.mul(SKY_SHARE * ISOTROPIC)

  /** A sample's medium as the light after first order reads it: this step's, or the step's being closed. */
  interface Lit {
    readonly level: Node<'int'>
    readonly radius: Node<'float'>
    readonly sigma: Node<'float'>
    /** The level's in-cloud column over the sample, and whole. */
    readonly depth: Node<'vec2'>
    /** The column's cumuliform share as the factor of the sun takes it, 0..1. */
    readonly convective: Node<'float'>
  }

  /**
   * The source of the sun's light past first order at a sample, per unit
   * of the sun's irradiance: the slab the sample stands in, read in the
   * sample's own frame. `rise` is the ray's cosine to the sample's
   * vertical, and `up` that vertical.
   */
  function slabSource(
    at: CloudSample,
    sun: CloudSun,
    sample: Lit,
    rise: Node<'float'>,
    up: Node<'vec3'>,
  ): Node<'float'> {
    const above = at.sunMu.greaterThanEqual(0)
    // To the lit face's outward normal, of light traveling to the eye: the
    // face is the top under a sun over the sample's horizon and the base
    // under one below it.
    const muV = select(above, rise.negate(), rise)
    // That light and the sun's, each laid on the face.
    const eyeLaid = up.mul(rise).sub(ray.direction)
    const sunLaid = up.mul(at.sunMu).sub(once.sun)
    const laid = length(eyeLaid).mul(length(sunLaid))
    const bearing = select(
      laid.greaterThan(NO_BEARING),
      dot(eyeLaid, sunLaid).div(max(laid, NO_BEARING)),
      float(0),
    )
    const view = deps.source.view(muV, bearing)
    const { convective } = sample
    const statistical = at.footprint
      .greaterThan(ofLevel(once.statistical, sample.level))
      .toVar()
    const levelRead = select(
      sample.level.equal(int(0)),
      once.levels[0]!,
      select(sample.level.equal(int(1)), once.levels[1]!, once.levels[2]!),
    ).toVar()
    // The share of the level's column the ray has crossed to here: the
    // profile's own share over the sample, from whichever face the eye is
    // on.
    const over = saturate(sample.depth.x.div(max(sample.depth.y, TINY)))
    const down = rise.lessThan(0)
    const seen = select(down, over, float(1).sub(over))
    const litSide = down.and(above).or(down.not().and(above.not()))
    const points = options.statisticalPoints ?? 2
    const gauss = (point: 0 | 1) =>
      statisticalSlab(column, seen, abs(rise), litSide, at.sunMu, point, points)
    /*
     * One read serves a resolved step and a statistical step's first point,
     * its slab chosen between the two rules, and the second point is read
     * only where a step is statistical. As two branches of a read each, a
     * batch of rays that straddles the switch paid for three: this GPU
     * runs a branch's dearer side for all 32.
     */
    const plain = resolvedSlab(sun.depth.toVar(), at.sunMu)
    const first = gauss(0)
    const source = deps.source
      .source(
        {
          sunMu: plain.sunMu,
          depth: select(statistical, first.slab.depth, plain.depth),
          convective,
        },
        sample.radius,
        levelRead,
        view,
      )
      .mul(select(statistical, first.weight, float(1)))
      .toVar()
    if (points === 2)
      If(statistical, () => {
        const second = gauss(1)
        source.addAssign(
          second.weight.mul(
            deps.source.source(
              { ...second.slab, convective },
              sample.radius,
              levelRead,
              view,
            ),
          ),
        )
      })
    return source
  }

  /**
   * The sky's light on a sample, as a source (design §5.6): the sky's mean
   * radiance, which a conservative medium returns exactly at any depth,
   * leaned toward the side the sample's column is nearer by the
   * diffusion's weight of the two faces, with the flux's view term.
   *
   * The column is the level's own over and under the sample, in transport
   * depths at the level's reference radius, scaled by the sample's
   * extinction over the level's reference, no more than one: a wisp inside
   * a deep level reads a thin column and glows with the whole sphere's
   * mean. A heuristic, declared.
   */
  function skyLight(
    sky: ReturnType<typeof skyRegisters>,
    at: CloudSample,
    sample: Lit,
    rise: Node<'float'>,
  ): Node<'vec3'> {
    const transport = ofLevel(body.layers.transport, sample.level)
    const thin = saturate(
      sample.sigma.div(max(ofLevel(body.layers.sigma, sample.level), TINY)),
    )
    const scale = transport.mul(thin)
    const over = sample.depth.x.mul(scale)
    const under = max(sample.depth.y.sub(sample.depth.x), 0).mul(scale)
    const span = over.add(under)
    const top = under.add(SKY_REACH).div(span.add(2 * SKY_REACH))
    // The ray's cosine to the sun's horizontal direction at the sample.
    const sunward = ray.nu
      .sub(rise.mul(at.sunMu))
      .div(
        max(sqrt(max(float(1).sub(at.sunMu.mul(at.sunMu)), 0)), SUN_OVERHEAD),
      )
    const flux = sky.up
      .mul(rise)
      .add(sky.sunward.mul(sunward))
      .mul(float(1).sub(transport))
      .div(span.add(2 * SKY_REACH))
    return sky.mean.mul(max(sky.up.mul(top.sub(0.5)).add(1).add(flux), 0))
  }

  /** A step of `length` through cloud: its mix, its opacity's moments, and its light left pending. */
  function step(
    here: ReturnType<typeof crossingAt>,
    s: CloudSample,
    length: Node<'float'>,
  ): void {
    // The step's share of its crossing's columns, by its share of the
    // chord; a cloud outside every level's crossing is one column a step.
    const exponent = select(
      here.index.greaterThanEqual(int(0)),
      crossingExponent(here.run, column.sight)
        .mul(length)
        .div(max(here.chord, TINY)),
      float(1),
    )
    /*
     * Past the switch the medium's extinction sums, up a vertical column,
     * to the depth whose transmittance is the cloudy columns' mean: the
     * step's mean depth is that times the spread's share, and its columns
     * hold the level's gamma. Up to the switch the medium is the resolved
     * field at a cover of one, and its depth is the step's own. The switch
     * is the medium's, formed here from the same cell and the same dither.
     */
    const statistical = s.footprint
      .greaterThan(ofLevel(body.layers.cell, m.layer).mul(switchShare))
      .toVar()
    /*
     * A whole column whose depths do not spread passes Beer's law, which
     * is what the crossing's law answers for it at any exponent: so the
     * law is taken only where the step is statistical or its column is
     * partly clear. Its logarithms and exponentials are a third dearer
     * than a read of the field, and under an overcast, where every step is
     * resolved, they were 0.46 ms of the frame for an answer the step
     * already held.
     */
    const depth = m.sigma.mul(length).toVar()
    If(statistical.or(m.fraction.lessThan(1)), () => {
      depth.assign(
        crossingDepth(
          m.fraction,
          m.sigma.mul(length).mul(select(statistical, column.spread, float(1))),
          exponent,
          select(statistical, column.shape, float(UNSPREAD_SHAPE)),
        ),
      )
    })
    // 1 − e^−τ by its series under τ = 0.01, where the subtraction cancels
    // in float32.
    const opacity = depth.mul(stepShare(depth)).toVar()
    const before = r.through
    const after = before.mul(exp(depth.negate())).toVar()
    /** Where in the step the transmittance falls to `level`, by the step's own extinction. */
    const reached = (level: number): Node<'float'> =>
      r.t.add(
        length.mul(saturate(log(before.div(level)).div(max(depth, TINY)))),
      )
    If(
      r.front.lessThan(0).and(after.lessThanEqual(FRONT_TRANSMITTANCE)),
      () => {
        r.front.assign(reached(FRONT_TRANSMITTANCE))
      },
    )
    If(
      r.range.lessThan(0).and(after.lessThanEqual(RANGE_TRANSMITTANCE)),
      () => {
        r.range.assign(reached(RANGE_TRANSMITTANCE))
      },
    )
    // Dimmed by the air between t₀ and this step as it is gathered.
    const seen = r.air.mul(before).toVar()
    if (skyTable === null) r.rest.addAssign(seen.mul(skySource()).mul(opacity))
    const weight = before.mul(opacity)
    const middle = r.t.add(length.mul(0.5)).sub(ray.start)
    r.weight.addAssign(weight)
    r.moment.addAssign(weight.mul(middle))
    r.moment2.addAssign(weight.mul(middle).mul(middle))
    pending.on.assign(1)
    pending.seen.assign(seen)
    pending.depth.assign(depth)
    pending.level.assign(here.level)
    pending.radius.assign(m.radius)
    pending.weight.assign(gather.weight(here.level, m.radius))
    If(knot.open.equal(0), () => {
      knot.open.assign(1)
      knot.crossing.assign(here.index)
      knot.entry.assign(r.t)
      knot.through.assign(before)
    })
    knot.exit.assign(r.t.add(length))
    for (const key of Object.keys(m) as (keyof MediumRegisters)[])
      stepped[key].assign(m[key])
    if (sharesHeld) share.stepped.assign(share.here)
    r.through.assign(after)
  }

  /**
   * The schedule's step, lengthened to the budget's floor: an even share,
   * in ln t, of what is left to the handover. `between` is a sample outside
   * every level's crossing, where the step is a stride, and `ahead` the
   * meters to the next boundary, which cuts it.
   */
  function stepLength(
    cloudy: Node<'bool'>,
    between: Node<'bool'>,
    ahead: Node<'float'>,
  ): Node<'float'> {
    const outside = min(
      STEP_LONGEST,
      max(STEP_FIRST, r.growth.mul(STEP_GROWTH)),
    ).toVar()
    const inside = clamp(
      float(STEP_DEPTH).div(max(m.sigma, TINY)),
      r.t.mul(STEP_FLOOR_SLOPE).add(STEP_FLOOR),
      outside,
    )
    const stride = min(outside.mul(STRIDE), AIR_EVERY * STEP_LONGEST)
    const schedule = select(
      cloudy,
      inside,
      select(between, stride, outside),
    ).toVar()
    const left = max(trace.maxSteps.sub(r.counted), 1)
    const from = max(r.t, BUDGET_FROM)
    const share = from.mul(exp(log(max(stop.div(from), 1)).div(left)).sub(1))
    // The last counted step goes the rest of the way, whatever its share
    // was formed from.
    const least = select(left.lessThanEqual(1), stop.sub(r.t), share).toVar()
    // A step in cloud the floor lengthens is resolution lost. A clear one
    // loses nothing: the air is on its own schedule.
    If(cloudy.and(least.greaterThan(schedule)), () => {
      r.floored.assign(1)
    })
    r.growth.assign(schedule)
    // A stride leaves the schedule where the steps it stands for would
    // have: at the last of its eight, or at the one the next boundary cuts.
    // The level past the gap is then sampled on the grid the single steps
    // lay, to the meter: left three steps ahead, a cirrus seen near the sun
    // drew 8% brighter in the mean, by where its samples fell.
    If(between.and(cloudy.not()), () => {
      const whole = floor(
        log(
          max(ahead, 0)
            .mul(STEP_GROWTH - 1)
            .div(outside)
            .add(1),
        ).div(Math.log(STEP_GROWTH)),
      )
      r.growth.assign(
        min(
          outside.mul(
            exp(min(whole, AIR_EVERY - 1).mul(Math.log(STEP_GROWTH))),
          ),
          STEP_LONGEST,
        ),
      )
    })
    return max(schedule, least).mul(
      select(r.fresh.greaterThan(0), jitter, float(1)),
    )
  }

  Loop(
    {
      start: int(0),
      end: int(trace.maxSteps).add(int(UNCOUNTED_STEPS)),
      type: 'int',
      condition: '<',
    },
    () => {
      const done = r.t
        .greaterThanEqual(stop)
        .or(r.through.lessThan(EXIT_TRANSMITTANCE))
        .or(r.counted.greaterThanEqual(trace.maxSteps))
        .toVar()
      // One iteration past the last step where a step waits for its far
      // end's sun or a knot is open: a crossing whose last steps are clear
      // has no step waiting, and its knot is still to be recorded.
      const owed =
        knots === null
          ? pending.on.greaterThan(0)
          : pending.on.greaterThan(0).or(knot.open.greaterThan(0))
      If(done.and(owed.not()), () => {
        Break()
      })
      const bound = min(nextCrossing(spheres, r.t), stop).toVar()
      const inset = max(
        min(bound.sub(r.t).mul(0.5), r.t.mul(INSET_RELATIVE).add(INSET)),
        0,
      )
      const s = held(
        cloudSample(ray, r.t.add(inset), body, uniforms.camera.pixelAngle),
        dither,
      )
      const here = crossingAt(s.distance)
      // Past the last step the medium is not read again: the step being
      // closed keeps the one it was taken with. The level's statistics are
      // read where the ray enters a crossing, and held for it.
      If(done.not(), () => {
        const medium = deps.medium(s, body)
        assignMedium(m, medium)
        if (medium.convective !== undefined) {
          sharesHeld = true
          share.here.assign(medium.convective)
        }
        If(here.index.notEqual(r.crossing), () => {
          readStatistics(medium)
        })
      })
      const cloudy = done
        .not()
        .and(m.sigma.greaterThan(0))
        .and(m.fraction.greaterThan(0))
        .toVar()
      const waiting = pending.on.greaterThan(0).toVar()
      // The air when it is due, and where the cloud in front of it changes:
      // a cloud's first steps are its lit face, and the air's throughput
      // eight steps stale is up to 8 km of out-of-cloud steps behind them.
      // Between two levels every step is a stride, and the air's sample.
      const between =
        options.unstrided === true
          ? bool(false)
          : here.index.lessThan(int(0)).toVar()
      const due = r.steps.mod(AIR_EVERY).equal(0).or(between)
      const turned = cloudy
        .and(waiting.not())
        .or(waiting.and(cloudy.not()))
        .or(here.index.notEqual(r.crossing))
      If(done.not().and(due.or(turned)), () => {
        sampleAir(s)
      })
      r.crossing.assign(here.index)
      // The sun, where a step starts in cloud and where one waits for its
      // far end: there with the medium the waiting step was taken with.
      If(cloudy.or(waiting), () => {
        const at = held(
          cloudSample(ray, r.t, body, uniforms.camera.pixelAngle),
          dither,
        )
        const opens = cloudy
        const level = select(opens, m.layer, stepped.layer).toVar()
        const radius = select(opens, m.radius, stepped.radius).toVar()
        const sigma = select(opens, m.sigma, stepped.sigma)
        const depth = vec2(
          select(opens, m.depth, stepped.depth),
          select(opens, m.whole, stepped.whole),
        ).toVar()
        const sun = deps.sun(
          at,
          {
            fraction: select(opens, m.fraction, stepped.fraction),
            sigma,
            layer: level,
            column: float(NEVER),
            radius,
            depth,
            statistics: column,
          },
          body,
        )
        // The beam through the air, once: first order's light and the
        // light after it are both lit by it.
        const air = sun.air.toVar()
        const sunlight = air.mul(sun.cloud).toVar()
        r.kinds.addAssign(uint(KIND_SUN))
        const { taken, skipped } = sun as Partial<CloudSunTaps>
        if (taken !== undefined && skipped !== undefined)
          r.taps.addAssign(vec2(taken, skipped))
        // The sample's own vertical, from heights: the frame the light
        // after first order is laid in.
        const radiusAt = max(once.datum.add(at.altitude), 1)
        const rise = once.eyeRadius
          .mul(ray.mu)
          .add(at.distance)
          .div(radiusAt)
          .toVar()
        const up = once.eyeUp.add(at.offset).div(radiusAt)
        const medium: Lit = {
          level,
          radius,
          sigma,
          depth,
          // The column's own share where the medium holds it, and the
          // level's elsewhere.
          convective: sharesHeld
            ? select(
                trace.transport.equal(uint(SLAB_TRANSPORT)),
                saturate(select(opens, share.here, share.stepped)),
                float(0),
              )
            : ofLevel(once.share, level),
        }
        const higher = slabSource(at, sun, medium, rise, up).toVar()
        const sky =
          skyTable === null
            ? null
            : skyLight(skyTable, at, medium, rise).toVar()
        If(waiting, () => {
          closeStep(sunlight, higher, air, sky)
          // Behind the exit the cloud goes on: the sun's source there past
          // first order, times what the cloud still passes.
          If(r.through.lessThan(EXIT_TRANSMITTANCE), () => {
            r.rest.addAssign(r.air.mul(air).mul(r.through.mul(higher)))
          })
        })
        pending.source.assign(sunlight)
        pending.higher.assign(higher)
        if (skyTable !== null && sky !== null) skyTable.pending.assign(sky)
      })
      // A knot a crossing: closed where the ray leaves the crossing its
      // cloud began in, and where the march ends inside one.
      if (knots !== null)
        If(
          knot.open
            .greaterThan(0)
            .and(here.index.notEqual(knot.crossing).or(done)),
          () => {
            If(r.through.lessThan(knot.through.mul(KNOT_TRANSMITTANCE)), () => {
              knots.record(knot.entry, knot.exit, r.through, lightSoFar())
            })
            knot.open.assign(0)
          },
        )
      If(done, () => {
        Break()
      })
      const next = min(
        r.t.add(stepLength(cloudy, between, bound.sub(r.t))),
        bound,
      ).toVar()
      // The first step and one cut at a boundary are not the budget's.
      const cut = next.greaterThanEqual(bound).and(bound.lessThan(stop))
      r.counted.addAssign(
        select(r.fresh.greaterThan(0).or(cut), float(0), float(1)),
      )
      r.fresh.assign(0)
      r.kinds.addAssign(
        select(
          cloudy,
          uint(1),
          select(here.index.lessThan(int(0)), uint(KIND_GAP), uint(0)),
        ),
      )
      If(cloudy, () => {
        step(here, s, next.sub(r.t))
      })
      r.airLength.addAssign(next.sub(r.t))
      r.t.assign(next)
      r.steps.addAssign(1)
    },
  )

  // The air over the last stretch.
  const last = held(cloudSample(ray, r.t, body, uniforms.camera.pixelAngle))
  If(r.airLength.greaterThan(0), () => {
    sampleAir(last)
  })
  /*
   * Stopped under 1%, the march leaves the air from here to t₁ to nobody:
   * no far march follows an exit, and the composite still adds L_a(0, t₁)
   * under the cloud's whole opacity, so an opaque cloud on the horizon
   * would wear every kilometer of air behind it to the union's top, some
   * 350 of them from Earth's ground. The cloud's transmittance is held at
   * the exit's, under 1%, from here on.
   */
  If(r.through.lessThan(EXIT_TRANSMITTANCE).and(r.t.lessThan(ray.end)), () => {
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
    r.blocked.addAssign(r.air.mul(r.through.sub(1)).mul(behind.inscatter))
  })

  const opacity = r.weight
  const mean = r.moment.div(max(opacity, 1e-30))
  const reproject = select(opacity.greaterThan(0), ray.start.add(mean), ray.end)
  return {
    light: lightSoFar(),
    air: r.blocked,
    transmittance: r.through,
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
    exhausted: r.floored,
    kinds: r.kinds,
    taps: r.taps,
    range: r.range,
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
